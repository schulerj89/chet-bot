type ResponseContentItem = {
  type?: string;
  text?: string;
  content?: ResponseContentItem[];
};

type ResponseOutputItem = {
  type?: string;
  content?: ResponseContentItem[];
};

type ResponsesApiPayload = {
  output_text?: string;
  output?: ResponseOutputItem[];
};

export function extractResponseText(payload: ResponsesApiPayload): string {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks: string[] = [];

  for (const item of payload.output ?? []) {
    if (!Array.isArray(item.content)) {
      continue;
    }

    collectText(item.content, chunks);
  }

  return chunks.join('\n').trim();
}

function collectText(items: ResponseContentItem[], chunks: string[]) {
  for (const item of items) {
    if (typeof item.text === 'string' && item.text.trim()) {
      chunks.push(item.text.trim());
    }

    if (Array.isArray(item.content)) {
      collectText(item.content, chunks);
    }
  }
}
