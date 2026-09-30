import * as THREE from 'three';

/**
 * A `THREE.Mesh` that exists purely as a transform node for its children and
 * must never draw anything itself.
 *
 * WHY THIS EXISTS — `new THREE.Mesh()` IS NOT SAFE ON WEBGPU
 * ---------------------------------------------------------
 * Calling `new THREE.Mesh()` with no arguments returns a default
 * `BufferGeometry` that has NO attributes at all. Under WebGL that draws as a
 * harmless no-op, so the idiom "geometry-less Mesh used as a parent" looks
 * fine. Under WebGPU the render pipeline cannot be created without a
 * `position` attribute, so the backend hands `setPipeline()` a null pipeline
 * and throws INSIDE `renderer.render()`:
 *
 *   TypeError: parameter 1 is not of type 'GPURenderPipeline'
 *
 * The exception aborts the whole frame, so a single such node blanks the
 * ENTIRE scene — terrain, characters and skybox included — while the DOM HUD
 * keeps updating. It reads as "the game went completely black", with the real
 * cause several frames upstream. This bit the racing karts: four wheel-wrapper
 * nodes per kart, six karts on the grid.
 *
 * THE FIX: declare the attributes with ZERO-LENGTH arrays. The pipeline gets
 * the vertex layout it needs from the attribute descriptors, and the draw
 * count comes out 0 — a no-op draw that paints nothing. An attribute that is
 * PRESENT but empty is fine (a CPU-released terrain batch is exactly that and
 * renders correctly); an attribute that is ABSENT is what kills the frame.
 *
 * Prefer `THREE.Group` whenever the type allows it — reach for this only when
 * a `THREE.Mesh` is required by a shipped engine interface that cannot be
 * widened (e.g. `VehicleRenderer.createWheelMeshes`).
 */

/**
 * Immutable, shared across every transform-only mesh: it is never drawn and
 * never mutated, so one instance for the whole engine is safe.
 */
export const TRANSFORM_ONLY_GEOMETRY = (() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(0), 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(0), 2));
    // An empty geometry has no finite bounds; give it degenerate ones rather
    // than let anything test a NaN sphere.
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    geom.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    return geom;
})();

/**
 * Create a Mesh that carries children but draws nothing of its own. Culling is
 * disabled because the node has no extent — its children are separate objects
 * and are culled on their own bounds.
 */
export function createTransformOnlyMesh(name?: string): THREE.Mesh {
    const mesh = new THREE.Mesh(TRANSFORM_ONLY_GEOMETRY);
    mesh.frustumCulled = false;
    if (name !== undefined) mesh.name = name;
    return mesh;
}
