import * as THREE from 'three';
import { KinematicPlatform, DEFAULT_KINEMATIC_PLATFORM_OPTIONS } from 'engine/KinematicPlatform.js';
import { CrumblingPlatform, DEFAULT_CRUMBLING_PLATFORM_OPTIONS } from 'engine/CrumblingPlatform.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import type { EngineLike, GameData } from 'types/game.js';

/**
 * MechanismSystem — DATA-DRIVEN moving hazards and platforms.
 *
 * Reads the top-level `mechanisms` array in world.json and spawns each entry
 * with the engine's mechanism classes. This is the PREFERRED way to add
 * spinners, moving platforms, pendulums, crushers, conveyors, and crumbling
 * floors to a game:
 *
 *  - No game code required — the engine builds and runs them.
 *  - Fully editable: every entry's parameters appear in the creator editor's
 *    Mechanism panel, apply live, and PERSIST back into world.json (edits
 *    survive reloads — unlike mechanisms hardcoded in game code).
 *  - The AI agents and the creator UI share one source of truth.
 *
 * Entries use world-space coordinates; `y` omitted = resolved on the ground.
 *
 * World-forger challenge mechanisms are a separate, sibling system
 * (TraversalChallengeSystem — feature params in site-local frames with
 * completability semantics). This one is the simple world-space registry for
 * agent- and editor-authored mechanisms.
 */

export type MechanismType = 'spinner' | 'movingPlatform' | 'pendulum' | 'crusher' | 'conveyor' | 'crumbling';

/** The engine spawns these types itself; any OTHER `type` string is a custom
 *  mechanism owned by game code (see getSpec/registerCustom below). */
const ENGINE_TYPES: ReadonlySet<string> = new Set<MechanismType>(['spinner', 'movingPlatform', 'pendulum', 'crusher', 'conveyor', 'crumbling']);

export interface MechanismSpecLike {
    id?: string;
    type?: string;
    name?: string;
    position?: { x?: number; y?: number; z?: number };
    params?: Record<string, unknown>;
}

/**
 * Editable-parameter binding for a CUSTOM (game-code) mechanism: the clamp
 * range shown in the editor plus the live-apply callback. `display:
 * 'degPerSec'` presents a radian value in degrees.
 */
export interface CustomEditableParam {
    min: number;
    max: number;
    step: number;
    display?: 'degPerSec';
    apply: (value: number) => void;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const vec = (v: unknown, fx: number, fy: number, fz: number): THREE.Vector3 => {
    const o = (v ?? {}) as { x?: unknown; y?: unknown; z?: unknown };
    return new THREE.Vector3(num(o.x, fx), num(o.y, fy), num(o.z, fz));
};

export class MechanismSystem {
    private readonly engine: EngineLike;
    private built = false;
    private attempts = 0;
    private readonly platforms: KinematicPlatform[] = [];
    private readonly crumbling: CrumblingPlatform[] = [];

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    /** Tick mechanisms; lazily builds once the terrain answers height queries. */
    update(deltaTime: number): void {
        if (!this.built) this.tryBuild();
        for (const p of this.platforms) p.update(deltaTime);
        for (const c of this.crumbling) c.update(deltaTime);
    }

    dispose(): void {
        for (const p of this.platforms) p.dispose();
        for (const c of this.crumbling) c.dispose();
        this.platforms.length = 0;
        this.crumbling.length = 0;
        this.built = true; // never rebuild after teardown
    }

    private specs(): MechanismSpecLike[] {
        const gameData = this.engine.getGameData?.() as (GameData & { mechanisms?: MechanismSpecLike[] }) | null | undefined;
        return Array.isArray(gameData?.mechanisms) ? gameData.mechanisms : [];
    }

    /**
     * The world.json `mechanisms[]` entry for `id`, or null. CUSTOM mechanisms
     * (any `type` the engine doesn't spawn itself) read their configuration
     * from here instead of hardcoding values.
     */
    getSpec(id: string): MechanismSpecLike | null {
        return this.specs().find(s => s.id === id) ?? null;
    }

