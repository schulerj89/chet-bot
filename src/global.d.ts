type SessionState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'stopped' | 'error';

type ApprovalRequest = {
  id: string;
  toolName: string;
  reason: string;
  args: Record<string, unknown>;
};

type RealtimeEvent =
  | { type: 'session-status'; status: SessionState; detail?: string }
  | { type: 'assistant-transcript'; text: string; itemId?: string }
  | { type: 'user-transcript'; text: string; itemId?: string }
  | { type: 'assistant-audio'; audioBase64: string }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'tool-result'; name: string; output: string; ok: boolean }
  | { type: 'error'; message: string };

type DesktopApi = {
  startSession: () => Promise<{ ok: boolean; message?: string }>;
  stopSession: () => Promise<void>;
  sendAudioChunk: (audioBase64: string) => void;
  resolveApproval: (approvalId: string, approved: boolean) => void;
  onEvent: (callback: (event: RealtimeEvent) => void) => () => void;
  getConfig: () => Promise<{ hasApiKey: boolean; model: string; voice: string }>;
};

declare global {
  interface Window {
    chetBot: DesktopApi;
  }
}

export {};
