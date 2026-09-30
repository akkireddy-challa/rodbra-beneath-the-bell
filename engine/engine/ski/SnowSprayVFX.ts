import * as THREE from 'three';
import type { SkiState } from 'engine/ski/SkiMovement.js';

/**
 * Snow-spray / powder VFX for skiing & snowboarding.
 *
 * Unlike a `THREE.Points` cloud (flat, unlit, can't cast shadows — which reads
 * as a few stray white dots against white snow), this renders the powder as a
 * dense pool of tiny **lit, shadow-casting voxel cubes** via a single
 * `InstancedMesh` — the same approach the engine uses for `VoxelObjectDebris`.
 * Each grain is shaded by the scene light and drops a real shadow, so the plume
 * reads as 3D volume over the snow.
 *
 * Drive it every frame from the ski movement state: emission scales with
 * `skid * speed` (a clean carve throws almost nothing; a hard sideways turn at
 * speed throws a big plume). Grains spawn at the board/snow contact line, fly
 * up + back (opposite travel) + out to the sliding edge, fall under gravity and
 * shrink over a short life.
 */
export interface SnowSprayVFXOptions {
    /** Hard cap on simultaneously-live grains (pool + InstancedMesh capacity). */
    maxParticles: number;
    /** Grain colour — a touch of cool blue-white so it shades against pure snow. */
    color: THREE.ColorRepresentation;
    /** Base cube edge length (m). */
    grainSize: number;
    /** Extra random size added on top of grainSize (m). */
    grainSizeJitter: number;
    /** Grain lifetime (s). */
    lifetime: number;
    /** Downward accel pulling powder back to the snow (m/s^2). */
    gravity: number;
    /** `skid * speed` below which no spray is thrown. */
    emissionThreshold: number;
    /** `skid * speed` at/above which the emitter runs at full rate. */
    emissionFull: number;
    /** Grains/second at the full plume. */
    maxEmissionRate: number;
    /** Half-length the spawn line is spread along the board's long axis (m). */
    boardHalfLength: number;
    /** How hard the rooster tail flies sideways out of a turn: lateral throw
     *  speed ≈ skid × board-speed × this. 0 = straight behind, higher = fans out. */
    sprayOutScale: number;
    /** Whether grains cast shadows (the dense, dramatic look — costs shadow-map fill). */
    castShadow: boolean;
}

export const DEFAULT_SNOW_SPRAY_VFX_OPTIONS: SnowSprayVFXOptions = {
    maxParticles: 3000,
    color: 0xeaf1fb,
    grainSize: 0.09,
    grainSizeJitter: 0.07,
    lifetime: 0.7,
    gravity: -8,
    emissionThreshold: 0.3,
    emissionFull: 14,
    maxEmissionRate: 2200,
    boardHalfLength: 0.6,
    sprayOutScale: 0.5,
    castShadow: true,
};

/** Drop from the board deck (`state.boardContactY`) down to the board's underside
 *  / snow contact, where powder is actually thrown up from. */
const BOARD_UNDERSIDE_DROP = 0.1;

interface Grain {
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    quaternion: THREE.Quaternion;
    age: number;
    life: number;
    size: number;
    active: boolean;
}

export class SnowSprayVFX {
    private readonly scene: THREE.Scene;
    private readonly opts: SnowSprayVFXOptions;

    private readonly grains: Grain[] = [];
    private readonly mesh: THREE.InstancedMesh;

    private emissionAccumulator = 0;
    private cursor = 0;

    // Scratch — no per-frame allocation in the hot loop.
    private readonly travelDir = new THREE.Vector3();
    private readonly boardDir = new THREE.Vector3();
    private readonly sideDir = new THREE.Vector3();
    private readonly spawnPos = new THREE.Vector3();
    private readonly tmpVel = new THREE.Vector3();
    private readonly outDir = new THREE.Vector3();
    private readonly tmpScale = new THREE.Vector3();
    private readonly tmpMatrix = new THREE.Matrix4();

