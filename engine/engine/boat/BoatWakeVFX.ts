/**
 * Wake and spray for a watercraft: the white V trailing behind the hull, and
 * the rooster tail thrown off the stern when it turns, lands or boosts.
 *
 * Both read off `BoatState`, so they respond to what the motor actually did —
 * drift throws more spray than straight-line speed, a splashdown throws a burst
 * scaled by the impact — rather than to the throttle key.
 *
 * The wake ribbon is RE-SEATED on the water every frame from the same
 * `WaterSurfaceQuery` the boat rides, so it stays on the surface as the swell
 * rolls under it. A wake baked at emit height sinks into the next trough and
 * pops out of the following crest, which is the single most obvious way to make
 * an ocean look fake.
 *
 * Spray uses lit, shadow-casting boxes rather than `THREE.Points`: points can
 * be neither lit nor shadowed, so against a cel-shaded sea they read as a flat
 * grey smear (the same reason `engine/ski/SnowSprayVFX.ts` uses cubes).
 *
 * Usage:
 *   const wake = new BoatWakeVFX(scene, surface);
 *   // per frame, after the motor has stepped:
 *   wake.update(dt, motor.getState(), hullPosition);
 */

import * as THREE from 'three';
import type { BoatState } from 'engine/boat/BoatMotor.js';
import type { WaterSurfaceQuery } from 'engine/water/WaterSurfaceQuery.js';

export interface BoatWakeVFXOptions {
    /** Spray particles alive at once. */
    maxParticles: number;
    /** Particle lifetime (s). */
    particleLife: number;
    /** Particle edge length (m) at birth. */
    particleSize: number;
    /** Particles per second at full speed with no drift. */
    baseEmitRate: number;
    /** Extra particles per second at full drift. */
    driftEmitRate: number;
    /** Particles in the one-off burst per m/s of landing impact. */
    landingBurstPerImpact: number;
    /** Spray colour. */
    sprayColor: THREE.ColorRepresentation;
    /** Downward acceleration on spray (m/s²). */
    gravity: number;
    /** Wake samples retained. Each is one cross-section of the ribbon. */
    wakeSamples: number;
    /** Distance (m) the boat must travel before a new wake sample is laid. */
    wakeSpacing: number;
    /** Half-width (m) of the wake directly behind the hull. */
    wakeHalfWidth: number;
    /** How much the wake spreads by the time it reaches the oldest sample. */
    wakeSpread: number;
    /** Metres the wake floats above the water, to beat z-fighting. */
    wakeLift: number;
    wakeColor: THREE.ColorRepresentation;
    /** Peak wake opacity right behind the hull. */
    wakeOpacity: number;
}

export const DEFAULT_BOAT_WAKE_OPTIONS: BoatWakeVFXOptions = {
    maxParticles: 220,
    particleLife: 0.85,
    particleSize: 0.11,
    baseEmitRate: 90,
    driftEmitRate: 170,
    landingBurstPerImpact: 4,
    sprayColor: 0xf4fbff,
    gravity: 14,
    wakeSamples: 34,
    wakeSpacing: 0.8,
    wakeHalfWidth: 0.85,
    wakeSpread: 2.2,
    wakeLift: 0.07,
    wakeColor: 0xeaf7ff,
    wakeOpacity: 0.32,
};

interface Particle {
    px: number; py: number; pz: number;
    vx: number; vy: number; vz: number;
    life: number;
    spin: number;
}

interface WakeSample {
    x: number;
    z: number;
    /** Course direction when this sample was laid (unit XZ). */
    dx: number;
    dz: number;
    /** Seconds since it was laid. */
    age: number;
}

export class BoatWakeVFX {
    private readonly opts: BoatWakeVFXOptions;
    private surface: WaterSurfaceQuery;
    private readonly scene: THREE.Object3D;

    private readonly particles: Particle[] = [];
    private readonly sprayMesh: THREE.InstancedMesh;
    private readonly sprayGeometry: THREE.BufferGeometry;
    private readonly sprayMaterial: THREE.Material;
    private emitCarry = 0;

    private readonly wake: WakeSample[] = [];
    private readonly wakeMesh: THREE.Mesh;
    private readonly wakeGeometry: THREE.BufferGeometry;
    private readonly wakeMaterial: THREE.Material;
    private readonly lastEmit = new THREE.Vector3();
    private readonly wakeColor = new THREE.Color();
    private hasLastEmit = false;

    private readonly dummy = new THREE.Object3D();

