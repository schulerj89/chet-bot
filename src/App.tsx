import { useEffect, useMemo, useRef, useState } from 'react';

type SessionState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'stopped' | 'error';

type TranscriptEntry = {
  id: string;
  order: number;
  kind: 'speech' | 'tool' | 'system';
  speaker: 'user' | 'assistant' | 'system';
  text: string;
  final: boolean;
  toolName?: string;
  status?: 'pending' | 'success' | 'error' | 'approved' | 'denied';
  imageSrc?: string;
  imagePath?: string;
};

type ApprovalRequest = {
  id: string;
  toolName: string;
  reason: string;
  args: Record<string, unknown>;
};

type RealtimeEvent =
  | { type: 'session-status'; status: SessionState; detail?: string }
  | { type: 'assistant-transcript'; text: string; itemId?: string; final?: boolean }
  | { type: 'user-transcript'; text: string; itemId?: string; final?: boolean }
  | { type: 'assistant-audio'; audioBase64: string }
  | { type: 'assistant-audio-reset'; reason: 'interrupt' | 'stop' }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'tool-result'; name: string; output: string; ok: boolean }
  | { type: 'error'; message: string };

function App() {
  const bridge = window.chetBot;
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [statusDetail, setStatusDetail] = useState('Ready.');
  const [isActive, setIsActive] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [config, setConfig] = useState({
    hasApiKey: false,
    model: 'gpt-realtime',
    voice: 'alloy',
  });
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [entries, setEntries] = useState<TranscriptEntry[]>([
    {
      id: 'system-intro',
      order: 0,
      kind: 'system',
      speaker: 'system',
      text: 'Press Start Conversation once to open the voice session. Press Stop Conversation to end it.',
      final: true,
    },
  ]);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const playerRef = useRef<PcmAudioPlayer | null>(null);
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const entryOrderRef = useRef(1);

  useEffect(() => {
    if (!bridge) {
      setBridgeError('Electron bridge not found. Open the app window, not the raw Vite page in a browser.');
      return;
    }

    const detach = bridge.onEvent((event: RealtimeEvent) => {
      handleRealtimeEvent(event);
    });

    void bridge.getConfig().then(setConfig).catch((error: unknown) => {
      setBridgeError(error instanceof Error ? error.message : 'Unable to load desktop config.');
    });

    try {
      playerRef.current = new PcmAudioPlayer();
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : 'Unable to initialize audio output.');
    }

    return () => {
      detach();
      void recorderRef.current?.stop();
      playerRef.current?.dispose();
    };
  }, [bridge]);

  useEffect(() => {
    const transcriptList = transcriptListRef.current;

    if (!transcriptList) {
      return;
    }

    transcriptList.scrollTop = transcriptList.scrollHeight;
  }, [entries]);

  const statusLabel = useMemo(() => {
    switch (sessionState) {
      case 'connecting':
        return 'Connecting';
      case 'listening':
        return 'Listening';
      case 'thinking':
        return 'Thinking';
      case 'speaking':
        return 'Speaking';
      case 'error':
        return 'Error';
      case 'stopped':
      case 'idle':
      default:
        return 'Idle';
    }
  }, [sessionState]);

  async function toggleSession() {
    if (!bridge) {
      setBridgeError('Electron bridge not found. Restart the desktop app from Electron.');
      return;
    }

    if (isActive) {
      await stopConversation();
      return;
    }

    setSessionState('connecting');
    setStatusDetail('Opening realtime voice session...');

    const response = await bridge.startSession();

    if (!response.ok) {
      setSessionState('error');
      setStatusDetail(response.message ?? 'Unable to start session.');
      return;
    }

    try {
      const recorder = new AudioRecorder((audioBase64, level) => {
        setAudioLevel(level);
        bridge.sendAudioChunk(audioBase64);
      });

      await recorder.start();
      recorderRef.current = recorder;
      setIsActive(true);
    } catch (error) {
      await bridge.stopSession();
      setSessionState('error');
      setStatusDetail(
        error instanceof Error ? error.message : 'Unable to access the microphone.',
      );
    }
  }

  async function stopConversation() {
    if (!bridge) {
      return;
    }

    setIsActive(false);
    setApproval(null);
    await recorderRef.current?.stop();
    recorderRef.current = null;
    setAudioLevel(0);
    playerRef.current?.flush();
    await bridge.stopSession();
    setSessionState('stopped');
    setStatusDetail('Conversation stopped.');
  }

  function handleRealtimeEvent(event: RealtimeEvent) {
    switch (event.type) {
      case 'session-status':
        setSessionState(event.status);
        setStatusDetail(event.detail ?? '');
        return;
      case 'assistant-transcript':
        upsertTranscript(
          event.itemId ?? `assistant-live`,
          'assistant',
          event.text,
          event.final ?? false,
        );
        return;
      case 'user-transcript':
        upsertTranscript(event.itemId ?? `user-live`, 'user', event.text, event.final ?? true);
        return;
      case 'assistant-audio':
        void playerRef.current?.appendBase64(event.audioBase64);
        return;
      case 'assistant-audio-reset':
        playerRef.current?.flush();
        return;
      case 'approval-request':
        appendToolEntry(
          event.request.toolName,
          event.request.reason,
          'pending',
          `approval-${event.request.id}`,
        );
        setApproval(event.request);
        return;
      case 'tool-result':
        void appendToolEntry(
          event.name,
          event.output,
          event.ok ? 'success' : 'error',
          `result-${event.name}-${crypto.randomUUID()}`,
        );
        return;
      case 'error':
        setSessionState('error');
        setStatusDetail(event.message);
        appendSystemMessage(`Error: ${event.message}`);
        return;
      default:
        return;
    }
  }

  function appendSystemMessage(text: string) {
    const nextEntry: TranscriptEntry = {
      id: crypto.randomUUID(),
      order: entryOrderRef.current++,
      kind: 'system',
      speaker: 'system',
      text,
      final: true,
    };

    setEntries((current) => [
      ...current,
      nextEntry,
    ].sort((left, right) => left.order - right.order));
  }

  async function appendToolEntry(
    toolName: string,
    text: string,
    status: TranscriptEntry['status'],
    id?: string,
  ) {
    const screenshotPath =
      toolName === 'take_screenshot' && status === 'success' ? extractScreenshotPath(text) : null;
    let imageSrc: string | undefined;

    if (screenshotPath && bridge) {
      try {
        imageSrc = await bridge.getImageDataUrl(screenshotPath);
      } catch {
        imageSrc = undefined;
      }
    }

    const nextEntry: TranscriptEntry = {
      id: id ?? crypto.randomUUID(),
      order: entryOrderRef.current++,
      kind: 'tool',
      speaker: 'system',
      text,
      final: true,
      toolName,
      status,
      imageSrc,
      imagePath: screenshotPath ?? undefined,
    };

    setEntries((current) => [...current, nextEntry].sort((left, right) => left.order - right.order));
  }

  function upsertTranscript(
    id: string,
    speaker: TranscriptEntry['speaker'],
    text: string,
    isFinal: boolean,
  ) {
    if (!text.trim()) {
      return;
    }

    setEntries((current) => {
      const index = current.findIndex((entry) => entry.id === id);

      if (index === -1) {
        const nextEntry: TranscriptEntry = {
          id,
          order: entryOrderRef.current++,
          kind: 'speech',
          speaker,
          text,
          final: isFinal,
        };

        return [...current, nextEntry].sort((left, right) => left.order - right.order);
      }

      const next = [...current];
      next[index] = { ...next[index], text, final: isFinal || next[index].final };
      return next.sort((left, right) => left.order - right.order);
    });
  }

  function resolveApproval(approved: boolean) {
    if (!approval) {
      return;
    }

    bridge?.resolveApproval(approval.id, approved);
    void appendToolEntry(
      approval.toolName,
      approval.reason,
      approved ? 'approved' : 'denied',
      `approval-resolution-${approval.id}`,
    );
    setApproval(null);
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">Voice Desktop Agent</p>
        <h1>Chet Bot</h1>
        <p className="lede">
          One button. Live voice conversation. Local tool calls only after approval.
        </p>

        <div className="status-row">
          <div className={`status-pill status-${sessionState}`}>{statusLabel}</div>
          <span>{statusDetail}</span>
        </div>

        {bridgeError ? <div className="bridge-alert">{bridgeError}</div> : null}

        <div className={`voice-orb voice-orb-${sessionState}`}>
          <div className="voice-orb-core">
            <span />
          </div>
          <div className="voice-meters" aria-hidden="true">
            {Array.from({ length: 5 }).map((_, index) => {
              const active = audioLevel > index * 0.12;
              return (
                <i
                  key={index}
                  className={active && sessionState === 'listening' ? 'meter-active' : ''}
                />
              );
            })}
          </div>
        </div>

        <button
          className={`talk-button ${isActive ? 'active' : ''}`}
          onClick={toggleSession}
          disabled={!bridge}
        >
          {isActive ? 'Stop Conversation' : 'Start Conversation'}
        </button>

        <div className="config-grid">
          <div>
            <span className="meta-label">Model</span>
            <strong>{config.model}</strong>
          </div>
          <div>
            <span className="meta-label">Voice</span>
            <strong>{config.voice}</strong>
          </div>
          <div>
            <span className="meta-label">API Key</span>
            <strong>{config.hasApiKey ? 'Loaded' : 'Missing'}</strong>
          </div>
        </div>
      </section>

      <section className="transcript-panel">
        <div className="panel-header">
          <h2>Conversation</h2>
          <p>Live transcript and tool activity</p>
        </div>

        <div className="transcript-list" ref={transcriptListRef}>
          {entries.map((entry) => (
            <article
              key={entry.id}
              className={`entry entry-${entry.speaker} entry-kind-${entry.kind} ${
                entry.status ? `entry-status-${entry.status}` : ''
              }`}
            >
              <div className="entry-header">
                <span className="entry-speaker">
                  {entry.kind === 'tool' ? entry.toolName ?? 'tool' : entry.speaker}
                </span>
                {entry.kind === 'tool' && entry.status ? (
                  <span className={`entry-badge entry-badge-${entry.status}`}>{entry.status}</span>
                ) : null}
              </div>
              <p>{entry.text}</p>
              {entry.imageSrc ? (
                <figure className="entry-image">
                  <img src={entry.imageSrc} alt={entry.imagePath ?? 'tool preview'} />
                </figure>
              ) : null}
              {!entry.final ? <span className="entry-live">live</span> : null}
            </article>
          ))}
        </div>
      </section>

      {approval ? (
        <section className="approval-modal">
          <div className="approval-card">
            <p className="eyebrow">Approval Required</p>
            <h2>{approval.toolName}</h2>
            <p>{approval.reason}</p>
            <pre>{JSON.stringify(approval.args, null, 2)}</pre>
            <div className="approval-actions">
              <button className="secondary-button" onClick={() => resolveApproval(false)}>
                Deny
              </button>
              <button className="primary-button" onClick={() => resolveApproval(true)}>
                Approve
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function extractScreenshotPath(text: string) {
  const match = text.match(/Saved screenshot to (.+)$/);
  return match ? match[1].trim() : null;
}

class AudioRecorder {
  private readonly onChunk: (audioBase64: string, level: number) => void;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor(onChunk: (audioBase64: string, level: number) => void) {
    this.onChunk = onChunk;
  }

  async start() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: 48_000 });
    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(input, this.audioContext?.sampleRate ?? 48_000, 24_000);
      const audioBase64 = encodePcm16ToBase64(downsampled);
      this.onChunk(audioBase64, getAudioLevel(input));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  async stop() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());

    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }

    this.processor = null;
    this.source = null;
    this.mediaStream = null;
    this.audioContext = null;
  }
}

