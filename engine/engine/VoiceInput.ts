/**
 * VoiceInput — player microphone capture + speech-to-text for game code.
 *
 * Core flow: `startListening()` acquires the mic and records; `stopListening()`
 * finishes the recording and resolves with the transcript. Templates reach this
 * via `engine.getVoiceInput()`, or use the one-call `engine.enablePushToTalk()`
 * preset (see PushToTalk.ts) instead of driving this class directly.
 *
 * Two interchangeable backends behind the same API:
 * - MediaRecorder → `AIService.transcribe` (game-server → Asset Forger →
 *   Eleven Labs). The normal path everywhere, including local dev: finding a
 *   game-server that can actually transcribe is `runtimeBackend.ts`'s job, not
 *   this class's, so there is no lane where recording is the wrong choice.
 * - Browser Web Speech API (`SpeechRecognition`). For browsers with no
 *   MediaRecorder, and for developers who force it with a `bmWebSpeech`
 *   localStorage flag (same opt-in pattern as `bmLocalAI` / `bmWebLLM` in
 *   AIService). It is a downgrade — a different engine, no language hint
 *   guarantee, and absent entirely in Firefox — so it is never chosen for a
 *   browser that could record instead.
 *
 * The mic stream is kept alive between listens so repeated push-to-talk doesn't
 * pay the acquisition latency; `releaseMicrophone()` (or `dispose()`) turns off
 * the browser's recording indicator. The engine calls both on `loadGame()`.
 */

import { AIService } from 'engine/AIService.js';
import type { TranscriptionResult } from 'engine/AIService.js';

export type { TranscriptionResult } from 'engine/AIService.js';

export type VoiceInputErrorCode =
  | 'unsupported'          // insecure context, no mic API, or no usable backend
  | 'permission-denied'    // the player blocked the microphone
  | 'no-microphone'        // no audio input device present
  | 'already-listening'
  | 'not-listening'
  | 'transcription-failed' // backend/network failure
  | 'unavailable'          // speech-to-text backend not configured (503)
  | 'rate-limited';        // too many transcriptions (429)

export class VoiceInputError extends Error {
  readonly code: VoiceInputErrorCode;

  constructor(code: VoiceInputErrorCode, message: string) {
    super(message);
    this.name = 'VoiceInputError';
    this.code = code;
  }
}

/**
 * Options for a single listening session.
 * All fields are required; use DEFAULT_VOICE_LISTEN_OPTIONS and spread overrides.
 */
export interface VoiceListenOptions {
  /** ISO 639-1 language hint (e.g. 'en'), or null to auto-detect. */
  language: string | null;
  /** Recording auto-stops (and still transcribes) after this many milliseconds. */
  maxDurationMs: number;
  /** Timeout for the transcription request itself, in milliseconds. */
  timeoutMs: number;
}

export const DEFAULT_VOICE_LISTEN_OPTIONS: VoiceListenOptions = {
  language: null,
  maxDurationMs: 15_000,
  timeoutMs: 30_000,
};

/**
 * A finished recording smaller than this holds only container headers — a tap that never
 * became speech. Sending one costs a round-trip and comes back either empty or as a server
 * error (in one week of production every upload of 412 bytes or less failed outright, while
 * the shortest that ever produced words was 3612 bytes), so it resolves as "nothing heard"
 * here instead. The game server enforces the same floor for games built before this check.
 */
const MIN_SPEECH_AUDIO_BYTES = 1024;

export type VoiceInputState = 'idle' | 'listening' | 'transcribing';

const WEB_SPEECH_FLAG_KEY = 'bmWebSpeech';

/** MediaRecorder container preference; first supported wins (mp4 covers Safari/iOS). */
const RECORDER_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];

/**
 * Minimal structural types for the Web Speech API — not part of TS's dom lib.
 * Only what we call is described (same approach as AIService's web-llm types).
 */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const w = globalThis as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function canUseMediaRecorder(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';
}

type Backend = 'recorder' | 'web-speech';

/**
 * Whether the backend choice has been narrated yet. The choice itself is cheap
 * enough to redo per listen, but push-to-talk calls startListening on every key
 * press, and a line per press would bury whatever the game is logging.
 */
let backendAnnounced = false;

function announceBackendOnce(log: (message: string) => void, message: string): void {
  if (backendAnnounced) return;
  backendAnnounced = true;
  log(message);
}

/** What every in-progress recording carries, whichever backend is active. */
interface SessionBase {
  options: VoiceListenOptions;
  maxDurationTimer: ReturnType<typeof setTimeout>;
}
interface RecorderSession extends SessionBase {
  backend: 'recorder';
  recorder: MediaRecorder;
  chunks: Blob[];
}
interface WebSpeechSession extends SessionBase {
  backend: 'web-speech';
  recognition: SpeechRecognitionLike;
  finalText: string;
}
/** Discriminated on `backend`, so each branch sees only its own fields. */
type ActiveSession = RecorderSession | WebSpeechSession;

