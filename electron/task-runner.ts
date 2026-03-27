import crypto from 'node:crypto';
import { extractResponseText } from './openai-response.js';
import { capTextToApproxTokens } from './token-limits.js';
import type { ToolDefinition, ToolExecutionResult } from './tool-types.js';

export type TaskStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskStep = {
  index: number;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message: string;
  toolName?: string;
};

export type TaskSnapshot = {
  id: string;
  goal: string;
  plannerModel: string;
  status: TaskStatus;
  currentStep: number;
  maxSteps: number;
  lastUpdate: string;
  history: TaskStep[];
  finalAnswer?: string;
};

type PlannerDecision = {
  status: 'continue' | 'done' | 'blocked';
  stepTitle?: string;
  messageForUser?: string;
  toolName?: string;
  toolArgsJson?: string;
  finalAnswer?: string;
};

const PLANNER_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['continue', 'done', 'blocked'],
    },
    stepTitle: {
      type: ['string', 'null'],
    },
    messageForUser: {
      type: ['string', 'null'],
    },
    toolName: {
      type: ['string', 'null'],
    },
    toolArgsJson: {
      type: ['string', 'null'],
    },
    finalAnswer: {
      type: ['string', 'null'],
    },
  },
  required: ['status', 'stepTitle', 'messageForUser', 'toolName', 'toolArgsJson', 'finalAnswer'],
} as const;

type TaskRunnerConfig = {
  apiKey: string;
  plannerModel: string;
  useWebSearch: boolean;
  maxSteps: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolDefinitions: ToolDefinition[];
  initialTask?: TaskSnapshot | null;
  onUpdate: (snapshot: TaskSnapshot) => void;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>;
};

export function getTaskToolDefinitions(defaultMaxSteps: number): ToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'run_task',
      description:
        'Run a bounded multi-step task for goals that require planning, research, or several tool calls.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: {
            type: 'string',
            description: 'The task goal to complete.',
          },
          maxSteps: {
            type: 'number',
            description: `Optional max number of planning steps. Defaults to ${defaultMaxSteps}.`,
          },
        },
        required: ['goal'],
      },
    },
    {
      type: 'function',
      name: 'resume_task',
      description: 'Resume the current paused task if one exists.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  ];
}

export class TaskRunner {
  private readonly config: TaskRunnerConfig;
  private activeTask: TaskSnapshot | null = null;
  private paused = false;
  private cancelled = false;

  constructor(config: TaskRunnerConfig) {
    this.config = config;
    this.activeTask = config.initialTask ?? null;
    this.paused = Boolean(this.activeTask && this.activeTask.status === 'paused');
  }

  getActiveTask() {
    return this.activeTask;
  }

  pause() {
    if (!this.activeTask || this.activeTask.status !== 'running') {
      return;
    }

    this.paused = true;
    this.activeTask = {
      ...this.activeTask,
      status: 'paused',
      lastUpdate: 'Task paused by user.',
    };
    this.config.onUpdate(this.activeTask);
  }

  cancel() {
    if (!this.activeTask) {
      return;
    }

    this.cancelled = true;
    this.activeTask = {
      ...this.activeTask,
      status: 'cancelled',
      lastUpdate: 'Task cancelled by user.',
    };
    this.config.onUpdate(this.activeTask);
  }

  async start(goal: string, requestedMaxSteps?: number) {
    const maxSteps = clampMaxSteps(requestedMaxSteps ?? this.config.maxSteps);

    this.cancelled = false;
    this.paused = false;
    this.activeTask = {
      id: crypto.randomUUID(),
      goal,
      plannerModel: this.config.plannerModel,
      status: 'running',
      currentStep: 0,
      maxSteps,
      lastUpdate: 'Task started.',
      history: [],
    };
    this.config.onUpdate(this.activeTask);

    return this.runLoop();
  }

  async resume() {
    if (!this.activeTask || this.activeTask.status !== 'paused') {
      throw new Error('No paused task is available to resume.');
    }

    this.paused = false;
    this.cancelled = false;
    this.activeTask = {
      ...this.activeTask,
      status: 'running',
      lastUpdate: 'Resuming task.',
    };
    this.config.onUpdate(this.activeTask);

    return this.runLoop();
  }

