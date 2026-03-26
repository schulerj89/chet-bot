import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { executeChromeToolCall, getChromeToolDefinitions, isChromeToolName } from './chrome-tools.js';
import type { ApprovalRequest, ToolCallRequest, ToolDefinition, ToolExecutionResult } from './tool-types.js';

const execFileAsync = promisify(execFile);
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'chet-bot');

export type { ApprovalRequest, ToolCallRequest, ToolDefinition, ToolExecutionResult } from './tool-types.js';

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'get_time',
      description: 'Get the current local date and time for the computer.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      type: 'function',
      name: 'take_screenshot',
      description: 'Capture the current desktop and return the saved image path.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'Optional short label to include in the filename.' },
        },
      },
    },
    {
      type: 'function',
      name: 'list_windows',
      description: 'List visible top-level windows with titles and process information.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      type: 'function',
      name: 'focus_window',
      description: 'Focus a visible window by title match or process id after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Case-insensitive partial match for the window title.' },
          processId: { type: 'number', description: 'Process id for the window.' },
        },
      },
    },
    {
      type: 'function',
      name: 'mouse_click',
      description: 'Move the mouse to a coordinate and click after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number', description: 'Screen X coordinate.' },
          y: { type: 'number', description: 'Screen Y coordinate.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button to click.' },
          double: { type: 'boolean', description: 'Whether to perform a double click.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      type: 'function',
      name: 'type_text',
      description: 'Type text into the currently focused window after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'The exact text to type.' },
        },
        required: ['text'],
      },
    },
    {
      type: 'function',
      name: 'read_file',
      description: 'Read a UTF-8 text file from disk.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Absolute or project-relative file path.' },
        },
        required: ['path'],
      },
    },
    {
      type: 'function',
      name: 'write_file',
      description: 'Write UTF-8 text to a file after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Absolute or project-relative file path.' },
          content: { type: 'string', description: 'The full file contents to write.' },
        },
        required: ['path', 'content'],
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
          target: { type: 'string', description: 'Executable path or app name to open.' },
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
          command: { type: 'string', description: 'The PowerShell command to execute.' },
        },
        required: ['command'],
      },
    },
    {
      type: 'function',
      name: 'run_codex',
      description:
        'Run the local Codex CLI for codebase analysis or code changes after explicit user approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'The instructions to give Codex.' },
          cwd: { type: 'string', description: 'Optional working directory. Defaults to the current project root.' },
        },
        required: ['prompt'],
      },
    },
    ...getChromeToolDefinitions(),
  ];
}