    constructor(scene: THREE.Scene, options: SnowSprayVFXOptions = DEFAULT_SNOW_SPRAY_VFX_OPTIONS) {
        this.scene = scene;
        this.opts = options;

        for (let i = 0; i < options.maxParticles; i++) {
            this.grains.push({
                position: new THREE.Vector3(),
                velocity: new THREE.Vector3(),
                quaternion: new THREE.Quaternion(),
                age: 0,
                life: options.lifetime,
                size: options.grainSize,
                active: false,
            });
        }

        // Lit cube grains. A LIT material (Lambert) shades each grain by the scene
        // light so the powder reads as 3D volume with contrast against the white
        // snow — an unlit flat-white material is invisible (white on white). Lit
        // InstancedMesh draws correctly on both backends incl. the WebGPU MRT pass.
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshLambertMaterial({ color: options.color });
        this.mesh = new THREE.InstancedMesh(geometry, material, options.maxParticles);
        this.mesh.castShadow = options.castShadow;
        this.mesh.receiveShadow = true;
        this.mesh.frustumCulled = false;
        // Compacted draw: every frame `update()` packs the live grains into slots
        // 0..N-1 and sets `count = N`; dead grains are simply excluded. Verified on
        // the WebGPU backend (a dynamic InstancedMesh whose count grows from 0
        // renders fine). The earlier "fixed count + scale-0 hide" scheme left 3500+
        // inactive cubes stranded at the world origin because a makeScale(0,0,0)
        // matrix written via setMatrixAt does not take — the instance stays identity.
        this.mesh.count = 0;
        this.scene.add(this.mesh);
    }

    /**
     * @param deltaTime    seconds since last frame
     * @param state        the ski movement state (`getSkiState()`); its
     *                      `boardContactY` sets the spawn height (the board deck)
     * @param playerRootPos player root world position — supplies the spawn XZ only
     */
    update(deltaTime: number, state: SkiState, playerRootPos: THREE.Vector3): void {
        if (deltaTime <= 0) return;
        const dt = Math.min(deltaTime, 0.1); // a stalled frame can't fast-forward life
        const o = this.opts;

        // Only throw snow when the board is actually carving the ground. Airborne
        // (grounded=false) emits nothing; a crash bail (`bailing`) also emits
        // nothing — the ragdoll/tumble still reports `grounded` while the board is
        // flailing in the air, and powder erupting mid-tumble looks wrong.
        const intensity = state.grounded && !state.bailing ? state.skid * state.speed : 0;

        // ── Emit ────────────────────────────────────────────────────────────
        if (intensity > o.emissionThreshold) {
            const t = Math.min(1, (intensity - o.emissionThreshold) / (o.emissionFull - o.emissionThreshold));
            this.emissionAccumulator += o.maxEmissionRate * t * dt;
            const spawnCount = Math.floor(this.emissionAccumulator);
            this.emissionAccumulator -= spawnCount;
            if (spawnCount > 0) this.spawn(spawnCount, state, playerRootPos, t);
        } else {
            this.emissionAccumulator = 0;
        }

        // ── Simulate + pack live grains into a COMPACTED instance range ──────
        // Each live grain is written into the next free slot (0..N-1) and the
        // instance `count` is set to N below; dead grains are simply skipped, so
        // nothing inactive is drawn (no scale-0 hiding — a makeScale(0,0,0) matrix
        // does not take via setMatrixAt, which previously stranded inactive cubes
        // at the world origin).
        let writeIdx = 0;
        for (let idx = 0; idx < this.grains.length; idx++) {
            const g = this.grains[idx]!;
            if (!g.active) continue;
            g.age += dt;
            if (g.age >= g.life) {
                g.active = false;
                continue;
            }
            g.velocity.y += o.gravity * dt;
            g.position.addScaledVector(g.velocity, dt);

            // Puff up as it disperses, then shrink toward death.
            const lifeT = g.age / g.life;
            const grow = 1 + lifeT * 0.6;
            const shrink = lifeT > 0.6 ? 1 - (lifeT - 0.6) / 0.4 : 1;
            const s = g.size * grow * shrink;
            this.tmpScale.set(s, s, s);
            this.tmpMatrix.compose(g.position, g.quaternion, this.tmpScale);
            this.mesh.setMatrixAt(writeIdx, this.tmpMatrix);
            writeIdx++;
        }
        this.mesh.count = writeIdx; // only live grains are drawn
        this.mesh.instanceMatrix.needsUpdate = true;
    }

