/**
 * @fileoverview The white slash arc a blade leaves as it sweeps.
 *
 * Distinct from `AttackVFX`'s trail, which follows a LIMB BONE with a thin
 * fixed-width ribbon. This follows the WEAPON, and its width is the blade
 * itself: each frame it records where the blade's outer section is, and the
 * resulting band is literally the area the blade swept — the hit area, drawn.
 *
 * That difference is the whole point. A thin line traced by the hand reads as a
 * motion smear; a band spanning the business end of the blade reads as "this is
 * what the swing would have cut", which is the information a player actually
 * needs from a melee attack.
 *
 * ── Why a ribbon and not a texture/shader ──────────────────────────────────
 * Geometry updated per frame, drawn with `MeshBasicMaterial` + per-vertex alpha.
 * No custom shader, so it works unchanged on both the WebGL and WebGPU backends
 * (see docs/renderer-backends.md) — a hand-written GLSL pass would need a dual
 * path and this needs none of that power.
 *
 * ── Why arcs are pooled, not created per swing ─────────────────────────────
 * An arc's mesh, geometry and material are built once and REUSED through an
 * `EffectPool`. The first version created a fresh material per swing and
 * disposed it when the arc faded, which made three.js delete the shader
 * program and compile it again on the next swing — 160–210 ms per swing in a
 * headless profile, a visible hitch on every attack on real hardware. See
 * `engine/effects/EffectPool.ts` for the mechanism.
 */

import * as THREE from 'three';
import { EffectPool, type PooledEffect } from 'engine/effects/EffectPool.js';
import { ShaderKeepAlive } from 'engine/effects/ShaderKeepAlive.js';

/** How the arc looks. Everything here is per-swing, so weapons can differ. */
export interface SlashArcOptions {
    /**
     * Where along the blade the band starts, 0 = hilt, 1 = tip.
     *
     * Not 0: a band spanning the whole blade sweeps a huge fan through the
     * character's own body, because the hilt barely moves while the tip travels
     * metres. Starting out near the tip is what makes it read as an arc rather
     * than a dinner plate.
     *
     * This is the WIDTH dial. 0.72 leaves the band spanning the outer ~28% of
     * the blade — a thin ribbon along the cutting tip. Lower values thicken it
     * toward the grip; 0.45 (the previous value) covered over half the blade and
     * read as a sheet rather than a slash.
     */
    innerFraction: number;
    /** Colour of the arc's leading (tip) edge. */
    color: THREE.Color;
    /** Peak opacity at the freshest part of the sweep. */
    opacity: number;
    /** Seconds the arc lingers after the swing ends, fading out. */
    fadeSeconds: number;
    /** Cap on recorded samples — the arc's "length" in frames. */
    maxSamples: number;
    /**
     * Fraction of the swing's PEAK tip speed below which the blade is not
     * considered to be striking, and no arc is drawn.
     *
     * This is what keeps the trail on the cut itself instead of smearing across
     * the whole animation. A swing is three moves, not one: a slow settle into
     * the wind-up, the strike, then a slow recovery to guard. Drawing all three
     * produced a ribbon that wrapped the character and read as a flourish rather
     * than a cut — the wind-up trail in particular points the wrong way.
     *
     * Relative rather than absolute because peak speed varies hugely: a dagger
     * flick and a two-handed cleave differ by several times, and a fixed m/s
     * threshold would either miss the dagger entirely or let the greataxe's
     * wind-up through.
     *
     * 0.45 measured against the authored clips (tip speed sampled 40x per clip):
     *   AttackSlashSide   arc drawn over phases 0.38-0.47  (impact 0.42)
     *   AttackHeavyChop   arc drawn over phases 0.40-0.47  (impact 0.46)
     *   AttackWhirlwind   arc drawn over phases 0.05-0.95 - correct, a 360 deg
     *                     spin is strike all the way through
     * Dropping to 0.30 pulled AttackSlashSide's window out to 0.03-0.50, i.e.
     * straight back into the wind-up this exists to exclude.
     */
    strikeSpeedFraction: number;
}

export const DEFAULT_SLASH_ARC: SlashArcOptions = {
    innerFraction: 0.72,
    color: new THREE.Color(0xffffff),
    opacity: 0.85,
    fadeSeconds: 0.18,
    maxSamples: 24,
    strikeSpeedFraction: 0.45,
};

/** The arc's material. Colour and alpha come per vertex, so one configuration serves every weapon. */
function createSlashArcMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        // Additive so overlapping sweeps brighten rather than muddying, and
        // so the arc reads as light rather than as a painted surface.
        blending: THREE.AdditiveBlending,
        // Never occlude the character or write depth: the arc is an overlay
        // that happens to live in world space.
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
    });
}

