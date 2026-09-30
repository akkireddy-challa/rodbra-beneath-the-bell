import * as THREE from 'three';
import { KinematicPlatform, DEFAULT_KINEMATIC_PLATFORM_OPTIONS } from 'engine/KinematicPlatform.js';
import { CrumblingPlatform, DEFAULT_CRUMBLING_PLATFORM_OPTIONS } from 'engine/CrumblingPlatform.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import type { EngineLike, ForgedLevelFeature } from 'types/game.js';
import { forgedFeatures } from 'engine/ForgedLevelData.js';

/**
 * TraversalChallengeSystem — the ENGINE realization of the world-forger's
 * completability-critical challenge mechanisms: moving-platform ferries,
 * vertical lifts, crumbling crossings, spinner gauntlets, pusher alleys,
 * pendulum bridges, crusher alleys, and mesa ascent lifts.
 *
 * Why the engine and not the per-game AI code: these mechanisms are the ONLY
 * way past their blocker walls. When their construction was delegated to the
 * coding agent, one missed or mis-transformed build made a level unfinishable
 * (and each game re-derived the same local→world math). The forge marks its
 * features `params.engineAutoBuild: true`; this system builds and runs exactly
 * those, deterministically, from the same params the docs describe. Games
 * forged before the flag keep their agent-built mechanisms (no double-build).
 *
 * Coordinate contract (identical to the docs): mechanism positions are LOCAL
 * to `params.dir` at the feature's `points[0]` — local +Z along dir, +X to its
 * right; heights are relative to the TERRAIN ground at each spot (terrain-only
 * raycast, so blocker walls and pads never offset the reference).
 */

/**
 * The forged features this system builds from — the engine's own declared shape,
 * not a local guess at it. `buildFromFeature` stays public and takes it by name,
 * so game code that hands one over gets the same type the lookup returns.
 */
export type ChallengeFeatureLike = ForgedLevelFeature;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** A mechanism site in the feature's local frame (+Z along `params.dir`, +X to its right). */
interface LocalPoint { x?: number; z?: number }
/** Box extents as the forge writes them — any axis may be missing, hence per-axis defaults. */
interface Size3 { x?: number; y?: number; z?: number }

/** Box size from forge params, falling back per axis. */
const sizeVec = (s: Size3 | undefined, x: number, y: number, z: number): THREE.Vector3 =>
    new THREE.Vector3(num(s?.x, x), num(s?.y, y), num(s?.z, z));

export class TraversalChallengeSystem {
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

    private autoBuildFeatures(): ChallengeFeatureLike[] {
        return forgedFeatures(this.engine.getGameData?.()).filter(f => f.params?.engineAutoBuild === true);
    }

