import { VoiceInput, VoiceInputError, DEFAULT_VOICE_LISTEN_OPTIONS } from 'engine/VoiceInput.js';
import { PushToTalk } from 'engine/PushToTalk.js';
import type { AIService, TranscriptionResult } from 'engine/AIService.js';
import type { PlayerControllerLike } from 'types/game.js';

/**
 * Branch tests for the voice-input state machine and backend selection. The
 * browser APIs (getUserMedia, MediaRecorder, SpeechRecognition) are faked on
 * globalThis per test; AIService.transcribe is a stub.
 */

type GlobalPatch = Record<string, unknown>;
/** Pre-patch value of every global a test has touched, keyed by name. */
const originals = new Map<string, unknown>();

function patchGlobals(patch: GlobalPatch): void {
    for (const [key, value] of Object.entries(patch)) {
        if (!originals.has(key)) originals.set(key, (globalThis as GlobalPatch)[key]);
        (globalThis as GlobalPatch)[key] = value;
    }
}

afterEach(() => {
    for (const [key, value] of originals) {
        (globalThis as GlobalPatch)[key] = value;
    }
    originals.clear();
    jest.useRealTimers();
});

// A real recording is kilobytes; VoiceInput discards anything smaller than a container
// header's worth as "nothing heard", so the fake has to emit a plausible size.
const RECORDED_BYTES = 8192;

class FakeMediaRecorder {
    static instances: FakeMediaRecorder[] = [];
    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    /** Byte length of the blob `stop()` emits. Tests override it to simulate a silent tap. */
    emitBytes = RECORDED_BYTES;

    constructor(_stream: unknown, options?: { mimeType?: string }) {
        this.mimeType = options?.mimeType ?? 'audio/webm';
        FakeMediaRecorder.instances.push(this);
    }

    static isTypeSupported(type: string): boolean {
        return type === 'audio/webm;codecs=opus';
    }

    start(): void {
        this.state = 'recording';
    }

    stop(): void {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array(this.emitBytes)], { type: 'audio/webm' }) });
        this.onstop?.();
    }
}

class FakeSpeechRecognition {
    static instances: FakeSpeechRecognition[] = [];
    lang = '';
    continuous = false;
    interimResults = false;
    started = false;
    onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;

    constructor() {
        FakeSpeechRecognition.instances.push(this);
    }

    start(): void {
        this.started = true;
    }

    stop(): void {
        this.onend?.();
    }

    abort(): void {
        this.onend?.();
    }
}

type FakeTrack = { stop: jest.Mock };

function installRecorderEnvironment(options?: { getUserMedia?: jest.Mock; tracks?: FakeTrack[] }): {
    getUserMedia: jest.Mock;
    tracks: FakeTrack[];
} {
    const tracks = options?.tracks ?? [{ stop: jest.fn() }];
    const getUserMedia = options?.getUserMedia
        ?? jest.fn().mockResolvedValue({ getTracks: () => tracks });
    FakeMediaRecorder.instances = [];
    patchGlobals({
        navigator: { mediaDevices: { getUserMedia } },
        MediaRecorder: FakeMediaRecorder,
        SpeechRecognition: undefined,
        webkitSpeechRecognition: undefined,
        localStorage: undefined,
    });
    return { getUserMedia, tracks };
}

function makeAIService(transcribe: jest.Mock): AIService {
    return { transcribe } as unknown as AIService;
}

