import * as THREE from 'three';

/**
 * Plays audio asset files (e.g. opus/ogg) via the Web Audio API.
 *
 * Uses a THREE.AudioListener attached to the active camera so the AudioContext
 * is shared with any THREE.Audio usage and so PokiIntegration's
 * listener.setMasterVolume() mute path works during commercial breaks.
 *
 * Routing: sfxGain, musicGain -> listener.getInput() -> destination
 *
 * - SFX are fire-and-forget and can overlap.
 * - Only one music track plays at a time; playMusic cross-fades.
 * - Decoded buffers are cached per URL.
 * - All errors are caught and logged; gameplay never breaks on audio failure.
 */
export class AudioPlayer {
    private listener: THREE.AudioListener;
    private camera: THREE.Camera;
    private sfxGain: GainNode;
    private musicGain: GainNode;
    private bufferCache = new Map<string, AudioBuffer>();
    private pendingLoads = new Map<string, Promise<AudioBuffer | null>>();
    private currentMusic: {
        source: AudioBufferSourceNode;
        gain: GainNode;
        url: string;
        targetVolume: number;
    } | null = null;

    constructor(camera: THREE.Camera) {
        this.camera = camera;
        this.listener = new THREE.AudioListener();
        camera.add(this.listener);

        const ctx = this.listener.context;
        this.sfxGain = ctx.createGain();
        this.sfxGain.gain.value = 1;
        this.sfxGain.connect(this.listener.getInput());

        this.musicGain = ctx.createGain();
        this.musicGain.gain.value = 1;
        this.musicGain.connect(this.listener.getInput());

        // iOS 17+: unless the page opts into the 'playback' audio session
        // category, the phone's ringer/silent switch mutes ALL Web Audio
        // output — invisibly, with nothing in the console. Not yet in TS
        // lib.dom, so feature-detect through a structural type.
        try {
            const nav = navigator as unknown as { audioSession?: { type: string } };
            if (nav.audioSession) nav.audioSession.type = 'playback';
        } catch { /* audioSession unsupported or read-only */ }
    }

    /**
     * Play a one-shot sound effect. Returns immediately; failures are logged.
     * Multiple SFX can overlap.
     */
    playSound(url: string, opts?: { volume?: number }): void {
        const volume = opts?.volume ?? 1;
        this.loadBuffer(url).then((buffer) => {
            if (!buffer) return;
            this.resumeContext();
            const ctx = this.listener.context;
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            const gain = ctx.createGain();
            gain.gain.value = volume;
            source.connect(gain);
            gain.connect(this.sfxGain);
            source.start(0);
            source.onended = () => {
                source.disconnect();
                gain.disconnect();
            };
        }).catch((err) => {
            console.warn(`[AudioPlayer] playSound failed for ${url}:`, err);
        });
    }

    /**
     * Play a music track. Only one music track plays at a time — calling this
     * while another track is playing cross-fades to the new one.
     * Resolves when the new track has started (after the outgoing fade, if any).
     */
    async playMusic(url: string, opts?: { loop?: boolean; fadeIn?: number; volume?: number }): Promise<void> {
        const loop = opts?.loop ?? true;
        const fadeIn = opts?.fadeIn ?? 0.5;
        const volume = opts?.volume ?? 1;

        const buffer = await this.loadBuffer(url);
        if (!buffer) return;

        // Cross-fade out any existing music track.
        if (this.currentMusic) {
            await this.stopMusic({ fadeOut: fadeIn });
        }

        this.resumeContext();
        const ctx = this.listener.context;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = loop;

        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(this.musicGain);

        const now = ctx.currentTime;
        if (fadeIn > 0) {
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(volume, now + fadeIn);
        } else {
            gain.gain.setValueAtTime(volume, now);
        }

        source.start(0);
        this.currentMusic = { source, gain, url, targetVolume: volume };

        source.onended = () => {
            // Only clear if this is still the active track (natural end for non-looping).
            if (this.currentMusic?.source === source) {
                source.disconnect();
                gain.disconnect();
                this.currentMusic = null;
            }
        };
    }

    /**
     * Fade out and stop the current music track, if any. Resolves after the
     * fade completes.
     */
    async stopMusic(opts?: { fadeOut?: number }): Promise<void> {
        const fadeOut = opts?.fadeOut ?? 0.5;
        const music = this.currentMusic;
        if (!music) return;
        this.currentMusic = null;

        const { gain } = music;
        const now = this.listener.context.currentTime;

        if (fadeOut > 0) {
            const currentValue = gain.gain.value;
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(currentValue, now);
            gain.gain.linearRampToValueAtTime(0, now + fadeOut);
            await new Promise<void>((resolve) => setTimeout(resolve, fadeOut * 1000));
        }

        AudioPlayer.releaseTrack(music);
    }

