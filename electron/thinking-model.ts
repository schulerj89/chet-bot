import { extractResponseText } from './openai-response.js';
import { capTextToApproxTokens } from './token-limits.js';
import type { ToolDefinition } from './tool-types.js';

type ThinkingConfig = {
  apiKey: string;
  model: string;
  useWebSearch: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
};

type ThinkingResult = {
  output: string;
};

export function getThinkingToolDefinition(model: string): ToolDefinition {
  return {
    type: 'function',
    name: 'deep_think',
    description: `Use ${model} for slower, deeper reasoning on complex tasks, planning, recommendations, investigations, or ambiguous tool workflows.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description: 'The exact problem or question that needs deeper reasoning.',
        },
      },
      required: ['prompt'],
    },
  };
}

export async function runThinkingModel(
  prompt: string,
  config: ThinkingConfig,
): Promise<ThinkingResult> {
  const primaryBody = buildRequestBody(prompt, config, config.useWebSearch);

  try {
    return await requestWithRetries(primaryBody, config.apiKey, 2);
  } catch (error) {
    if (!config.useWebSearch) {
      throw error;
    }

    const fallbackBody = buildRequestBody(prompt, config, false);
    return requestWithRetries(fallbackBody, config.apiKey, 1);
  }
}

function buildRequestBody(prompt: string, config: ThinkingConfig, useWebSearch: boolean) {
  const cappedPrompt = capTextToApproxTokens(prompt, config.maxInputTokens);
  const body: Record<string, unknown> = {
    model: config.model,
    input: cappedPrompt,
    instructions: [
      'You are a high-judgment helper model supporting a realtime voice assistant.',
      'Think carefully and return only the useful final answer for the assistant to say or paraphrase.',
      'Be concise, practical, and decisive.',
      'If the task involves current information and web search is available, use it when needed.',
      'If the request is a recommendation or requires tradeoffs, give a clear recommendation and brief reasoning.',
      'Do not mention internal tool names, hidden reasoning, or implementation details.',
    ].join(' '),
    max_output_tokens: config.maxOutputTokens,
  };

  if (useWebSearch) {
    body.tools = [{ type: 'web_search' }];
    body.tool_choice = 'auto';
  }

  return body;
}

async function requestWithRetries(
  body: Record<string, unknown>,
  apiKey: string,
  retries: number,
): Promise<ThinkingResult> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt <= retries) {
    try {
      return await sendRequest(body, apiKey);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown thinking model error.');
      attempt += 1;

      if (attempt > retries || !isRetryableThinkingError(lastError)) {
        throw lastError;
      }

      await delay(400 * attempt);
    }
  }

  throw lastError ?? new Error('Thinking model request failed.');
}

async function sendRequest(
  body: Record<string, unknown>,
  apiKey: string,
): Promise<ThinkingResult> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Thinking model request failed: ${response.status} ${errorText}`.trim());
  }

  const payload = (await response.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };

  const output = extractResponseText(payload);

  if (!output) {
    throw new Error('Thinking model returned no text.');
  }

  return { output };
}

function isRetryableThinkingError(error: Error) {
  return (
    error.message.includes('Thinking model request failed: 500') ||
    error.message.includes('Thinking model request failed: 502') ||
    error.message.includes('Thinking model request failed: 503') ||
    error.message.includes('Thinking model request failed: 504') ||
    error.message.includes('fetch failed')
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
