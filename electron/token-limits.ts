const DEFAULT_TOKEN_LIMIT = 2000;
const MIN_TOKEN_LIMIT = 100;
const MAX_TOKEN_LIMIT = 8000;
const APPROX_CHARS_PER_TOKEN = 4;

export function resolveTokenLimit(value: string | undefined, fallback = DEFAULT_TOKEN_LIMIT) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(MIN_TOKEN_LIMIT, Math.min(Math.round(parsed), MAX_TOKEN_LIMIT));
}

export function capTextToApproxTokens(text: string, maxTokens: number) {
  const trimmed = text.trim();

  if (!trimmed) {
    return trimmed;
  }

  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxChars - 32)).trim()}\n\n[truncated for token limit]`;
}