describe('VoiceInput', () => {
    it('reports unsupported and rejects startListening when no mic API exists', async () => {
        patchGlobals({
            navigator: {},
            MediaRecorder: undefined,
            SpeechRecognition: undefined,
            webkitSpeechRecognition: undefined,
        });
        const voice = new VoiceInput(makeAIService(jest.fn()));
        expect(voice.isSupported()).toBe(false);
        await expect(voice.startListening()).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('maps a blocked mic to permission-denied', async () => {
        installRecorderEnvironment({
            getUserMedia: jest.fn().mockRejectedValue(new DOMException('nope', 'NotAllowedError')),
        });
        const voice = new VoiceInput(makeAIService(jest.fn()));
        await expect(voice.startListening()).rejects.toMatchObject({ code: 'permission-denied' });
        expect(voice.getState()).toBe('idle');
    });

    it('maps a missing input device to no-microphone', async () => {
        installRecorderEnvironment({
            getUserMedia: jest.fn().mockRejectedValue(new DOMException('none', 'NotFoundError')),
        });
        const voice = new VoiceInput(makeAIService(jest.fn()));
        await expect(voice.startListening()).rejects.toMatchObject({ code: 'no-microphone' });
    });

    it('records and transcribes on the happy path, notifying state listeners', async () => {
        installRecorderEnvironment();
        const transcribe = jest.fn().mockResolvedValue({ text: 'open the gate', language: 'en' });
        const voice = new VoiceInput(makeAIService(transcribe));
        const states: string[] = [];
        voice.onStateChange((state) => states.push(state));

        await voice.startListening({ language: 'en' });
        expect(voice.isListening()).toBe(true);

        const result = await voice.stopListening();
        expect(result.text).toBe('open the gate');
        expect(states).toEqual(['listening', 'transcribing', 'idle']);

        const [blob, options] = transcribe.mock.calls[0];
        expect((blob as Blob).size).toBeGreaterThan(0);
        expect(options).toMatchObject({ language: 'en', timeoutMs: DEFAULT_VOICE_LISTEN_OPTIONS.timeoutMs });
    });

    it('rejects a second startListening while active', async () => {
        installRecorderEnvironment();
        const voice = new VoiceInput(makeAIService(jest.fn().mockResolvedValue({ text: '' })));
        await voice.startListening();
        await expect(voice.startListening()).rejects.toMatchObject({ code: 'already-listening' });
        voice.cancelListening();
    });

    it('rejects stopListening with no active session', async () => {
        installRecorderEnvironment();
        const voice = new VoiceInput(makeAIService(jest.fn()));
        await expect(voice.stopListening()).rejects.toMatchObject({ code: 'not-listening' });
    });

    it('auto-stops at maxDurationMs and hands the pending transcript to a later stopListening', async () => {
        installRecorderEnvironment();
        let resolveTranscription: (result: TranscriptionResult) => void = () => {};
        const transcribe = jest.fn().mockReturnValue(
            new Promise<TranscriptionResult>((resolve) => { resolveTranscription = resolve; }),
        );
        const voice = new VoiceInput(makeAIService(transcribe));

        jest.useFakeTimers();
        await voice.startListening({ maxDurationMs: 1000 });
        jest.advanceTimersByTime(1001);
        // Let the finish flow reach the transcription await.
        await Promise.resolve();
        await Promise.resolve();
        expect(voice.getState()).toBe('transcribing');

        const pending = voice.stopListening();
        resolveTranscription({ text: 'made it anyway' });
        await expect(pending).resolves.toMatchObject({ text: 'made it anyway' });
        expect(voice.getState()).toBe('idle');
    });

    it('cancelListening discards the recording without transcribing', async () => {
        installRecorderEnvironment();
        const transcribe = jest.fn();
        const voice = new VoiceInput(makeAIService(transcribe));
        await voice.startListening();
        voice.cancelListening();
        expect(voice.getState()).toBe('idle');
        expect(transcribe).not.toHaveBeenCalled();
    });

    it('releaseMicrophone stops the stream tracks and the next start re-acquires', async () => {
        const { getUserMedia, tracks } = installRecorderEnvironment();
        const voice = new VoiceInput(makeAIService(jest.fn().mockResolvedValue({ text: '' })));
        await voice.startListening();
        voice.cancelListening();
        voice.releaseMicrophone();
        expect(tracks[0].stop).toHaveBeenCalled();

        await voice.startListening();
        expect(getUserMedia).toHaveBeenCalledTimes(2);
        voice.cancelListening();
    });

    it('classifies a 429 transcription failure as rate-limited', async () => {
        installRecorderEnvironment();
        const transcribe = jest.fn().mockRejectedValue(new Error('Transcription failed (429): too much'));
        const voice = new VoiceInput(makeAIService(transcribe));
        await voice.startListening();
        await expect(voice.stopListening()).rejects.toMatchObject({ code: 'rate-limited' });
    });

    it('classifies a 503 transcription failure as unavailable', async () => {
        installRecorderEnvironment();
        const transcribe = jest.fn().mockRejectedValue(new Error('Transcription failed (503): no backend'));
        const voice = new VoiceInput(makeAIService(transcribe));
        await voice.startListening();
        await expect(voice.stopListening()).rejects.toMatchObject({ code: 'unavailable' });
    });

    it('bmWebSpeech flag routes to the browser speech backend instead of the recorder', async () => {
        FakeSpeechRecognition.instances = [];
        patchGlobals({
            navigator: { mediaDevices: { getUserMedia: jest.fn() } },
            MediaRecorder: FakeMediaRecorder,
            SpeechRecognition: FakeSpeechRecognition,
            webkitSpeechRecognition: undefined,
            localStorage: { getItem: (key: string) => (key === 'bmWebSpeech' ? '1' : null) },
        });
        const transcribe = jest.fn();
        const voice = new VoiceInput(makeAIService(transcribe));

        await voice.startListening();
        const recognition = FakeSpeechRecognition.instances[0];
        expect(recognition.started).toBe(true);

        recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'talk to me' } }] });
        const result = await voice.stopListening();
        expect(result.text).toBe('talk to me');
        expect(transcribe).not.toHaveBeenCalled();
    });

    // A tap that opens and closes the mic leaves only container headers, which the
    // speech-to-text backend cannot transcribe — see MIN_SPEECH_AUDIO_BYTES.
    it.each([0, 5, 110, 412, 1023])('resolves a %i-byte recording as nothing heard, without a request', async (bytes) => {
        installRecorderEnvironment();
        const transcribe = jest.fn().mockResolvedValue({ text: 'should never be reached' });
        const voice = new VoiceInput(makeAIService(transcribe));

        await voice.startListening();
        FakeMediaRecorder.instances[0].emitBytes = bytes;

        await expect(voice.stopListening()).resolves.toEqual({ text: '' });
        expect(transcribe).not.toHaveBeenCalled();
    });

    it('still transcribes a recording long enough to hold speech', async () => {
        installRecorderEnvironment();
        const transcribe = jest.fn().mockResolvedValue({ text: 'hello' });
        const voice = new VoiceInput(makeAIService(transcribe));

        await voice.startListening();
        // 3612 bytes is the smallest upload that produced a real transcript in production.
        FakeMediaRecorder.instances[0].emitBytes = 3612;

        await expect(voice.stopListening()).resolves.toMatchObject({ text: 'hello' });
        expect(transcribe).toHaveBeenCalled();
    });

    it('records rather than asking a game-server whether it can transcribe', async () => {
        // This class used to probe /health itself and downgrade to browser speech
        // recognition when the local game-server could not transcribe. Finding a
        // server that can is runtimeBackend.ts's job now (reached through
        // AIService.transcribe), so a browser that can record always records —
        // including in Firefox, which has no SpeechRecognition to downgrade to.
        installRecorderEnvironment();
        FakeSpeechRecognition.instances = [];
        const fetchMock = jest.fn();
        patchGlobals({ SpeechRecognition: FakeSpeechRecognition, fetch: fetchMock });

        const transcribe = jest.fn().mockResolvedValue({ text: 'recorded' });
        const voice = new VoiceInput(makeAIService(transcribe));

        await voice.startListening();
        await expect(voice.stopListening()).resolves.toMatchObject({ text: 'recorded' });

        expect(FakeSpeechRecognition.instances).toHaveLength(0);
        expect(transcribe).toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('PushToTalk', () => {
    interface FakeController {
        registerCustomAction: jest.Mock;
        keys: Record<string, boolean>;
    }

    function makeController(): FakeController {
        return { registerCustomAction: jest.fn(), keys: {} };
    }

    interface FakeVoice {
        state: string;
        startListening: jest.Mock;
        stopListening: jest.Mock;
        cancelListening: jest.Mock;
        isSupported: () => boolean;
        isListening: () => boolean;
        getState: () => string;
        onStateChange: () => () => void;
    }

    function makeVoice(): FakeVoice {
        const voice: FakeVoice = {
            state: 'idle',
            startListening: jest.fn().mockImplementation(async () => { voice.state = 'listening'; }),
            stopListening: jest.fn().mockImplementation(async () => {
                voice.state = 'idle';
                return { text: ' fetch the sword ' };
            }),
            cancelListening: jest.fn().mockImplementation(() => { voice.state = 'idle'; }),
            isSupported: () => true,
            isListening: () => voice.state === 'listening',
            getState: () => voice.state,
            onStateChange: () => () => {},
        };
        return voice;
    }

    function setup(nowRef: { value: number }): { pushToTalk: PushToTalk; controller: FakeController; voice: FakeVoice } {
        patchGlobals({ performance: { now: () => nowRef.value } });
        const voice = makeVoice();
        const pushToTalk = new PushToTalk(voice as unknown as VoiceInput);
        // indicator: false — the node test env has no DOM for the fallback element.
        pushToTalk.configure(jest.fn(), { indicator: false });
        const controller = makeController();
        pushToTalk.wire(
            controller as unknown as PlayerControllerLike,
            null,
            { appendChild: () => {} } as unknown as HTMLElement,
        );
        return { pushToTalk, controller, voice };
    }

    it('registers the custom action with desktop keys and a continuous mobile button', () => {
        const { controller } = setup({ value: 0 });
        expect(controller.registerCustomAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'voiceTalk',
            desktop: { keys: ['KeyV'] },
            mobile: expect.objectContaining({ label: 'TALK', behavior: 'continuous' }),
        }));
    });

    it('starts listening on press and delivers the trimmed transcript on release', async () => {
        const now = { value: 0 };
        const onTranscript = jest.fn();
        const { pushToTalk, controller, voice } = setup(now);
        pushToTalk.configure(onTranscript);

        controller.keys.voiceTalk = true;
        pushToTalk.update();
        expect(voice.startListening).toHaveBeenCalledTimes(1);

        // Held frames are not re-triggers.
        pushToTalk.update();
        expect(voice.startListening).toHaveBeenCalledTimes(1);

        now.value = 900;
        controller.keys.voiceTalk = false;
        pushToTalk.update();
        await Promise.resolve();
        await Promise.resolve();
        expect(voice.stopListening).toHaveBeenCalledTimes(1);
        expect(onTranscript).toHaveBeenCalledWith('fetch the sword');
    });

    it('discards holds shorter than minDurationMs as accidental taps', async () => {
        const now = { value: 0 };
        const onTranscript = jest.fn();
        const { pushToTalk, controller, voice } = setup(now);
        pushToTalk.configure(onTranscript, { minDurationMs: 300 });

        controller.keys.voiceTalk = true;
        pushToTalk.update();
        await Promise.resolve();

        now.value = 100;
        controller.keys.voiceTalk = false;
        pushToTalk.update();
        expect(voice.cancelListening).toHaveBeenCalledTimes(1);
        expect(voice.stopListening).not.toHaveBeenCalled();
        expect(onTranscript).not.toHaveBeenCalled();
    });

    it('routes failures to onError instead of throwing into game code', async () => {
        const now = { value: 0 };
        const onError = jest.fn();
        const { pushToTalk, controller, voice } = setup(now);
        pushToTalk.configure(jest.fn(), { onError });
        voice.stopListening.mockRejectedValue(new VoiceInputError('unavailable', 'no backend'));

        controller.keys.voiceTalk = true;
        pushToTalk.update();
        await Promise.resolve();
        now.value = 1000;
        controller.keys.voiceTalk = false;
        pushToTalk.update();
        await Promise.resolve();
        await Promise.resolve();
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'unavailable' }));
    });
});
