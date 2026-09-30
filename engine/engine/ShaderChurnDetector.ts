/**
 * @fileoverview Detects shader programs that are deleted and compiled again
 * while a game is running.
 *
 * A program compiled once at load is fine. A program that goes away and comes
 * back means something disposed the last material or geometry using it and
 * then spawned the same kind of object again — the classic create-a-material-
 * per-effect pattern, which costs a synchronous compile on the first draw
 * after every respawn (see `engine/effects/EffectPool.ts`). This class only
 * observes; `PerfStatsCollector` feeds it each frame and reports.
 *
 * Two inputs, one per backend:
 * - WebGL exposes `renderer.info.programs`, a list with stable ids and cache
 *   keys, so a recompile can be matched exactly and named by material type.
 * - WebGPU exposes only `renderer.info.memory.programs`, a count. A decrease
 *   followed within a few seconds by an increase is reported as a recompile;
 *   it cannot be named.
 */

/** The three fields of a WebGL program entry this detector reads. */
export interface ProgramIdentity {
    id: number;
    cacheKey: string;
    /** three.js sets this to `material.name`, which is usually empty. */
    name: string;
}

/**
 * three.js starts a built-in program's cache key with its shader id
 * (`WebGLPrograms.shaderIDs`); custom shaders start with a numeric id instead.
 */
const SHADER_ID_MATERIALS: Record<string, string> = {
    depth: 'MeshDepthMaterial',
    distance: 'MeshDistanceMaterial',
    normal: 'MeshNormalMaterial',
    basic: 'MeshBasicMaterial',
    lambert: 'MeshLambertMaterial',
    phong: 'MeshPhongMaterial',
    toon: 'MeshToonMaterial',
    physical: 'MeshStandardMaterial',
    matcap: 'MeshMatcapMaterial',
    dashed: 'LineDashedMaterial',
    points: 'PointsMaterial',
    shadow: 'ShadowMaterial',
    sprite: 'SpriteMaterial',
};

/**
 * A readable material type for a program: the material's own name when it
 * has one, else the type behind the cache key's shader id, else `custom shader`.
 */
export function describeProgram(p: ProgramIdentity): string {
    if (p.name) return p.name;
    const comma = p.cacheKey.indexOf(',');
    const shaderId = comma < 0 ? p.cacheKey : p.cacheKey.slice(0, comma);
    return SHADER_ID_MATERIALS[shaderId] ?? 'custom shader';
}

/** One detected recompile. */
export interface ShaderChurnEvent {
    /** `performance.now()` at detection, ms. */
    t: number;
    /** Material type (see `describeProgram`), or `render pipeline` on WebGPU. */
    name: string;
    /** Running total of recompiles for this name, including this one. */
    count: number;
}

/**
 * On WebGPU a count drop older than this no longer pairs with a later rise.
 * Keeps a level unload from flagging the next level's genuinely new
 * programs as churn.
 */
export const WEBGPU_CHURN_PAIRING_WINDOW_MS = 5000;

const EMPTY: readonly string[] = [];

export class ShaderChurnDetector {
    private static readonly EVENT_MAX = 200;

    // WebGL: live programs by id, and the cache keys of programs seen deleted.
    private readonly known = new Map<number, ProgramIdentity>();
    private readonly deletedKeys = new Map<string, string>();
    private prevLength = -1;
    private prevLastId = -1;

    // WebGPU: program count and the timestamps of unpaired decreases.
    private prevCount = -1;
    private readonly pendingDrops: number[] = [];

    private readonly countByName = new Map<string, number>();
    private total = 0;
    private readonly events: ShaderChurnEvent[] = [];

    /** Total recompiles detected since the last reset. */
    get totalRecompiles(): number {
        return this.total;
    }

    /** Detected recompiles, oldest first, capped at the most recent 200. */
    get eventLog(): readonly ShaderChurnEvent[] {
        return this.events;
    }

    /**
     * Feed the WebGL program list for this frame. Returns the material names
     * of programs found recompiled this frame (empty when nothing changed).
     * Cheap when the list is unchanged: programs are appended with increasing
     * ids, so a same-length list with the same last id is the same list.
     */
    observePrograms(programs: readonly ProgramIdentity[], t: number): readonly string[] {
        const n = programs.length;
        const lastId = n > 0 ? programs[n - 1]!.id : -1;
        if (n === this.prevLength && lastId === this.prevLastId) return EMPTY;
        this.prevLength = n;
        this.prevLastId = lastId;

        const current = new Set<number>();
        let hits: string[] | null = null;
        for (const p of programs) {
            current.add(p.id);
            if (this.known.has(p.id)) continue;
            this.known.set(p.id, { id: p.id, cacheKey: p.cacheKey, name: p.name });
            if (this.deletedKeys.has(p.cacheKey)) {
                const label = describeProgram(p);
                this.record(label, t);
                (hits ??= []).push(label);
            }
        }
        for (const [id, ident] of this.known) {
            if (current.has(id)) continue;
            this.known.delete(id);
            this.deletedKeys.set(ident.cacheKey, ident.name);
        }
        return hits ?? EMPTY;
    }

    /**
     * Feed the WebGPU active-program count for this frame. Returns one
     * `render pipeline` entry per recompile paired with a recent decrease.
     */
    observeProgramCount(count: number, t: number): readonly string[] {
        if (this.prevCount < 0) {
            this.prevCount = count;
            return EMPTY;
        }
        const delta = count - this.prevCount;
        this.prevCount = count;
        if (delta === 0) return EMPTY;

        if (delta < 0) {
            for (let i = 0; i < -delta; i++) this.pendingDrops.push(t);
            return EMPTY;
        }

        // Drop pairings older than the window, then pair the rise with what is left.
        while (this.pendingDrops.length > 0 && t - this.pendingDrops[0]! > WEBGPU_CHURN_PAIRING_WINDOW_MS) {
            this.pendingDrops.shift();
        }
        const paired = Math.min(delta, this.pendingDrops.length);
        if (paired === 0) return EMPTY;
        this.pendingDrops.splice(0, paired);
        const hits: string[] = [];
        for (let i = 0; i < paired; i++) {
            this.record('render pipeline', t);
            hits.push('render pipeline');
        }
        return hits;
    }

    /** Forget everything — call when a new game is loaded. */
    reset(): void {
        this.known.clear();
        this.deletedKeys.clear();
        this.prevLength = -1;
        this.prevLastId = -1;
        this.prevCount = -1;
        this.pendingDrops.length = 0;
        this.countByName.clear();
        this.total = 0;
        this.events.length = 0;
    }

    private record(name: string, t: number): void {
        const count = (this.countByName.get(name) ?? 0) + 1;
        this.countByName.set(name, count);
        this.total++;
        this.events.push({ t: Math.round(t), name, count });
        if (this.events.length > ShaderChurnDetector.EVENT_MAX) this.events.shift();
    }
}
