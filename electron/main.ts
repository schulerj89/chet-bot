import 'dotenv/config';
import { app, BrowserWindow, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealtimeSession, type RendererEvent } from './realtime-session.js';
import type { TaskSnapshot } from './task-runner.js';
import type { ApprovalRequest } from './tooling.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const isDev = Boolean(rendererUrl);

let mainWindow: BrowserWindow | null = null;
let realtimeSession: RealtimeSession | null = null;
const pendingApprovals = new Map<string, (approved: boolean) => void>();
let persistedTask: TaskSnapshot | null = null;

function getTaskStatePath() {
  return path.join(app.getPath('userData'), 'active-task.json');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 700,
    backgroundColor: '#0c1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    void mainWindow.loadURL(rendererUrl ?? 'http://127.0.0.1:5173');
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendRendererEvent(event: RendererEvent) {
  if (event.type === 'task-update') {
    persistedTask = normalizePersistedTask(event.task);
    void saveTaskState(persistedTask);
  }

  mainWindow?.webContents.send('session:event', event);
}

function getEnvConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
    voice: process.env.OPENAI_REALTIME_VOICE ?? 'alloy',
    thinkingModel: process.env.OPENAI_THINKING_MODEL ?? 'gpt-5.2',
    thinkingWebSearch: /^(1|true|yes)$/i.test(process.env.OPENAI_THINKING_USE_WEB_SEARCH ?? ''),
    thinkingMaxInputTokens: Math.max(
      100,
      Math.min(Number(process.env.OPENAI_THINKING_MAX_INPUT_TOKENS ?? '2000') || 2000, 8000),
    ),
    thinkingMaxOutputTokens: Math.max(
      100,
      Math.min(Number(process.env.OPENAI_THINKING_MAX_OUTPUT_TOKENS ?? '2000') || 2000, 8000),
    ),
    plannerMaxInputTokens: Math.max(
      100,
      Math.min(Number(process.env.OPENAI_TASK_PLANNER_MAX_INPUT_TOKENS ?? '2000') || 2000, 8000),
    ),
    plannerMaxOutputTokens: Math.max(
      100,
      Math.min(Number(process.env.OPENAI_TASK_PLANNER_MAX_OUTPUT_TOKENS ?? '2000') || 2000, 8000),
    ),
    approvalMode: /^(never|auto)$/i.test(process.env.CHET_APPROVAL_MODE ?? '') ? 'never' : 'always',
    taskMaxSteps: Math.max(1, Math.min(Number(process.env.CHET_TASK_MAX_STEPS ?? '5') || 5, 12)),
  };
}

function requestApproval(request: ApprovalRequest) {
  const config = getEnvConfig();

  if (config.approvalMode === 'never') {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(request.id, resolve);
    sendRendererEvent({ type: 'approval-request', request });
  });
}

async function loadTaskState() {
  try {
    const raw = await fs.readFile(getTaskStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as TaskSnapshot;
    persistedTask = normalizePersistedTask(parsed);
  } catch {
    persistedTask = null;
  }
}

async function saveTaskState(task: TaskSnapshot | null) {
  const taskStatePath = getTaskStatePath();

  if (!task) {
    try {
      await fs.rm(taskStatePath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    return;
  }

  await fs.mkdir(path.dirname(taskStatePath), { recursive: true });
  await fs.writeFile(taskStatePath, JSON.stringify(task, null, 2), 'utf8');
}

function normalizePersistedTask(task: TaskSnapshot | null): TaskSnapshot | null {
  if (!task) {
    return null;
  }

  if (task.status === 'running' || task.status === 'waiting_approval') {
    return {
      ...task,
      status: 'paused' as const,
      lastUpdate: 'Task was interrupted and can be resumed.',
    };
  }

  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
    return null;
  }

  return task;
}

app.whenReady().then(async () => {
  await loadTaskState();
  createMainWindow();

  ipcMain.handle('session:config', () => {
    const config = getEnvConfig();
    return {
      hasApiKey: Boolean(config.apiKey),
      model: config.model,
      voice: config.voice,
      thinkingModel: config.thinkingModel,
      thinkingWebSearch: config.thinkingWebSearch,
      thinkingMaxInputTokens: config.thinkingMaxInputTokens,
      thinkingMaxOutputTokens: config.thinkingMaxOutputTokens,
      plannerMaxInputTokens: config.plannerMaxInputTokens,
      plannerMaxOutputTokens: config.plannerMaxOutputTokens,
      approvalMode: config.approvalMode,
      taskMaxSteps: config.taskMaxSteps,
    };
  });

  ipcMain.handle('asset:image-data-url', async (_event, filePath: string) => {
    const resolvedPath = path.resolve(filePath);
    const extension = path.extname(resolvedPath).toLowerCase();

    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extension)) {
      throw new Error('Unsupported image type.');
    }

    const imageBuffer = await fs.readFile(resolvedPath);
    const mimeType =
      extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : extension === '.gif'
          ? 'image/gif'
          : extension === '.webp'
            ? 'image/webp'
            : extension === '.bmp'
              ? 'image/bmp'
              : 'image/png';

    return `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  });

  ipcMain.handle('session:start', async () => {
    const config = getEnvConfig();

    if (!config.apiKey) {
      return {
        ok: false,
        message: 'Missing OPENAI_API_KEY in .env.',
      };
    }

    realtimeSession?.disconnect();
    realtimeSession = new RealtimeSession({
      apiKey: config.apiKey,
      model: config.model,
      voice: config.voice,
      thinkingModel: config.thinkingModel,
      thinkingWebSearch: config.thinkingWebSearch,
      taskMaxSteps: config.taskMaxSteps,
      initialTask: persistedTask,
      onEvent: sendRendererEvent,
      requestApproval,
    });
    realtimeSession.connect();

    return { ok: true };
  });

  ipcMain.handle('session:stop', async () => {
    realtimeSession?.disconnect();
    realtimeSession = null;

    for (const resolve of pendingApprovals.values()) {
      resolve(false);
    }

    pendingApprovals.clear();
    sendRendererEvent({
      type: 'session-status',
      status: 'stopped',
      detail: 'Conversation stopped.',
    });
  });

  ipcMain.handle('task:get', async () => realtimeSession?.getTask() ?? persistedTask);
  ipcMain.handle('task:pause', async () => {
    realtimeSession?.pauseTask();
  });
  ipcMain.handle('task:resume', async () => {
    return realtimeSession?.resumeTask() ?? 'No task available.';
  });
  ipcMain.handle('task:cancel', async () => {
    realtimeSession?.cancelTask();
  });

  ipcMain.on('session:audio-chunk', (_event, audioBase64: string) => {
    realtimeSession?.appendInputAudio(audioBase64);
  });

  ipcMain.on(
    'session:approval-response',
    (_event, payload: { approvalId: string; approved: boolean }) => {
      const resolve = pendingApprovals.get(payload.approvalId);

      if (!resolve) {
        return;
      }

      pendingApprovals.delete(payload.approvalId);
      resolve(payload.approved);
    },
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