function getAudioLevel(buffer: Float32Array) {
  let peak = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    peak = Math.max(peak, Math.abs(buffer[index]));
  }

  return Math.min(1, peak * 2.4);
}

class PcmAudioPlayer {
  private audioContext = new AudioContext({ sampleRate: 24_000 });
  private nextStartTime = 0;
  private generation = 0;
  private activeSources = new Set<AudioBufferSourceNode>();

  async appendBase64(audioBase64: string) {
    const generation = this.generation;
    const pcm16 = decodeBase64ToPcm16(audioBase64);
    const float32 = new Float32Array(pcm16.length);

    for (let index = 0; index < pcm16.length; index += 1) {
      float32[index] = pcm16[index] / 0x7fff;
    }

    const buffer = this.audioContext.createBuffer(1, float32.length, 24_000);
    buffer.copyToChannel(float32, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      source.disconnect();
    };

    const startAt = Math.max(this.audioContext.currentTime, this.nextStartTime);
    if (generation !== this.generation) {
      this.activeSources.delete(source);
      source.disconnect();
      return;
    }

    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  flush() {
    this.generation += 1;
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Source may already be finished; stopping the rest is what matters.
      }
      source.disconnect();
    }
    this.activeSources.clear();
    this.nextStartTime = this.audioContext.currentTime;
  }

  dispose() {
    this.flush();
    void this.audioContext.close();
  }
}

function downsampleBuffer(
  buffer: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
) {
  if (outputSampleRate === inputSampleRate) {
    return buffer;
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accum += buffer[index];
      count += 1;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function encodePcm16ToBase64(float32: Float32Array) {
  const pcm = new Int16Array(float32.length);

  for (let index = 0; index < float32.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return window.btoa(binary);
}

function decodeBase64ToPcm16(audioBase64: string) {
  const binary = window.atob(audioBase64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Int16Array(bytes.buffer);
}

export default App;
