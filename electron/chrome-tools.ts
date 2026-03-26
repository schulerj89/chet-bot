import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type { ApprovalRequest, ToolCallRequest, ToolDefinition, ToolExecutionResult } from './tool-types.js';

const execFileAsync = promisify(execFile);
const CHROME_DEBUG_PORT = 9222;
const CHROME_DEBUG_PROFILE_DIR = path.join(os.tmpdir(), 'chet-bot-chrome-debug');

type ChromeTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

const CHROME_TOOL_NAMES = new Set([
  'launch_chrome_debug',
  'chrome_new_tab',
  'chrome_close_tab',
  'chrome_list_tabs',
  'chrome_get_page',
  'chrome_navigate',
  'chrome_click',
  'chrome_type',
  'chrome_eval',
  'chrome_screenshot',
  'chrome_wait_for_selector',
]);

export function getChromeToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'launch_chrome_debug',
      description:
        'Launch Google Chrome with the DevTools remote debugging port enabled using a separate profile.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'Optional URL to open immediately.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
      },
    },
    {
      type: 'function',
      name: 'chrome_list_tabs',
      description: 'List Chrome tabs available over the DevTools remote debugging port.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
      },
    },
    {
      type: 'function',
      name: 'chrome_new_tab',
      description: 'Create a new Chrome tab over the DevTools remote debugging port after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'Optional URL to open in the new tab.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
      },
    },
    {
      type: 'function',
      name: 'chrome_close_tab',
      description: 'Close a Chrome tab over the DevTools remote debugging port after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: { type: 'string', description: 'Exact Chrome target id from chrome_list_tabs.' },
          titleContains: { type: 'string', description: 'Case-insensitive title match used to pick a tab.' },
          urlContains: { type: 'string', description: 'Case-insensitive URL match used to pick a tab.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
      },
    },
    {
      type: 'function',
      name: 'chrome_get_page',
      description:
        'Get basic structured information from a Chrome tab, including title, URL, and visible text snippet.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: { type: 'string', description: 'Exact Chrome target id from chrome_list_tabs.' },
          titleContains: { type: 'string', description: 'Case-insensitive title match used to pick a tab.' },
          urlContains: { type: 'string', description: 'Case-insensitive URL match used to pick a tab.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
      },
    },
    {
      type: 'function',
      name: 'chrome_navigate',
      description: 'Navigate a Chrome tab to a URL through the DevTools Protocol after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'Absolute URL to open in the selected tab.' },
          targetId: { type: 'string', description: 'Exact Chrome target id from chrome_list_tabs.' },
          titleContains: { type: 'string', description: 'Case-insensitive title match used to pick a tab.' },
          urlContains: { type: 'string', description: 'Case-insensitive URL match used to pick a tab.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
        required: ['url'],
      },
    },
    {
      type: 'function',
      name: 'chrome_click',
      description:
        'Click a DOM element in a Chrome tab using a CSS selector through the DevTools Protocol after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: { type: 'string', description: 'CSS selector for the target element.' },
          targetId: { type: 'string', description: 'Exact Chrome target id from chrome_list_tabs.' },
          titleContains: { type: 'string', description: 'Case-insensitive title match used to pick a tab.' },
          urlContains: { type: 'string', description: 'Case-insensitive URL match used to pick a tab.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
        required: ['selector'],
      },
    },
    {
      type: 'function',
      name: 'chrome_type',
      description:
        'Fill a form field in a Chrome tab using a CSS selector through the DevTools Protocol after approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector for the target input, textarea, or contenteditable element.',
          },
          text: { type: 'string', description: 'Text to place into the field.' },
          submit: { type: 'boolean', description: 'Whether to submit the nearest form after typing.' },
          targetId: { type: 'string', description: 'Exact Chrome target id from chrome_list_tabs.' },
          titleContains: { type: 'string', description: 'Case-insensitive title match used to pick a tab.' },
          urlContains: { type: 'string', description: 'Case-insensitive URL match used to pick a tab.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
        required: ['selector', 'text'],
      },
    },
    {
      type: 'function',
      name: 'chrome_eval',
      description:
        'Evaluate JavaScript in a Chrome tab through the DevTools Protocol. Use carefully and prefer the structured Chrome tools first.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate.' },
          targetId: { type: 'string', description: 'Exact Chrome target id from chrome_list_tabs.' },
          titleContains: { type: 'string', description: 'Case-insensitive title match used to pick a tab.' },
          urlContains: { type: 'string', description: 'Case-insensitive URL match used to pick a tab.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
        required: ['expression'],
      },
    },
    {
      type: 'function',
      name: 'chrome_screenshot',
      description: 'Capture a screenshot of a Chrome tab through the DevTools Protocol.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetId: { type: 'string', description: 'Exact Chrome target id from chrome_list_tabs.' },
          titleContains: { type: 'string', description: 'Case-insensitive title match used to pick a tab.' },
          urlContains: { type: 'string', description: 'Case-insensitive URL match used to pick a tab.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
          format: { type: 'string', enum: ['png', 'jpeg'], description: 'Screenshot format.' },
        },
      },
    },
    {
      type: 'function',
      name: 'chrome_wait_for_selector',
      description: 'Wait for a CSS selector to appear in a Chrome tab through the DevTools Protocol.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for.' },
          timeoutMs: { type: 'number', description: 'Maximum time to wait in milliseconds. Defaults to 10000.' },
          targetId: { type: 'string', description: 'Exact Chrome target id from chrome_list_tabs.' },
          titleContains: { type: 'string', description: 'Case-insensitive title match used to pick a tab.' },
          urlContains: { type: 'string', description: 'Case-insensitive URL match used to pick a tab.' },
          port: { type: 'number', description: 'Optional remote debugging port. Defaults to 9222.' },
        },
        required: ['selector'],
      },
    },
  ];
}