export async function executeToolCall(
  request: ToolCallRequest,
  requestApproval: (request: ApprovalRequest) => Promise<boolean>,
): Promise<ToolExecutionResult> {
  const args = safeParseArgs(request.argumentsJson);

  if (isChromeToolName(request.name)) {
    return executeChromeToolCall(request, args, requestApproval);
  }

  switch (request.name) {
    case 'get_time':
      return { ok: true, output: new Date().toString() };
    case 'take_screenshot':
      return runTool(async () => {
        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        const label = sanitizeLabel(String(args.label ?? 'desktop'));
        const filePath = path.join(SCREENSHOT_DIR, `${Date.now()}-${label}.png`);

        await runPowerShellScript(buildScreenshotScript(filePath));
        const imageBuffer = await fs.readFile(filePath);

        return {
          output: `Saved screenshot to ${filePath}`,
          attachment: {
            type: 'image',
            dataUrl: `data:image/png;base64,${imageBuffer.toString('base64')}`,
            mimeType: 'image/png',
            path: filePath,
          },
        };
      });
    case 'list_windows':
      return runTool(async () => {
        const { stdout } = await runPowerShellScript(buildListWindowsScript());
        return stdout.trim() || 'No visible windows found.';
      });
    case 'focus_window':
      return runApprovalWrappedTool(
        request.callId,
        'focus_window',
        `Focus window title=${String(args.title ?? '')} processId=${String(args.processId ?? '')}`,
        args,
        async () => {
          const title = String(args.title ?? '').trim();
          const processId = coerceInteger(args.processId);
          if (!title && processId === null) {
            throw new Error('Provide either title or processId.');
          }

          const { stdout } = await runPowerShellScript(buildFocusWindowScript(title, processId));
          return stdout.trim() || 'Window focused.';
        },
        requestApproval,
      );
    case 'mouse_click':
      return runApprovalWrappedTool(
        request.callId,
        'mouse_click',
        `Click mouse at (${String(args.x ?? '')}, ${String(args.y ?? '')})`,
        args,
        async () => {
          const x = coerceInteger(args.x);
          const y = coerceInteger(args.y);
          const button = String(args.button ?? 'left').toLowerCase();
          const isDouble = Boolean(args.double);

          if (x === null || y === null) {
            throw new Error('x and y must be numbers.');
          }
          if (!['left', 'right', 'middle'].includes(button)) {
            throw new Error('button must be left, right, or middle.');
          }

          const { stdout } = await runPowerShellScript(buildMouseClickScript(x, y, button, isDouble));
          return stdout.trim() || `Clicked ${button} mouse button at ${x}, ${y}.`;
        },
        requestApproval,
      );
    case 'type_text':
      return runApprovalWrappedTool(
        request.callId,
        'type_text',
        `Type text: ${truncateForReason(String(args.text ?? ''))}`,
        args,
        async () => {
          const text = String(args.text ?? '');
          if (!text) {
            throw new Error('Missing text.');
          }

          const { stdout } = await runPowerShellScript(buildTypeTextScript(text));
          return stdout.trim() || `Typed ${text.length} characters.`;
        },
        requestApproval,
      );
    case 'read_file':
      return runTool(async () => {
        const filePath = resolveUserPath(String(args.path ?? ''));
        if (!filePath) {
          throw new Error('Missing path.');
        }

        const content = await fs.readFile(filePath, 'utf8');
        return content.length > 12_000 ? `${content.slice(0, 12_000)}\n\n[truncated]` : content;
      });
    case 'write_file':
      return runApprovalWrappedTool(
        request.callId,
        'write_file',
        `Write file: ${String(args.path ?? '')}`,
        args,
        async () => {
          const filePath = resolveUserPath(String(args.path ?? ''));
          const content = String(args.content ?? '');
          if (!filePath) {
            throw new Error('Missing path.');
          }

          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, 'utf8');
          return `Wrote ${content.length} characters to ${filePath}`;
        },
        requestApproval,
      );
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

          await execFileAsync('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
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
          const targetArgs = Array.isArray(args.args) ? args.args.map((value) => String(value)) : [];
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

          const { stdout, stderr } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command]);
          const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
          return combined || 'Command completed with no output.';
        },
        requestApproval,
      );
    case 'run_codex':
      return runApprovalWrappedTool(
        request.callId,
        'run_codex',
        `Run Codex: ${truncateForReason(String(args.prompt ?? ''))}`,
        args,
        async () => {
          const prompt = String(args.prompt ?? '').trim();
          const cwd = resolveToolWorkingDirectory(String(args.cwd ?? ''));
          if (!prompt) {
            throw new Error('Missing prompt.');
          }

          const { stdout, stderr } = await execFileAsync(
            'cmd.exe',
            [
              '/d',
              '/s',
              '/c',
              'codex.cmd',
              'exec',
              '--dangerously-bypass-approvals-and-sandbox',
              '--skip-git-repo-check',
              '--cd',
              cwd,
              prompt,
            ],
            { windowsHide: true, cwd, maxBuffer: 1024 * 1024 * 10 },
          );

          const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
          return combined || 'Codex completed with no output.';
        },
        requestApproval,
      );
    default:
      return { ok: false, output: `Unsupported tool: ${request.name}` };
  }
}

async function runTool(
  action: () => Promise<string | { output: string; attachment?: ToolExecutionResult['attachment'] }>,
): Promise<ToolExecutionResult> {
  try {
    const result = await action();
    return typeof result === 'string'
      ? { ok: true, output: result }
      : { ok: true, output: result.output, attachment: result.attachment };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : 'Tool execution failed.' };
  }
}

async function runApprovalWrappedTool(
  callId: string,
  toolName: string,
  reason: string,
  args: Record<string, unknown>,
  action: () => Promise<string | { output: string; attachment?: ToolExecutionResult['attachment'] }>,
  requestApproval: (request: ApprovalRequest) => Promise<boolean>,
): Promise<ToolExecutionResult> {
  const approved = await requestApproval({ id: callId, toolName, reason, args });
  if (!approved) {
    return { ok: false, output: 'The user denied this action.' };
  }
  return runTool(action);
}

async function runPowerShellScript(script: string) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10,
  });
}

