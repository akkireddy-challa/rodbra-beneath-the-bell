/**
 * Flat, painted sky for stylized outdoor games — the counterpart to
 * `engine/water/OceanSurface.ts`. Open water has nothing in it but sea and
 * sky, so the sky is half the frame: an equirect photo skybox behind a
 * cel-shaded ocean reads as two different games stitched together.
 *
 * Deliberately shader-free. The gradient is baked into VERTEX COLOURS on a
 * sphere and the clouds are flat white quads, both drawn with plain
 * `MeshBasicMaterial`. That means one implementation for WebGL and WebGPU
 * instead of the dual TSL/GLSL path every custom material needs
 * (`game/docs/renderer-backends.md`) — worth it for something this simple.
 *
 * The dome follows the camera, so it never gets closer and never clips.
 *
 * Usage:
 *   const sky = createStylizedSkyDome({ horizon: 0xbfe0f5, zenith: 0x2f7fd6 });
 *   scene.add(sky.group);
 *   // per frame, after positioning the camera:
 *   sky.update(camera, elapsedSeconds);
 */

import * as THREE from 'three';

export interface StylizedSkyDomeOptions {
    /** Colour at the horizon line. Match this to the ocean palette's `horizon`. */
    horizon: THREE.ColorRepresentation;
    /** Colour straight overhead. */
    zenith: THREE.ColorRepresentation;
    /** Cloud colour. */
    cloud: THREE.ColorRepresentation;
    /** Dome radius (m). Keep it inside the camera's far plane. */
    radius: number;
    /** How many cloud clusters to scatter around the band. 0 disables clouds. */
    cloudCount: number;
    /** Lowest cloud elevation, in degrees above the horizon. */
    cloudMinElevationDeg: number;
    /** Highest cloud elevation, in degrees above the horizon. */
    cloudMaxElevationDeg: number;
    /** Degrees per second the cloud band rotates. 0 for a static sky. */
    cloudDriftDegPerSec: number;
    /**
     * How sharply the gradient concentrates near the horizon. 1 is linear in
     * elevation; higher values keep more of the dome at the zenith colour and
     * squeeze the pale band down onto the horizon, which is what a painted sky
     * does.
     */
    gradientBias: number;
    /** Seed for cloud placement, so a scene renders identically every run. */
    seed: number;
}

export const DEFAULT_STYLIZED_SKY_OPTIONS: StylizedSkyDomeOptions = {
    horizon: 0xd6ecfb,
    zenith: 0x2f7fd6,
    cloud: 0xffffff,
    radius: 6000,
    cloudCount: 44,
    cloudMinElevationDeg: 2,
    cloudMaxElevationDeg: 26,
    cloudDriftDegPerSec: 0.35,
    gradientBias: 2.6,
    seed: 1337,
};

export interface StylizedSkyDome {
    /** Add to the scene. Repositions itself in `update`. */
    readonly group: THREE.Group;
    /** Recentre on the camera and drift the clouds. Call once per frame. */
    update(camera: THREE.Object3D, elapsedSeconds: number): void;
    dispose(): void;
}

/** Deterministic LCG — a seeded sky renders the same in every screenshot. */
function makeRandom(seed: number): () => number {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * Sphere with the gradient baked per-vertex. Only the upper hemisphere is
 * generated plus a short skirt below the horizon, so a camera that dips below
 * sea level still sees sky rather than a hole.
 */
function buildDome(opts: StylizedSkyDomeOptions): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(
        opts.radius, 48, 32,
        0, Math.PI * 2,
        0, Math.PI * 0.56, // a little past the equator
    );
    const horizon = new THREE.Color(opts.horizon);
    const zenith = new THREE.Color(opts.zenith);
    const pos = geometry.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
        // Elevation as a 0..1 ramp, biased so the pale band hugs the horizon.
        const elevation = Math.max(0, pos.getY(i) / opts.radius);
        const t = Math.pow(elevation, 1 / opts.gradientBias);
        c.copy(horizon).lerp(zenith, Math.min(1, t));
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'StylizedSkyDome';
    mesh.renderOrder = -100;
    mesh.frustumCulled = false;
    return mesh;
}

/**
 * One cloud: a handful of overlapping discs in a plane, so the silhouette is
 * lumpy the way a painted cloud is instead of a single lens shape. Returned in
 * the XY plane facing +Z; the caller orients it onto the dome.
 */