    /**
     * Bind a CUSTOM game-code mechanism to its `mechanisms[]` entry so it gets
     * the SAME editor treatment as engine-built ones: selecting its object
     * shows the Mechanism panel, edits clamp + apply live through the given
     * callbacks, and every change persists into the entry's params in
     * world.json (survives reloads).
     *
     * Contract: every tunable number a custom mechanism uses MUST live in its
     * entry's `params` (never as a code literal) and appear here — that is
     * what makes user requests like "make it spin slower" one editor slider
     * instead of an AI round-trip.
     */
    registerCustom(id: string, object3D: THREE.Object3D, editable: Record<string, CustomEditableParam>): boolean {
        const spec = this.getSpec(id);
        if (!spec) {
            console.warn(`[MechanismSystem] registerCustom("${id}"): no mechanisms[] entry with that id`);
            return false;
        }
        object3D.name = object3D.name || spec.name || `${spec.type ?? 'mechanism'} ${id}`;
        const params = spec.params ?? {};
        // Display mirror + editable spec (sans callbacks) + persist paths.
        const specOnly: Record<string, { min: number; max: number; step: number; display?: 'degPerSec' }> = {};
        const persistPaths: Record<string, string> = {};
        for (const [key, p] of Object.entries(editable)) {
            const current = params[key];
            if (typeof current === 'number') object3D.userData[key] = current;
            specOnly[key] = { min: p.min, max: p.max, step: p.step, ...(p.display ? { display: p.display } : {}) };
            persistPaths[key] = `params.${key}`;
        }
        Object.assign(object3D.userData, {
            mechanism: spec.type ?? 'custom',
            source: 'data:mechanisms',
            mechanismId: id,
        });
        const shim = {
            applyEditableParam: (key: string, value: number): boolean => {
                const p = editable[key];
                if (!p || !Number.isFinite(value)) return false;
                const v = Math.min(p.max, Math.max(p.min, value));
                p.apply(v);
                object3D.userData[key] = v;
                return true;
            },
        };
        Object.defineProperty(object3D.userData, '__editable', { value: specOnly, enumerable: false, configurable: true });
        Object.defineProperty(object3D.userData, '__mechanism', { value: shim, enumerable: false, configurable: true });
        Object.defineProperty(object3D.userData, '__persistPaths', { value: persistPaths, enumerable: false, configurable: true });
        return true;
    }

    private groundProbe(x: number, z: number): number | null {
        const pw = this.engine.physicsWorld;
        if (!pw) return null;
        const result = pw.raycast(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0), 600, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);
        return result.hasHit ? result.hitPoint.y : null;
    }

    private tryBuild(): void {
        // Only engine-spawned types build here; custom types (any other
        // `type` string) are constructed by game code via getSpec/registerCustom.
        const specs = this.specs().filter(s => typeof s.type === 'string' && ENGINE_TYPES.has(s.type));
        if (specs.length === 0) {
            this.built = true;
            return;
        }
        // Entries without an explicit y need the ground to be queryable first.
        const needsGround = specs.find(s => typeof s.position?.y !== 'number');
        if (needsGround) {
            const p = needsGround.position ?? {};
            if (this.groundProbe(num(p.x, 0), num(p.z, 0)) === null) {
                if (++this.attempts < 600) return;
                console.warn('[MechanismSystem] ground never became queryable; building anyway');
            }
        }
        for (const spec of specs) this.buildFromSpec(spec);
        this.built = true;
    }

