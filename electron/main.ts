import 'dotenv/config';
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealtimeSession, type RendererEvent } from './realtime-session.js';
import type { ApprovalRequest } from './tooling.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const isDev = Boolean(rendererUrl);

let mainWindow: BrowserWindow | null = null;
let realtimeSession: RealtimeSession | null = null;
const pendingApprovals = new Map<string, (approved: boolean) => void>();

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
  mainWindow?.webContents.send('session:event', event);
}

function getEnvConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
    voice: process.env.OPENAI_REALTIME_VOICE ?? 'alloy',
  };
}

function requestApproval(request: ApprovalRequest) {
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(request.id, resolve);
    sendRendererEvent({ type: 'approval-request', request });
  });
}

app.whenReady().then(() => {
  createMainWindow();

  ipcMain.handle('session:config', () => {
    const config = getEnvConfig();
    return {
      hasApiKey: Boolean(config.apiKey),
      model: config.model,
      voice: config.voice,
    };
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