  private async runLoop(): Promise<string> {
    if (!this.activeTask) {
      throw new Error('No active task.');
    }

    try {
      while (this.activeTask.currentStep < this.activeTask.maxSteps) {
        if (this.cancelled) {
          throw new Error('Task cancelled.');
        }

        if (this.paused) {
          return 'Task paused.';
        }

        const nextStepNumber: number = this.activeTask.currentStep + 1;
        this.activeTask = {
          ...this.activeTask,
          lastUpdate: `Planning step ${nextStepNumber} of ${this.activeTask.maxSteps}...`,
        };
        this.config.onUpdate(this.activeTask);

        const decision = await planNextStep({
          apiKey: this.config.apiKey,
          model: this.config.plannerModel,
          useWebSearch: this.config.useWebSearch,
          goal: this.activeTask.goal,
          currentStep: nextStepNumber,
          maxSteps: this.activeTask.maxSteps,
          maxInputTokens: this.config.maxInputTokens,
          maxOutputTokens: this.config.maxOutputTokens,
          history: this.activeTask.history,
          toolDefinitions: this.config.toolDefinitions,
        });

        if (decision.status === 'done') {
          const finalAnswer = String(decision.finalAnswer ?? '').trim() || 'Task completed.';
          this.activeTask = {
            ...this.activeTask,
            status: 'completed',
            finalAnswer,
            lastUpdate: decision.messageForUser?.trim() || 'Task completed.',
          };
          this.config.onUpdate(this.activeTask);
          return finalAnswer;
        }

        if (decision.status === 'blocked') {
          this.activeTask = {
            ...this.activeTask,
            status: 'paused',
            lastUpdate: decision.messageForUser?.trim() || 'Task is blocked and needs guidance.',
          };
          this.config.onUpdate(this.activeTask);
          return this.activeTask.lastUpdate;
        }

        const toolName = String(decision.toolName ?? '').trim();
        const toolArgs = parseToolArgsJson(decision.toolArgsJson);

        if (!toolName) {
          this.activeTask = {
            ...this.activeTask,
            status: 'failed',
            lastUpdate: 'Planner did not provide a valid next tool.',
          };
          this.config.onUpdate(this.activeTask);
          throw new Error(this.activeTask.lastUpdate);
        }

        if (['run_task', 'resume_task', 'deep_think'].includes(toolName)) {
          this.activeTask = {
            ...this.activeTask,
            status: 'failed',
            lastUpdate: `Planner selected an invalid tool for task execution: ${toolName}.`,
          };
          this.config.onUpdate(this.activeTask);
          throw new Error(this.activeTask.lastUpdate);
        }

        const step: TaskStep = {
          index: nextStepNumber,
          title: decision.stepTitle?.trim() || `Step ${nextStepNumber}`,
          status: 'running',
          message: decision.messageForUser?.trim() || `Running ${toolName}...`,
          toolName,
        };

        this.activeTask = {
          ...this.activeTask,
          currentStep: nextStepNumber,
          lastUpdate: `${step.message} Using ${toolName}.`,
          history: [...this.activeTask.history, step],
        };
        this.config.onUpdate(this.activeTask);

        const result = await this.config.executeTool(toolName, toolArgs);
        const history: TaskStep[] = [...this.activeTask.history];
        history[history.length - 1] = {
          ...history[history.length - 1],
          status: result.ok ? 'completed' : 'failed',
          message: truncateText(result.output, 280),
        };

        this.activeTask = {
          ...this.activeTask,
          history,
          lastUpdate: history[history.length - 1].message,
          status: result.ok ? 'running' : 'paused',
        };
        this.config.onUpdate(this.activeTask);

        if (!result.ok) {
          return this.activeTask.lastUpdate;
        }
      }

      this.activeTask = {
        ...this.activeTask,
        status: 'paused',
        lastUpdate: `Reached the max step limit of ${this.activeTask.maxSteps}. Resume to continue.`,
      };
      this.config.onUpdate(this.activeTask);
      return this.activeTask.lastUpdate;
    } catch (error) {
      if (!this.activeTask || this.cancelled || this.paused || this.activeTask.status === 'cancelled') {
        throw error;
      }

      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Task planner failed unexpectedly.';

      this.activeTask = {
        ...this.activeTask,
        status: 'failed',
        lastUpdate: truncateText(message, 280),
      };
      this.config.onUpdate(this.activeTask);
      throw error;
    }
  }
}

