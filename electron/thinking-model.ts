import type { ToolDefinition } from './tool-types.js';

type ThinkingConfig = {
  apiKey: string;
  model: string;
  useWebSearch: boolean;
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
  const body: Record<string, unknown> = {
    model: config.model,
    input: prompt,
    instructions: [
      'You are a high-judgment helper model supporting a realtime voice assistant.',
      'Think carefully and return only the useful final answer for the assistant to say or paraphrase.',
      'Be concise, practical, and decisive.',
      'If the task involves current information and web search is available, use it when needed.',
      'If the request is a recommendation or requires tradeoffs, give a clear recommendation and brief reasoning.',
      'Do not mention internal tool names, hidden reasoning, or implementation details.',
    ].join(' '),
  };

  if (config.useWebSearch) {
    body.tools = [
      {
        type: 'web_search',
        user_location: {
          type: 'approximate',
          country: 'US',
          timezone: 'America/Chicago',
        },
      },
    ];
    body.tool_choice = 'auto';
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Thinking model request failed: ${response.status} ${errorText}`.trim());
  }

  const payload = (await response.json()) as {
    output_text?: string;
  };

  const output = String(payload.output_text ?? '').trim();

  if (!output) {
    throw new Error('Thinking model returned no text.');
  }

  return { output };
}