/** Vertex attributes beyond position that shape the arc's program. */
const SLASH_ARC_ATTRIBUTES = [{ name: 'color', itemSize: 4 }];

/**
 * One sweep. Owns its mesh for its whole life; `WeaponSlashArcs` re-arms a
 * faded arc for the next swing instead of building a new one.
 */
export class SlashArc implements PooledEffect {
    private readonly scene: THREE.Scene;
    private weapon: THREE.Object3D;
    private readonly hilt: THREE.Vector3;
    private readonly tip: THREE.Vector3;
    private opts: SlashArcOptions;
    /** Samples the buffers were sized for; a swing may not ask for more. */
    readonly capacity: number;

    private readonly mesh: THREE.Mesh;
    private readonly geometry: THREE.BufferGeometry;
    private readonly material: THREE.MeshBasicMaterial;
    private readonly positionAttr: THREE.BufferAttribute;
    private readonly colorAttr: THREE.BufferAttribute;

    /**
     * Recorded blade sections, oldest first.
     *
     * `speed` is kept per sample so the whole trail can be re-pruned as the
     * swing's true peak becomes known — see `update`.
     */
    private samples: Array<{ inner: THREE.Vector3; tip: THREE.Vector3; speed: number }> = [];
    /** Fastest tip speed seen so far this swing, in world units per second. */
    private peakSpeed = 0;
    private lastTip: THREE.Vector3 | null = null;
    private elapsed = 0;
    private swingSeconds: number;
    private done = false;

    constructor(
        scene: THREE.Scene,
        weapon: THREE.Object3D,
        hiltOffset: THREE.Vector3,
        tipOffset: THREE.Vector3,
        swingSeconds: number,
        opts: SlashArcOptions = DEFAULT_SLASH_ARC,
    ) {
        this.scene = scene;
        this.weapon = weapon;
        this.hilt = hiltOffset.clone();
        this.tip = tipOffset.clone();
        this.swingSeconds = swingSeconds;
        this.opts = opts;
        this.capacity = opts.maxSamples;

        // Two vertices per sample, two triangles per quad between samples.
        const maxVerts = opts.maxSamples * 2;
        this.positionAttr = new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3);
        // itemSize 4 gives per-vertex ALPHA, which is what lets the arc fade
        // along its length instead of as one flat block.
        this.colorAttr = new THREE.BufferAttribute(new Float32Array(maxVerts * 4), 4);

        this.geometry = new THREE.BufferGeometry();
        this.geometry.setAttribute('position', this.positionAttr);
        this.geometry.setAttribute('color', this.colorAttr);
        this.geometry.setIndex(SlashArc.buildIndices(opts.maxSamples));
        this.geometry.setDrawRange(0, 0);

