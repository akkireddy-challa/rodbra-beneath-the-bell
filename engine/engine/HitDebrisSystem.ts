/**
 * @fileoverview Debris knocked off a target when it is hit.
 *
 * The engine already marked hits two ways, and neither said much about WHAT was
 * hit: melee burst a fixed orange spark cloud (metal-on-metal, whatever you
 * struck), and projectiles left a surface decal. Hitting a living NPC therefore
 * looked identical to hitting a wall, so a player could not tell a connecting
 * blow from a whiff on geometry.
 *
 * This spawns small cubes off the impact point, coloured FROM THE TARGET'S OWN
 * MATERIAL. That one decision is what makes it read correctly everywhere without
 * per-entity configuration: a red NPC sprays red, a stone golem chips grey, a
 * green slime spits green. Hardcoding blood would be wrong for half the things
 * a creator puts in a game, and asking creators to configure a colour per entity
 * would mean most never do.
 *
 * Cubes rather than a particle sprite because the whole game is voxel-built —
 * chunks knocked off a block character are the native visual language here, and
 * they need no texture, so there is no asset to ship or load.
 *
 * ── Renderer ───────────────────────────────────────────────────────────────
 * `MeshBasicMaterial` on a shared BoxGeometry, no custom shader, so it runs
 * unchanged on both WebGL and WebGPU (see docs/renderer-backends.md).
 *
 * ── Why pieces are pooled ──────────────────────────────────────────────────
 * A retired piece is hidden and kept, mesh and material intact, for the next
 * burst (`EffectPool`). The first version created a material per piece and
 * disposed it when the piece expired, which made three.js delete the shader
 * program and compile it again on the next hit — a synchronous stall on the
 * first draw, a visible hitch on every hit. The pool is bounded by
 * `maxPieces`, the same cap that bounds live pieces.
 */

import * as THREE from 'three';
import { EffectPool, type EffectSpawn, type PooledEffect } from 'engine/effects/EffectPool.js';
import { keepShaderAlive } from 'engine/effects/ShaderKeepAlive.js';

export interface HitDebrisConfig {
    /** Cubes per hit. */
    count: number;
    /** Edge length range, world units. */
    minSize: number;
    maxSize: number;
    /** Initial speed along the impact normal. */
    minSpeed: number;
    maxSpeed: number;
    /** How much the spray fans out from the normal, radians. */
    spread: number;
    /** Downward acceleration. */
    gravity: number;
    /** Seconds before a piece has fully shrunk away. */
    lifetime: number;
    /**
     * Fallback colour when NOTHING about the target can be read.
     *
     * Deliberately a last resort: debris takes the body's own colour (see
     * sampleTargetColor), because a game's enemies are as likely to be stone,
     * metal or slime as flesh, and a red spray off a rock golem reads as a bug.
     */
    fallbackColor: THREE.Color;
    /** Hard cap on live pieces, so a burst of hits cannot run away. */
    maxPieces: number;
}

export const DEFAULT_HIT_DEBRIS: HitDebrisConfig = {
    count: 10,
    minSize: 0.04,
    maxSize: 0.11,
    minSpeed: 1.8,
    maxSpeed: 4.5,
    spread: 0.9,
    gravity: 9.8,
    lifetime: 0.85,
    fallbackColor: new THREE.Color(0xb02020),
    maxPieces: 240,
};

/** Debris is small and fast; lighting it adds nothing a player can see and costs a lit draw per piece. */
function createDebrisMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, toneMapped: false });
}

/** One cube. Hidden between bursts; its material lives until the system is disposed. */
class DebrisPiece implements PooledEffect {
    private readonly scene: THREE.Scene;
    private readonly mesh: THREE.Mesh;
    /** Held directly so update/teardown never re-narrow `mesh.material`. */
    private readonly material: THREE.MeshBasicMaterial;
    private readonly velocity = new THREE.Vector3();
    private readonly spin = new THREE.Vector3();
    private age = 0;
    private life = 0;
    private size = 0;
    private gravity = 0;

    constructor(scene: THREE.Scene, geometry: THREE.BufferGeometry) {
        this.scene = scene;
        this.material = createDebrisMaterial();
        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.visible = false;
        scene.add(this.mesh);
    }

