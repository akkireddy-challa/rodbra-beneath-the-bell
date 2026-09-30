import * as THREE from 'three';
import { SeededRandom } from 'engine/SeededRandom.js';
import type { WaterSurfaceQuery } from 'engine/water/WaterSurfaceQuery.js';
import type { VesselFrame } from 'engine/sailing/VesselFrame.js';

/**
 * Foam that reads the ship as under way, when the ship itself cannot move.
 *
 * Streaks of foam stream aft past the hull at the ship's speed and are born
 * again ahead of the bow; a standing wake peels off the stem and churns astern.
 * Everything sits ON the water — every patch is sampled onto the surface each
 * frame — and a turn sweeps the whole field across the bow, because in the
 * frame of a turning ship that is where the sea goes.
 *
 * Laid out in SHIP SPACE: `group` stands at the ship's centre yawed to its
 * geometry, so a child's local +Z is towards the bow and "aft" is −Z. Add
 * `group` to the world; the wake owns nothing else.
 */
export interface SailingWakeOptions {
    /** Drifting foam patches alive at once. */
    streakCount: number;
    /** How far ahead of the ship's centre a patch is born, in metres. */
    fieldForward: number;
    /** How far astern it drifts before it is born again, in metres. */
    fieldAft: number;
    /** Half-width of the foam field, in metres — keep it inside the fog's near band. */
    fieldHalfWidth: number;
    /** Gap between the hull's side and the nearest patch, in metres. */
    hullClearance: number;
    /** How far foam floats above the water it is sampled onto, in metres. */
    surfaceClearance: number;
    /** Opacity range of a drifting patch. */
    opacityRange: readonly [number, number];
    foamColor: THREE.ColorRepresentation;
    wakeColor: THREE.ColorRepresentation;
    /** Seed for the layout, so the same sea turns up every run. */
    seed: number;
}

export const DEFAULT_SAILING_WAKE_OPTIONS: SailingWakeOptions = {
    streakCount: 60,
    fieldForward: 70,
    fieldAft: 80,
    fieldHalfWidth: 46,
    hullClearance: 4.25,
    surfaceClearance: 0.08,
    opacityRange: [0.18, 0.48],
    foamColor: 0xeef6ff,
    wakeColor: 0xffffff,
    seed: 0x5ea15,
};

/**
 * Patches share a few materials rather than one each: the breathing that stops
 * foam reading as solid only needs to be out of step between neighbours.
 */
const OPACITY_BUCKETS = 6;
/** Past this far outside the field (after a long turn) a patch is recycled. */
const FIELD_SLACK = 10;
/** Names on the children, so tools and tests can tell the pieces apart. */
export const SAILING_WAKE_STREAK_NAME = 'SailingWakeStreak';
export const SAILING_WAKE_STANDING_NAME = 'SailingWakeStanding';

interface OpacityBucket {
    material: THREE.MeshBasicMaterial;
    base: number;
    phase: number;
}

export class SailingWake {
    /** Ship space. Add to the world; see the class comment. */
    readonly group: THREE.Group;

    private readonly options: SailingWakeOptions;
    private readonly surface: WaterSurfaceQuery;
    private readonly random: SeededRandom;
    private readonly geometry = new THREE.PlaneGeometry(1, 1);
    private readonly buckets: OpacityBucket[] = [];
    private readonly standingMaterials: THREE.MeshBasicMaterial[] = [];
    private readonly streaks: THREE.Mesh[] = [];
    private readonly standing: THREE.Mesh[] = [];
    private readonly innerHalfWidth: number;
    private readonly centreX: number;
    private readonly centreZ: number;
    private readonly cosHeading: number;
    private readonly sinHeading: number;
    private elapsed = 0;

    constructor(frame: VesselFrame, surface: WaterSurfaceQuery, options: SailingWakeOptions) {
        this.options = options;
        this.surface = surface;
        this.random = new SeededRandom(options.seed);
        this.innerHalfWidth = frame.beam / 2 + options.hullClearance;
        this.centreX = frame.centre.x;
        this.centreZ = frame.centre.z;
        this.cosHeading = Math.cos(frame.heading);
        this.sinHeading = Math.sin(frame.heading);

        this.group = new THREE.Group();
        this.group.name = 'SailingWake';
        this.group.position.set(frame.centre.x, 0, frame.centre.z);
        this.group.rotation.y = frame.heading;

        const [lo, hi] = options.opacityRange;
        for (let i = 0; i < OPACITY_BUCKETS; i++) {
            const base = lo + (hi - lo) * (i / (OPACITY_BUCKETS - 1));
            this.buckets.push({ material: foamMaterial(options.foamColor, base), base, phase: this.random.next() * Math.PI * 2 });
        }

        for (let i = 0; i < options.streakCount; i++) {
            const mesh = this.flatQuad(this.buckets[i % OPACITY_BUCKETS]!.material, SAILING_WAKE_STREAK_NAME);
            this.placeStreak(mesh, options.fieldForward - this.random.next() * (options.fieldForward + options.fieldAft));
            this.streaks.push(mesh);
        }

        this.buildStandingWake(frame);
    }