    /**
     * Ground height fallback for features that lack a resolved y. Forged levels
     * register their baked colliders as ENVIRONMENT (only classic template
     * terrain is TERRAIN), so the query must include both groups. Preferred
     * reference is the feature point's own bake-time y — see groundRefOf().
     */
    private groundProbe(x: number, z: number): number | null {
        const pw = this.engine.physicsWorld;
        if (!pw) return null;
        const result = pw.raycast(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0), 600, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);
        return result.hasHit ? result.hitPoint.y : null;
    }

    /**
     * The route-floor height a feature's ground-relative offsets refer to: the
     * forge world-resolves every feature point INCLUDING y (the floor at bake
     * time), which stays authoritative at runtime and — unlike a raycast — can
     * never be skewed by the blocker wall or pads sitting on the same spot.
     * Typed `y?` on purpose: the points arrive as JSON, so a forge that omitted
     * one must fall through to the probe rather than plant a mechanism at NaN.
     */
    private static bakedY(p: { y?: number } | undefined): number | null {
        return typeof p?.y === 'number' ? p.y : null;
    }

    /** Bake-time floor at a point, else a live probe there; null when neither answers. */
    private groundOf(p: { x: number; z: number; y?: number }): number | null {
        return TraversalChallengeSystem.bakedY(p) ?? this.groundProbe(p.x, p.z);
    }

    private tryBuild(): void {
        const features = this.autoBuildFeatures();
        if (features.length === 0) {
            this.built = true; // nothing marked for the engine (pre-flag forges, other genres)
            return;
        }
        // Readiness only matters for features without a baked y (then the ground
        // probe needs colliders present); baked-y features build immediately.
        const first = features[0]!.points?.[0];
        if (first && this.groundOf(first) === null) {
            if (++this.attempts < 600) return;
            console.warn('[TraversalChallenge] ground never became queryable; building anyway');
        }
        for (const f of features) this.buildFromFeature(f);
        this.built = true;
    }

    /** Build one feature's mechanism (public so tests can drive it directly). */
    buildFromFeature(f: ChallengeFeatureLike): void {
        const site = f.points?.[0];
        const params = f.params ?? {};
        if (!site) return;
        const dir = (params.dir as LocalPoint | undefined) ?? {};
        const dx = num(dir.x, 0), dz = num(dir.z, 1);
        const len = Math.hypot(dx, dz) || 1;
        const d = { x: dx / len, z: dz / len };
        // local (lx = right of travel, lz = along travel) -> world.
        const toWorld = (lx: number, lz: number): { x: number; z: number } => ({
            x: site.x + lx * d.z + lz * d.x,
            z: site.z + lx * -d.x + lz * d.z,
        });
        // Every ground-relative offset at a challenge site refers to the ROUTE FLOOR
        // at the site point: the carved corridor is flat across the site, and the
        // baked y can't be skewed by the wall/pads the way a raycast would be.
        const siteGround = TraversalChallengeSystem.bakedY(site);
        const groundAt = (p: { x: number; z: number }): number =>
            siteGround ?? this.groundProbe(p.x, p.z) ?? 0;
        const feet = (): THREE.Vector3 | null =>
            this.engine.getPlayerController()?.getGroundPosition?.() ?? null;
        // Editor identity: every mechanism this system builds names itself after
        // its forger feature and carries edit-pointer metadata, so clicking one
        // in the creator's editor shows what it is and where its parameters live
        // instead of "Unnamed".
        const featureName = typeof f.name === 'string' && f.name ? f.name : (f.kind ?? 'challenge');
        const editorData = (role: string): Record<string, unknown> => ({
            source: 'worldForger',
            feature: featureName,
            role,
            ...(typeof params.challenge === 'string' ? { challenge: params.challenge } : {}),
            ...(typeof params.difficulty === 'number' ? { difficulty: params.difficulty } : {}),
            editVia: `world.json level asset -> worldForgerFeatures["${featureName}"].params (or ask the AI)`,
        });

        try {
            if (f.kind === 'ascentLift') {
                // Shortcut elevator up a mesa: points are WORLD [foot, summit] — the
                // site IS the foot, and the summit carries its own bake-time ground y
                // (the two differ by design, so the summit never reuses the site's).
                const summit = f.points?.[1];
                if (!summit) return;
                const footY = groundAt(site);
                const summitY = this.groundOf(summit) ?? footY + num(params.travelM, 10);
                const a = new THREE.Vector3(site.x, footY + 0.4, site.z);
                const b = new THREE.Vector3(summit.x, summitY + 0.4, summit.z);
                this.platforms.push(new KinematicPlatform(this.engine, {
                    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                    waypoints: [a, b],
                    speed: Math.max(1.5, b.y - a.y) / Math.max(2.5, num(params.upS, 4)),
                    loop: 'pingpong',
                    trigger: 'proximity',
                    proximityRadius: 5,
                    size: new THREE.Vector3(3.5, 0.5, 3.5),
                    name: `${featureName} · ascent lift`,
                    editorData: editorData('ascent lift'),
                }));
                return;
            }

            const challenge = params.challenge;
            if (challenge === 'movingPlatformFerry') {
                const ferry = (params.ferry ?? {}) as {
                    boardAt?: LocalPoint & { aboveGround?: number };
                    crestAt?: LocalPoint & { aboveGround?: number };
                    landAt?: LocalPoint & { aboveGround?: number };
                    speed?: number;
                    size?: Size3;
                };
                const wp = (p: (LocalPoint & { aboveGround?: number }) | undefined): THREE.Vector3 => {
                    const w = toWorld(num(p?.x, 0), num(p?.z, 0));
                    return new THREE.Vector3(w.x, groundAt(w) + num(p?.aboveGround, 1.5), w.z);
                };
                this.platforms.push(new KinematicPlatform(this.engine, {
                    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                    waypoints: [wp(ferry.boardAt), wp(ferry.crestAt), wp(ferry.landAt)],
                    speed: num(ferry.speed, 2.2),
                    loop: 'pingpong',
                    trigger: 'always',
                    size: sizeVec(ferry.size, 3.2, 0.5, 3.2),
                    name: `${featureName} · ferry`,
                    editorData: { ...editorData('ferry'), __persistPaths: { speed: 'ferry.speed' } },
                }));
            } else if (challenge === 'verticalLift') {
                const lift = (params.lift ?? {}) as { at?: LocalPoint; travelM?: number; upS?: number; waitS?: number; aboveGroundBoard?: number };
                const at = toWorld(num(lift.at?.x, 5), num(lift.at?.z, -5));
                const baseY = groundAt(at) + num(lift.aboveGroundBoard, 0.9);
                const travel = num(lift.travelM, 10);
                this.platforms.push(new KinematicPlatform(this.engine, {
                    ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                    waypoints: [new THREE.Vector3(at.x, baseY, at.z), new THREE.Vector3(at.x, baseY + travel, at.z)],
                    speed: travel / Math.max(1.5, num(lift.upS, 2.5)),
                    loop: 'pingpong',
                    trigger: 'proximity',
                    proximityRadius: 5,
                    size: new THREE.Vector3(3.2, 0.5, 3.2),
                    name: `${featureName} · elevator`,
                    editorData: editorData('elevator'),
                }));
            } else if (challenge === 'pusherAlley') {
                // Blocks sliding back and forth ACROSS the corridor: waypoint
                // ping-pong with an end dwell. The sweeper push shoves anyone hit.
                const pushers = (params.pushers ?? []) as Array<{
                    from?: LocalPoint;
                    to?: LocalPoint;
                    aboveGround?: number;
                    speed?: number;
                    dwellS?: number;
                    size?: Size3;
                }>;
                pushers.forEach((p, pi) => {
                    const a = toWorld(num(p.from?.x, -2), num(p.from?.z, 0));
                    const b = toWorld(num(p.to?.x, 2), num(p.to?.z, 0));
                    const y = groundAt(a) + num(p.aboveGround, 0.9);
                    this.platforms.push(new KinematicPlatform(this.engine, {
                        ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                        waypoints: [new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(b.x, y, b.z)],
                        speed: num(p.speed, 3.4),
                        dwellS: num(p.dwellS, 0.5),
                        loop: 'pingpong',
                        trigger: 'always',
                        size: sizeVec(p.size, 1.4, 1.6, 1.2),
                        name: `${featureName} · pusher ${this.platforms.length + 1}`,
                        editorData: { ...editorData('pusher'), __persistPaths: { speed: `pushers.${pi}.speed`, dwellS: `pushers.${pi}.dwellS` } },
                    }));
                });
            } else if (challenge === 'pendulumBridge') {
                // Blades swinging across the corridor from an overhead beam.
                const pendulums = (params.pendulums ?? []) as Array<{
                    pivotAt?: LocalPoint;
                    pivotHeight?: number;
                    armLength?: number;
                    periodS?: number;
                    amplitudeDeg?: number;
                    phaseDeg?: number;
                    size?: Size3;
                }>;
                pendulums.forEach((p, di) => {
                    const w = toWorld(num(p.pivotAt?.x, 0), num(p.pivotAt?.z, 0));
                    const pivotY = groundAt(w) + num(p.pivotHeight, 4.6);
                    // Swing ACROSS the route: displacement along local +X in world.
                    const swingYawDeg = Math.atan2(d.z, -d.x) * (180 / Math.PI);
                    this.platforms.push(new KinematicPlatform(this.engine, {
                        ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                        waypoints: [new THREE.Vector3(w.x, pivotY, w.z)],
                        speed: 0,
                        trigger: 'always',
                        pendulum: {
                            armLength: num(p.armLength, 3.4),
                            periodS: num(p.periodS, 2.2),
                            amplitudeDeg: num(p.amplitudeDeg, 55),
                            swingYawDeg,
                            phaseDeg: num(p.phaseDeg, 0),
                        },
                        size: sizeVec(p.size, 0.5, 1.1, 0.4),
                        name: `${featureName} · pendulum ${this.platforms.length + 1}`,
                        editorData: { ...editorData('pendulum'), __persistPaths: {
                            pendulumArmLength: `pendulums.${di}.armLength`,
                            pendulumPeriodS: `pendulums.${di}.periodS`,
                            pendulumAmplitudeDeg: `pendulums.${di}.amplitudeDeg`,
                        } },
                    }));
                });
            } else if (challenge === 'crusherAlley') {
                // Stomper blocks: slam down fast, dwell, rise slow. The sweeper
                // push squeezes anyone caught out sideways — never enveloped.
                const crushers = (params.crushers ?? []) as Array<{
                    at?: LocalPoint;
                    topClearance?: number;
                    floorGap?: number;
                    slamSpeed?: number;
                    riseSpeed?: number;
                    dwellS?: number;
                    startLow?: boolean;
                    size?: Size3;
                }>;
                crushers.forEach((c, ci) => {
                    const w = toWorld(num(c.at?.x, 0), num(c.at?.z, 0));
                    const g = groundAt(w);
                    const size = sizeVec(c.size, 2.4, 1.4, 2.2);
                    const top = new THREE.Vector3(w.x, g + num(c.topClearance, 2.6) + size.y / 2, w.z);
                    const low = new THREE.Vector3(w.x, g + num(c.floorGap, 0.15) + size.y / 2, w.z);
                    // The slam is always the DOWNWARD leg; startLow just phase-staggers
                    // the cycle, so speeds swap with the waypoint order.
                    const startLow = c.startLow === true;
                    const slam = num(c.slamSpeed, 8);
                    const rise = num(c.riseSpeed, 2);
                    this.platforms.push(new KinematicPlatform(this.engine, {
                        ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                        waypoints: startLow ? [low, top] : [top, low],
                        speed: startLow ? rise : slam,
                        returnSpeed: startLow ? slam : rise,
                        dwellS: num(c.dwellS, 0.9),
                        loop: 'pingpong',
                        trigger: 'always',
                        size,
                        name: `${featureName} · crusher ${this.platforms.length + 1}`,
                        editorData: { ...editorData('crusher'), __persistPaths: {
                            // the slam is always the downward leg; startLow phase-staggered
                            // crushers store it in the swapped field (see waypoint order above)
                            speed: startLow ? `crushers.${ci}.riseSpeed` : `crushers.${ci}.slamSpeed`,
                            returnSpeed: startLow ? `crushers.${ci}.slamSpeed` : `crushers.${ci}.riseSpeed`,
                            dwellS: `crushers.${ci}.dwellS`,
                        } },
                    }));
                });
            } else if (challenge === 'spinnerGauntlet') {
                // Rotating hazard bars sweeping the gauntlet corridor. One
                // stationary waypoint + angularSpeed = a spinner; the bar has a
                // real kinematic collider, so the movement motor's sweeper push
                // physically shoves the player (never a pass-through hazard).
                const spinners = (params.spinners ?? []) as Array<{
                    at?: LocalPoint;
                    aboveGround?: number;
                    angularSpeedRad?: number;
                    size?: Size3;
                }>;
                spinners.forEach((s, si) => {
                    const w = toWorld(num(s.at?.x, 0), num(s.at?.z, 0));
                    this.platforms.push(new KinematicPlatform(this.engine, {
                        ...DEFAULT_KINEMATIC_PLATFORM_OPTIONS,
                        waypoints: [new THREE.Vector3(w.x, groundAt(w) + num(s.aboveGround, 0.9), w.z)],
                        speed: 1.5,
                        loop: 'pingpong',
                        trigger: 'always',
                        angularSpeed: num(s.angularSpeedRad, 1.2),
                        size: sizeVec(s.size, 4.6, 0.4, 0.7),
                        name: `${featureName} · spinner ${this.platforms.length + 1}`,
                        editorData: { ...editorData('spinner'), __persistPaths: { angularSpeedRad: `spinners.${si}.angularSpeedRad` } },
                    }));
                });
            } else if (challenge === 'crumblingCrossing') {
                const spots = (params.crumblingPlatforms ?? []) as Array<LocalPoint & { topAboveGround?: number }>;
                const sizeParams = params.size as Size3 | undefined;
                for (const spot of spots) {
                    const w = toWorld(num(spot.x, 0), num(spot.z, 0));
                    const top = groundAt(w) + num(spot.topAboveGround, 3);
                    // One vector per platform: the mechanisms keep the reference.
                    const size = sizeVec(sizeParams, 2.9, DEFAULT_CRUMBLING_PLATFORM_OPTIONS.size.y, 2.9);
                    this.crumbling.push(new CrumblingPlatform(this.engine, {
                        ...DEFAULT_CRUMBLING_PLATFORM_OPTIONS,
                        size,
                        center: new THREE.Vector3(w.x, top - size.y / 2, w.z),
                        breakAfterS: num(params.breakAfterS, DEFAULT_CRUMBLING_PLATFORM_OPTIONS.breakAfterS),
                        respawnAfterS: num(params.respawnAfterS, DEFAULT_CRUMBLING_PLATFORM_OPTIONS.respawnAfterS),
                        getPlayerFeet: feet,
                        name: `${featureName} · crumbling ${this.crumbling.length + 1}`,
                        editorData: { ...editorData('crumbling platform'), __persistPaths: { breakAfterS: 'breakAfterS', respawnAfterS: 'respawnAfterS' } },
                    }));
                }
            }
        } catch (err) {
            console.error(`[TraversalChallenge] failed to build "${f.name ?? f.kind}":`, err);
        }
    }
}