    constructor(
        scene: THREE.Object3D,
        surface: WaterSurfaceQuery,
        options: Partial<BoatWakeVFXOptions> = {},
    ) {
        this.opts = { ...DEFAULT_BOAT_WAKE_OPTIONS, ...options };
        this.surface = surface;
        this.scene = scene;

        this.sprayGeometry = new THREE.BoxGeometry(1, 1, 1);
        this.sprayMaterial = new THREE.MeshLambertMaterial({
            color: this.opts.sprayColor,
            // Spray is water catching the sky from every angle; a purely
            // diffuse cube turns grey the moment it faces away from the sun,
            // and grey spray next to white caps reads as flying gravel.
            emissive: 0x8fb4c8,
            flatShading: true,
        });
        this.sprayMesh = new THREE.InstancedMesh(this.sprayGeometry, this.sprayMaterial, this.opts.maxParticles);
        this.sprayMesh.name = 'BoatSpray';
        this.sprayMesh.castShadow = true;
        this.sprayMesh.frustumCulled = false;
        this.sprayMesh.count = 0;
        this.sprayMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        scene.add(this.sprayMesh);

        // Two vertices per sample, RGBA vertex colours so the tail can fade out
        // without a per-instance material.
        const verts = this.opts.wakeSamples * 2;
        this.wakeGeometry = new THREE.BufferGeometry();
        this.wakeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
        this.wakeGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 4), 4));
        const idx = new Uint16Array((this.opts.wakeSamples - 1) * 6);
        for (let i = 0, o = 0; i < this.opts.wakeSamples - 1; i++) {
            const a = i * 2;
            idx[o++] = a; idx[o++] = a + 2; idx[o++] = a + 1;
            idx[o++] = a + 1; idx[o++] = a + 2; idx[o++] = a + 3;
        }
        this.wakeGeometry.setIndex(new THREE.BufferAttribute(idx, 1));
        this.wakeGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
        this.wakeMaterial = new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        this.wakeMesh = new THREE.Mesh(this.wakeGeometry, this.wakeMaterial);
        this.wakeMesh.name = 'BoatWake';
        this.wakeMesh.frustumCulled = false;
        this.wakeMesh.renderOrder = 6;
        scene.add(this.wakeMesh);
    }

    /**
     * Re-point at a different water surface, dropping the trail laid on the old
     * one. `BoatMovement` is constructed before the game's ocean exists, so the
     * wake starts on the flat stand-in and is switched over here; without this
     * the boat rides the swell while its wake stays pinned at y = 0.
     */
    setSurface(surface: WaterSurfaceQuery): void {
        this.surface = surface;
        this.reset();
    }

    /**
     * Advance the effect. `hullPosition` is the boat's waterline point — the
     * same position the motor reports, not the rider's hips.
     */
    update(deltaTime: number, state: BoatState, hullPosition: THREE.Vector3): void {
        const dt = Math.max(1e-4, Math.min(0.1, deltaTime));
        this.updateWake(dt, state, hullPosition);
        this.updateSpray(dt, state, hullPosition);
    }

    private updateWake(dt: number, state: BoatState, hullPosition: THREE.Vector3): void {
        const o = this.opts;
        for (const s of this.wake) s.age += dt;

        const moved = this.hasLastEmit ? hullPosition.distanceTo(this.lastEmit) : Infinity;
        if (state.onWater && moved >= o.wakeSpacing) {
            const dx = Math.sin(state.heading);
            const dz = Math.cos(state.heading);
            this.wake.unshift({ x: hullPosition.x, z: hullPosition.z, dx, dz, age: 0 });
            if (this.wake.length > o.wakeSamples) this.wake.length = o.wakeSamples;
            this.lastEmit.copy(hullPosition);
            this.hasLastEmit = true;
        }

        const pos = this.wakeGeometry.getAttribute('position') as THREE.BufferAttribute;
        const col = this.wakeGeometry.getAttribute('color') as THREE.BufferAttribute;
        const wakeCol = this.wakeColor.set(o.wakeColor);
        for (let i = 0; i < o.wakeSamples; i++) {
            const s = this.wake[i];
            if (!s) {
                // Collapse unused samples onto the newest one so the strip has
                // no stray geometry stretching to the origin.
                const anchor = this.wake[this.wake.length - 1];
                const ax = anchor?.x ?? hullPosition.x;
                const az = anchor?.z ?? hullPosition.z;
                const y = this.surface.heightAt(ax, az) + o.wakeLift;
                pos.setXYZ(i * 2, ax, y, az);
                pos.setXYZ(i * 2 + 1, ax, y, az);
                col.setXYZW(i * 2, 0, 0, 0, 0);
                col.setXYZW(i * 2 + 1, 0, 0, 0, 0);
                continue;
            }
            const t = i / Math.max(1, o.wakeSamples - 1);
            const half = o.wakeHalfWidth + o.wakeSpread * t;
            // Perpendicular to the direction the boat was heading when laid.
            const rx = s.dz;
            const rz = -s.dx;
            const lx = s.x - rx * half;
            const lz = s.z - rz * half;
            const r2x = s.x + rx * half;
            const r2z = s.z + rz * half;
            pos.setXYZ(i * 2, lx, this.surface.heightAt(lx, lz) + o.wakeLift, lz);
            pos.setXYZ(i * 2 + 1, r2x, this.surface.heightAt(r2x, r2z) + o.wakeLift, r2z);
            // Fade with distance behind AND with real age, so a stopped boat's
            // wake dissolves instead of hanging there.
            const alpha = o.wakeOpacity * (1 - t) * Math.max(0, 1 - s.age / 3.5);
            col.setXYZW(i * 2, wakeCol.r, wakeCol.g, wakeCol.b, alpha);
            col.setXYZW(i * 2 + 1, wakeCol.r, wakeCol.g, wakeCol.b, alpha);
        }
        pos.needsUpdate = true;
        col.needsUpdate = true;
    }

    private updateSpray(dt: number, state: BoatState, hullPosition: THREE.Vector3): void {
        const o = this.opts;

        // ---- integrate ----
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i]!;
            p.life -= dt;
            p.vy -= o.gravity * dt;
            p.px += p.vx * dt;
            p.py += p.vy * dt;
            p.pz += p.vz * dt;
            const waterY = this.surface.heightAt(p.px, p.pz);
            if (p.life <= 0 || p.py < waterY) {
                this.particles.splice(i, 1);
            }
        }

        // ---- emit ----
        const speedRatio = Math.min(1, state.speed / 20);
        let want = (o.baseEmitRate * speedRatio + o.driftEmitRate * state.drift * speedRatio) * dt;
        if (state.landingImpact > 0) {
            want += o.landingBurstPerImpact * state.landingImpact;
        }
        if (!state.onWater && state.landingImpact === 0) want = 0;
        this.emitCarry += want;
        const spawn = Math.floor(this.emitCarry);
        this.emitCarry -= spawn;

        const bx = Math.sin(state.heading);
        const bz = Math.cos(state.heading);
        const rx = bz;
        const rz = -bx;
        for (let i = 0; i < spawn && this.particles.length < o.maxParticles; i++) {
            const side = Math.random() < 0.5 ? -1 : 1;
            const lateral = side * (0.35 + Math.random() * 0.7);
            const back = -1.3 - Math.random() * 0.6;
            const px = hullPosition.x + bx * back + rx * lateral;
            const pz = hullPosition.z + bz * back + rz * lateral;
            this.particles.push({
                px,
                // Above the course ribbon's lift, or a transparent ribbon drawn
                // over the spray tints every particle its own colour.
                py: this.surface.heightAt(px, pz) + 0.3,
                pz,
                // Thrown backwards, outwards and up — the rooster tail.
                vx: -bx * (1.5 + state.speed * 0.10) + rx * lateral * 2.6 + (Math.random() - 0.5),
                vy: 2.2 + Math.random() * 2.6 + state.landingImpact * 0.35,
                vz: -bz * (1.5 + state.speed * 0.10) + rz * lateral * 2.6 + (Math.random() - 0.5),
                life: o.particleLife * (0.6 + Math.random() * 0.7),
                spin: Math.random() * Math.PI,
            });
        }

        // ---- write instances ----
        const n = Math.min(this.particles.length, o.maxParticles);
        for (let i = 0; i < n; i++) {
            const p = this.particles[i]!;
            const fade = Math.max(0.15, Math.min(1, p.life / o.particleLife));
            this.dummy.position.set(p.px, p.py, p.pz);
            this.dummy.rotation.set(p.spin, p.spin * 1.7, p.spin * 0.6);
            this.dummy.scale.setScalar(o.particleSize * fade);
            this.dummy.updateMatrix();
            this.sprayMesh.setMatrixAt(i, this.dummy.matrix);
        }
        this.sprayMesh.count = n;
        this.sprayMesh.instanceMatrix.needsUpdate = true;
    }

    /** Drop every trail sample and particle (respawn, teleport, race reset). */
    reset(): void {
        this.particles.length = 0;
        this.wake.length = 0;
        this.hasLastEmit = false;
        this.sprayMesh.count = 0;
    }

    dispose(): void {
        this.scene.remove(this.sprayMesh);
        this.scene.remove(this.wakeMesh);
        this.sprayGeometry.dispose();
        this.sprayMaterial.dispose();
        this.wakeGeometry.dispose();
        this.wakeMaterial.dispose();
    }
}