    /**
     * The wake that stands with the hull: two streaks peeling off the stem and
     * the churn under the stern, sized from the ship rather than hand-placed.
     */
    private buildStandingWake(frame: VesselFrame): void {
        const half = frame.length / 2;
        for (const side of [-1, 1]) {
            const material = foamMaterial(this.options.wakeColor, 0.4);
            this.standingMaterials.push(material);
            const mesh = this.flatQuad(material, SAILING_WAKE_STANDING_NAME);
            mesh.rotation.z = side * 0.32;
            mesh.scale.set(frame.beam * 0.25, frame.length * 0.33, 1);
            mesh.position.set(side * frame.beam * 0.385, 0, half * 0.65);
            mesh.userData.baseScaleX = mesh.scale.x;
            this.standing.push(mesh);
        }

        const churnMaterial = foamMaterial(this.options.wakeColor, 0.3);
        churnMaterial.color.set(0xdfeaf5);
        this.standingMaterials.push(churnMaterial);
        const churn = this.flatQuad(churnMaterial, SAILING_WAKE_STANDING_NAME);
        churn.scale.set(frame.beam * 0.67, frame.length * 0.5, 1);
        churn.position.set(0, 0, -half - frame.length * 0.19);
        churn.userData.baseScaleX = churn.scale.x;
        this.standing.push(churn);
    }

    private flatQuad(material: THREE.Material, name: string): THREE.Mesh {
        const mesh = new THREE.Mesh(this.geometry, material);
        mesh.name = name;
        mesh.rotation.x = -Math.PI / 2;
        mesh.renderOrder = 2;
        this.group.add(mesh);
        return mesh;
    }

    /** Put a patch at longitudinal `z` (ship space) with a fresh width, length and side. */
    private placeStreak(mesh: THREE.Mesh, z: number): void {
        const { fieldHalfWidth } = this.options;
        const side = this.random.next() < 0.5 ? -1 : 1;
        const inner = Math.min(this.innerHalfWidth, fieldHalfWidth);
        const lateral = side * (inner + this.random.next() * (fieldHalfWidth - inner));
        mesh.position.set(lateral, 0, z);
        mesh.scale.set(0.6 + this.random.next() * 1.8, 2.5 + this.random.next() * 6, 1);
    }

    /**
     * Drift the sea past the hull. `speed` is the way the ship is making
     * (m/s); `turnRate` how fast she is swinging (rad/s, positive to starboard).
     */
    update(deltaTime: number, speed: number, turnRate: number): void {
        this.elapsed += deltaTime;
        const { fieldForward, fieldAft, fieldHalfWidth } = this.options;
        const travelled = speed * deltaTime;

        // A ship swinging to starboard sees the sea swing to port about her centre.
        const sweep = -turnRate * deltaTime;
        const c = Math.cos(sweep);
        const s = Math.sin(sweep);

        for (const mesh of this.streaks) {
            const p = mesh.position;
            const x = p.x * c + p.z * s;
            const z = -p.x * s + p.z * c - travelled;
            p.x = x;
            p.z = z;
            if (z < -fieldAft || z > fieldForward + FIELD_SLACK || Math.abs(x) > fieldHalfWidth + FIELD_SLACK) {
                this.placeStreak(mesh, fieldForward);
            }
        }

        for (const bucket of this.buckets) {
            bucket.material.opacity = bucket.base * (0.75 + 0.25 * Math.sin(this.elapsed * 0.9 + bucket.phase));
        }
        const pulse = 0.85 + 0.15 * Math.sin(this.elapsed * 1.6);
        for (const mesh of this.standing) mesh.scale.x = (mesh.userData.baseScaleX as number) * pulse;

        for (const mesh of this.streaks) this.float(mesh);
        for (const mesh of this.standing) this.float(mesh);
    }

    /** Sit a patch on the water rather than on a flat plane at mean sea level. */
    private float(mesh: THREE.Mesh): void {
        const { x, z } = mesh.position;
        const worldX = this.centreX + x * this.cosHeading + z * this.sinHeading;
        const worldZ = this.centreZ - x * this.sinHeading + z * this.cosHeading;
        mesh.position.y = this.surface.heightAt(worldX, worldZ) + this.options.surfaceClearance;
    }

    dispose(): void {
        this.group.removeFromParent();
        this.geometry.dispose();
        for (const bucket of this.buckets) bucket.material.dispose();
        for (const material of this.standingMaterials) material.dispose();
        this.streaks.length = 0;
        this.standing.length = 0;
    }
}

function foamMaterial(color: THREE.ColorRepresentation, opacity: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
}
