import * as fs from 'fs';
import * as path from 'path';

import { warmupPolicyFor, resolveWarmupMode } from 'engine/WarmupPolicy.js';

/**
 * `GameEngine.preloadLevel()` — whose body is `runLevelPreload` in the
 * GameEngineWarmup friend module — must flush the `onSceneWarmedUp` callbacks whatever
 * the warmup did: succeeded, was switched off by policy, failed, or threw.
 *
 * Those callbacks arm the ONLY release of the terrain batches' CPU-side buffer copies
 * (`VxlSceneRenderer.releaseCpuGeometry`, the single consumer of `onSceneWarmedUp` in the
 * engine). The gate used to be `warmed || !warmupDrawsAFrame()`, which covers a warmup
 * switched off by policy but NOT one that ran and failed — and mobile's default (`light`)
 * draws a frame, so the escape clause never applied there. A warm frame that threw on a
 * phone therefore left every batch holding its full CPU copy for the life of the level, on
 * the platform with the least memory to spare, in exactly the circumstances that provoke
 * the throw.
 *
 * Arming regardless is safe because `releaseCpuGeometry` only ARMS a per-batch after-DRAW
 * release: nothing is freed until that batch has reached the GPU on a real frame. That
 * per-batch guard is what protects correctness; the warmup outcome only ever decided
 * whether the release was attempted at all.
 *
 * Source-shape, in the style of `ResizeSkipsBloom.test.ts`: reproducing it needs a real
 * renderer whose warm frame throws, which no unit test can stand up.
 */
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'GameEngineWarmup.ts'), 'utf-8');

const CODE_ONLY = SOURCE.split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

/** `runLevelPreload`'s body, from its signature to its top-level closing brace. */
function preloadLevelBody(): string {
    const start = CODE_ONLY.indexOf('export async function runLevelPreload(');
    expect(start).toBeGreaterThan(-1);
    const rest = CODE_ONLY.slice(start);
    const end = rest.indexOf('\n}\n');
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
}

describe('preloadLevel arms the CPU-geometry release unconditionally', () => {
    it('flushes the warmed-up callbacks from a finally, not a conditional', () => {
        const body = preloadLevelBody();
        expect(body).toContain('} finally {');
        // The flush must sit AFTER the finally keyword — i.e. inside it.
        expect(body.indexOf("eng['sceneWarmedUpCallbacks'] = []")).toBeGreaterThan(body.indexOf('} finally {'));
        expect(body).toContain("eng['sceneWarmedUp'] = true");
    });

    it('does not gate the flush on the warmup result any more', () => {
        const body = preloadLevelBody();
        // The old gate, in either spelling.
        expect(body).not.toMatch(/if\s*\(\s*warmed\b/);
        expect(body).not.toContain('warmupDrawsAFrame()');
    });
});

describe('why the old gate missed mobile', () => {
    it("mobile's default warmup DRAWS a frame, so a draws-a-frame escape clause never applied", () => {
        // This is the fact that made a failed warm frame leak on phones and nowhere else.
        // If the mobile default ever becomes frameless, revisit the reasoning above — but
        // the unconditional flush stays correct either way.
        const mobileMode = resolveWarmupMode('light');
        expect(mobileMode).toBe('light');
        expect(warmupPolicyFor(mobileMode).frame).toBe(true);
    });

    it('only the fully-off rung skips the frame', () => {
        expect(warmupPolicyFor('off').frame).toBe(false);
        for (const mode of ['full', 'nocompile', 'culled', 'light'] as const) {
            expect(warmupPolicyFor(mode).frame).toBe(true);
        }
    });
});