    /** Launch from `position` along a cone around the unit `axis`. */
    arm(position: THREE.Vector3, axis: THREE.Vector3, color: THREE.Color, c: HitDebrisConfig): void {
        this.size = THREE.MathUtils.lerp(c.minSize, c.maxSize, Math.random());
        this.material.color.copy(color);
        this.material.opacity = 1;
        this.mesh.scale.setScalar(this.size);
        this.mesh.position.copy(position);
        this.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
        this.mesh.visible = true;

        // Cone around the normal, so the spray comes back off the surface
        // toward whoever landed the hit rather than in every direction.
        const dir = this.velocity.copy(axis);
        dir.x += (Math.random() - 0.5) * c.spread;
        dir.y += (Math.random() - 0.5) * c.spread + 0.35;   // slight lift
        dir.z += (Math.random() - 0.5) * c.spread;
        dir.normalize().multiplyScalar(THREE.MathUtils.lerp(c.minSpeed, c.maxSpeed, Math.random()));

        this.spin.set(
            (Math.random() - 0.5) * 14,
            (Math.random() - 0.5) * 14,
            (Math.random() - 0.5) * 14,
        );
        this.age = 0;
        this.life = c.lifetime * (0.7 + Math.random() * 0.6);
        this.gravity = c.gravity;
    }

    get isFinished(): boolean {
        return this.age >= this.life;
    }

    update(deltaTime: number): void {
        this.age += deltaTime;
        if (this.age >= this.life) return;

        this.velocity.y -= this.gravity * deltaTime;
        this.mesh.position.addScaledVector(this.velocity, deltaTime);
        this.mesh.rotation.x += this.spin.x * deltaTime;
        this.mesh.rotation.y += this.spin.y * deltaTime;
        this.mesh.rotation.z += this.spin.z * deltaTime;

        // Shrink away rather than blink out. Fading alpha alone leaves a
        // ghost hanging in the air; shrinking reads as the piece receding.
        const t = this.age / this.life;
        this.mesh.scale.setScalar(this.size * (1 - t * t));
        this.material.opacity = 1 - t * t * t;
    }

    retire(): void {
        this.mesh.visible = false;
    }

    dispose(): void {
        this.scene.remove(this.mesh);
        this.material.dispose();
    }
}

/**
 * Read a usable colour off whatever was hit.
 *
 * Walks up from the hit mesh because a block character's meshes are nested in
 * groups, and a raycast can land on a child that has no material of its own.
 * Returns null rather than guessing, so the caller can fall back deliberately.
 */
export function sampleTargetColor(object: THREE.Object3D | null | undefined): THREE.Color | null {
    if (!object) return null;

    // 1. The node's OWN material.
    //
    // A melee raycast hands us the exact mesh that was struck, so this is the
    // faithful answer for a hit: strike a green shirt, spray green.
    const own = materialColorOf(object);
    if (own) return own;

    // 2. INSIDE the node, torso first.
    //
    // Searched before the parent chain, and that order is the whole fix. A death
    // burst is handed a body part or a character group, which carries no material
    // itself — and walking UP from there reaches the skinned GLB's single white
    // SkinnedMesh, so every enemy bled white regardless of how it looked. The
    // colour that matters is inside: the block character's `torso` group holds a
    // mesh with the body's actual colour.
    const torso = findByName(object, 'torso');
    if (torso) {
        const color = materialColorOf(torso) ?? firstDescendantColor(torso);
        if (color) return color;
    }
    const descendant = firstDescendantColor(object);
    if (descendant) return descendant;

    // 3. Only now the parent chain — for a raycast that landed on a child with
    //    no material of its own, where the material lives one level up.
    let node: THREE.Object3D | null = object.parent;
    for (let depth = 0; node && depth < 3; depth++) {
        const color = materialColorOf(node);
        if (color) return color;
        node = node.parent;
    }

    return null;
}

/** The colour of a node's own material, if it has one. */
function materialColorOf(node: THREE.Object3D): THREE.Color | null {
    const material = (node as THREE.Mesh).material;
    const first = Array.isArray(material) ? material[0] : material;
    const color = (first as (THREE.Material & { color?: THREE.Color }) | undefined)?.color;
    return color ? color.clone() : null;
}

/** Nearest descendant whose name matches, case-insensitively. */
function findByName(root: THREE.Object3D, name: string): THREE.Object3D | null {
    let found: THREE.Object3D | null = null;
    root.traverse((child) => {
        if (!found && child.name.toLowerCase() === name) found = child;
    });
    return found;
}