function buildCloudGeometry(rand: () => number): THREE.BufferGeometry {
    const puffCount = 3 + Math.floor(rand() * 4);
    const parts: THREE.BufferGeometry[] = [];
    let x = 0;
    for (let i = 0; i < puffCount; i++) {
        const r = 0.55 + rand() * 0.65;
        const disc = new THREE.CircleGeometry(r, 14);
        // Flatten: real cloud banks are far wider than they are tall.
        disc.scale(1.35, 0.62, 1);
        disc.translate(x, (rand() - 0.5) * 0.35, 0);
        parts.push(disc);
        x += r * (0.85 + rand() * 0.5);
    }
    // Centre the cluster so rotation about the dome axis behaves.
    const merged = mergeGeometries(parts);
    merged.translate(-x / 2, 0, 0);
    for (const p of parts) p.dispose();
    return merged;
}

/**
 * Minimal position-only merge. `BufferGeometryUtils.mergeGeometries` would do
 * it, but pulling an addon in for flat untextured discs is not worth the
 * import — these have one attribute and no index sharing to reconcile.
 */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
    let vertexTotal = 0;
    let indexTotal = 0;
    for (const p of parts) {
        vertexTotal += p.getAttribute('position').count;
        indexTotal += p.getIndex()?.count ?? 0;
    }
    const positions = new Float32Array(vertexTotal * 3);
    const indices = new Uint16Array(indexTotal);
    let vOffset = 0;
    let iOffset = 0;
    for (const p of parts) {
        const pp = p.getAttribute('position');
        for (let i = 0; i < pp.count; i++) {
            positions[(vOffset + i) * 3] = pp.getX(i);
            positions[(vOffset + i) * 3 + 1] = pp.getY(i);
            positions[(vOffset + i) * 3 + 2] = pp.getZ(i);
        }
        const idx = p.getIndex();
        if (idx) {
            for (let i = 0; i < idx.count; i++) indices[iOffset + i] = vOffset + idx.getX(i);
            iOffset += idx.count;
        }
        vOffset += pp.count;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    return g;
}

export function createStylizedSkyDome(
    options: Partial<StylizedSkyDomeOptions> = {},
): StylizedSkyDome {
    const opts = { ...DEFAULT_STYLIZED_SKY_OPTIONS, ...options };
    const group = new THREE.Group();
    group.name = 'StylizedSky';
    const dome = buildDome(opts);
    group.add(dome);

    // Clouds live under their own group so drift is one rotation, not N.
    const cloudGroup = new THREE.Group();
    cloudGroup.name = 'StylizedSkyClouds';
    group.add(cloudGroup);

    const cloudMaterial = new THREE.MeshBasicMaterial({
        color: opts.cloud,
        side: THREE.DoubleSide,
        depthWrite: false,
        fog: false,
        transparent: true,
        opacity: 0.95,
    });
    const cloudGeometries: THREE.BufferGeometry[] = [];
    const rand = makeRandom(opts.seed);
    const minEl = opts.cloudMinElevationDeg * (Math.PI / 180);
    const maxEl = opts.cloudMaxElevationDeg * (Math.PI / 180);
    // Clouds sit just inside the dome so they always draw in front of it.
    const cloudRadius = opts.radius * 0.94;
    for (let i = 0; i < opts.cloudCount; i++) {
        const geo = buildCloudGeometry(rand);
        cloudGeometries.push(geo);
        const mesh = new THREE.Mesh(geo, cloudMaterial);
        // Bias toward the horizon: low clouds are the ones that read.
        const elevation = minEl + Math.pow(rand(), 1.8) * (maxEl - minEl);
        const azimuth = (i / opts.cloudCount) * Math.PI * 2 + rand() * 0.12;
        const cosEl = Math.cos(elevation);
        mesh.position.set(
            Math.sin(azimuth) * cosEl * cloudRadius,
            Math.sin(elevation) * cloudRadius,
            Math.cos(azimuth) * cosEl * cloudRadius,
        );
        // Face the dome centre; higher clouds are drawn smaller so the band
        // reads as receding rather than as a wall of equal blobs.
        mesh.lookAt(0, 0, 0);
        const scale = cloudRadius * (0.012 + rand() * 0.028) * (1 - elevation / (maxEl * 1.6));
        mesh.scale.setScalar(Math.max(cloudRadius * 0.004, scale));
        mesh.renderOrder = -99;
        mesh.frustumCulled = false;
        cloudGroup.add(mesh);
    }

    const camPos = new THREE.Vector3();
    return {
        group,
        update(camera: THREE.Object3D, elapsedSeconds: number): void {
            camera.getWorldPosition(camPos);
            group.position.copy(camPos);
            cloudGroup.rotation.y = elapsedSeconds * opts.cloudDriftDegPerSec * (Math.PI / 180);
        },
        dispose(): void {
            group.removeFromParent();
            dome.geometry.dispose();
            (dome.material as THREE.Material).dispose();
            for (const g of cloudGeometries) g.dispose();
            cloudMaterial.dispose();
        },
    };
}