async function planNextStep(input: {
  apiKey: string;
  model: string;
  useWebSearch: boolean;
  goal: string;
  currentStep: number;
  maxSteps: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  history: TaskStep[];
  toolDefinitions: ToolDefinition[];
}): Promise<PlannerDecision> {
  const toolList = input.toolDefinitions
    .filter((tool) => !['run_task', 'resume_task', 'deep_think'].includes(tool.name))
    .map((tool) => `${tool.name}: ${tool.description}`)
    .join('\n');

  const historyText =
    input.history.length > 0
      ? input.history
          .map((step) => `${step.index}. ${step.title} [${step.status}] ${step.message}`)
          .join('\n')
      : 'No steps completed yet.';

  const prompt = [
    `Goal: ${input.goal}`,
    `Current step: ${input.currentStep} of ${input.maxSteps}`,
    `Available tools:\n${toolList}`,
    `History:\n${historyText}`,
    'Respond with JSON only.',
    'Schema:',
    '{',
    '  "status": "continue" | "done" | "blocked",',
    '  "stepTitle": "short title",',
    '  "messageForUser": "short progress update",',
    '  "toolName": "tool to call when continuing",',
    '  "toolArgsJson": "{\\"key\\":\\"value\\"}",',
    '  "finalAnswer": "final answer when done"',
    '}',
    'Rules:',
    '- Use status="done" only when the task is complete.',
    '- Use status="blocked" when you cannot proceed safely or lack required information.',
    '- Use status="continue" with exactly one toolName when another action is needed.',
    '- When status="continue", encode tool arguments as a valid JSON object string in toolArgsJson.',
    '- Prefer the Chrome tools for browser work.',
    '- Prefer concise user-facing updates.',
  ].join('\n');
  const cappedPrompt = capTextToApproxTokens(prompt, input.maxInputTokens);

  const body: Record<string, unknown> = {
    model: input.model,
    input: cappedPrompt,
    text: {
      format: {
        type: 'json_schema',
        name: 'task_planner_decision',
        strict: true,
        schema: PLANNER_RESPONSE_SCHEMA,
      },
    },
    temperature: 0.2,
    max_output_tokens: input.maxOutputTokens,
  };

  if (input.useWebSearch) {
    body.tools = [{ type: 'web_search' }];
    body.tool_choice = 'auto';
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (attempt === 0 && response.status >= 500) {
        await delay(350);
        continue;
      }

      throw new Error(`Task planner failed: ${response.status} ${errorText}`.trim());
    }

    const payload = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const rawText = extractResponseText(payload);
    const parsed = parsePlannerDecision(rawText);

    if (parsed && ['continue', 'done', 'blocked'].includes(parsed.status)) {
      return parsed;
    }

    if (attempt === 0) {
      await delay(200);
      continue;
    }

    throw new Error(`Task planner returned invalid JSON: ${rawText}`);
  }

  throw new Error('Task planner failed after retries.');
}

function parsePlannerDecision(rawText: string): PlannerDecision | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, '').replace(/```$/i, '').trim(),
    trimmed.replace(/^```\s*/i, '').replace(/```$/i, '').trim(),
    extractJsonObject(trimmed),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      return JSON.parse(candidate) as PlannerDecision;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function parseToolArgsJson(rawValue: string | undefined): Record<string, unknown> {
  if (!rawValue?.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function extractJsonObject(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return '';
  }

  return text.slice(start, end + 1).trim();
}

function clampMaxSteps(value: number) {
  return Math.max(1, Math.min(Math.round(value), 12));
}

function truncateText(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
