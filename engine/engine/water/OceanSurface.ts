/**
 * The visible ocean: one camera-following mesh that reads as open water to the
 * horizon, shaded by `engine/shaders/StylizedOceanMaterial.ts` and displaced by
 * the shared `engine/water/OceanWaveField.ts`.
 *
 * ## Why a radial grid and not a big plane
 *
 * A uniform plane large enough to reach the horizon is either coarse near the
 * boat (where every crest matters) or ruinously dense far away (where a
 * triangle is smaller than a pixel). The grid here is radial with
 * exponentially growing ring spacing, centred on the camera: sub-metre facets
 * at the bow, hundreds of metres at the horizon, ~29k quads total. Because the
 * wave field is evaluated in WORLD XZ, recentring the mesh moves the window,
 * never the water — the swell stays pinned to the world and the boat's CPU-side
 * buoyancy agrees with what is on screen.
 *
 * Displacement fades out past `waveFadeStart` (the material's job): beyond it
 * the ring spacing exceeds the shortest wavelength, so displacing would alias
 * into a shimmering mess. Colour, foam and haze carry the distance instead.
 *
 * Usage:
 *   const ocean = createOceanSurface({ waveField });
 *   scene.add(ocean.mesh);
 *   // per frame, after the camera has been positioned:
 *   ocean.update(camera, elapsedSeconds);
 *   // gameplay:
 *   const y = ocean.heightAt(boat.x, boat.z);
 */

import * as THREE from 'three';
import {
    createOceanWaveField,
    OCEAN_WAVE_PRESETS,
    type OceanWaveField,
    type OceanWavePresetName,
} from 'engine/water/OceanWaveField.js';
import {
    createStylizedOceanMaterial,
    DEFAULT_STYLIZED_OCEAN_OPTIONS,
    type OceanPalette,
    type StylizedOceanMaterialHandle,
} from 'engine/shaders/StylizedOceanMaterial.js';
import type { WaterSurfaceQuery } from 'engine/water/WaterSurfaceQuery.js';
import {
    gradientToWorld,
    IDENTITY_OCEAN_WAVE_FRAME,
    toWaveSpace,
    type OceanWaveFrame,
} from 'engine/water/OceanWaveFrame.js';

export interface OceanSurfaceOptions {
    /** Wave field. Defaults to the open-ocean preset. */
    waveField: OceanWaveField;
    /** Mean sea level in world Y. Waves oscillate around it. */
    seaLevelY: number;
    /** Radius of the disc (m). Must comfortably exceed the haze end. */
    radius: number;
    /** Radius of the innermost ring (m) — sets the finest facet size. */
    innerRadius: number;
    /** Rings from `innerRadius` to `radius`, spaced geometrically. */
    ringCount: number;
    /** Radial slices around the disc. */
    sectorCount: number;
    palette: Partial<OceanPalette>;
    /** Sun direction (world, surface → sun); line this up with the level's sun. */
    sunDirection: THREE.Vector3;
    /** Flat tone steps in the cel shading. See StylizedOceanMaterialOptions. */
    toneBands: number;
    foamThreshold: number;
    fleckStrength: number;
    waveFadeStart: number;
    waveFadeEnd: number;
    hazeStart: number;
    hazeEnd: number;
    detailFadeStart: number;
    detailFadeEnd: number;
}

export const DEFAULT_OCEAN_SURFACE_OPTIONS: Omit<OceanSurfaceOptions, 'waveField'> = {
    seaLevelY: 0,
    radius: 8000,
    innerRadius: 1,
    ringCount: 180,
    sectorCount: 160,
    palette: {},
    sunDirection: DEFAULT_STYLIZED_OCEAN_OPTIONS.sunDirection.clone(),
    toneBands: DEFAULT_STYLIZED_OCEAN_OPTIONS.toneBands,
    foamThreshold: DEFAULT_STYLIZED_OCEAN_OPTIONS.foamThreshold,
    fleckStrength: DEFAULT_STYLIZED_OCEAN_OPTIONS.fleckStrength,
    waveFadeStart: 130,
    waveFadeEnd: 560,
    hazeStart: DEFAULT_STYLIZED_OCEAN_OPTIONS.hazeStart,
    hazeEnd: DEFAULT_STYLIZED_OCEAN_OPTIONS.hazeEnd,
    detailFadeStart: DEFAULT_STYLIZED_OCEAN_OPTIONS.detailFadeStart,
    detailFadeEnd: DEFAULT_STYLIZED_OCEAN_OPTIONS.detailFadeEnd,
};