function resolveUserPath(inputPath: string) {
  const trimmed = inputPath.trim();
  return trimmed ? (path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed)) : '';
}

function resolveToolWorkingDirectory(inputPath: string) {
  const trimmed = inputPath.trim();
  return trimmed ? (path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed)) : process.cwd();
}

function sanitizeLabel(label: string) {
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'desktop';
}

function coerceInteger(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return null;
}

function truncateForReason(input: string) {
  return input.length > 120 ? `${input.slice(0, 117)}...` : input;
}

function safeParseArgs(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function psSingleQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildScreenshotScript(filePath: string) {
  const escapedPath = psSingleQuote(filePath);
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
$bitmap.Save(${escapedPath}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output ${escapedPath}
`.trim();
}

function buildListWindowsScript() {
  return `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$results = New-Object System.Collections.Generic.List[object]
[Win32]::EnumWindows({
  param($hWnd, $lParam)
  if (-not [Win32]::IsWindowVisible($hWnd)) { return $true }
  $length = [Win32]::GetWindowTextLength($hWnd)
  if ($length -le 0) { return $true }
  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [void][Win32]::GetWindowText($hWnd, $builder, $builder.Capacity)
  $title = $builder.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $pid = 0
  [void][Win32]::GetWindowThreadProcessId($hWnd, [ref]$pid)
  $processName = ''
  try { $processName = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch {}
  $results.Add([pscustomobject]@{
    title = $title
    processId = $pid
    processName = $processName
    handle = $hWnd.ToInt64()
  })
  return $true
}, [IntPtr]::Zero) | Out-Null
$results | ConvertTo-Json -Depth 3
`.trim();
}

function buildFocusWindowScript(title: string, processId: number | null) {
  const titleFilter = psSingleQuote(title.toLowerCase());
  const pidValue = processId ?? -1;

  return `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$target = [IntPtr]::Zero
[Win32]::EnumWindows({
  param($hWnd, $lParam)
  if (-not [Win32]::IsWindowVisible($hWnd)) { return $true }
  $length = [Win32]::GetWindowTextLength($hWnd)
  if ($length -le 0) { return $true }
  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [void][Win32]::GetWindowText($hWnd, $builder, $builder.Capacity)
  $windowTitle = $builder.ToString()
  $pid = 0
  [void][Win32]::GetWindowThreadProcessId($hWnd, [ref]$pid)
  $matchesTitle = ${title ? `$windowTitle.ToLower().Contains(${titleFilter})` : '$false'}
  $matchesPid = ${processId !== null ? `$pid -eq ${pidValue}` : '$false'}
  if ($matchesTitle -or $matchesPid) {
    $script:target = $hWnd
    return $false
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($target -eq [IntPtr]::Zero) { throw 'No matching window found.' }
[void][Win32]::ShowWindowAsync($target, 5)
if (-not [Win32]::SetForegroundWindow($target)) { throw 'Unable to focus the window.' }
Write-Output 'Window focused.'
`.trim();
}

function buildMouseClickScript(x: number, y: number, button: string, isDouble: boolean) {
  const eventMap: Record<string, { down: string; up: string }> = {
    left: { down: '0x0002', up: '0x0004' },
    right: { down: '0x0008', up: '0x0010' },
    middle: { down: '0x0020', up: '0x0040' },
  };
  const events = eventMap[button];
  const clickSequence = isDouble
    ? `[Win32]::mouse_event(${events.down}, 0, 0, 0, [UIntPtr]::Zero); [Win32]::mouse_event(${events.up}, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [Win32]::mouse_event(${events.down}, 0, 0, 0, [UIntPtr]::Zero); [Win32]::mouse_event(${events.up}, 0, 0, 0, [UIntPtr]::Zero);`
    : `[Win32]::mouse_event(${events.down}, 0, 0, 0, [UIntPtr]::Zero); [Win32]::mouse_event(${events.up}, 0, 0, 0, [UIntPtr]::Zero);`;

  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
if (-not [Win32]::SetCursorPos(${x}, ${y})) { throw 'Unable to move cursor.' }
Start-Sleep -Milliseconds 40
${clickSequence}
Write-Output 'Mouse click sent.'
`.trim();
}

function buildTypeTextScript(text: string) {
  const escapedText = psSingleQuote(text);
  return `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${escapedText})
Write-Output 'Text typed.'
`.trim();
}