    private spawn(count: number, state: SkiState, playerRootPos: THREE.Vector3, intensityT: number): void {
        const o = this.opts;

        // Travel direction (horizontal); grains trail OPPOSITE to it.
        this.travelDir.set(state.velocity.x, 0, state.velocity.z);
        const horizSpeed = this.travelDir.length();
        if (horizSpeed > 1e-3) this.travelDir.multiplyScalar(1 / horizSpeed);
        else this.travelDir.set(Math.sin(state.heading), 0, Math.cos(state.heading));

        // Board long axis (heading) — spread spawns along the deck/snow line.
        this.boardDir.set(Math.sin(state.heading), 0, Math.cos(state.heading));
        if (this.boardDir.lengthSq() < 1e-6) this.boardDir.copy(this.travelDir);
        else this.boardDir.normalize();

        // Edge (right of travel) for a little fan spread.
        this.sideDir.set(this.travelDir.z, 0, -this.travelDir.x);

        // Direction the board slides ACROSS the snow — momentum's component
        // perpendicular to the board. The rooster tail flies OUT this way, so a
        // turn throws snow to the side instead of straight behind the board.
        const alongB = this.travelDir.x * this.boardDir.x + this.travelDir.z * this.boardDir.z;
        this.outDir.set(
            this.travelDir.x - alongB * this.boardDir.x,
            0,
            this.travelDir.z - alongB * this.boardDir.z,
        );
        if (this.outDir.lengthSq() > 1e-8) this.outDir.normalize();
        else this.outDir.copy(this.sideDir);

        for (let i = 0; i < count; i++) {
            const g = this.acquire();

            // The board sits at the player root XZ; its deck Y is state.boardContactY.
            // Spawn powder just under the deck (board underside / snow contact) so it
            // kicks up from the snowboard, not the hips root.
            this.spawnPos.copy(playerRootPos);
            this.spawnPos.y = state.boardContactY - BOARD_UNDERSIDE_DROP;
            const along = (Math.random() - 0.5) * 2 * o.boardHalfLength;
            this.spawnPos.addScaledVector(this.boardDir, along);
            this.spawnPos.addScaledVector(this.sideDir, (Math.random() - 0.5) * 0.18);
            g.position.copy(this.spawnPos);

            const up = (1.0 + Math.random() * 1.5) * (0.5 + intensityT);
            const back = 1.5 + Math.random() * 2;
            // Lateral fly-out grows with BOTH how sideways the board is (skid) and
            // how fast it's going — a fast, hard turn fans a big rooster tail out.
            const out = (0.6 + Math.random() * 0.8) * state.skid * horizSpeed * o.sprayOutScale;
            const spread = (Math.random() - 0.5) * horizSpeed * 0.2;
            this.tmpVel.set(0, 0, 0);
            this.tmpVel.addScaledVector(this.travelDir, -back + horizSpeed * 0.12);
            this.tmpVel.addScaledVector(this.outDir, out);
            this.tmpVel.addScaledVector(this.sideDir, spread);
            this.tmpVel.y += up;
            g.velocity.copy(this.tmpVel);

            // Random tumble so grains read as irregular clumps, not aligned boxes.
            g.quaternion.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();

            g.age = 0;
            g.life = o.lifetime * (0.7 + Math.random() * 0.6);
            g.size = o.grainSize + Math.random() * o.grainSizeJitter;
            g.active = true;
        }
    }

    /** Round-robin slot acquisition; recycles the oldest slot when the pool is full. */
    private acquire(): Grain {
        const n = this.grains.length;
        for (let i = 0; i < n; i++) {
            const idx = (this.cursor + i) % n;
            const candidate = this.grains[idx]!;
            if (!candidate.active) {
                this.cursor = (idx + 1) % n;
                return candidate;
            }
        }
        const slot = this.grains[this.cursor]!;
        this.cursor = (this.cursor + 1) % n;
        return slot;
    }

    dispose(): void {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
        this.mesh.dispose();
    }
}