export interface OceanSurface extends WaterSurfaceQuery {
    /** Add this to the scene. It repositions itself in `update`. */
    readonly mesh: THREE.Mesh;
    readonly waveField: OceanWaveField;
    readonly material: StylizedOceanMaterialHandle;
    /** Mean sea level in world Y. */
    readonly seaLevelY: number;
    /** Seconds of animation elapsed, as last driven by `update`. */
    readonly time: number;
    /** Recentre on the camera and advance the animation. Call once per frame. */
    update(camera: THREE.Object3D, elapsedSeconds: number): void;
    /** World Y of the surface at (x, z), at the current animation time. */
    heightAt(x: number, z: number): number;
    /** Unit surface normal at (x, z), at the current animation time. */
    normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
    /**
     * Move the sea past something that holds still: the waves are sampled
     * through `frame` on the GPU and in `heightAt` / `normalAt` alike, so
     * whatever floats stays on the surface that is drawn. Identity (waves pinned
     * to the world) until set. See `engine/water/OceanWaveFrame.ts`.
     */
    setWaveFrame(frame: Readonly<OceanWaveFrame>): void;
    setSunDirection(dir: THREE.Vector3): void;
    dispose(): void;
}

/**
 * Radial disc in the XZ plane, y = 0, rings spaced geometrically so facet size
 * grows with distance. Wound counter-clockwise seen from above, so the face
 * normal is +Y and the default `FrontSide` material shows from above.
 */