export class VoiceInput {
  private aiService: AIService;
  private state: VoiceInputState = 'idle';
  private stateListeners = new Set<(state: VoiceInputState) => void>();
  private stream: MediaStream | null = null;
  private onMicrophoneReleased?: () => void;
  private session: ActiveSession | null = null;
  /** Transcription in flight after the recording ended (also what a late stopListening returns). */
  private activeResult: Promise<TranscriptionResult> | null = null;

  /**
   * @param onMicrophoneReleased  fires after releaseMicrophone() tears down a
   *   warm mic stream. The engine uses it to resume the shared AudioContext:
   *   while the stream is warm iOS holds the OS audio session in
   *   play-and-record (ducking/re-routing game output) and can park the
   *   context in its non-standard 'interrupted' state. Optional (with a no-op
   *   default) only for backward compatibility — published games carry frozen
   *   template code that may construct VoiceInput directly.
   */
  constructor(aiService: AIService, onMicrophoneReleased?: () => void) {
    this.aiService = aiService;
    this.onMicrophoneReleased = onMicrophoneReleased;
  }

  /** True when voice capture can work at all in this browser/context. */
  isSupported(): boolean {
    return canUseMediaRecorder() || getSpeechRecognitionConstructor() !== null;
  }

  isListening(): boolean {
    return this.state === 'listening';
  }

  getState(): VoiceInputState {
    return this.state;
  }

  /** Observe state changes ('idle' | 'listening' | 'transcribing') for UI. Returns unsubscribe. */
  onStateChange(callback: (state: VoiceInputState) => void): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /**
   * Request the microphone (browser prompts on first use) and start recording.
   * Rejects with a VoiceInputError ('unsupported' | 'permission-denied' |
   * 'no-microphone' | 'already-listening') on failure.
   */
  async startListening(options?: Partial<VoiceListenOptions>): Promise<void> {
    if (this.state !== 'idle') {
      throw new VoiceInputError('already-listening', 'startListening called while a session is active');
    }
    const merged: VoiceListenOptions = { ...DEFAULT_VOICE_LISTEN_OPTIONS, ...options };
    if (!this.isSupported()) {
      throw new VoiceInputError('unsupported', 'Voice input is not supported in this browser/context');
    }

    if (VoiceInput.resolveBackend() === 'web-speech') {
      this.startWebSpeechSession(merged);
    } else {
      await this.startRecorderSession(merged);
    }
    this.setState('listening');
  }

  /**
   * Stop recording and resolve with the transcript ('' when nothing was said).
   * If the recording already auto-stopped at maxDurationMs, resolves with that
   * pending transcription. Rejects with VoiceInputError ('not-listening' |
   * 'transcription-failed' | 'unavailable' | 'rate-limited').
   */
  async stopListening(): Promise<TranscriptionResult> {
    if (this.state === 'listening' && this.session) {
      return this.finishSession(this.session);
    }
    if (this.state === 'transcribing' && this.activeResult) {
      return this.activeResult;
    }
    throw new VoiceInputError('not-listening', 'stopListening called with no active session');
  }

  /** Abort the current recording without transcribing. Safe when not listening. */
  cancelListening(): void {
    const session = this.session;
    if (!session || this.state !== 'listening') return;
    this.session = null;
    clearTimeout(session.maxDurationTimer);
    if (session.backend === 'recorder') {
      session.recorder.ondataavailable = null;
      session.recorder.onstop = null;
      if (session.recorder.state !== 'inactive') session.recorder.stop();
    } else {
      session.recognition.onresult = null;
      session.recognition.onerror = null;
      session.recognition.onend = null;
      session.recognition.abort();
    }
    this.setState('idle');
  }

  /**
   * Release the mic stream (turns off the browser's recording indicator).
   * Cancels any active recording first. The stream is re-acquired on the next
   * startListening.
   */
  releaseMicrophone(): void {
    this.cancelListening();
    const hadStream = this.stream !== null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    // Only when a stream actually existed — no stream, no OS audio session
    // held in play-and-record, nothing to recover from.
    if (hadStream) this.onMicrophoneReleased?.();
  }

  dispose(): void {
    this.releaseMicrophone();
    this.stateListeners.clear();
  }

  private setState(state: VoiceInputState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  /**
   * Pick the backend: the bmWebSpeech flag forces Web Speech, a browser without
   * MediaRecorder has nothing else to use, and everything else records and lets
   * AIService.transcribe find a server that can handle it.
   */
  private static resolveBackend(): Backend {
    const hasWebSpeech = getSpeechRecognitionConstructor() !== null;
    if (hasWebSpeech && VoiceInput.readWebSpeechFlag()) {
      announceBackendOnce(console.info, '[VoiceInput] bmWebSpeech flag set; using browser speech recognition');
      return 'web-speech';
    }
    if (!canUseMediaRecorder()) {
      // isSupported() passed, so Web Speech must be available.
      announceBackendOnce(console.warn, '[VoiceInput] MediaRecorder/getUserMedia unavailable; using browser speech recognition');
      return 'web-speech';
    }
    return 'recorder';
  }

  private static readWebSpeechFlag(): boolean {
    try {
      const raw = globalThis.localStorage?.getItem(WEB_SPEECH_FLAG_KEY)?.trim();
      return raw === '1' || raw === 'true' || raw === 'on';
    } catch {
      return false;
    }
  }

  // --- MediaRecorder backend ---

  private async startRecorderSession(options: VoiceListenOptions): Promise<void> {
    if (!this.stream) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        throw VoiceInput.mapGetUserMediaError(err);
      }
      // getUserMedia awaited; a concurrent start would have thrown already-listening
      // in startListening's re-check, so the stream is ours to keep.
    }

