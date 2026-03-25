import WebSocket, { type RawData } from 'ws';
import { executeToolCall, getToolDefinitions, type ApprovalRequest } from './tooling.js';

export type RendererEvent =
  | { type: 'session-status'; status: SessionStatus; detail?: string }
  | { type: 'assistant-transcript'; text: string; itemId?: string }
  | { type: 'user-transcript'; text: string; itemId?: string }
  | { type: 'assistant-audio'; audioBase64: string }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'tool-result'; name: string; output: string; ok: boolean }
  | { type: 'error'; message: string };

export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'stopped'
  | 'error';

type SessionConfig = {
  apiKey: string;
  model: string;
  voice: string;
  onEvent: (event: RendererEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
};

export class RealtimeSession {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly onEvent: (event: RendererEvent) => void;
  private readonly requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  private socket: WebSocket | null = null;
  private connected = false;
  private responseTranscript = '';

  constructor(config: SessionConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.voice = config.voice;
    this.onEvent = config.onEvent;
    this.requestApproval = config.requestApproval;
  }

  connect() {
    if (this.socket) {
      return;
    }

    this.onEvent({ type: 'session-status', status: 'connecting' });

    this.socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${this.model}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    this.socket.on('open', () => {
      this.connected = true;
      this.updateSession();
      this.onEvent({
        type: 'session-status',
        status: 'listening',
        detail: 'Microphone is live.',
      });
    });

    this.socket.on('message', async (buffer: RawData) => {
      const payload = JSON.parse(buffer.toString()) as Record<string, unknown>;
      await this.handleServerEvent(payload);
    });

    this.socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.onEvent({
        type: 'session-status',
        status: 'stopped',
        detail: 'Session closed.',
      });
    });

    this.socket.on('error', (error: Error) => {
      this.onEvent({
        type: 'error',
        message: error.message,
      });
      this.onEvent({
        type: 'session-status',
        status: 'error',
        detail: error.message,
      });
    });
  }

  disconnect() {
    this.socket?.close(1000, 'User stopped conversation');
    this.socket = null;
    this.connected = false;
  }

  appendInputAudio(audioBase64: string) {
    this.send({
      type: 'input_audio_buffer.append',
      audio: audioBase64,
    });
  }

  private updateSession() {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: [
          'You are Chet Bot, a voice-first desktop assistant.',
          'Keep replies concise and conversational because the user hears them aloud.',
          'You are allowed to use tools when they help.',
          'Before using any tool, briefly tell the user what you are about to do.',
          'Never imply that a machine-affecting action already happened before the tool succeeds.',
          'If the user asks for something risky or unclear, ask one brief clarifying question.',
        ].join(' '),
        audio: {
          input: {
            format: {
              type: 'audio/pcm',
            },
            turn_detection: {
              type: 'server_vad',
            },
          },
          output: {
            format: {
              type: 'audio/pcm',
            },
            voice: this.voice,
          },
        },
        tools: getToolDefinitions(),
      },
    });
  }

  private async handleServerEvent(event: Record<string, unknown>) {
    const type = String(event.type ?? '');

    switch (type) {
      case 'session.created':
      case 'session.updated':
        return;
      case 'input_audio_buffer.speech_started':
        this.onEvent({ type: 'session-status', status: 'listening', detail: 'Listening...' });
        return;
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
        this.onEvent({ type: 'session-status', status: 'thinking', detail: 'Thinking...' });
        return;
      case 'response.audio.delta': {
        const audioBase64 = String(event.delta ?? '');
        if (audioBase64) {
          this.onEvent({ type: 'assistant-audio', audioBase64 });
          this.onEvent({ type: 'session-status', status: 'speaking', detail: 'Speaking...' });
        }
        return;
      }
      case 'response.audio_transcript.delta': {
        const delta = String(event.delta ?? '');
        this.responseTranscript += delta;
        this.onEvent({
          type: 'assistant-transcript',
          text: this.responseTranscript,
          itemId: typeof event.item_id === 'string' ? event.item_id : undefined,
        });
        return;
      }
      case 'response.audio_transcript.done': {
        const transcript = String(event.transcript ?? this.responseTranscript);
        this.responseTranscript = '';
        this.onEvent({
          type: 'assistant-transcript',
          text: transcript,
          itemId: typeof event.item_id === 'string' ? event.item_id : undefined,
        });
        this.onEvent({ type: 'session-status', status: 'listening', detail: 'Listening...' });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = String(event.transcript ?? '').trim();
        if (transcript) {
          this.onEvent({
            type: 'user-transcript',
            text: transcript,
            itemId: typeof event.item_id === 'string' ? event.item_id : undefined,
          });
        }
        return;
      }
      case 'response.function_call_arguments.done': {
        await this.handleToolCall(event);
        return;
      }
      case 'error': {
        const message =
          typeof event.error === 'object' &&
          event.error !== null &&
          'message' in event.error &&
          typeof event.error.message === 'string'
            ? event.error.message
            : 'Unknown realtime error';

        this.onEvent({ type: 'error', message });
        this.onEvent({ type: 'session-status', status: 'error', detail: message });
        return;
      }
      default:
        return;
    }
  }

  private async handleToolCall(event: Record<string, unknown>) {
    const callId = String(event.call_id ?? '');
    const name = String(event.name ?? '');
    const argumentsJson = String(event.arguments ?? '{}');

    const result = await executeToolCall(
      {
        callId,
        name,
        argumentsJson,
      },
      this.requestApproval,
    );

    this.onEvent({
      type: 'tool-result',
      name,
      output: result.output,
      ok: result.ok,
    });

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result),
      },
    });

    this.send({
      type: 'response.create',
    });
  }

  private send(payload: Record<string, unknown>) {
    if (!this.socket || !this.connected) {
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }
}