/** First descendant carrying a material colour. */
function firstDescendantColor(root: THREE.Object3D): THREE.Color | null {
    let found: THREE.Color | null = null;
    root.traverse((child) => {
        if (!found) found = materialColorOf(child);
    });
    return found;
}

export class HitDebrisSystem {
    private readonly scene: THREE.Scene;
    private readonly config: HitDebrisConfig;
    private readonly geometry: THREE.BoxGeometry;
    private readonly pieces = new EffectPool<DebrisPiece>();

    constructor(scene: THREE.Scene, config?: Partial<HitDebrisConfig>) {
        this.scene = scene;
        this.config = { ...DEFAULT_HIT_DEBRIS, ...config };
        // One unit cube, scaled per piece — geometry is shared, so a burst costs
        // matrices, not vertex buffers.
        this.geometry = new THREE.BoxGeometry(1, 1, 1);
        // Pre-warm: the program compiles with the scene at load, not on the first hit.
        keepShaderAlive(scene, 'hit-debris', createDebrisMaterial(), 'mesh', this.geometry);
    }

    /**
     * Spawn a burst at a hit.
     *
     * @param position  world-space impact point
     * @param normal    surface normal, i.e. roughly back toward the attacker
     * @param target    the object that was hit; its material colours the debris
     */
    spawn(
        position: THREE.Vector3,
        normal: THREE.Vector3,
        target?: THREE.Object3D | null,
        overrides?: Partial<HitDebrisConfig>,
    ): void {
        const c = overrides ? { ...this.config, ...overrides } : this.config;
        const color = sampleTargetColor(target) ?? c.fallbackColor;

        // Budget check BEFORE spawning: dropping the oldest keeps a chaotic
        // fight bounded without ever refusing to show the hit the player just
        // landed, which is the one thing this exists to communicate.
        const overflow = this.pieces.activeCount + c.count - c.maxPieces;
        if (overflow > 0) this.pieces.retireOldest(overflow);

        const axis = normal.lengthSq() > 1e-6
            ? normal.clone().normalize()
            : new THREE.Vector3(0, 1, 0);

        const spawn: EffectSpawn<DebrisPiece> = {
            fits: () => true,
            rearm: (p) => p.arm(position, axis, color, c),
            create: () => {
                const p = new DebrisPiece(this.scene, this.geometry);
                p.arm(position, axis, color, c);
                return p;
            },
        };
        for (let i = 0; i < c.count; i++) this.pieces.spawn(spawn);
    }

    update(deltaTime: number): void {
        this.pieces.update(deltaTime);
    }

    dispose(): void {
        this.pieces.dispose();
        this.geometry.dispose();
    }
}

// ── Global instance ─────────────────────────────────────────────────────────
//
// Mirrors VoxelDecalSystem's accessor pattern: melee, unarmed and projectile
// impacts all want this, they live in different systems with no shared owner,
// and every one of them already reaches for a global the same way.

let globalHitDebris: HitDebrisSystem | null = null;

/** Initialise the global debris system. Call once during engine setup. */
export function initHitDebrisSystem(scene: THREE.Scene, config?: Partial<HitDebrisConfig>): HitDebrisSystem {
    if (globalHitDebris) globalHitDebris.dispose();
    globalHitDebris = new HitDebrisSystem(scene, config);
    return globalHitDebris;
}

/** The global debris system, or null before init. */
export function getHitDebrisSystem(): HitDebrisSystem | null {
    return globalHitDebris;
}

/** Spawn a burst through the global system. No-op when uninitialised. */
export function spawnHitDebris(
    position: THREE.Vector3,
    normal: THREE.Vector3,
    target?: THREE.Object3D | null,
    overrides?: Partial<HitDebrisConfig>,
): void {
    globalHitDebris?.spawn(position, normal, target, overrides);
}

/**
 * The bigger burst a death deserves.
 *
 * Same system, more of it and thrown further — a kill should read differently
 * from a hit that merely connected. Reusing the burst rather than defining a
 * separate death effect means the colour is still sampled from the body, so a
 * stone golem chips grey instead of bleeding.
 */
export const DEATH_BURST: Partial<HitDebrisConfig> = {
    count: 26,
    minSpeed: 2.4,
    maxSpeed: 6.5,
    spread: 1.5,
    lifetime: 1.3,
    minSize: 0.05,
    maxSize: 0.15,
};

export function disposeHitDebrisSystem(): void {
    globalHitDebris?.dispose();
    globalHitDebris = null;
}
