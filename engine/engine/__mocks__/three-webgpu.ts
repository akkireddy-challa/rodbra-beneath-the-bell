/**
 * Jest mock for `three/webgpu`.
 *
 * `three/webgpu` is an ESM-only build (`three` is `"type": "module"`) that
 * re-exports from `three.core.js` with top-level `import`, which the ts-jest CJS
 * runtime cannot evaluate. Engine material factories import it at module load
 * for the WebGPU (NodeMaterial/TSL) path. Most tests never take that path —
 * `isWebGpuActive()` returns false (the default WebGL backend) — so this stub
 * exists first of all to satisfy the top-level import bindings, letting a module
 * that offers both backends be loaded in a test without pulling in the real ESM
 * build. A test that wants the WebGPU branch opts in with
 * `setActiveRendererType('webgpu')` and gets these stand-ins; the real node graph
 * and shader compilation still only happen in a browser.
 *
 * Add exports here only as tested modules begin importing more `three/webgpu`
 * symbols. Keep them thin — the real node/TSL machinery must not run in Jest.
 */

import * as THREE from 'three';

/** Minimal stand-in for a NodeMaterial subclass.
 *
 *  Subclasses `THREE.Material` so tests that deliberately take the WebGPU branch
 *  (`setActiveRendererType('webgpu')`) get the real base behaviour the engine's
 *  node paths use — `userData`, `alphaHash`, `side`, and the `dispose` event that
 *  `EnvDistanceFade` unregisters its fade uniforms on. `color` is declared here
 *  because the real node materials carry one and the faded-material factory copies
 *  the source tint onto it.
 *
 *  Declared rather than left absent because a missing named export does NOT throw
 *  under the CJS runtime — it simply arrives as `undefined`, so an import that has
 *  outgrown this stub goes unnoticed until something tries to construct it. */
class InertNodeMaterial extends THREE.Material {
    emissiveNode: unknown = null;
    opacityNode: unknown = null;
    color: THREE.Color = new THREE.Color(0xffffff);
    map: THREE.Texture | null = null;
    vertexColors: boolean = false;
    constructor(parameters?: Record<string, unknown>) {
        super();
        // Only the handful of constructor params the engine's node paths pass; the
        // real NodeMaterial applies the full set.
        if (parameters) Object.assign(this, parameters);
    }
}

export class MeshLambertNodeMaterial extends InertNodeMaterial {}
/** `VoxelSlotMaterial`'s 'direct' material-class tier. */
export class MeshPhongNodeMaterial extends InertNodeMaterial {}
/** `VoxelSlotMaterial`'s 'environment' material-class tier. */
export class MeshPhysicalNodeMaterial extends InertNodeMaterial {}
/** Skin coverage/albedo pass class checks; real shaders run in browser reviews. */
export class MeshBasicNodeMaterial extends InertNodeMaterial {}
/** `EnvDistanceFade`'s faded copy of a Standard env-object material. */
export class MeshStandardNodeMaterial extends InertNodeMaterial {}
/** Hero skin subclasses this; shader execution is covered outside Jest. */
export class PhysicalLightingModel {}