    /** Build one mechanism entry (public so tests can drive it directly). */
    buildFromSpec(spec: MechanismSpecLike): void {
        const id = typeof spec.id === 'string' && spec.id ? spec.id : `mechanism_${this.platforms.length + this.crumbling.length}`;
        const type = spec.type as MechanismType | undefined;
        const params = spec.params ?? {};
        const px = num(spec.position?.x, 0);
        const pz = num(spec.position?.z, 0);
        const groundY = (): number => typeof spec.position?.y === 'number'
            ? spec.position.y
            : (this.groundProbe(px, pz) ?? 0);
        const name = spec.name ?? `${type ?? 'mechanism'} ${id}`;
        // Shared editor identity: entries are DATA, so edits persist by id into
        // the world.json `mechanisms` array (see ObjectInspector +
        // MECHANISM_PARAM_EDITED in the creator).
        const editorData = (persistPaths: Record<string, string>): Record<string, unknown> => ({
            source: 'data:mechanisms',
            mechanismId: id,
            __persistPaths: persistPaths,
        });

        try {
            switch (type) {
                case 'spinner': {
                    const size = vec(params.size, 4.6, 0.4, 0.7);
                    this.platforms.push(new KinematicPlatform(this.engine, {
                        ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                        waypoints: [new THREE.Vector3(px, groundY() + num(params.aboveGround, 0.9), pz)],
                        angularSpeed: num(params.angularSpeedRad, 1.2),
                        size,
                        shape: (params.shape as 'box' | 'cylinder' | 'sphere' | undefined) ?? 'box',
                        name,
                        editorData: editorData({ angularSpeedRad: 'params.angularSpeedRad' }),
                    }));
                    return;
                }
                case 'movingPlatform': {
                    const wps = Array.isArray(params.waypoints) ? params.waypoints as Array<{ x?: number; y?: number; z?: number }> : [];
                    if (wps.length < 2) {
                        console.warn(`[MechanismSystem] "${id}": movingPlatform needs >= 2 waypoints`);
                        return;
                    }
                    const above = num(params.aboveGround, 1.2);
                    const waypoints = wps.map(w => new THREE.Vector3(
                        num(w.x, px),
                        typeof w.y === 'number' ? w.y : (this.groundProbe(num(w.x, px), num(w.z, pz)) ?? 0) + above,
                        num(w.z, pz),
                    ));
                    this.platforms.push(new KinematicPlatform(this.engine, {
                        ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                        waypoints,
                        speed: num(params.speed, 2.2),
                        returnSpeed: num(params.returnSpeed, num(params.speed, 2.2)),
                        dwellS: num(params.dwellS, 0),
                        loop: (params.loop as 'loop' | 'pingpong' | 'once' | undefined) ?? 'pingpong',
                        trigger: (params.trigger as 'always' | 'proximity' | 'key' | undefined) ?? 'always',
                        proximityRadius: num(params.proximityRadius, 5),
                        size: vec(params.size, 3.2, 0.5, 3.2),
                        name,
                        editorData: editorData({
                            speed: 'params.speed',
                            returnSpeed: 'params.returnSpeed',
                            dwellS: 'params.dwellS',
                        }),
                    }));
                    return;
                }
                case 'pendulum': {
                    const pivotY = groundY() + num(params.pivotHeight, 4.6);
                    this.platforms.push(new KinematicPlatform(this.engine, {
                        ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                        waypoints: [new THREE.Vector3(px, pivotY, pz)],
                        speed: 0,
                        pendulum: {
                            armLength: num(params.armLength, 3.4),
                            periodS: num(params.periodS, 2.2),
                            amplitudeDeg: num(params.amplitudeDeg, 55),
                            swingYawDeg: num(params.swingYawDeg, 0),
                            phaseDeg: num(params.phaseDeg, 0),
                        },
                        size: vec(params.size, 0.5, 1.1, 0.4),
                        name,
                        editorData: editorData({
                            pendulumArmLength: 'params.armLength',
                            pendulumPeriodS: 'params.periodS',
                            pendulumAmplitudeDeg: 'params.amplitudeDeg',
                        }),
                    }));
                    return;
                }
                case 'crusher': {
                    const size = vec(params.size, 2.4, 1.4, 2.2);
                    const g = groundY();
                    const startLow = params.startLow === true;
                    const slam = num(params.slamSpeed, 8);
                    const rise = num(params.riseSpeed, 2);
                    const top = new THREE.Vector3(px, g + num(params.topClearance, 2.6) + size.y / 2, pz);
                    const low = new THREE.Vector3(px, g + num(params.floorGap, 0.15) + size.y / 2, pz);
                    this.platforms.push(new KinematicPlatform(this.engine, {
                        ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                        waypoints: startLow ? [low, top] : [top, low],
                        speed: startLow ? rise : slam,
                        returnSpeed: startLow ? slam : rise,
                        dwellS: num(params.dwellS, 0.9),
                        size,
                        name,
                        editorData: editorData({
                            speed: startLow ? 'params.riseSpeed' : 'params.slamSpeed',
                            returnSpeed: startLow ? 'params.slamSpeed' : 'params.riseSpeed',
                            dwellS: 'params.dwellS',
                        }),
                    }));
                    return;
                }
                case 'conveyor': {
                    const sv = (params.surfaceVelocity ?? {}) as { x?: number; z?: number };
                    this.platforms.push(new KinematicPlatform(this.engine, {
                        ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                        waypoints: [new THREE.Vector3(px, groundY() + num(params.aboveGround, 0.25), pz)],
                        surfaceVelocity: { x: num(sv.x, 2), z: num(sv.z, 0) },
                        size: vec(params.size, 12, 0.4, 3),
                        name,
                        editorData: editorData({
                            conveyorVelX: 'params.surfaceVelocity.x',
                            conveyorVelZ: 'params.surfaceVelocity.z',
                        }),
                    }));
                    return;
                }
                case 'crumbling': {
                    const size = vec(params.size, 2.9, 0.5, 2.9);
                    const top = groundY() + num(params.topAboveGround, 0);
                    this.crumbling.push(new CrumblingPlatform(this.engine, {
                        ...DEFAULT_CRUMBLING_PLATFORM_OPTIONS,
                        size,
                        center: new THREE.Vector3(px, top - size.y / 2, pz),
                        breakAfterS: num(params.breakAfterS, DEFAULT_CRUMBLING_PLATFORM_OPTIONS.breakAfterS),
                        respawnAfterS: num(params.respawnAfterS, DEFAULT_CRUMBLING_PLATFORM_OPTIONS.respawnAfterS),
                        getPlayerFeet: () => {
                            const pc = this.engine.getPlayerController();
                            return pc?.getGroundPosition?.() ?? null;
                        },
                        name,
                        editorData: editorData({
                            breakAfterS: 'params.breakAfterS',
                            respawnAfterS: 'params.respawnAfterS',
                        }),
                    }));
                    return;
                }
                default:
                    // A type the engine doesn't spawn = a CUSTOM mechanism owned
                    // by game code (getSpec + registerCustom). Not an error.
                    if (typeof type !== 'string' || !type) {
                        console.warn(`[MechanismSystem] "${id}": entry has no mechanism type`);
                    }
            }
        } catch (err) {
            console.error(`[MechanismSystem] failed to build "${id}":`, err);
        }
    }
}
