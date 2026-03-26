import crypto from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { executeToolCall, getToolDefinitions, type ApprovalRequest } from './tooling.js';
import { getTaskToolDefinitions, TaskRunner, type TaskSnapshot } from './task-runner.js';

export type RendererEvent =
  | { type: 'session-status'; status: SessionStatus; detail?: string }
  | { type: 'assistant-transcript'; text: string; itemId?: string; final?: boolean }
  | { type: 'user-transcript'; text: string; itemId?: string; final?: boolean }
  | { type: 'assistant-audio'; audioBase64: string }
  | { type: 'assistant-audio-reset'; reason: 'interrupt' | 'stop' }
  | { type: 'task-update'; task: TaskSnapshot | null }
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
  thinkingModel: string;
  thinkingWebSearch: boolean;
  taskMaxSteps: number;
  onEvent: (event: RendererEvent) => void;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
};

export class RealtimeSession {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly thinkingModel: string;
  private readonly thinkingWebSearch: boolean;
  private readonly taskMaxSteps: number;
  private readonly onEvent: (event: RendererEvent) => void;
  private readonly requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  private readonly taskRunner: TaskRunner;
  private socket: WebSocket | null = null;
  private connected = false;
  private responseTranscript = '';
  private activeAssistantItemId: string | undefined;