export function isChromeToolName(name: string) {
  return CHROME_TOOL_NAMES.has(name);
}

export async function executeChromeToolCall(
  request: ToolCallRequest,
  args: Record<string, unknown>,
  requestApproval: (request: ApprovalRequest) => Promise<boolean>,
): Promise<ToolExecutionResult> {
  switch (request.name) {
    case 'launch_chrome_debug':
      return runApprovalWrappedTool(
        request.callId,
        'launch_chrome_debug',
        `Launch Chrome with remote debugging on port ${String(args.port ?? CHROME_DEBUG_PORT)}`,
        args,
        async () => {
          const port = resolveChromeDebugPort(args.port);
          const url = String(args.url ?? '').trim();
          const chromePath = await findChromeExecutable();

          await fs.mkdir(CHROME_DEBUG_PROFILE_DIR, { recursive: true });
          await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-Command',
            'Start-Process',
            '-FilePath',
            chromePath,
            '-ArgumentList',
            [
              `--remote-debugging-port=${port}`,
              `--user-data-dir=${quoteArgument(CHROME_DEBUG_PROFILE_DIR)}`,
              ...(url ? [quoteArgument(url)] : []),
            ].join(' '),
          ]);

          return `Chrome launched with remote debugging on port ${port}.`;
        },
        requestApproval,
      );
    case 'chrome_new_tab':
      return runApprovalWrappedTool(
        request.callId,
        'chrome_new_tab',
        `Open new Chrome tab ${String(args.url ?? '') || '(blank tab)'}`,
        args,
        async () => {
          const port = resolveChromeDebugPort(args.port);
          const rawUrl = String(args.url ?? '').trim();
          const url = rawUrl ? normalizeChromeUrl(rawUrl) : '';
          const endpoint = `http://127.0.0.1:${port}/json/new${url ? `?${encodeURIComponent(url)}` : ''}`;
          const target = await fetchJson<ChromeTarget>(endpoint);
          return JSON.stringify({ id: target.id, title: target.title, url: target.url }, null, 2);
        },
        requestApproval,
      );
    case 'chrome_close_tab':
      return runApprovalWrappedTool(
        request.callId,
        'chrome_close_tab',
        `Close Chrome tab ${String(args.targetId ?? args.titleContains ?? args.urlContains ?? '')}`,
        args,
        async () => {
          const port = resolveChromeDebugPort(args.port);
          const target = await resolveChromeTarget(args);
          const result = await fetchJson<{ success?: boolean }>(
            `http://127.0.0.1:${port}/json/close/${encodeURIComponent(target.id)}`,
          );
          if (!result.success) {
            throw new Error(`Chrome did not confirm closing tab ${target.id}.`);
          }
          return `Closed Chrome tab ${target.id} (${target.title || target.url}).`;
        },
        requestApproval,
      );
    case 'chrome_list_tabs':
      return runTool(async () => {
        const port = resolveChromeDebugPort(args.port);
        const targets = await listChromeTargets(port);
        const pageTargets = targets
          .filter((target) => target.type === 'page')
          .map((target) => ({ id: target.id, title: target.title, url: target.url }));

        return pageTargets.length > 0
          ? JSON.stringify(pageTargets, null, 2)
          : `No Chrome page tabs found on debugging port ${port}.`;
      });
    case 'chrome_get_page':
      return runTool(async () => {
        const page = await withChromePage(args, async (target) => {
          const result = await sendChromeCommand(target, 'Runtime.evaluate', {
            expression: `(() => ({
              title: document.title,
              url: location.href,
              readyState: document.readyState,
              textSnippet: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 2000)
            }))()`,
            returnByValue: true,
          });
          return result.result?.value;
        });

        return JSON.stringify(page, null, 2);
      });
    case 'chrome_navigate':
      return runApprovalWrappedTool(
        request.callId,
        'chrome_navigate',
        `Navigate Chrome to ${String(args.url ?? '')}`,
        args,
        async () => {
          const url = String(args.url ?? '').trim();

          if (!/^https?:\/\//i.test(url)) {
            throw new Error('Only http and https URLs are allowed.');
          }

          await withChromePage(args, async (target) => {
            await sendChromeCommand(target, 'Page.navigate', { url });
            return null;
          });

          return `Navigated Chrome tab to ${url}`;
        },
        requestApproval,
      );
    case 'chrome_click':
      return runApprovalWrappedTool(
        request.callId,
        'chrome_click',
        `Click Chrome element ${String(args.selector ?? '')}`,
        args,
        async () => {
          const selector = String(args.selector ?? '').trim();

          if (!selector) {
            throw new Error('Missing selector.');
          }

          const result = await withChromePage(args, async (target) => {
            const response = await sendChromeCommand(target, 'Runtime.evaluate', {
              expression: buildChromeClickExpression(selector),
              returnByValue: true,
            });
            return response.result?.value;
          });

          return typeof result === 'string' ? result : JSON.stringify(result);
        },
        requestApproval,
      );
    case 'chrome_type':
      return runApprovalWrappedTool(
        request.callId,
        'chrome_type',
        `Type into Chrome element ${String(args.selector ?? '')}`,
        args,
        async () => {
          const selector = String(args.selector ?? '').trim();
          const text = String(args.text ?? '');
          const submit = Boolean(args.submit);

          if (!selector) {
            throw new Error('Missing selector.');
          }

          const result = await withChromePage(args, async (target) => {
            const response = await sendChromeCommand(target, 'Runtime.evaluate', {
              expression: buildChromeTypeExpression(selector, text, submit),
              returnByValue: true,
            });
            return response.result?.value;
          });

          return typeof result === 'string' ? result : JSON.stringify(result);
        },
        requestApproval,
      );
    case 'chrome_eval':
      return runApprovalWrappedTool(
        request.callId,
        'chrome_eval',
        `Evaluate JavaScript in Chrome: ${truncateForReason(String(args.expression ?? ''))}`,
        args,
        async () => {
          const expression = String(args.expression ?? '').trim();

          if (!expression) {
            throw new Error('Missing expression.');
          }

          const result = await withChromePage(args, async (target) => {
            const response = await sendChromeCommand(target, 'Runtime.evaluate', {
              expression,
              awaitPromise: true,
              returnByValue: true,
            });

            if (response.exceptionDetails) {
              const description =
                response.result?.description ?? response.exceptionDetails.text ?? 'JavaScript evaluation failed.';
              throw new Error(description);
            }

            return response.result?.value ?? response.result?.description ?? null;
          });

          return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        },
        requestApproval,
      );
    case 'chrome_screenshot':
      return runTool(async () => {
        const format = String(args.format ?? 'png').toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
        const target = await resolveChromeTarget(args);
        await sendChromeCommand(target, 'Page.enable', {});
        const result = await sendChromeCommand(target, 'Page.captureScreenshot', {
          format,
          fromSurface: true,
        });

        const base64 = String(result.data ?? '');
        if (!base64) {
          throw new Error('Chrome returned an empty screenshot.');
        }

        return {
          output: `Captured Chrome tab screenshot for ${target.title || target.url}`,
          attachment: {
            type: 'image',
            dataUrl: `data:image/${format};base64,${base64}`,
            mimeType: `image/${format}`,
            path: `${target.url || target.id}#chrome-screenshot`,
          },
        };
      });
    case 'chrome_wait_for_selector':
      return runTool(async () => {
        const selector = String(args.selector ?? '').trim();
        const timeoutMs = resolveTimeoutMs(args.timeoutMs);

        if (!selector) {
          throw new Error('Missing selector.');
        }

        const target = await resolveChromeTarget(args);
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
          const response = await sendChromeCommand(target, 'Runtime.evaluate', {
            expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
            returnByValue: true,
          });

          if (response.result?.value === true) {
            return `Selector ${selector} is present in Chrome tab ${target.id}.`;
          }

          await delay(250);
        }

        throw new Error(`Timed out after ${timeoutMs}ms waiting for selector ${selector}.`);
      });
    default:
      return {
        ok: false,
        output: `Unsupported Chrome tool: ${request.name}`,
      };
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
    return {
      ok: false,
      output: error instanceof Error ? error.message : 'Chrome tool execution failed.',
    };
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

