/**
 * CharacterLodScheduler — the central brain of the NPC/animal LOD system.
 *
 * A module-global scheduler (navmesh-global pattern: getGlobalLodScheduler())
 * stamps a CharacterLodState on every registered character once per frame.
 * Controllers read the stamped state and gate their own work (AI, animation,
 * avoidance, shadows); the scheduler only stamps booleans — controllers keep
 * their own dt accumulators.
 *
 * Rings (distance bands, hysteresis at the boundaries):
 *   R0 = near (full rate), R1 = mid (reduced rates), R2 = far/off-frustum.
 * Sim classes: FULL, COARSE (R1 crowd), VIRTUAL (R2 crowd with a goal),
 * HIBERNATED (R2 crowd without a goal). Heroes are always FULL.
 *
 * Sim class and AI/avoidance tick rates follow the DISTANCE ring only
 * (rec.distRing) — a zombie 3 m behind the camera must keep moving, keep its
 * physics body, and stay hittable. The frustum only gates cosmetic work: the
 * EFFECTIVE ring (off-frustum forces 2) drives the animation tick rate and
 * ring-gated visuals (nameplates, damage rings, anim pause off-frustum).
 *
 * Per-frame work caps are enforced with round-robin fairness: due characters
 * that miss the cap stay due, and the rotating start cursor guarantees every
 * crowd character is eventually served.
 */
