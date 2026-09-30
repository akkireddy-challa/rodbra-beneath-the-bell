/**
 * @fileoverview The "swish" a weapon makes as it cuts the air.
 *
 * SYNTHESISED, not sampled. A swish is filtered noise with a moving resonance —
 * that is genuinely what the physics produces — so generating it costs a few
 * lines of Web Audio and buys things a sample cannot:
 *
 * - No asset. Nothing to author, host, download, cache-bust or ship in a bundle,
 *   and it works offline and on every weapon the moment it is equipped,
 *   including custom weapons registered by template code.
 * - It tracks the SWING. Duration, weight and attack type change the sound
 *   rather than replaying one fixed clip, so a dagger flick and a greataxe
 *   cleave are audibly different, and a slow swing sounds slow.
 * - No repetition. Every swing is re-synthesised with a little jitter, which is
 *   what stops a melee loop turning into the same 300 ms sample forever.
 *
 * Routed through the engine's master gain so its volume control and
 * mute apply. Nothing here is positional: the swing belongs to the player's own
 * weapon, right next to the camera.
 */

/**
 * The slice of the engine this needs. Declared structurally rather than taking
 * the whole engine so the sound can be unit-tested and reused by anything with
 * a Web Audio context — and because `EngineLike` exposes these as OPTIONAL
 * members, which published games' engines may predate.
 */
export interface SwishAudioHost {
    getAudioContext?(): AudioContext | null;
    getAudioDestination?(): AudioNode | null;
}

/** How a weapon sounds when it moves. Derived from its preset, not authored per weapon. */
export interface SwishVoice {
    /** Centre of the noise band at the peak of the swing, Hz. Heavy = lower. */
    peakHz: number;
    /** How far the band sweeps up into the fastest part of the arc. */
    sweep: number;
    /** Resonance. Higher is more whistle, lower is more airy rush. */
    resonance: number;
    /** Overall loudness before the master bus. */
    gain: number;
    /** Fraction of the swing where the blade is fastest — where the peak lands. */
    peakAt: number;
}

/**
 * A thrust is not a slash.
 *
 * A cut sweeps a wide arc with a long rising hiss; a thrust is a short, tighter
 * push of air with far less movement across the band. Blending them into one
 * sound is the single biggest thing that makes synthesised melee audio read as
 * generic, so they are separate voices.
 */
const THRUST_PATTERN = /thrust|stab|spear/i;

/** Two-handed weapons move more air, more slowly. */
const HEAVY_PATTERN = /chop|cleave|heavy|whirlwind|smash/i;

export const DEFAULT_SWISH_VOICE: SwishVoice = {
    peakHz: 1500,
    sweep: 2.6,
    resonance: 1.6,
    gain: 0.40,
    peakAt: 0.45,
};

/**
 * Pick a voice from what the engine already knows about the weapon.
 *
 * `bladeRadius` and `attackRange` stand in for mass and reach: a long, thick
 * blade displaces more air and speaks lower. Deriving it means custom weapons
 * registered by templates get a sensible swish with no extra work.
 */
export function voiceForWeapon(opts: {
    bladeRadius: number;
    attackRange: number;
    grip?: 'one' | 'two';
    moveName?: string;
}): SwishVoice {
    const heft = Math.min(1, (opts.bladeRadius * 6 + opts.attackRange * 0.25) / 2);
    const twoHanded = opts.grip === 'two';
    const move = opts.moveName ?? '';

    const isThrust = THRUST_PATTERN.test(move);
    const isHeavy = HEAVY_PATTERN.test(move) || twoHanded;

    // Heavier weapons speak lower. The floor keeps a greataxe from turning into
    // a rumble with no air in it at all.
    const peakHz = Math.max(420, 2100 - heft * 900 - (isHeavy ? 350 : 0));

    return {
        peakHz,
        // A thrust barely sweeps — the air moves past the point, not across an arc.
        sweep: isThrust ? 1.5 : (isHeavy ? 3.1 : 2.6),
        resonance: isThrust ? 3.2 : (isHeavy ? 1.3 : 1.8),
        gain: isHeavy ? 0.52 : 0.38,
        // A thrust peaks late (all the speed is at full extension); a cut peaks
        // around the middle of its arc.
        peakAt: isThrust ? 0.6 : 0.45,
    };
}

/**
 * Synthesises one swish per swing.
 *
 * Cheap enough to build per swing — a noise buffer, a bandpass and two gains,
 * all discarded when the note ends. The noise buffer itself is generated once
 * and reused, since that is the only part with real cost.
 */
export class WeaponSwishSound {
    private readonly host: SwishAudioHost;
    private noiseBuffer: AudioBuffer | null = null;

    constructor(host: SwishAudioHost) {
        this.host = host;
    }

    /**
     * Play a swish shaped to this swing.
     *
     * @param durationSeconds  the swing's full length — the sound is scaled to it,
     *                         so a slowed or sped-up attack stays in sync
     * @param voice            per-weapon character, from `voiceForWeapon`
     */
    play(durationSeconds: number, voice: SwishVoice = DEFAULT_SWISH_VOICE): void {
        const ctx = this.host.getAudioContext?.() ?? null;
        const destination = this.host.getAudioDestination?.() ?? null;
        if (!ctx || !destination) return;        // engine predates the audio hooks

        // A suspended context used to mean "give up", which made the FIRST
        // swings of a session silent — browsers start the context suspended
        // until a user gesture, and nothing else here wakes it. An attack IS a
        // user gesture, so resuming is both allowed and the right moment.
        // `!== 'running'` rather than `=== 'suspended'` so iOS Safari's
        // non-standard 'interrupted' state (phone call, Siri, screen lock,
        // mic session) recovers too — it isn't in the TS AudioContextState
        // union, so this is also the only comparison that typechecks.
        if (ctx.state !== 'running') {
            ctx.resume().catch(() => { /* still blocked; stay silent */ });
            return;
        }

        // The audible part of a swing is shorter than the animation: the wind-up
        // and recovery are silent, only the fast middle cuts air.
        const audible = Math.max(0.12, Math.min(0.55, durationSeconds * 0.55));
        const now = ctx.currentTime;
        const peak = now + audible * voice.peakAt;
        const end = now + audible;

        const source = ctx.createBufferSource();
        source.buffer = this.getNoise(ctx);
        source.loop = true;

        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.Q.value = voice.resonance;

        // A little per-swing variation so repeated attacks never phase into one
        // recognisable sample.
        const jitter = 0.9 + Math.random() * 0.2;
        const start = voice.peakHz / voice.sweep;
        const top = voice.peakHz * jitter;

        band.frequency.setValueAtTime(start, now);
        band.frequency.exponentialRampToValueAtTime(top, peak);
        band.frequency.exponentialRampToValueAtTime(Math.max(120, start * 0.75), end);

        const gain = ctx.createGain();
        // Sharp rise into the peak, longer decay out of it — air noise builds
        // fast as the blade accelerates and trails off as it slows.
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(voice.gain * jitter, peak);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);

        source.connect(band);
        band.connect(gain);
        gain.connect(destination);

        source.start(now);
        source.stop(end + 0.02);
        source.onended = () => {
            source.disconnect();
            band.disconnect();
            gain.disconnect();
        };
    }

    /** White noise, generated once and looped — the only costly part. */
    private getNoise(ctx: AudioContext): AudioBuffer {
        if (this.noiseBuffer) return this.noiseBuffer;
        const length = Math.floor(ctx.sampleRate * 0.5);
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
        this.noiseBuffer = buffer;
        return buffer;
    }

    dispose(): void {
        this.noiseBuffer = null;
    }
}