function resolveChromeDebugPort(value: unknown) {
  const port = coerceInteger(value);
  return port === null || port < 1 || port > 65535 ? CHROME_DEBUG_PORT : port;
}

function resolveTimeoutMs(value: unknown) {
  const timeout = coerceInteger(value);
  return timeout === null || timeout < 250 ? 10_000 : timeout;
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

function normalizeChromeUrl(value: string) {
  if (!value) {
    return '';
  }

  if (/^[a-z]+:\/\//i.test(value)) {
    return value;
  }

  return `https://${value}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const targetUrl = new URL(url);
  const client = targetUrl.protocol === 'https:' ? https : http;

  return new Promise<T>((resolve, reject) => {
    const request = client.get(targetUrl, { headers: { Accept: 'application/json' } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${String(response.statusCode ?? 'error')} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('error', (error) => reject(error));
  });
}

async function listChromeTargets(port: number) {
  try {
    return await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${port}/json/list`);
  } catch {
    throw new Error(`Unable to reach Chrome on debugging port ${port}. Launch Chrome with launch_chrome_debug first.`);
  }
}

async function resolveChromeTarget(args: Record<string, unknown>) {
  const port = resolveChromeDebugPort(args.port);
  const targetId = String(args.targetId ?? '').trim();
  const titleContains = String(args.titleContains ?? '').trim().toLowerCase();
  const urlContains = String(args.urlContains ?? '').trim().toLowerCase();
  const targets = (await listChromeTargets(port)).filter((target) => target.type === 'page');

  const match =
    targets.find((target) => targetId && target.id === targetId) ??
    targets.find((target) => titleContains && target.title.toLowerCase().includes(titleContains)) ??
    targets.find((target) => urlContains && target.url.toLowerCase().includes(urlContains)) ??
    targets[0];

  if (!match) {
    throw new Error(`No Chrome page tabs found on debugging port ${port}.`);
  }
  if (!match.webSocketDebuggerUrl) {
    throw new Error(`Chrome target ${match.id} does not expose a debugger websocket.`);
  }

  return match;
}