  constructor(config: SessionConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.voice = config.voice;
    this.thinkingModel = config.thinkingModel;
    this.thinkingWebSearch = config.thinkingWebSearch;
    this.taskMaxSteps = config.taskMaxSteps;
    this.onEvent = config.onEvent;
    this.requestApproval = config.requestApproval;
    this.taskRunner = new TaskRunner({
      apiKey: this.apiKey,
      plannerModel: this.thinkingModel,
      useWebSearch: this.thinkingWebSearch,
      maxSteps: this.taskMaxSteps,
      toolDefinitions: getToolDefinitions(),
      onUpdate: (task) => {
        this.onEvent({ type: 'task-update', task });
      },
      executeTool: async (name, args) =>
        executeToolCall(
          {
            callId: crypto.randomUUID(),
            name,
            argumentsJson: JSON.stringify(args),
          },
          this.requestApproval,
        ),
    });
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
      this.onEvent({ type: 'task-update', task: this.taskRunner.getActiveTask() });
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
    this.emitAssistantAudioReset('stop');
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

  pauseTask() {
    this.taskRunner.pause();
  }

  cancelTask() {
    this.taskRunner.cancel();
    this.onEvent({ type: 'task-update', task: this.taskRunner.getActiveTask() });
  }

  async resumeTask() {
    return this.taskRunner.resume();
  }

  getTask() {
    return this.taskRunner.getActiveTask();
  }

  private updateSession() {
    this.send({
      type: 'session.update',
      session: {
        instructions: [
          'You are Chet Bot, a voice-first desktop assistant with a confident, relaxed, slightly witty personality.',
          'Sound natural, sharp, and human. Be warm and engaging without sounding cheesy, theatrical, or overexcited.',
          'Keep replies concise because the user hears them aloud, but do not sound clipped or robotic.',
          'Use light personality, occasional dry humor, and clear opinions when helpful, but stay practical and grounded.',
          'When the user asks for help, take initiative and sound capable.',
          'If the task is simple, answer directly. If the task is bigger, guide the user step by step without overexplaining.',
          'You are allowed to use tools when they help.',
          `For deeper reasoning, difficult recommendations, current-info research, or multi-step planning, use the deep_think tool backed by ${this.thinkingModel}.`,
          `For larger autonomous goals that need several tool calls, use run_task with up to ${this.taskMaxSteps} steps.`,
          'For codebase work in this project, prefer the run_codex tool instead of generic shell commands.',
          'For browser work in Google Chrome, prefer the Chrome DevTools tools over mouse clicks whenever possible.',
          'Before using deep_think or run_task, tell the user briefly that you need a second to think.',
          'Before using any tool, briefly tell the user what you are about to do in one short conversational line.',
          'Never imply that a machine-affecting action already happened before the tool succeeds.',
          'For actions that change the machine, files, settings, apps, or commands, wait for approval flow and do not pressure the user.',
          'If the user asks for something risky, unclear, or impossible, say so plainly and ask one brief clarifying question when needed.',
        ].join(' '),
        voice: this.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'gpt-4o-mini-transcribe',
        },
        turn_detection: {
          type: 'server_vad',
          create_response: true,
          interrupt_response: true,
        },
        tools: [...getToolDefinitions(), ...getTaskToolDefinitions(this.taskMaxSteps)],
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
        this.finalizeAssistantTranscript();
        this.emitAssistantAudioReset('interrupt');
        this.onEvent({ type: 'session-status', status: 'listening', detail: 'Listening...' });
        return;
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
        this.onEvent({ type: 'session-status', status: 'thinking', detail: 'Thinking...' });
        return;
      case 'response.audio.delta':
      case 'response.output_audio.delta': {
        const audioBase64 = String(event.delta ?? '');
        if (audioBase64) {
          this.activeAssistantItemId =
            typeof event.item_id === 'string' ? event.item_id : this.activeAssistantItemId;
          this.onEvent({ type: 'assistant-audio', audioBase64 });
          this.onEvent({ type: 'session-status', status: 'speaking', detail: 'Speaking...' });
        }
        return;
      }
      case 'response.audio.done':
      case 'response.output_audio.done':
      case 'response.done':
        this.onEvent({ type: 'session-status', status: 'listening', detail: 'Listening...' });
        return;
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta': {
        const delta = String(event.delta ?? '');
        this.activeAssistantItemId =
          typeof event.item_id === 'string' ? event.item_id : this.activeAssistantItemId;
        this.responseTranscript += delta;
        this.onEvent({
          type: 'assistant-transcript',
          text: this.responseTranscript,
          itemId: typeof event.item_id === 'string' ? event.item_id : undefined,
          final: false,
        });
        return;
      }
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done': {
        const transcript = String(event.transcript ?? this.responseTranscript);
        this.onEvent({
          type: 'assistant-transcript',
          text: transcript,
          itemId: typeof event.item_id === 'string' ? event.item_id : undefined,
          final: true,
        });
        this.responseTranscript = '';
        this.activeAssistantItemId = undefined;
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
            final: true,
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
    const parsedArgs = safeParseArgs(argumentsJson);

    if (name === 'run_task') {
      this.onEvent({
        type: 'session-status',
        status: 'thinking',
        detail: `Working through a ${this.taskMaxSteps}-step task...`,
      });
      const goal = String(parsedArgs.goal ?? '').trim();
      const maxSteps =
        typeof parsedArgs.maxSteps === 'number' && Number.isFinite(parsedArgs.maxSteps)
          ? parsedArgs.maxSteps
          : undefined;
      const output = await this.taskRunner.start(goal, maxSteps);
      this.sendToolResult(callId, name, { ok: true, output });
      return;
    }

    if (name === 'resume_task') {
      this.onEvent({
        type: 'session-status',
        status: 'thinking',
        detail: 'Resuming task...',
      });
      const output = await this.taskRunner.resume();
      this.sendToolResult(callId, name, { ok: true, output });
      return;
    }

    if (name === 'deep_think') {
      this.onEvent({
        type: 'session-status',
        status: 'thinking',
        detail: `Thinking deeply with ${this.thinkingModel}...`,
      });
    }

    const result = await executeToolCall(
      {
        callId,
        name,
        argumentsJson,
      },
      this.requestApproval,
    );

    this.sendToolResult(callId, name, result);
  }

  private sendToolResult(callId: string, name: string, result: Awaited<ReturnType<typeof executeToolCall>>) {
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

    if (result.ok && result.attachment?.type === 'image') {
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Screenshot captured from ${result.attachment.path}. Analyze the attached image.`,
            },
            {
              type: 'input_image',
              image_url: result.attachment.dataUrl,
            },
          ],
        },
      });
    }

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

  private emitAssistantAudioReset(reason: 'interrupt' | 'stop') {
    this.onEvent({ type: 'assistant-audio-reset', reason });
  }

  private finalizeAssistantTranscript() {
    if (!this.responseTranscript.trim()) {
      return;
    }

    this.onEvent({
      type: 'assistant-transcript',
      text: this.responseTranscript,
      itemId: this.activeAssistantItemId,
      final: true,
    });
    this.responseTranscript = '';
    this.activeAssistantItemId = undefined;
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