    /** Stop a track's nodes and release them. Tolerates an already-stopped source. */
    private static releaseTrack(track: { source: AudioBufferSourceNode; gain: GainNode }): void {
        try {
            track.source.stop();
        } catch {
            // Already stopped.
        }
        track.source.disconnect();
        track.gain.disconnect();
    }

    /**
     * Set volume on one or more buses. 0 = silent, 1 = full.
     * `master` controls the THREE.AudioListener gain (affects THREE.Audio too).
     */
    setVolume(opts: { master?: number; sfx?: number; music?: number }): void {
        if (opts.master !== undefined) this.listener.setMasterVolume(opts.master);
        if (opts.sfx !== undefined) this.sfxGain.gain.value = opts.sfx;
        if (opts.music !== undefined) this.musicGain.gain.value = opts.music;
    }

    /**
     * Return the shared AudioContext.
     * Templates that use the Web Audio API directly should use this context so that
     * engine.setAudioVolume() and AudioContext suspension on mute take effect.
     */
    getContext(): AudioContext {
        return this.listener.context as AudioContext;
    }

    /**
     * Return the master gain input node (THREE.AudioListener's gain).
     * Connect Web Audio API source nodes here to route them through the master
     * volume, ensuring engine.setAudioVolume({ master: 0 }) silences them.
     */
    getInput(): AudioNode {
        return this.listener.getInput();
    }

    /**
     * Detach the listener from its current camera and attach to a new one.
     * Call when the engine swaps cameras.
     */
    setCamera(camera: THREE.Camera): void {
        if (camera === this.camera) return;
        this.camera.remove(this.listener);
        this.camera = camera;
        camera.add(this.listener);
    }

    dispose(): void {
        if (this.currentMusic) {
            AudioPlayer.releaseTrack(this.currentMusic);
            this.currentMusic = null;
        }
        this.sfxGain.disconnect();
        this.musicGain.disconnect();
        this.bufferCache.clear();
        this.pendingLoads.clear();
        this.camera.remove(this.listener);
        // Do not close listener.context — THREE.AudioListener owns it and may
        // be recreated; closing would also kill any future THREE.Audio usage.
    }

    private resumeContext(): void {
        const ctx = this.listener.context;
        // `!== 'running'` rather than `=== 'suspended'`: after a phone call,
        // Siri, screen lock, or a getUserMedia mic session, iOS Safari parks
        // the context in the non-standard 'interrupted' state, which a
        // 'suspended'-only check never recovers from. (The TS
        // AudioContextState union doesn't include 'interrupted', so this is
        // also the only comparison that typechecks.) Note this alone is not
        // enough on iOS — resume() only sticks inside a user-gesture call
        // stack, which GameEngine's window-level unlock listeners provide.
        if (ctx.state !== 'running') {
            ctx.resume().catch(() => { /* ignore */ });
        }
    }

    /**
     * Pre-fetch and decode an audio buffer so the first playSound()/playMusic()
     * for this URL doesn't stall on the network fetch + decodeAudioData(). Used
     * by level preloading to move audio cost in front of the Play button.
     * Idempotent — loadBuffer() caches by URL and dedups in-flight loads.
     */
    async preload(url: string): Promise<void> {
        await this.loadBuffer(url);
    }

    private loadBuffer(url: string): Promise<AudioBuffer | null> {
        const cached = this.bufferCache.get(url);
        if (cached) return Promise.resolve(cached);

        const pending = this.pendingLoads.get(url);
        if (pending) return pending;

        const promise = this.fetchAndDecode(url).then((buffer) => {
            if (buffer) this.bufferCache.set(url, buffer);
            this.pendingLoads.delete(url);
            return buffer;
        });
        this.pendingLoads.set(url, promise);
        return promise;
    }

    private async fetchAndDecode(url: string): Promise<AudioBuffer | null> {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.warn(`[AudioPlayer] fetch failed for ${url}: ${response.status}`);
                return null;
            }
            const bytes = await response.arrayBuffer();
            return await this.listener.context.decodeAudioData(bytes);
        } catch (err) {
            console.warn(`[AudioPlayer] decode failed for ${url}:`, err);
            return null;
        }
    }
}