function buildRadialGrid(inner: number, outer: number, rings: number, sectors: number): THREE.BufferGeometry {
    const vertCount = 1 + rings * sectors;
    const positions = new Float32Array(vertCount * 3);
    // Vertex 0 is the centre; ring r (1-based) occupies [1 + (r-1)*sectors, ...].
    const growth = Math.pow(outer / inner, 1 / rings);
    let radius = inner;
    let p = 3; // index 0 is the centre, already (0, 0, 0)
    for (let r = 0; r < rings; r++) {
        for (let s = 0; s < sectors; s++) {
            const a = (s / sectors) * Math.PI * 2;
            positions[p++] = Math.cos(a) * radius;
            positions[p++] = 0;
            positions[p++] = Math.sin(a) * radius;
        }
        radius *= growth;
    }

    const triCount = sectors + (rings - 1) * sectors * 2;
    const indices = new Uint32Array(triCount * 3);
    let i = 0;
    // Centre fan.
    for (let s = 0; s < sectors; s++) {
        const a = 1 + s;
        const b = 1 + ((s + 1) % sectors);
        indices[i++] = 0; indices[i++] = b; indices[i++] = a;
    }
    // Ring quads.
    for (let r = 0; r < rings - 1; r++) {
        const base = 1 + r * sectors;
        const next = base + sectors;
        for (let s = 0; s < sectors; s++) {
            const s1 = (s + 1) % sectors;
            const a = base + s;
            const b = base + s1;
            const c = next + s;
            const dIdx = next + s1;
            indices[i++] = a; indices[i++] = dIdx; indices[i++] = c;
            indices[i++] = a; indices[i++] = b; indices[i++] = dIdx;
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    // The shader displaces in Y and the disc already spans the world; a real
    // bounding sphere would only invite culling a mesh that is always relevant.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outer * 1.1);
    return geometry;
}

export function createOceanSurface(options: Partial<OceanSurfaceOptions> = {}): OceanSurface {
    const opts: OceanSurfaceOptions = {
        ...DEFAULT_OCEAN_SURFACE_OPTIONS,
        waveField: options.waveField ?? createOceanWaveField(),
        ...options,
    };
    const field = opts.waveField;
    const materialHandle = createStylizedOceanMaterial({
        waveField: field,
        palette: opts.palette as OceanPalette,
        toneBands: opts.toneBands,
        foamThreshold: opts.foamThreshold,
        fleckStrength: opts.fleckStrength,
        waveFadeStart: opts.waveFadeStart,
        waveFadeEnd: opts.waveFadeEnd,
        hazeStart: opts.hazeStart,
        hazeEnd: opts.hazeEnd,
        detailFadeStart: opts.detailFadeStart,
        detailFadeEnd: opts.detailFadeEnd,
        sunDirection: opts.sunDirection,
    });

    const geometry = buildRadialGrid(
        Math.max(0.05, opts.innerRadius), opts.radius,
        Math.max(2, Math.round(opts.ringCount)), Math.max(3, Math.round(opts.sectorCount)),
    );
    const mesh = new THREE.Mesh(geometry, materialHandle.material);
    mesh.name = 'OceanSurface';
    mesh.frustumCulled = false;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.position.y = opts.seaLevelY;
    // Behind everything that floats on it. The material is opaque and writes
    // depth, so this only matters for other renderOrder-tagged effects.
    mesh.renderOrder = -1;

    let time = 0;
    const originScratch = new THREE.Vector3();
    const waveFrame: OceanWaveFrame = { ...IDENTITY_OCEAN_WAVE_FRAME };
    const waveScratch = new THREE.Vector2();
    const gradScratch = new THREE.Vector2();

    return {
        mesh,
        waveField: field,
        material: materialHandle,
        seaLevelY: opts.seaLevelY,
        get time(): number { return time; },
        update(camera: THREE.Object3D, elapsedSeconds: number): void {
            time = elapsedSeconds;
            // getWorldPosition, not .position: the camera may hang off a rig.
            camera.getWorldPosition(originScratch);
            mesh.position.set(originScratch.x, opts.seaLevelY, originScratch.z);
            materialHandle.setOrigin(originScratch.x, originScratch.z);
            materialHandle.setTime(elapsedSeconds);
        },
        heightAt(x: number, z: number): number {
            toWaveSpace(waveFrame, x, z, waveScratch);
            return opts.seaLevelY + field.heightAt(waveScratch.x, waveScratch.y, time);
        },
        normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
            toWaveSpace(waveFrame, x, z, waveScratch);
            field.gradientAt(waveScratch.x, waveScratch.y, time, gradScratch);
            gradientToWorld(waveFrame, gradScratch);
            return out.set(-gradScratch.x, 1, -gradScratch.y).normalize();
        },
        setWaveFrame(frame: Readonly<OceanWaveFrame>): void {
            waveFrame.cos = frame.cos;
            waveFrame.sin = frame.sin;
            waveFrame.shiftX = frame.shiftX;
            waveFrame.shiftZ = frame.shiftZ;
            materialHandle.setWaveFrame(waveFrame);
        },
        setSunDirection(dir: THREE.Vector3): void {
            materialHandle.setSunDirection(dir);
        },
        dispose(): void {
            mesh.removeFromParent();
            geometry.dispose();
            materialHandle.dispose();
        },
    };
}

/** Resolve a preset name (or an explicit field) to a wave field. */
export function oceanWaveFieldForPreset(
    preset: OceanWavePresetName,
    amplitudeScale = 1,
    windDirectionDeg = 0,
): OceanWaveField {
    return createOceanWaveField(OCEAN_WAVE_PRESETS[preset] ?? OCEAN_WAVE_PRESETS.ocean, {
        amplitudeScale,
        windDirectionDeg,
    });
}