import * as THREE from 'three';
import { getGlobalGoalFields } from 'engine/npc/nav/GoalField.js';
import { getGlobalPathQueue } from 'engine/npc/nav/PathRequestQueue.js';
import { getGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';

export enum SimClass { FULL = 0, COARSE = 1, VIRTUAL = 2, HIBERNATED = 3 }
export type LodRing = 0 | 1 | 2;
export type CharacterImportance = 'hero' | 'crowd';

export interface CharacterLodState {
    /**
     * EFFECTIVE ring: the distance ring clamped to 2 for anything off-frustum.
     * Right for work whose cost only matters when the character is SEEN
     * (animation rate, shadows, corpse ragdoll sync). WRONG for lifecycle
     * decisions — an NPC 4 m behind the camera stamps ring 2 here.
     */
    ring: LodRing;
    /**
     * DISTANCE ring, frustum-free: 2 only when genuinely far from both the
     * camera and the player. This is the ring for simulation-lifecycle
     * decisions (hibernation parking): parking off the EFFECTIVE ring froze
     * every off-screen guard NPC solid — a troll four metres behind the player
     * parked, its behavior stopped ticking, and nothing could ever wake it.
     */
    distRing: LodRing;
    simClass: SimClass;
    tickAi: boolean;
    tickAnim: boolean;
    tickAvoidance: boolean;
    castShadow: boolean;
    onFrustum: boolean;
}

export interface LodManagedCharacter {
    getPosition(): THREE.Vector3;
    getImportance(): CharacterImportance;
    isDeadOrRagdolled(): boolean;
    hasActiveGoal(): boolean;
    /** Stamped by the scheduler every evaluate(); read-only for the character. */
    lodState: CharacterLodState;
    /** Optional: notified when ring or simClass changes (shadow flips, body enable/disable). */
    onLodChanged?(prev: CharacterLodState, next: CharacterLodState): void;
    /** Optional: one-line controller-side detail for dumpStates() diagnostics. */
    getLodDebugInfo?(): string;
}

/**
 * The scheduler's tuning. An explicit interface rather than `typeof DEFAULT_CHARACTER_LOD`,
 * because `scaleCharacterLod` derives a per-device variant and `as const`'s literal types
 * reject any value but the authored one — see `docs/engine-options-pattern.md`: required
 * fields, one exported `DEFAULT_*`, no optional-with-fallback chains.
 */
export interface CharacterLodConfig {
    /** Ring 0 (full simulation) outer radius, metres. */
    r0DistanceM: number;
    /** Ring 1 (reduced rates) outer radius, metres. Beyond it is ring 2. */
    r1DistanceM: number;
    /** Fraction of a ring radius a character must cross back over to leave it. */
    hysteresisFraction: number;
    /** Per-ring tick rates in Hz; 0 means every frame in r0 and never in r2. */
    rates: {
        r0: { aiHz: number; animHz: number; avoidanceHz: number };
        r1: { aiHz: number; animHz: number; avoidanceHz: number };
        r2: { aiHz: number; animHz: number; avoidanceHz: number };
    };
    /** Per-frame work budgets, shared round-robin so no character starves. */
    caps: { aiPerFrame: number; animPerFrame: number; avoidancePerFrame: number };
    virtualOnFrustumHz: number;
    farEvalStaggerFrames: number;
    /** Characters closer than this re-evaluate their ring every frame. */
    nearEvalDistanceM: number;
    boundingRadiusM: number;
    /** `castShadow` only in rings at or below this. */
    shadowMaxRing: LodRing;
    accumClampS: number;
}

export const DEFAULT_CHARACTER_LOD: CharacterLodConfig = {
    r0DistanceM: 25,
    r1DistanceM: 60,
    hysteresisFraction: 0.12,
    rates: {
        r0: { aiHz: 0, animHz: 0, avoidanceHz: 0 },   // 0 = every frame
        r1: { aiHz: 5, animHz: 15, avoidanceHz: 3 },
        r2: { aiHz: 1, animHz: 5, avoidanceHz: 0 },   // avoidance 0 Hz in R2 = never (see code)
    },
    caps: { aiPerFrame: 40, animPerFrame: 60, avoidancePerFrame: 8 },
    virtualOnFrustumHz: 5,
    farEvalStaggerFrames: 10,
    nearEvalDistanceM: 80,        // chars closer than this re-evaluate ring every frame
    boundingRadiusM: 1.2,
    shadowMaxRing: 1,             // castShadow only in rings <= this
    accumClampS: 10,
};

/**
 * The same schedule, tightened by the device quality tier's `characterLodScale`.
 *
 * Pulls the ring distances IN and lowers the per-frame work caps, so a weaker device
 * demotes more characters to the r1/r2 tick rates and does less of that work per frame.
 * This module had no device branch at all before the tier existed, which made it the one
 * place a phone was doing full desktop character simulation — so a scale of 1 at the top
 * rungs preserves today's behaviour exactly and the lower rungs get a genuinely new saving.
 *
 * Deliberately NOT scaled: `rates` (a ring's tick rate is what that ring MEANS — scaling it
 * would make "r1" a different thing per device and make a bug report unreadable),
 * `hysteresisFraction` (a stability margin, not a cost), `boundingRadiusM` (a fact about
 * characters) and `shadowMaxRing` (already ring-derived, so it follows for free).
 *
 * Caps floor at 1: a scale that rounded one to zero would stop that work happening at all
 * rather than happening less often, which is a hang, not a saving.
 */
export function scaleCharacterLod(
    base: CharacterLodConfig,
    scale: number,
): CharacterLodConfig {
    if (scale >= 1) return base;
    const cap = (n: number): number => Math.max(1, Math.round(n * scale));
    return {
        ...base,
        r0DistanceM: base.r0DistanceM * scale,
        r1DistanceM: base.r1DistanceM * scale,
        nearEvalDistanceM: base.nearEvalDistanceM * scale,
        caps: {
            aiPerFrame: cap(base.caps.aiPerFrame),
            animPerFrame: cap(base.caps.animPerFrame),
            avoidancePerFrame: cap(base.caps.avoidancePerFrame),
        },
    };
}

/** Stamped state for controllers to use before the first evaluate / when the scheduler is absent. */
/** Window (seconds) over which same-frame-registered characters' first ticks
 *  are spread; sets the permanent per-character tick phase offsets. */
const TICK_PHASE_SPREAD_S = 0.25;

export const ALWAYS_FULL_LOD_STATE: CharacterLodState = Object.freeze({
    ring: 0 as LodRing,
    distRing: 0 as LodRing,
    simClass: SimClass.FULL,
    tickAi: true,
    tickAnim: true,
    tickAvoidance: true,
    castShadow: true,
    onFrustum: true,
});

export interface CharacterLodStats {
    total: number;
    byRing: [number, number, number];
    bySimClass: { full: number; coarse: number; virtual: number; hibernated: number };
    aiGrantedLastFrame: number;
    animGrantedLastFrame: number;
    avoidanceGrantedLastFrame: number;
    maxFramesSinceAiTick: number;
}

interface InternalRecord {
    char: LodManagedCharacter;
    /** Incremental slot id assigned on first sight — round-robin + stagger key. */
    slot: number;
    /** False until the first distance/frustum refresh. */
    initialized: boolean;
    distance: number;
    onFrustum: boolean;
    /** Distance-only ring memory for hysteresis (frustum-independent). */
    distRing: LodRing;
    /** Effective ring (off-frustum forces 2). */
    ring: LodRing;
    simClass: SimClass;
    isHero: boolean;
    isDead: boolean;
    /** Seconds accumulated since the last granted tick, per work type. */
    elapsedAi: number;
    elapsedAnim: number;
    elapsedAvoid: number;
    framesSinceAiTick: number;
    /** Per-frame grant scratch. */
    grantAi: boolean;
    grantAnim: boolean;
    grantAvoid: boolean;
    lastState: CharacterLodState | null;
}

/** Log a broken onLodChanged callback only once per session. */
let loggedCallbackError = false;

export class CharacterLodScheduler {
    private config: CharacterLodConfig;
    private readonly records = new Map<LodManagedCharacter, InternalRecord>();
    private nextSlot = 0;
    private frameCounter = 0;
    private enabled = true;

    /** CPU ms spent in the last drainNavigationQueues (A* + goal-field flood).
     *  Reported rather than recorded here so this module keeps no dependency on
     *  the debug HUD; GameEngine attributes it and subtracts it from 'npc'. */
    private lastNavDrainMs = 0;

    private aiCursor = -1;
    private animCursor = -1;
    private avoidCursor = -1;

    private stats: CharacterLodStats = {
        total: 0,
        byRing: [0, 0, 0],
        bySimClass: { full: 0, coarse: 0, virtual: 0, hibernated: 0 },
        aiGrantedLastFrame: 0,
        animGrantedLastFrame: 0,
        avoidanceGrantedLastFrame: 0,
        maxFramesSinceAiTick: 0,
    };

    private readonly frustum = new THREE.Frustum();
    private readonly projScreenMatrix = new THREE.Matrix4();
    private readonly sphere = new THREE.Sphere();
    private readonly cameraPos = new THREE.Vector3();

    constructor(config: CharacterLodConfig = DEFAULT_CHARACTER_LOD) {
        this.config = config;
    }

    /** Idempotent — re-registering an already-known character keeps its record. */
    registerCharacter(c: LodManagedCharacter): void {
        if (this.records.has(c)) return;
        // Per-character tick phase (golden-ratio slot hash, 0..1). Characters
        // registered in the same frame (a spawn loop of 50 zombies) must NOT
        // share tick phase: grants reset elapsed together, so a shared phase
        // locks the whole crowd into ticking on the SAME frame forever — e.g.
        // 50 synchronized 15 Hz pose updates every 4th frame is a recurring
        // multi-ms frame spike instead of a smooth ~13 per frame.
        const slot = this.nextSlot++;
        const phase = (slot * 0.618034) % 1;
        this.records.set(c, {
            char: c,
            slot,
            initialized: false,
            distance: 0,
            onFrustum: true,
            distRing: 2,
            ring: 2,
            simClass: SimClass.FULL,
            isHero: false,
            isDead: false,
            // Negative start = each character's first tick lands a few frames
            // apart (up to TICK_PHASE_SPREAD_S late), permanently de-phasing
            // per-character tick cycles from then on.
            elapsedAi: -phase * TICK_PHASE_SPREAD_S,
            elapsedAnim: -phase * TICK_PHASE_SPREAD_S,
            elapsedAvoid: -phase * TICK_PHASE_SPREAD_S,
            framesSinceAiTick: 0,
            grantAi: false,
            grantAnim: false,
            grantAvoid: false,
            lastState: null,
        });
    }

    unregisterCharacter(c: LodManagedCharacter): void {
        this.records.delete(c);
    }

    /**
     * Swap the tuning mid-session, for a quality-tier change.
     *
     * Safe to do live: the ring distances and per-frame caps are read fresh on every
     * evaluate, and the per-character accumulators carry seconds rather than ring-relative
     * state, so a character simply lands in whichever ring its distance now puts it in on
     * the next evaluation. Hysteresis smooths the boundary the same way it does for a
     * character that walked there.
     */
    setConfig(config: CharacterLodConfig): void {
        this.config = config;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Stamp every registered character for this frame. Call once per frame,
     * after physics and before controller updates.
     *
     * `playerPosition` (optional): when provided, the distance metric per
     * character becomes min(distance to camera, distance to player) — in
     * zoomed-out genres the camera can be 100 m overhead while NPCs brush
     * shoulders with the player, and those NPCs must simulate at full rate.
     *
     * `camera` may be null (e.g. during engine startup before the camera
     * exists): everyone is stamped FULL/all-ticks, but the navigation queues
     * are still drained so pathfinding never silently freezes.
     */
    evaluate(camera: THREE.Camera | null, deltaTime: number, playerPosition?: THREE.Vector3 | null): void {
        this.frameCounter++;
        if (!this.enabled || !camera) {
            this.stampAllFull();
            // Even with LOD disabled (or no camera), async path requests must still resolve.
            this.drainNavigationQueues(deltaTime);
            return;
        }

        this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
        this.cameraPos.setFromMatrixPosition(camera.matrixWorld);

        const dueAiCrowd: InternalRecord[] = [];
        const dueAnimCrowd: InternalRecord[] = [];
        const dueAvoidCrowd: InternalRecord[] = [];
        let aiGranted = 0;
        let animGranted = 0;
        let avoidGranted = 0;

        // Pass 1: refresh distance/frustum (staggered for far characters),
        // resolve ring + sim class, accumulate elapsed time, collect due work.
        for (const rec of this.records.values()) {
            const c = rec.char;
            rec.grantAi = false;
            rec.grantAnim = false;
            rec.grantAvoid = false;
            rec.isHero = c.getImportance() === 'hero';
            rec.isDead = c.isDeadOrRagdolled();
            if (rec.isDead) {
                // Dead/ragdolled characters keep a REAL, per-frame-refreshed
                // ring (no stagger): the controller ring-gates corpse ragdoll
                // sync on the stamp, so a corpse must start syncing when the
                // camera approaches and stop when it leaves. Sim class stays
                // FULL (stamped in pass 2); no ticks/grants are involved.
                const pos = c.getPosition();
                rec.distance = pos.distanceTo(this.cameraPos);
                if (playerPosition) {
                    rec.distance = Math.min(rec.distance, pos.distanceTo(playerPosition));
                }
                this.sphere.center.copy(pos);
                this.sphere.radius = this.config.boundingRadiusM;
                rec.onFrustum = this.frustum.intersectsSphere(this.sphere);
                rec.distRing = rec.initialized
                    ? this.applyHysteresis(rec.distance, rec.distRing)
                    : this.nominalRing(rec.distance);
                rec.initialized = true;
                rec.ring = rec.onFrustum ? rec.distRing : 2;
                continue; // stamped in pass 2
            }

            const firstSight = !rec.initialized;
            const near = firstSight || rec.distance <= this.config.nearEvalDistanceM;
            const staggerHit =
                this.frameCounter % this.config.farEvalStaggerFrames ===
                rec.slot % this.config.farEvalStaggerFrames;
            if (firstSight || near || staggerHit) {
                const pos = c.getPosition();
                rec.distance = pos.distanceTo(this.cameraPos);
                if (playerPosition) {
                    rec.distance = Math.min(rec.distance, pos.distanceTo(playerPosition));
                }
                this.sphere.center.copy(pos);
                this.sphere.radius = this.config.boundingRadiusM;
                rec.onFrustum = this.frustum.intersectsSphere(this.sphere);
                rec.initialized = true;
            }

            rec.distRing = firstSight
                ? this.nominalRing(rec.distance)
                : this.applyHysteresis(rec.distance, rec.distRing);
            rec.ring = rec.onFrustum ? rec.distRing : 2;
            rec.simClass = this.resolveSimClass(rec);

            const clamp = this.config.accumClampS;
            rec.elapsedAi = Math.min(rec.elapsedAi + deltaTime, clamp);
            rec.elapsedAnim = Math.min(rec.elapsedAnim + deltaTime, clamp);
            rec.elapsedAvoid = Math.min(rec.elapsedAvoid + deltaTime, clamp);

            if (rec.isHero) {
                // Heroes: AI and avoidance every frame, anim by ring rate — all exempt from caps.
                rec.grantAi = true;
                rec.elapsedAi = 0;
                rec.grantAvoid = true;
                rec.elapsedAvoid = 0;
                if (this.isDue(rec.elapsedAnim, this.animInterval(rec.ring))) {
                    rec.grantAnim = true;
                    rec.elapsedAnim = 0;
                    animGranted++;
                }
                aiGranted++;
                avoidGranted++;
                continue;
            }

            // HIBERNATED means FROZEN. Ticks were previously handed out purely by
            // distance ring, so a hibernated NPC still received animation ticks at
            // the r2 rate and posed itself — and posing is the single most
            // expensive thing an NPC does (~1.8 ms: a forced walk of a ~65-bone
            // skeleton, a 19-group part hierarchy, and a bounding-box rebuild).
            //
            // Measured with 30 NPCs, ALL hibernated: npcPose 20.6 ms. Nothing was
            // moving, nothing was visible, and the frame was still paying for
            // every one of them. The tier existed but bought nothing.
            //
            // AI is withheld for the same reason and is safe: a hibernated NPC is
            // beyond r1 from both camera and player and holds no goal, so there is
            // nothing for it to decide. Approach re-evaluates the ring (every
            // farEvalStaggerFrames at distance) and promotes it before it can
            // matter.
            if (rec.simClass === SimClass.HIBERNATED) continue;

            if (this.isDue(rec.elapsedAi, this.aiInterval(rec))) dueAiCrowd.push(rec);
            if (this.isDue(rec.elapsedAnim, this.animInterval(rec.ring))) dueAnimCrowd.push(rec);
            // Avoidance never ticks in distance-R2 (rates.r2.avoidanceHz 0 means "off",
            // not "every frame"). Distance ring, not effective ring: a near
            // off-frustum character still needs collision avoidance.
            if (rec.distRing !== 2 && this.isDue(rec.elapsedAvoid, this.avoidInterval(rec.distRing))) {
                dueAvoidCrowd.push(rec);
            }
        }

        // Grant capped crowd work round-robin (rotating start cursor = fairness).
        this.aiCursor = this.grantRoundRobin(dueAiCrowd, this.aiCursor, this.config.caps.aiPerFrame, 'ai');
        this.animCursor = this.grantRoundRobin(dueAnimCrowd, this.animCursor, this.config.caps.animPerFrame, 'anim');
        this.avoidCursor = this.grantRoundRobin(dueAvoidCrowd, this.avoidCursor, this.config.caps.avoidancePerFrame, 'avoid');

        // Pass 2: stamp states, fire transition callbacks, gather stats.
        const byRing: [number, number, number] = [0, 0, 0];
        const bySimClass = { full: 0, coarse: 0, virtual: 0, hibernated: 0 };
        let maxStarvation = 0;
        for (const rec of this.records.values()) {
            if (rec.isDead) {
                // Dead/ragdolled characters are exempt from sim-class demotion
                // (FULL, all ticks, no transition callbacks) but are stamped
                // with their REAL ring — refreshed every frame in pass 1 — so
                // ring-gated corpse work (ragdoll sync) tracks the camera.
                const state = this.makeFullState();
                state.ring = rec.ring;
                state.distRing = rec.distRing;
                state.onFrustum = rec.onFrustum;
                state.castShadow = rec.distRing <= this.config.shadowMaxRing;
                rec.char.lodState = state;
                rec.lastState = state;
                rec.framesSinceAiTick = 0;
                byRing[rec.ring]++;
                bySimClass.full++;
                continue;
            }
            if (!rec.isHero) {
                if (rec.grantAi) {
                    aiGranted++;
                    rec.elapsedAi = 0;
                    rec.framesSinceAiTick = 0;
                } else {
                    rec.framesSinceAiTick++;
                    // Hibernated characters are EXCLUDED from the starvation
                    // metric. It exists to catch a crowd NPC that the round-robin
                    // caps never get to; a hibernated one is intentionally never
                    // served, so counting it pins the number in the thousands and
                    // makes a working system read as broken.
                    if (rec.simClass !== SimClass.HIBERNATED) {
                        maxStarvation = Math.max(maxStarvation, rec.framesSinceAiTick);
                    }
                }
                if (rec.grantAnim) {
                    animGranted++;
                    rec.elapsedAnim = 0;
                }
                if (rec.grantAvoid) {
                    avoidGranted++;
                    rec.elapsedAvoid = 0;
                }
            }

            const next: CharacterLodState = {
                ring: rec.ring,
                distRing: rec.distRing,
                simClass: rec.simClass,
                tickAi: rec.grantAi,
                tickAnim: rec.grantAnim,
                tickAvoidance: rec.distRing === 2 && !rec.isHero ? false : rec.grantAvoid,
                // Shadows follow the DISTANCE-only ring, not the frustum-forced
                // effective ring: an off-frustum NPC 5 m away must keep casting
                // (its shadow can still fall on-screen).
                castShadow: rec.distRing <= this.config.shadowMaxRing,
                onFrustum: rec.onFrustum,
            };
            const prev = rec.lastState ?? ALWAYS_FULL_LOD_STATE;
            rec.char.lodState = next;
            rec.lastState = next;
            this.notifyIfChanged(rec.char, prev, next);

            byRing[next.ring]++;
            switch (next.simClass) {
                case SimClass.FULL: bySimClass.full++; break;
                case SimClass.COARSE: bySimClass.coarse++; break;
                case SimClass.VIRTUAL: bySimClass.virtual++; break;
                case SimClass.HIBERNATED: bySimClass.hibernated++; break;
            }
        }

        this.stats = {
            total: this.records.size,
            byRing,
            bySimClass,
            aiGrantedLastFrame: aiGranted,
            animGrantedLastFrame: animGranted,
            avoidanceGrantedLastFrame: avoidGranted,
            maxFramesSinceAiTick: maxStarvation,
        };

        // Frame-budgeted navigation work (path queue, goal fields) is drained here.
        this.drainNavigationQueues(deltaTime);
    }

    /**
     * Drain the frame-budgeted async navigation work. When the navmesh is not
     * ready, requests simply wait in the queue (NavigationComponent's legacy
     * fallback branch never submits here) and goal-field flood work is skipped
     * — completed goal-field front buffers keep serving sampleDirection.
     */
    private drainNavigationQueues(deltaTime: number): void {
        // Attributed separately from the rest of the NPC update: this is A* and
        // goal-field flooding, whose cost tracks PATH DEMAND rather than NPC
        // count, and it is budgeted independently. Folding it into 'npc' hid a
        // ~20 ms span behind a number that looked like per-NPC AI.
        const _t0 = performance.now();
        const nav = getGlobalNavMesh();
        const readyNav = nav && nav.isReady() ? nav : null;
        if (readyNav) {
            getGlobalPathQueue().update((s, g, extras, maxLen) => readyNav.findPath(s, g, extras, maxLen));
        }
        getGlobalGoalFields().update(deltaTime, readyNav);
        this.lastNavDrainMs = performance.now() - _t0;
    }

    /** CPU ms of the last navigation drain — see lastNavDrainMs. */
    getLastNavDrainMs(): number {
        return this.lastNavDrainMs;
    }

    getStats(): CharacterLodStats {
        return { ...this.stats, total: this.records.size };
    }

    getStatsLine(): string {
        const s = this.stats;
        return `NPC LOD: ${this.records.size} (r0 ${s.byRing[0]} r1 ${s.byRing[1]} r2 ${s.byRing[2]}) ` +
            `sim F${s.bySimClass.full}/C${s.bySimClass.coarse}/V${s.bySimClass.virtual}/H${s.bySimClass.hibernated} ` +
            `ai ${s.aiGrantedLastFrame} anim ${s.animGrantedLastFrame} avoid ${s.avoidanceGrantedLastFrame} ` +
            `starve ${s.maxFramesSinceAiTick}f`;
    }

    /**
     * One line per registered character: scheduler-side record fields plus the
     * controller's optional getLodDebugInfo() detail. Diagnostics only (debug
     * panel dump button) — never called per-frame.
     */
    dumpStates(): string {
        const simName = ['FULL', 'COARSE', 'VIRTUAL', 'HIBERNATED'];
        const lines: string[] = [`CharacterLodScheduler dump: ${this.records.size} chars, enabled=${this.enabled}, frame=${this.frameCounter}`];
        let i = 0;
        for (const rec of this.records.values()) {
            const s = rec.lastState;
            // Stamped simClass when available (dead chars skip pass-1 resolution
            // but are stamped FULL — the stamp is what the controller acts on).
            const sim = s ? s.simClass : rec.simClass;
            let line = `#${i} slot=${rec.slot} ${rec.char.getImportance()}` +
                `${rec.isDead ? ' DEAD' : ''}` +
                ` d=${rec.distance.toFixed(1)} distRing=${rec.distRing} ring=${rec.ring}` +
                ` frustum=${rec.onFrustum ? 'y' : 'n'} sim=${simName[sim] ?? '?'}` +
                ` ai=${s ? (s.tickAi ? 'y' : 'n') : '-'} anim=${s ? (s.tickAnim ? 'y' : 'n') : '-'}`;
            if (rec.char.getLodDebugInfo) {
                try {
                    line += ` | ${rec.char.getLodDebugInfo()}`;
                } catch (err) {
                    line += ` | debugInfo threw: ${String(err)}`;
                }
            }
            lines.push(line);
            i++;
        }
        return lines.join('\n');
    }

    // --- internals ---

    /** Disabled mode: stamp everyone FULL with all ticks on. */
    private stampAllFull(): void {
        const byRing: [number, number, number] = [0, 0, 0];
        for (const rec of this.records.values()) {
            const next = this.makeFullState();
            const prev = rec.lastState ?? ALWAYS_FULL_LOD_STATE;
            rec.char.lodState = next;
            rec.lastState = next;
            rec.framesSinceAiTick = 0;
            if (!rec.char.isDeadOrRagdolled()) this.notifyIfChanged(rec.char, prev, next);
        }
        byRing[0] = this.records.size;
        this.stats = {
            total: this.records.size,
            byRing,
            bySimClass: { full: this.records.size, coarse: 0, virtual: 0, hibernated: 0 },
            aiGrantedLastFrame: this.records.size,
            animGrantedLastFrame: this.records.size,
            avoidanceGrantedLastFrame: this.records.size,
            maxFramesSinceAiTick: 0,
        };
    }

    private makeFullState(): CharacterLodState {
        return {
            ring: 0,
            distRing: 0,
            simClass: SimClass.FULL,
            tickAi: true,
            tickAnim: true,
            tickAvoidance: true,
            castShadow: true,
            onFrustum: true,
        };
    }

    private nominalRing(distance: number): LodRing {
        if (distance < this.config.r0DistanceM) return 0;
        if (distance < this.config.r1DistanceM) return 1;
        return 2;
    }

    /**
     * A character keeps its distance ring until it exits the hysteresis band
     * threshold * (1 +/- hysteresisFraction) in the appropriate direction.
     * Demotions cascade before promotions so large jumps settle in one call.
     */
    private applyHysteresis(distance: number, current: LodRing): LodRing {
        const h = this.config.hysteresisFraction;
        const r0 = this.config.r0DistanceM;
        const r1 = this.config.r1DistanceM;
        let ring = current;
        if (ring === 0 && distance > r0 * (1 + h)) ring = 1;
        if (ring === 1 && distance > r1 * (1 + h)) ring = 2;
        if (ring === 2 && distance < r1 * (1 - h)) ring = 1;
        if (ring === 1 && distance < r0 * (1 - h)) ring = 0;
        return ring;
    }

    /**
     * Sim class follows the DISTANCE ring only — the frustum must never
     * disembody a character. A crowd NPC 3 m behind the camera stays FULL:
     * its body stays enabled (vehicles hit it), its AI keeps ticking (it
     * keeps chasing), only its animation pauses (effective ring 2).
     */
    private resolveSimClass(rec: InternalRecord): SimClass {
        if (rec.isHero) return SimClass.FULL;
        if (rec.distRing === 0) return SimClass.FULL;
        if (rec.distRing === 1) return SimClass.COARSE;
        return rec.char.hasActiveGoal() ? SimClass.VIRTUAL : SimClass.HIBERNATED;
    }

    /** Interval in seconds between ticks; 0 = every frame. Distance ring, not effective ring. */
    private aiInterval(rec: InternalRecord): number {
        switch (rec.distRing) {
            case 0: return this.hzToInterval(this.config.rates.r0.aiHz);
            case 1: return this.hzToInterval(this.config.rates.r1.aiHz);
            case 2:
                if (rec.simClass === SimClass.VIRTUAL && rec.onFrustum) {
                    return this.hzToInterval(this.config.virtualOnFrustumHz);
                }
                return this.hzToInterval(this.config.rates.r2.aiHz);
        }
    }

    private animInterval(ring: LodRing): number {
        switch (ring) {
            case 0: return this.hzToInterval(this.config.rates.r0.animHz);
            case 1: return this.hzToInterval(this.config.rates.r1.animHz);
            case 2: return this.hzToInterval(this.config.rates.r2.animHz);
        }
    }

    /** Only meaningful for rings 0-1; R2 avoidance is hard-coded off by the caller. */
    private avoidInterval(ring: LodRing): number {
        switch (ring) {
            case 0: return this.hzToInterval(this.config.rates.r0.avoidanceHz);
            case 1: return this.hzToInterval(this.config.rates.r1.avoidanceHz);
            case 2: return Infinity;
        }
    }

    /** 0 Hz encodes "every frame" for R0 rates; otherwise the period in seconds. */
    private hzToInterval(hz: number): number {
        return hz === 0 ? 0 : 1 / hz;
    }

    private isDue(elapsed: number, interval: number): boolean {
        if (interval === 0) return true;
        return elapsed >= interval;
    }

    /**
     * Grant up to `cap` ticks among `due`, starting after the last-granted slot
     * (rotating cursor). Un-granted characters stay due — their elapsed keeps
     * growing — so fairness comes from the cursor rotation. Returns the new cursor.
     */
    private grantRoundRobin(due: InternalRecord[], cursor: number, cap: number, work: 'ai' | 'anim' | 'avoid'): number {
        if (due.length === 0 || cap <= 0) return cursor;
        due.sort((a, b) => a.slot - b.slot);
        let start = due.findIndex((r) => r.slot > cursor);
        if (start < 0) start = 0;
        const grants = Math.min(cap, due.length);
        let newCursor = cursor;
        for (let i = 0; i < grants; i++) {
            const rec = due[(start + i) % due.length];
            if (!rec) continue;
            if (work === 'ai') rec.grantAi = true;
            else if (work === 'anim') rec.grantAnim = true;
            else rec.grantAvoid = true;
            newCursor = rec.slot;
        }
        return newCursor;
    }

    private notifyIfChanged(c: LodManagedCharacter, prev: CharacterLodState, next: CharacterLodState): void {
        if (!c.onLodChanged) return;
        if (prev.ring === next.ring && prev.simClass === next.simClass && prev.castShadow === next.castShadow) return;
        try {
            c.onLodChanged(prev, next);
        } catch (err) {
            if (!loggedCallbackError) {
                loggedCallbackError = true;
                console.warn('[CharacterLodScheduler] onLodChanged callback threw (logged once per session):', err);
            }
        }
    }
}

let globalScheduler: CharacterLodScheduler | null = null;

export function getGlobalLodScheduler(): CharacterLodScheduler {
    if (!globalScheduler) {
        globalScheduler = new CharacterLodScheduler(
            scaleCharacterLod(DEFAULT_CHARACTER_LOD, activeQualityPolicy().live.characterLodScale),
        );
    }
    return globalScheduler;
}

export function disposeGlobalLodScheduler(): void {
    globalScheduler = null;
}