async function withChromePage<T>(args: Record<string, unknown>, action: (target: ChromeTarget) => Promise<T>) {
  const target = await resolveChromeTarget(args);
  return action(target);
}

async function sendChromeCommand(
  target: ChromeTarget,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, any>> {
  const websocketUrl = target.webSocketDebuggerUrl;
  if (!websocketUrl) {
    throw new Error(`Chrome target ${target.id} does not expose a debugger websocket.`);
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    let settled = false;

    const cleanup = () => {
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    };

    socket.on('open', () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });

    socket.on('message', (data) => {
      const payload = JSON.parse(data.toString()) as Record<string, any>;
      if (payload.id !== 1 || settled) {
        return;
      }

      settled = true;
      cleanup();

      if (payload.error) {
        reject(new Error(String(payload.error.message ?? `CDP command failed: ${method}`)));
        return;
      }

      resolve(payload.result ?? {});
    });

    socket.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    socket.on('close', () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`Chrome debugger connection closed while running ${method}.`));
    });
  });
}

async function findChromeExecutable() {
  const candidates = [
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    process.env['PROGRAMFILES(X86)']
      ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  try {
    const { stdout } = await execFileAsync('where.exe', ['chrome.exe'], { windowsHide: true });
    const match = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (match) {
      return match;
    }
  } catch {
    // Fall through to final error.
  }

  throw new Error('Google Chrome executable not found.');
}

function quoteArgument(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildChromeClickExpression(selector: string) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) {
      throw new Error('No element matched selector: ${selector.replace(/'/g, "\\'")}');
    }
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof element.click === 'function') {
      element.click();
    }
    return { ok: true, selector: ${JSON.stringify(selector)}, tagName: element.tagName, text: (element.textContent || '').trim().slice(0, 200) };
  })()`;
}

function buildChromeTypeExpression(selector: string, text: string, submit: boolean) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) {
      throw new Error('No element matched selector: ${selector.replace(/'/g, "\\'")}');
    }
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = ${JSON.stringify(text)};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = ${JSON.stringify(text)};
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      throw new Error('Target element is not typable.');
    }
    if (${submit ? 'true' : 'false'}) {
      const form = element.closest('form');
      if (form) {
        form.requestSubmit ? form.requestSubmit() : form.submit();
      }
    }
    return { ok: true, selector: ${JSON.stringify(selector)}, typedLength: ${text.length}, submitted: ${submit ? 'true' : 'false'} };
  })()`;
}
