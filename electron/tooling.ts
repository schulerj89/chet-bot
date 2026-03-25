import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export type ToolExecutionResult = {
  ok: boolean;
  output: string;
};

export function getToolDefinitions() {
  return [
    {
      type: 'function',
      name: 'get_time',
      description: 'Get the current local date and time for the computer.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      type: 'function',
      name: 'open_url',
      description: 'Open a URL in the user default browser after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'The absolute URL to open.' },
        },
        required: ['url'],
      },
    },
    {
      type: 'function',
      name: 'open_app',
      description: 'Launch a local application by path or known name after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: {
            type: 'string',
            description: 'Executable path or app name to open.',
          },
          args: {
            type: 'array',
            description: 'Optional arguments to pass to the app.',
            items: { type: 'string' },
          },
        },
        required: ['target'],
      },
    },
    {
      type: 'function',
      name: 'run_powershell',
      description: 'Run a PowerShell command after explicit user approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: {
            type: 'string',
            description: 'The PowerShell command to execute.',
          },
        },
        required: ['command'],
      },
    },
  ];
}

export async function executeToolCall(
  request: ToolCallRequest,
  requestApproval: (request: ApprovalRequest) => Promise<boolean>,
): Promise<ToolExecutionResult> {
  const args = safeParseArgs(request.argumentsJson);

  switch (request.name) {
    case 'get_time':
      return {
        ok: true,
        output: new Date().toString(),
      };
    case 'open_url':
      return runApprovalWrappedTool(
        request.callId,
        'open_url',
        `Open URL: ${String(args.url ?? '')}`,
        args,
        async () => {
          const url = String(args.url ?? '');

          if (!/^https?:\/\//i.test(url)) {
            throw new Error('Only http and https URLs are allowed.');
          }

          await execFileAsync('cmd.exe', ['/c', 'start', '', url], {
            windowsHide: true,
          });

          return `Opened ${url}`;
        },
        requestApproval,
      );
    case 'open_app':
      return runApprovalWrappedTool(
        request.callId,
        'open_app',
        `Launch application: ${String(args.target ?? '')}`,
        args,
        async () => {
          const target = String(args.target ?? '').trim();
          const targetArgs = Array.isArray(args.args)
            ? args.args.map((value) => String(value))
            : [];

          if (!target) {
            throw new Error('Missing target.');
          }

          await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-Command',
            'Start-Process',
            '-FilePath',
            target,
            ...(targetArgs.length > 0 ? ['-ArgumentList', targetArgs.join(' ')] : []),
          ]);

          return `Started ${target}`;
        },
        requestApproval,
      );
    case 'run_powershell':
      return runApprovalWrappedTool(
        request.callId,
        'run_powershell',
        `Run PowerShell command: ${String(args.command ?? '')}`,
        args,
        async () => {
          const command = String(args.command ?? '').trim();

          if (!command) {
            throw new Error('Missing command.');
          }

          const { stdout, stderr } = await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-Command',
            command,
          ]);

          const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
          return combined || 'Command completed with no output.';
        },
        requestApproval,
      );
    default:
      return {
        ok: false,
        output: `Unsupported tool: ${request.name}`,
      };
  }
}

async function runApprovalWrappedTool(
  callId: string,
  toolName: string,
  reason: string,
  args: Record<string, unknown>,
  action: () => Promise<string>,
  requestApproval: (request: ApprovalRequest) => Promise<boolean>,
): Promise<ToolExecutionResult> {
  const approved = await requestApproval({
    id: callId,
    toolName,
    reason,
    args,
  });

  if (!approved) {
    return {
      ok: false,
      output: 'The user denied this action.',
    };
  }

  try {
    const output = await action();
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : 'Tool execution failed.',
    };
  }
}

function safeParseArgs(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
