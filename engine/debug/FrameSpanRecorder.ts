/**
 * FrameSpanRecorder — lightweight per-frame CPU-time attribution for the debug HUD.
 *
 * GameEngine.animate wraps its big spans (physics step, NPC/animal updates,
 * render) with performance.now() pairs and calls record(name, ms), then
 * endFrame(totalMs) once per frame — the recorder derives 'other' as the
 * unattributed remainder. The debug panel polls getWorstLine() in its 500 ms
 * flush: it returns each span's WORST ms seen in the window (spikes, not
 * averages — a 42 ms hitch must not vanish into a 500 ms mean), then resets
 * for the next window.
 *
 * Spike self-description: any frame whose total exceeds SPIKE_THRESHOLD_MS
 * logs its full span breakdown plus the NPC scheduler's grant counters to the
 * console and keeps it in a small ring buffer (getSpikeLog) — so a stall names
 * its own composition in ANY environment, without a profiler attached.
 *
 * Module-level singleton so GameEngine stays within its ESLint line budget.
 */
import { getGlobalLodScheduler } from 'engine/character/CharacterLodScheduler.js';

const SPIKE_THRESHOLD_MS = 30;
const SPIKE_LOG_SIZE = 40;

class FrameSpanRecorder {
    /** Worst ms per span since the last getWorstLine() flush. */
    private worst = new Map<string, number>();
    /** Per-span ms recorded in the CURRENT frame (cleared every endFrame). */
    private frameSpans = new Map<string, number>();
    /** Sum of ms attributed via record() in the current frame. */
    private frameAttributedMs = 0;
    /** Ring buffer of recent spike descriptions (most recent last). */
    private spikes: string[] = [];

    record(name: string, ms: number): void {
        this.frameAttributedMs += ms;
        this.frameSpans.set(name, (this.frameSpans.get(name) ?? 0) + ms);
        const prev = this.worst.get(name);
        if (prev === undefined || ms > prev) this.worst.set(name, ms);
    }

    /** Close the frame: derive 'other' = total minus the recorded spans. */
    endFrame(totalMs: number): void {
        const other = Math.max(0, totalMs - this.frameAttributedMs);
        const prev = this.worst.get('other');
        if (prev === undefined || other > prev) this.worst.set('other', other);

        if (totalMs > SPIKE_THRESHOLD_MS) {
            const parts: string[] = [`total=${totalMs.toFixed(1)}`];
            for (const [name, ms] of this.frameSpans) parts.push(`${name}=${ms.toFixed(1)}`);
            parts.push(`other=${other.toFixed(1)}`);
            const stats = getGlobalLodScheduler().getStats();
            parts.push(`aiGrants=${stats.aiGrantedLastFrame} animGrants=${stats.animGrantedLastFrame} avoidGrants=${stats.avoidanceGrantedLastFrame}`);
            const line = `[FrameSpike] ${parts.join(' ')}`;
            console.debug(line);
            this.spikes.push(line);
            if (this.spikes.length > SPIKE_LOG_SIZE) this.spikes.shift();
        }

        this.frameSpans.clear();
        this.frameAttributedMs = 0;
    }

    /** Recent spike-frame descriptions (most recent last). */
    getSpikeLog(): readonly string[] {
        return this.spikes;
    }

    /** Worst ms per span since the last call, formatted as one line; resets the window. */
    getWorstLine(): string {
        if (this.worst.size === 0) return 'Spans: —';
        const parts: string[] = [];
        for (const [name, ms] of this.worst) {
            parts.push(`${name} ${ms.toFixed(1)}`);
        }
        this.worst.clear();
        return `Spans worst ms: ${parts.join(' | ')}`;
    }
}

/** Module-level singleton (see header). */
export const frameSpanRecorder = new FrameSpanRecorder();