        this.material = createSlashArcMaterial();

        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.frustumCulled = false;   // its bounds change every frame
        this.mesh.renderOrder = 10;
        this.scene.add(this.mesh);
    }

    /** Triangle indices for a fixed-capacity two-vertex-wide strip. */
    private static buildIndices(maxSamples: number): number[] {
        const indices: number[] = [];
        for (let i = 0; i < maxSamples - 1; i++) {
            const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
            indices.push(a, b, c, b, d, c);
        }
        return indices;
    }

    get isFinished(): boolean { return this.done; }

    update(deltaTime: number): void {
        if (this.done) return;
        this.elapsed += deltaTime;

        // Record while the swing is live; afterwards just fade what we have.
        if (this.elapsed <= this.swingSeconds && deltaTime > 1e-6) {
            this.weapon.updateWorldMatrix(true, false);
            const matrix = this.weapon.matrixWorld;
            const tipWorld = this.tip.clone().applyMatrix4(matrix);
            // Inner edge sits partway up the blade, so the band covers the
            // cutting section rather than fanning out from the grip.
            const inner = this.hilt.clone().applyMatrix4(matrix)
                .lerp(tipWorld, this.opts.innerFraction);

            const speed = this.lastTip
                ? this.lastTip.distanceTo(tipWorld) / deltaTime
                : 0;
            if (speed > this.peakSpeed) this.peakSpeed = speed;

            // `lastTip` and the sample share one vector; neither is written again.
            this.lastTip = tipWorld;
            this.samples.push({ inner, tip: tipWorld, speed });
            if (this.samples.length > this.opts.maxSamples) this.samples.shift();

            // Re-prune against the peak, every frame.
            //
            // The peak is not known until the strike actually happens, so a
            // wind-up frame can look fast relative to the little that came
            // before it and get recorded. Once the real strike raises the peak,
            // those early samples fall below the threshold and are dropped —
            // which is why this re-checks the WHOLE buffer rather than only
            // gating on the way in.
            const floor = this.peakSpeed * this.opts.strikeSpeedFraction;
            let firstKept = 0;
            while (firstKept < this.samples.length && this.samples[firstKept]!.speed < floor) firstKept++;
            if (firstKept > 0) this.samples.splice(0, firstKept);
        }

        this.rebuild();

        if (this.elapsed > this.swingSeconds + this.opts.fadeSeconds) this.done = true;
    }

    private rebuild(): void {
        const count = this.samples.length;
        if (count < 2) {
            this.geometry.setDrawRange(0, 0);
            return;
        }

        // Global fade once the swing is over.
        const over = Math.max(0, this.elapsed - this.swingSeconds);
        const globalAlpha = this.opts.opacity
            * Math.max(0, 1 - over / this.opts.fadeSeconds);

        const { r, g, b } = this.opts.color;

        for (let i = 0; i < count; i++) {
            const { inner, tip } = this.samples[i]!;
            const v = i * 2;

            this.positionAttr.setXYZ(v, inner.x, inner.y, inner.z);
            this.positionAttr.setXYZ(v + 1, tip.x, tip.y, tip.z);

            // Oldest samples are faintest — the arc trails off behind the blade.
            const age = i / (count - 1);
            const alpha = globalAlpha * age * age;

            // The inner edge is dimmer than the tip edge, which is what gives the
            // band its blade-like taper instead of looking like a flat sheet.
            this.colorAttr.setXYZW(v, r, g, b, alpha * 0.35);
            this.colorAttr.setXYZW(v + 1, r, g, b, alpha);
        }

        this.positionAttr.needsUpdate = true;
        this.colorAttr.needsUpdate = true;
        this.geometry.setDrawRange(0, (count - 1) * 6);
    }

    /**
     * Start a new swing on this arc's existing mesh. `opts.maxSamples` must not
     * exceed `capacity` — the buffers are not resized.
     */
    rearm(
        weapon: THREE.Object3D,
        hiltOffset: THREE.Vector3,
        tipOffset: THREE.Vector3,
        swingSeconds: number,
        opts: SlashArcOptions,
    ): void {
        if (opts.maxSamples > this.capacity) {
            throw new Error(`SlashArc.rearm: maxSamples ${opts.maxSamples} exceeds capacity ${this.capacity}`);
        }
        this.weapon = weapon;
        this.hilt.copy(hiltOffset);
        this.tip.copy(tipOffset);
        this.swingSeconds = swingSeconds;
        this.opts = opts;
        this.samples = [];
        this.peakSpeed = 0;
        this.lastTip = null;
        this.elapsed = 0;
        this.done = false;
        this.geometry.setDrawRange(0, 0);
        this.mesh.visible = true;
    }

    /**
     * Hide a finished arc, keeping mesh, geometry and material alive so the
     * shader program stays cached for the next `rearm`.
     */
    retire(): void {
        this.mesh.visible = false;
        this.geometry.setDrawRange(0, 0);
        this.samples = [];
        this.lastTip = null;
        this.done = true;
    }

    /** Final teardown. Frees the GPU resources — only for system shutdown. */
    dispose(): void {
        this.scene.remove(this.mesh);
        this.geometry.dispose();
        this.material.dispose();
        this.samples = [];
        this.done = true;
    }
}

/**
 * Owns the arcs and pumps them. One per melee system.
 *
 * Faded arcs are re-armed for the next swing, so the pool only ever grows to
 * the peak number of simultaneous swings (see the file header for why).
 */
export class WeaponSlashArcs {
    private readonly scene: THREE.Scene;
    private readonly arcs = new EffectPool<SlashArc>();

    constructor(scene: THREE.Scene) {
        this.scene = scene;
        // Pre-warm: the program compiles with the scene at load, not on the first swing.
        ShaderKeepAlive.for(scene).retain('slash-arc', createSlashArcMaterial(), 'mesh', SLASH_ARC_ATTRIBUTES);
    }

    /** Start an arc for a swing. `hiltOffset`/`tipOffset` are weapon-local. */
    spawn(
        weapon: THREE.Object3D,
        hiltOffset: THREE.Vector3,
        tipOffset: THREE.Vector3,
        swingSeconds: number,
        opts?: Partial<SlashArcOptions>,
    ): void {
        const merged = { ...DEFAULT_SLASH_ARC, ...opts };
        this.arcs.spawn({
            fits: (arc) => arc.capacity >= merged.maxSamples,
            rearm: (arc) => arc.rearm(weapon, hiltOffset, tipOffset, swingSeconds, merged),
            create: () => new SlashArc(this.scene, weapon, hiltOffset, tipOffset, swingSeconds, merged),
        });
    }

    update(deltaTime: number): void {
        this.arcs.update(deltaTime);
    }

    dispose(): void {
        this.arcs.dispose();
    }
}
