/**
 * @fileoverview Keeps shader programs compiled for effects that build and
 * dispose their own materials.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 * three.js deletes a shader program when the last material using it is
 * disposed (WebGL), or when the last render object built from that material
 * and geometry is disposed (WebGPU). An effect that creates a material per
 * spawn and disposes it when it fades therefore pays a synchronous compile on
 * the first draw of EVERY spawn — a hitch on every explosion, telegraph or
 * blood burst. `EffectPool` fixes this where the effect has a re-armable
 * lifecycle. This class covers the rest: public per-instance effect classes
 * that games construct and dispose themselves, and one-shot closures.
 *
 * ── The mechanism ──────────────────────────────────────────────────────────
 * For each material configuration, one always-visible twin object is kept in
 * the scene: a clone of the material on a three-vertex geometry with the same
 * vertex attributes, whose vertices sit far below the world. The twin draws
 * every frame — one degenerate, fully clipped triangle, so no fragment is ever
 * shaded — which keeps the program's last user alive AND makes the driver
 * build its pipeline. Measured on ANGLE: linking alone (what a zero-length
 * draw range gives) left a ~150 ms stall on the first real draw; issuing the
 * draw moves that cost to the frame the twin appears, i.e. into loading when
 * the twin is registered from a constructor. The price is one draw call per
 * configuration per frame.
 *
 * What the program depends on, and so what the twin must match: the material
 * type and its flags, the vertex attributes present (three.js keys on whether
 * `normal` exists, `color` with itemSize 4 is per-vertex alpha, `uv1`,
 * tangents, …), the object type (Mesh / Points / Line), and the scene (fog,
 * lights). The twin lives in the same scene, so the caller supplies only the
 * first three. Built-in geometries all carry `normal` and `uv`, which is the
 * default for a mesh; a custom geometry should be passed so its layout is
 * copied.
 *
 * Lights are the one scene input that moves: on WebGL every program key
 * carries the light counts, even an unlit material's, and three.js re-keys
 * only LIT materials when the counts change. A twin built while a level still
 * had all its lamps visible would keep that program forever while effects
 * spawned after culling compiled another. So the twins take a census of the
 * scene's visible lights every few frames and re-key themselves when it
 * changes — the compile lands on that frame, not on the next spawn.
 *
 * Retain once per configuration, keyed by a stable string; repeat calls are a
 * map lookup. Retaining is idempotent, so calling it from an effect's
 * constructor is the natural place.
 */

import * as THREE from 'three';

/** The renderable the effect draws with — it selects the shader family. */
export type KeepAliveKind = 'mesh' | 'instanced' | 'points' | 'line';

/** A vertex attribute the effect's geometry carries that shapes its program. */
export interface KeepAliveAttribute {
    name: string;
    itemSize: number;
}

/** Name of the group the twins live under, for scene inspection. */
export const SHADER_KEEP_ALIVE_GROUP_NAME = 'ShaderKeepAlive';

/** What every built-in three.js geometry carries beyond `position`. */
export const DEFAULT_MESH_ATTRIBUTES: readonly KeepAliveAttribute[] = [
    { name: 'normal', itemSize: 3 },
    { name: 'uv', itemSize: 2 },
];

/**
 * Vertex attributes the twin's geometry should carry: an explicit list, or a
 * geometry whose layout is copied. `undefined` means the built-in-geometry
 * default for a mesh and `position` only for points and lines.
 */
export type KeepAliveLayout = readonly KeepAliveAttribute[] | THREE.BufferGeometry;

/** Far below any world: the twin's triangle is clipped before rasterisation. */
const TWIN_Y = -1e5;

/** Frames between light censuses. A change is picked up within this many frames. */
export const LIGHT_CENSUS_INTERVAL_FRAMES = 30;

/** What the twins' `onBeforeRender` reads off the renderer — both backends provide it. */
interface FrameCounter {
    info: { render: { frame: number } };
}

/**
 * The light inputs a WebGL program key carries (`WebGLPrograms.getParameters`):
 * counts per light type, shadow-casting counts, spot light maps, light probes.
 */
function lightSignature(scene: THREE.Scene): string {
    let dir = 0, dirShadow = 0, point = 0, pointShadow = 0, spot = 0, spotShadow = 0, spotMap = 0;
    let rect = 0, hemi = 0, probe = 0;
    scene.traverseVisible((o) => {
        const light = o as THREE.Light & {
            isDirectionalLight?: boolean; isPointLight?: boolean; isSpotLight?: boolean;
            isRectAreaLight?: boolean; isHemisphereLight?: boolean; isLightProbe?: boolean;
            map?: THREE.Texture | null;
        };
        if (!light.isLight) return;
        if (light.isDirectionalLight) { dir++; if (light.castShadow) dirShadow++; }
        else if (light.isPointLight) { point++; if (light.castShadow) pointShadow++; }
        else if (light.isSpotLight) { spot++; if (light.castShadow) spotShadow++; if (light.map) spotMap++; }
        else if (light.isRectAreaLight) rect++;
        else if (light.isHemisphereLight) hemi++;
        else if (light.isLightProbe) probe++;
    });
    return `${dir},${dirShadow},${point},${pointShadow},${spot},${spotShadow},${spotMap},${rect},${hemi},${probe}`;
}

export class ShaderKeepAlive {
    private static readonly perScene = new WeakMap<THREE.Scene, ShaderKeepAlive>();

    /** The registry for `scene`, created on first use. */
    static for(scene: THREE.Scene): ShaderKeepAlive {
        let registry = ShaderKeepAlive.perScene.get(scene);
        if (!registry) {
            registry = new ShaderKeepAlive(scene);
            ShaderKeepAlive.perScene.set(scene, registry);
        }
        return registry;
    }

