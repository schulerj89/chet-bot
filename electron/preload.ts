import { contextBridge, ipcRenderer } from 'electron';
import type { RendererEvent } from './realtime-session.js';

type DesktopApi = {
  startSession: () => Promise<{ ok: boolean; message?: string }>;
  stopSession: () => Promise<void>;
  sendAudioChunk: (audioBase64: string) => void;
  resolveApproval: (approvalId: string, approved: boolean) => void;
  onEvent: (callback: (event: RendererEvent) => void) => () => void;
  getConfig: () => Promise<{
    hasApiKey: boolean;
    model: string;
    voice: string;
    thinkingModel: string;
    thinkingWebSearch: boolean;
  }>;
  getImageDataUrl: (filePath: string) => Promise<string>;
};

const api: DesktopApi = {
  startSession: () => ipcRenderer.invoke('session:start'),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  sendAudioChunk: (audioBase64) => {
    ipcRenderer.send('session:audio-chunk', audioBase64);
  },
  resolveApproval: (approvalId, approved) => {
    ipcRenderer.send('session:approval-response', { approvalId, approved });
  },
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RendererEvent) => {
      callback(payload);
    };

    ipcRenderer.on('session:event', listener);
    return () => ipcRenderer.removeListener('session:event', listener);
  },
  getConfig: () => ipcRenderer.invoke('session:config'),
  getImageDataUrl: (filePath) => ipcRenderer.invoke('asset:image-data-url', filePath),
};

contextBridge.exposeInMainWorld('chetBot', api);

declare global {
  interface Window {
    chetBot: DesktopApi;
  }
}
