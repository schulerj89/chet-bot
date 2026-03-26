type SessionState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'stopped' | 'error';

type ApprovalRequest = {
  id: string;
  toolName: string;
  reason: string;
  args: Record<string, unknown>;
};

type TaskStatus = 'idle' | 'running' | 'paused' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';

type TaskStep = {
  index: number;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message: string;
  toolName?: string;
};

type TaskSnapshot = {
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

type RealtimeEvent =
  | { type: 'session-status'; status: SessionState; detail?: string }
  | { type: 'assistant-transcript'; text: string; itemId?: string; final?: boolean }
  | { type: 'user-transcript'; text: string; itemId?: string; final?: boolean }
  | { type: 'assistant-audio'; audioBase64: string }
  | { type: 'assistant-audio-reset'; reason: 'interrupt' | 'stop' }
  | { type: 'task-update'; task: TaskSnapshot | null }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'tool-result'; name: string; output: string; ok: boolean }
  | { type: 'error'; message: string };

type DesktopApi = {
  startSession: () => Promise<{ ok: boolean; message?: string }>;
  stopSession: () => Promise<void>;
  getTask: () => Promise<TaskSnapshot | null>;
  pauseTask: () => Promise<void>;
  resumeTask: () => Promise<string>;
  cancelTask: () => Promise<void>;
  sendAudioChunk: (audioBase64: string) => void;
  resolveApproval: (approvalId: string, approved: boolean) => void;
  onEvent: (callback: (event: RealtimeEvent) => void) => () => void;
  getConfig: () => Promise<{
    hasApiKey: boolean;
    model: string;
    voice: string;
    thinkingModel: string;
    thinkingWebSearch: boolean;
    approvalMode: 'always' | 'never';
    taskMaxSteps: number;
  }>;
  getImageDataUrl: (filePath: string) => Promise<string>;
};

declare global {
  interface Window {
    chetBot: DesktopApi;
  }
}

export {};
