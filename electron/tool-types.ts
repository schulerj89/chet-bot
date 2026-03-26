export type ToolCallRequest = {
  callId: string;
  name: string;
  argumentsJson: string;
};

export type ApprovalRequest = {
  id: string;
  toolName: string;
  reason: string;
  args: Record<string, unknown>;
};

export type ToolAttachment =
  | {
      type: 'image';
      dataUrl: string;
      mimeType: string;
      path: string;
    }
  | undefined;

export type ToolExecutionResult = {
  ok: boolean;
  output: string;
  attachment?: ToolAttachment;
};

export type ToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
