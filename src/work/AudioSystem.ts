/**
 * RÖDBRÅ: Beneath the Bell — Procedural Audio Engine
 * Pure Web Audio synthesis for authentic Scandinavian dark-fantasy soundscape.
 * Generates Nordic bowed drones (nyckelharpa/viol), frame drums, bronze bell FM partials,
 * weapon whooshes, bone/armor impacts, parry clangs, footsteps, and dynamic music layers.
 */

export type FootstepSurface = 'snow' | 'wood' | 'stone';
export type MusicMode = 'menu' | 'exploration' | 'combat' | 'miniboss' | 'boss_p1' | 'boss_p2' | 'boss_p3' | 'ending' | 'silent';

export class AudioEngine {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private musicGain: GainNode | null = null;
    private sfxGain: GainNode | null = null;
    private voiceGain: GainNode | null = null;

    // Volume settings (0.0 to 1.0)
    public masterVolume: number = 0.8;
    public musicVolume: number = 0.65;
    public sfxVolume: number = 0.85;
    public voiceVolume: number = 0.9;
    public isMuted: boolean = false;

    // Music generation loop state
    private activeMusicMode: MusicMode = 'silent';
    private musicLoopInterval: any = null;
    private droneOscillators: OscillatorNode[] = [];
    private droneGains: GainNode[] = [];
    private currentDroneGain: GainNode | null = null;
    private drumStep: number = 0;

    constructor() {
        // Will initialize AudioContext lazily on user gesture
    }