    const mimeType = RECORDER_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start();

    const session: RecorderSession = {
      backend: 'recorder',
      options,
      recorder,
      chunks,
      maxDurationTimer: setTimeout(() => this.autoStop(session), options.maxDurationMs),
    };
    this.session = session;
  }

  private static mapGetUserMediaError(err: unknown): VoiceInputError {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return new VoiceInputError('permission-denied', 'Microphone access was blocked');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
      return new VoiceInputError('no-microphone', 'No microphone was found');
    }
    return new VoiceInputError('no-microphone', `Could not open the microphone: ${String(err)}`);
  }

  /** Stop the recorder and resolve with the collected audio blob. */
  private static collectRecording(recorder: MediaRecorder, chunks: Blob[]): Promise<Blob> {
    return new Promise((resolve) => {
      const finish = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      recorder.onstop = finish;
      if (recorder.state === 'inactive') {
        finish();
      } else {
        recorder.stop();
      }
    });
  }

  // --- Web Speech backend ---

  private startWebSpeechSession(options: VoiceListenOptions): void {
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) {
      throw new VoiceInputError('unsupported', 'Browser speech recognition is not available');
    }
    const recognition = new Ctor();
    if (options.language) recognition.lang = options.language;
    recognition.continuous = true;
    recognition.interimResults = false;

    const session: WebSpeechSession = {
      backend: 'web-speech',
      options,
      recognition,
      finalText: '',
      maxDurationTimer: setTimeout(() => this.autoStop(session), options.maxDurationMs),
    };
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal) session.finalText += result[0].transcript;
      }
    };
    recognition.start();
    this.session = session;
  }

  // --- shared finish flow ---

  /** maxDurationMs elapsed: finish the session; the transcript stays available to stopListening. */
  private autoStop(session: ActiveSession): void {
    if (this.session !== session || this.state !== 'listening') return;
    // Park the promise so a later stopListening picks it up; surface failures
    // there too — swallow here to avoid an unhandled rejection when the caller
    // stops before ever asking for the result.
    this.finishSession(session).catch(() => {});
  }

  private finishSession(session: ActiveSession): Promise<TranscriptionResult> {
    this.session = null;
    clearTimeout(session.maxDurationTimer);
    this.setState('transcribing');

    const result = (async (): Promise<TranscriptionResult> => {
      try {
        if (session.backend === 'web-speech') {
          return await VoiceInput.collectWebSpeechResult(session);
        }
        const audio = await VoiceInput.collectRecording(session.recorder, session.chunks);
        if (audio.size < MIN_SPEECH_AUDIO_BYTES) return { text: '' };
        try {
          return await this.aiService.transcribe(audio, {
            language: session.options.language ?? undefined,
            timeoutMs: session.options.timeoutMs,
          });
        } catch (err) {
          throw VoiceInput.mapTranscribeError(err);
        }
      } finally {
        this.activeResult = null;
        this.setState('idle');
      }
    })();
    this.activeResult = result;
    return result;
  }

  private static collectWebSpeechResult(session: WebSpeechSession): Promise<TranscriptionResult> {
    const { recognition } = session;
    return new Promise((resolve, reject) => {
      let errorMessage: string | null = null;
      recognition.onerror = (event) => {
        // 'no-speech' / 'aborted' just mean an empty transcript, not a failure.
        const error = event.error ?? '';
        if (error && error !== 'no-speech' && error !== 'aborted') errorMessage = error;
      };
      recognition.onend = () => {
        const text = session.finalText.trim();
        if (errorMessage && !text) {
          reject(new VoiceInputError('transcription-failed', `Speech recognition failed: ${errorMessage}`));
        } else {
          resolve({ text, language: recognition.lang || undefined });
        }
      };
      recognition.stop();
    });
  }

  /** Classify AIService.transcribe failures by the status embedded in the error message. */
  private static mapTranscribeError(err: unknown): VoiceInputError {
    if (err instanceof VoiceInputError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('(429)')) {
      return new VoiceInputError('rate-limited', 'Too many voice requests — try again in a moment');
    }
    if (message.includes('(503)')) {
      return new VoiceInputError('unavailable', 'Speech-to-text is not available right now');
    }
    return new VoiceInputError('transcription-failed', message);
  }
}