    private readonly scene: THREE.Scene;
    private readonly group: THREE.Group;
    private readonly held = new Map<string, THREE.Object3D>();

    private lastFrame = -1;
    private framesSinceCensus = 0;
    private signature: string | null = null;

    private constructor(scene: THREE.Scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.group.name = SHADER_KEEP_ALIVE_GROUP_NAME;
        this.group.matrixAutoUpdate = false;
        scene.add(this.group);
    }

    /**
     * Runs before every twin draws; does its work once per frame and once
     * per `LIGHT_CENSUS_INTERVAL_FRAMES`. Exposed for tests.
     */
    readonly onTwinBeforeRender = (renderer: FrameCounter): void => {
        const frame = renderer.info.render.frame;
        if (frame === this.lastFrame) return;
        this.lastFrame = frame;
        if (++this.framesSinceCensus < LIGHT_CENSUS_INTERVAL_FRAMES && this.signature !== null) return;
        this.framesSinceCensus = 0;
        const signature = lightSignature(this.scene);
        if (this.signature !== null && signature !== this.signature) {
            for (const twin of this.held.values()) {
                ((twin as THREE.Mesh).material as THREE.Material).needsUpdate = true;
            }
        }
        this.signature = signature;
    };

    /** Whether a twin is held under `key`. */
    has(key: string): boolean {
        return this.held.has(key);
    }

    /** Number of twins held. */
    get size(): number {
        return this.held.size;
    }

    /**
     * Keep the program for `material`, as configured now, compiled under
     * `key`. The material is cloned, so the caller may dispose its own.
     * `layout` is the real geometry (its attribute layout is copied) or the
     * list of attributes it carries beyond `position`; omit it for a mesh on a
     * built-in geometry.
     */
    retain(
        key: string,
        material: THREE.Material,
        kind: KeepAliveKind = 'mesh',
        layout?: KeepAliveLayout,
    ): void {
        // A scene that was cleared between games drops the group; put it back.
        if (this.group.parent !== this.scene) this.scene.add(this.group);
        if (this.held.has(key)) return;

        const attributes = layout === undefined
            ? (kind === 'mesh' || kind === 'instanced' ? DEFAULT_MESH_ATTRIBUTES : [])
            : layout instanceof THREE.BufferGeometry ? ShaderKeepAlive.layoutOf(layout) : layout;

        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(9);
        for (let i = 1; i < 9; i += 3) positions[i] = TWIN_Y;
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        for (const attr of attributes) {
            if (attr.name === 'position') continue;
            geometry.setAttribute(attr.name, new THREE.BufferAttribute(new Float32Array(3 * attr.itemSize), attr.itemSize));
        }
        // Never computed from the vertices — culling is off anyway.
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, TWIN_Y, 0), 1);

        const twinMaterial = material.clone();
        const twin: THREE.Object3D = kind === 'points' ? new THREE.Points(geometry, twinMaterial)
            : kind === 'line' ? new THREE.Line(geometry, twinMaterial)
            : kind === 'instanced' ? new THREE.InstancedMesh(geometry, twinMaterial, 1)
            : new THREE.Mesh(geometry, twinMaterial);
        if (twin instanceof THREE.InstancedMesh) {
            twin.setMatrixAt(0, new THREE.Matrix4());
            twin.setColorAt(0, new THREE.Color(0xffffff));
        }
        twin.name = `${SHADER_KEEP_ALIVE_GROUP_NAME}:${key}`;
        twin.frustumCulled = false;
        twin.matrixAutoUpdate = false;
        twin.onBeforeRender = this.onTwinBeforeRender;
        this.group.add(twin);
        this.held.set(key, twin);
    }

    /**
     * Keep alive whatever `object` renders with: its material (the first, for
     * a material array), object type and geometry attributes are read off it.
     */
    retainFor(key: string, object: THREE.Mesh | THREE.Points | THREE.Line): void {
        if (this.held.has(key)) return;
        const material = Array.isArray(object.material) ? object.material[0] : object.material;
        if (!material) return;
        const kind: KeepAliveKind = (object as THREE.Points).isPoints ? 'points'
            : (object as THREE.Line).isLine ? 'line'
            : (object as THREE.InstancedMesh).isInstancedMesh ? 'instanced'
            : 'mesh';
        this.retain(key, material, kind, object.geometry);
    }

    /** The attribute layout of `geometry`, beyond `position`. */
    private static layoutOf(geometry: THREE.BufferGeometry): KeepAliveAttribute[] {
        const attributes: KeepAliveAttribute[] = [];
        for (const [name, attr] of Object.entries(geometry.attributes)) {
            if (name !== 'position') attributes.push({ name, itemSize: attr.itemSize });
        }
        return attributes;
    }

    /** Drop every twin and free its resources. Programs may then be deleted again. */
    dispose(): void {
        for (const twin of this.held.values()) {
            const renderable = twin as THREE.Mesh;
            renderable.geometry.dispose();
            (renderable.material as THREE.Material).dispose();
            if (renderable instanceof THREE.InstancedMesh) renderable.dispose();
        }
        this.held.clear();
        this.group.clear();
        this.group.parent?.remove(this.group);
        ShaderKeepAlive.perScene.delete(this.scene);
    }
}

/**
 * Keep the program for `material` compiled in `scene`. Shorthand for
 * `ShaderKeepAlive.for(scene).retain(...)` — see that class for what to pass.
 */
export function keepShaderAlive(
    scene: THREE.Scene,
    key: string,
    material: THREE.Material,
    kind: KeepAliveKind = 'mesh',
    layout?: KeepAliveLayout,
): void {
    ShaderKeepAlive.for(scene).retain(key, material, kind, layout);
}