    public init(): void {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') {
                this.ctx.resume().catch(() => {});
            }
            return;
        }

        try {
            const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioCtxClass) return;
            this.ctx = new AudioCtxClass();

            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.masterVolume, this.ctx.currentTime);
            this.masterGain.connect(this.ctx.destination);

            this.musicGain = this.ctx.createGain();
            this.musicGain.gain.setValueAtTime(this.musicVolume, this.ctx.currentTime);
            this.musicGain.connect(this.masterGain);

            this.sfxGain = this.ctx.createGain();
            this.sfxGain.gain.setValueAtTime(this.sfxVolume, this.ctx.currentTime);
            this.sfxGain.connect(this.masterGain);

            this.voiceGain = this.ctx.createGain();
            this.voiceGain.gain.setValueAtTime(this.voiceVolume, this.ctx.currentTime);
            this.voiceGain.connect(this.masterGain);

            console.log('🔊 AudioEngine initialized in Web Audio state:', this.ctx.state);
        } catch (e) {
            console.warn('AudioContext initialization deferred/failed:', e);
        }
    }

    public resume(): void {
        if (!this.ctx) {
            this.init();
        } else if (this.ctx.state === 'suspended') {
            this.ctx.resume().catch(() => {});
        }
    }

    public setVolumes(master: number, music: number, sfx: number, voice: number): void {
        this.masterVolume = THREE_clamp(master, 0, 1);
        this.musicVolume = THREE_clamp(music, 0, 1);
        this.sfxVolume = THREE_clamp(sfx, 0, 1);
        this.voiceVolume = THREE_clamp(voice, 0, 1);

        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        if (this.masterGain) this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.masterVolume, now);
        if (this.musicGain) this.musicGain.gain.setValueAtTime(this.musicVolume, now);
        if (this.sfxGain) this.sfxGain.gain.setValueAtTime(this.sfxVolume, now);
        if (this.voiceGain) this.voiceGain.gain.setValueAtTime(this.voiceVolume, now);
    }

    public setMute(muted: boolean): void {
        this.isMuted = muted;
        if (this.masterGain && this.ctx) {
            this.masterGain.gain.setValueAtTime(muted ? 0 : this.masterVolume, this.ctx.currentTime);
        }
    }

    // =========================================================================
    // SFX: WEAPON & COMBAT
    // =========================================================================

    public playSwordWhoosh(comboIndex: number = 1): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // Base frequency shifts slightly higher per combo stage
        const baseFreq = 180 + comboIndex * 40 + (Math.random() - 0.5) * 30;
        const osc = this.ctx.createOscillator();
        const filter = this.ctx.createBiquadFilter();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(baseFreq, now);
        osc.frequency.exponentialRampToValueAtTime(60, now + 0.22);

        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(800 + comboIndex * 200, now);
        filter.frequency.exponentialRampToValueAtTime(200, now + 0.22);
        filter.Q.setValueAtTime(2.0, now);

        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.35, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxGain);

        osc.start(now);
        osc.stop(now + 0.26);

        // Subtle noisy airy blade friction
        this.playNoiseBurst(0.18, 1200, 0.15, 'bandpass');
    }

    public playChargedHeavyRelease(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(140, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.4);

        gain.gain.setValueAtTime(0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.45);

        this.playNoiseBurst(0.35, 900, 0.4, 'lowpass');
    }

    public playFleshImpact(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // Low fleshy sub thump
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(90, now);
        osc.frequency.exponentialRampToValueAtTime(30, now + 0.18);

        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.22);

        // Wet tear noise
        this.playNoiseBurst(0.16, 1400, 0.3, 'bandpass');
    }

    public playArmorImpact(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // Sharp metallic transient
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(540 + Math.random() * 80, now);
        osc.frequency.exponentialRampToValueAtTime(180, now + 0.15);

        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.18);

        this.playNoiseBurst(0.12, 3500, 0.35, 'highpass');
    }

    public playWoodImpact(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(50, now + 0.14);

        gain.gain.setValueAtTime(0.45, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.16);

        this.playNoiseBurst(0.1, 700, 0.25, 'bandpass');
    }

    public playParryClang(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // Two harmonically dissonant square/triangle tones for resonant iron clash
        const freqs = [1120, 1580, 2340];
        for (const f of freqs) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(f + (Math.random() - 0.5) * 40, now);

            gain.gain.setValueAtTime(0.28, now);
            gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.7);

            osc.connect(gain);
            gain.connect(this.sfxGain);
            osc.start(now);
            osc.stop(now + 0.72);
        }

        // Sharp iron spark transient
        this.playNoiseBurst(0.08, 4800, 0.45, 'highpass');
    }

    public playDodgeSwoosh(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        const filter = this.ctx.createBiquadFilter();
        const gain = this.ctx.createGain();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(450, now);
        filter.frequency.exponentialRampToValueAtTime(900, now + 0.12);
        filter.frequency.exponentialRampToValueAtTime(300, now + 0.25);
        filter.Q.setValueAtTime(1.5, now);

        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.25, now + 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

        const noiseNode = this.createNoiseBufferNode();
        if (noiseNode) {
            noiseNode.connect(filter);
            filter.connect(gain);
            gain.connect(this.sfxGain);
            noiseNode.start(now);
            noiseNode.stop(now + 0.28);
        }
    }

    public playFootstep(surface: FootstepSurface = 'snow'): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        if (surface === 'snow') {
            // Crisp crunchy snow step
            this.playNoiseBurst(0.12, 1800, 0.18, 'bandpass');
            // Subtle low squish
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(75, now);
            osc.frequency.exponentialRampToValueAtTime(35, now + 0.08);
            gain.gain.setValueAtTime(0.12, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
            osc.connect(gain);
            gain.connect(this.sfxGain);
            osc.start(now);
            osc.stop(now + 0.1);
        } else if (surface === 'wood') {
            // Resonant timber footstep
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(120, now);
            osc.frequency.exponentialRampToValueAtTime(50, now + 0.1);
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
            osc.connect(gain);
            gain.connect(this.sfxGain);
            osc.start(now);
            osc.stop(now + 0.12);
        } else {
            // Stone click
            this.playNoiseBurst(0.06, 2600, 0.2, 'highpass');
        }
    }

    public playWardThrow(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // Whistling spinning iron talisman
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(750, now);
        osc.frequency.linearRampToValueAtTime(1300, now + 0.25);

        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.38);
    }

    public playWardHit(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(60, now + 0.3);

        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.35);

        this.playNoiseBurst(0.25, 1200, 0.4, 'bandpass');
    }

    public playWardRecharged(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // Soft shimmering ward recharge chime
        [587.33, 880.00].forEach((f, idx) => {
            const osc = this.ctx!.createOscillator();
            const gain = this.ctx!.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, now + idx * 0.08);

            gain.gain.setValueAtTime(0, now + idx * 0.08);
            gain.gain.linearRampToValueAtTime(0.2, now + idx * 0.08 + 0.03);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.45);

            osc.connect(gain);
            gain.connect(this.sfxGain!);
            osc.start(now + idx * 0.08);
            osc.stop(now + idx * 0.08 + 0.5);
        });
    }

    public playHealFlask(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // Cork uncork pop
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(450, now);
        osc.frequency.exponentialRampToValueAtTime(140, now + 0.08);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.1);

        // Restorative warm shimmer chord
        [220, 277.18, 329.63, 440].forEach((f, idx) => {
            const chordOsc = this.ctx!.createOscillator();
            const chordGain = this.ctx!.createGain();
            chordOsc.type = 'sine';
            chordOsc.frequency.setValueAtTime(f, now + 0.08 + idx * 0.04);

            chordGain.gain.setValueAtTime(0, now + 0.08 + idx * 0.04);
            chordGain.gain.linearRampToValueAtTime(0.18, now + 0.15 + idx * 0.04);
            chordGain.gain.exponentialRampToValueAtTime(0.001, now + 0.9 + idx * 0.04);

            chordOsc.connect(chordGain);
            chordGain.connect(this.sfxGain!);
            chordOsc.start(now + 0.08 + idx * 0.04);
            chordOsc.stop(now + 1.0 + idx * 0.04);
        });
    }

    public playPrayerPostRest(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // Resonant ancient holy chime (D minor triad with open fifths)
        const notes = [146.83, 220.0, 293.66, 440.0, 587.33];
        notes.forEach((freq, idx) => {
            const osc = this.ctx!.createOscillator();
            const gain = this.ctx!.createGain();
            osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
            osc.frequency.setValueAtTime(freq, now + idx * 0.05);

            gain.gain.setValueAtTime(0, now + idx * 0.05);
            gain.gain.linearRampToValueAtTime(0.25, now + idx * 0.05 + 0.08);
            gain.gain.exponentialRampToValueAtTime(0.0005, now + 2.2);

            osc.connect(gain);
            gain.connect(this.sfxGain!);
            osc.start(now + idx * 0.05);
            osc.stop(now + 2.4);
        });
    }

    public playBellToll(size: 'distant' | 'large' | 'colossal' = 'large'): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // FM Synthesis of bronze church bell acoustics
        // Real bronze bells have strong inharmonic partials:
        // Hum (0.5x), Prime (1.0x), Tierce (1.2x), Quint (1.5x), Nominal (2.0x)
        let fundamental = 220; // A3
        let duration = 3.5;
        let amp = 0.45;

        if (size === 'distant') {
            fundamental = 293.66; // D4
            duration = 2.5;
            amp = 0.22;
        } else if (size === 'colossal') {
            fundamental = 82.41; // E2 (Deep subterranean resonant bell)
            duration = 5.5;
            amp = 0.65;
        }

        const partialRatios = [0.5, 1.0, 1.18, 1.5, 2.0, 2.7, 3.8];
        const partialAmps = [0.7, 1.0, 0.6, 0.4, 0.5, 0.25, 0.15];

        partialRatios.forEach((ratio, i) => {
            const osc = this.ctx!.createOscillator();
            const gain = this.ctx!.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(fundamental * ratio, now);

            const pAmp = amp * (partialAmps[i] ?? 0.5);
            gain.gain.setValueAtTime(pAmp, now);
            // Higher partials decay much faster than the low hum
            const decay = duration / (1 + ratio * 0.4);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

            osc.connect(gain);
            gain.connect(this.sfxGain!);
            osc.start(now);
            osc.stop(now + decay + 0.1);
        });

        // Heavy iron clapper strike impact
        this.playNoiseBurst(0.08, 1400, amp * 0.5, 'bandpass');
    }

    public playRendReady(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.linearRampToValueAtTime(440, now + 0.35);

        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.3, now + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.5);
    }

    public playExecutionStab(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;

        // Deep resonant bass drop
        const sub = this.ctx.createOscillator();
        const subGain = this.ctx.createGain();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(110, now);
        sub.frequency.exponentialRampToValueAtTime(30, now + 0.6);
        subGain.gain.setValueAtTime(0.65, now);
        subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
        sub.connect(subGain);
        subGain.connect(this.sfxGain);
        sub.start(now);
        sub.stop(now + 0.7);

        // Blade driving into bone and flesh
        this.playArmorImpact();
        setTimeout(() => this.playFleshImpact(), 80);
    }

    public playUIHover(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, now);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.05);
    }

    public playUIConfirm(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;
        [440, 660].forEach((f, idx) => {
            const osc = this.ctx!.createOscillator();
            const gain = this.ctx!.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(f, now + idx * 0.06);
            gain.gain.setValueAtTime(0.18, now + idx * 0.06);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.06 + 0.12);
            osc.connect(gain);
            gain.connect(this.sfxGain!);
            osc.start(now + idx * 0.06);
            osc.stop(now + idx * 0.06 + 0.14);
        });
    }

    public playUIBack(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;
        [550, 360].forEach((f, idx) => {
            const osc = this.ctx!.createOscillator();
            const gain = this.ctx!.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(f, now + idx * 0.05);
            gain.gain.setValueAtTime(0.15, now + idx * 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.05 + 0.1);
            osc.connect(gain);
            gain.connect(this.sfxGain!);
            osc.start(now + idx * 0.05);
            osc.stop(now + idx * 0.05 + 0.12);
        });
    }

    public playUIError(): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(140, now);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(now);
        osc.stop(now + 0.2);
    }

    // =========================================================================
    // DYNAMIC FOLK-HORROR MUSIC LAYERS
    // =========================================================================

    public setMusicMode(mode: MusicMode): void {
        if (this.activeMusicMode === mode) return;
        this.activeMusicMode = mode;
        this.stopMusicDrone();

        if (mode === 'silent') return;
        this.startMusicForMode(mode);
    }

    private startMusicForMode(mode: MusicMode): void {
        if (!this.ctx || !this.musicGain) return;
        const now = this.ctx.currentTime;

        // D-minor / Dorian modal root frequencies:
        // D2=73.42, A2=110, D3=146.83, F3=174.61, G3=196, A3=220, C4=261.63
        let droneNotes: number[] = [73.42, 110.0, 146.83];
        let droneWave: OscillatorType = 'sawtooth';
        let filterCutoff = 350;
        let tempoMs = 2400; // slow atmospheric pulse

        if (mode === 'menu') {
            droneNotes = [73.42, 110.0, 174.61]; // D minor atmospheric drone
            filterCutoff = 300;
            tempoMs = 3000;
        } else if (mode === 'exploration') {
            droneNotes = [73.42, 110.0, 146.83, 220.0];
            filterCutoff = 420;
            tempoMs = 2200;
        } else if (mode === 'combat') {
            droneNotes = [73.42, 110.0, 155.56, 220.0]; // Diminished tension note
            filterCutoff = 650;
            tempoMs = 1200;
        } else if (mode === 'miniboss') {
            droneNotes = [65.41, 98.0, 130.81, 196.0]; // C minor low drone
            filterCutoff = 750;
            tempoMs = 950;
        } else if (mode === 'boss_p1') {
            droneNotes = [55.0, 110.0, 146.83, 164.81]; // Deep A drone with tritone
            filterCutoff = 600;
            tempoMs = 1400;
        } else if (mode === 'boss_p2') {
            droneNotes = [55.0, 110.0, 155.56, 233.08]; // Frenzied dissonance
            filterCutoff = 850;
            tempoMs = 850;
        } else if (mode === 'boss_p3') {
            droneNotes = [49.0, 73.42, 98.0, 146.83, 220.0]; // Massive low cluster
            filterCutoff = 1100;
            tempoMs = 680;
        } else if (mode === 'ending') {
            droneNotes = [73.42, 110.0, 146.83, 220.0, 293.66]; // Peaceful resolving D major/modal
            filterCutoff = 500;
            tempoMs = 3200;
        }

        // Create sustained filtered drone simulating Scandinavian bowed strings
        const droneGroupGain = this.ctx.createGain();
        droneGroupGain.gain.setValueAtTime(0.001, now);
        droneGroupGain.gain.linearRampToValueAtTime(0.35, now + 1.5);
        this.currentDroneGain = droneGroupGain;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(filterCutoff, now);
        filter.Q.setValueAtTime(2.2, now);

        droneNotes.forEach(freq => {
            const osc = this.ctx!.createOscillator();
            osc.type = droneWave;
            // Add subtle detuning for natural bowed acoustic chorusing
            osc.frequency.setValueAtTime(freq + (Math.random() - 0.5) * 1.5, now);

            // Subtle slow LFO vibrato
            const lfo = this.ctx!.createOscillator();
            const lfoGain = this.ctx!.createGain();
            lfo.frequency.setValueAtTime(3.8 + Math.random() * 0.8, now);
            lfoGain.gain.setValueAtTime(freq * 0.015, now);
            lfo.connect(lfoGain);
            lfoGain.connect(osc.frequency);
            lfo.start(now);

            osc.connect(filter);
            osc.start(now);

            this.droneOscillators.push(osc);
            this.droneOscillators.push(lfo);
        });

        filter.connect(droneGroupGain);
        droneGroupGain.connect(this.musicGain);

        // Start rhythmic frame drum and rhythmic string pluck scheduler
        this.drumStep = 0;
        this.musicLoopInterval = setInterval(() => {
            this.tickMusicPulse(mode);
        }, tempoMs / 2);
    }

    private tickMusicPulse(mode: MusicMode): void {
        if (!this.ctx || !this.musicGain || this.activeMusicMode !== mode) return;
        this.drumStep++;

        const now = this.ctx.currentTime;

        // Frame drum on beat 0 and accented on beat 4
        if (this.drumStep % 2 === 0) {
            this.playFrameDrum(mode === 'combat' || mode === 'miniboss' || mode.startsWith('boss') ? 0.45 : 0.25);
        }

        // Occasional distant bell toll during exploration & boss fights
        if (mode === 'exploration' && this.drumStep % 16 === 0) {
            this.playBellToll('distant');
        } else if (mode === 'boss_p1' && this.drumStep % 8 === 0) {
            this.playBellToll('large');
        } else if (mode === 'boss_p2' && this.drumStep % 6 === 0) {
            this.playBellToll('colossal');
        } else if (mode === 'boss_p3' && this.drumStep % 4 === 0) {
            this.playBellToll('colossal');
        }
    }

    private playFrameDrum(volume: number = 0.3): void {
        if (!this.ctx || !this.musicGain) return;
        const now = this.ctx.currentTime;

        // Deep skin drum resonance
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(65, now);
        osc.frequency.exponentialRampToValueAtTime(32, now + 0.35);

        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

        osc.connect(gain);
        gain.connect(this.musicGain);
        osc.start(now);
        osc.stop(now + 0.42);

        // Low muffled mallet impact
        this.playNoiseBurst(0.08, 220, volume * 0.4, 'lowpass');
    }

    public stopMusicDrone(): void {
        if (this.musicLoopInterval) {
            clearInterval(this.musicLoopInterval);
            this.musicLoopInterval = null;
        }

        if (this.currentDroneGain && this.ctx) {
            const now = this.ctx.currentTime;
            this.currentDroneGain.gain.linearRampToValueAtTime(0.001, now + 1.0);
            const oldGain = this.currentDroneGain;
            setTimeout(() => {
                try { oldGain.disconnect(); } catch (_) {}
            }, 1100);
            this.currentDroneGain = null;
        }

        const oldOscs = [...this.droneOscillators];
        this.droneOscillators = [];
        if (this.ctx) {
            const now = this.ctx.currentTime;
            setTimeout(() => {
                oldOscs.forEach(o => {
                    try { o.stop(); o.disconnect(); } catch (_) {}
                });
            }, 1100);
        }
    }

    // =========================================================================
    // HELPER: NOISE SYNTHESIS
    // =========================================================================

    private createNoiseBufferNode(): AudioBufferSourceNode | null {
        if (!this.ctx) return null;
        const bufferSize = this.ctx.sampleRate * 1.0;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;
        return noise;
    }

    private playNoiseBurst(duration: number, cutoff: number, volume: number, filterType: BiquadFilterType = 'bandpass'): void {
        if (!this.ctx || !this.sfxGain) return;
        const now = this.ctx.currentTime;
        const noise = this.createNoiseBufferNode();
        if (!noise) return;

        const filter = this.ctx.createBiquadFilter();
        filter.type = filterType;
        filter.frequency.setValueAtTime(cutoff, now);
        filter.Q.setValueAtTime(1.8, now);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.0005, now + duration);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxGain);

        noise.start(now);
        noise.stop(now + duration + 0.05);
    }

    public dispose(): void {
        this.stopMusicDrone();
        if (this.ctx) {
            try { this.ctx.close(); } catch (_) {}
            this.ctx = null;
        }
    }
}

function THREE_clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// Global audio engine singleton
export const audio = new AudioEngine();
