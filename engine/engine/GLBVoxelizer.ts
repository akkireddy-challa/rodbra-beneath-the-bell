/**
 * GLBVoxelizer — browser-side GLB-to-VXL voxelization.
 *
 * Adaptive version with variable voxel sizes based on geometry flatness.
 * Larger voxels in flat areas, smaller in detailed/curved areas.
 * Ignores texture variation for size decisions.
 *
 * Output format: VXL v3 packed binary (see VxlV3Format.ts). The
 * `preFragment` option enables build-time spatial partitioning so the
 * runtime can detach whole fragments on explosion instead of rebuilding
 * meshes/colliders for thousands of leaves.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { encodeVxlV3, type VxlV3Fragment, type VxlV3LodLevel, type VxlV3RigInput } from 'engine/VxlV3Format.js';
import { assignVoxelSlotsFromTriangles, nearestOwnerForLeaves } from 'engine/VoxelSlotAssign.js';
import { isBmPartNodeName } from 'engine/import/SmartPropParts.js';
import type { VxlV3Part } from 'engine/VxlV3Parts.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { bakeSurfaceAssetLeaves } from 'engine/SurfaceAssetVoxelizer.js';
import { expandBoundsToFitLeaves } from 'engine/VoxelAssetBounds.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
// extractGlbForVoxelization + ExtractedGlb live in their own file so this
// one stays under the 2000-line ESLint cap. Imported here for use by
// `voxelizeGLB` / `voxelizeFromExtracted` below, and re-exported so
// consumers importing from 'engine/GLBVoxelizer.js' continue to work.
import { extractGlbForVoxelization, type ExtractedGlb } from 'engine/ExtractGlbForVoxelization.js';
export { extractGlbForVoxelization, type ExtractedGlb };
// estimateColliderCount lives in its own pure module (no THREE import) so it can be
// unit tested and reused without pulling in this file's module-scope
// `three/examples/jsm` import. Re-exported here for existing consumers.
import { estimateColliderCount } from 'engine/ColliderEstimate.js';
export { estimateColliderCount };

// ─── Public interface ────────────────────────────────────────────────

export interface VoxelizeOptions {
  minVoxelSize: number;     // smallest voxel edge length (e.g. 0.1)
  maxVoxelSize: number;     // largest voxel edge length (e.g. 1.0)
  targetHeight?: number;    // optional, in meters
  fitBox?: { x: number; z: number; height: number };  // allocated box (m); when set and targetHeight is unset, height is computed to fit
  fillInterior: boolean;    // default true
  useSRGB?: boolean;        // default true
  /**
   * Pre-fragmentation: partition the voxelized leaves into spatial chunks
   * at build time so a runtime explosion can detach whole fragments as
   * single rigid bodies instead of rebuilding meshes/colliders per-leaf.
   * Omit to produce a single-fragment file (default).
   */
  preFragment?: { targetFragments?: number; individualVoxels?: number };
  /**
   * Coarser LOD levels to bake alongside the primary voxelization.
   * Ordered finest-to-coarsest. Each entry runs an independent octree pass
   * over the same GLB triangles + interior grid, then gets appended as a
   * v4 LOD trailer entry in the output file. Empty/undefined = single-LOD
   * v3 output (backward compatible).
   */
  additionalLods?: Array<{ minVoxelSize: number; maxVoxelSize: number }>;
  /**
   * Voxelization engine. `'surface'` (the default) is the World-Forger level
   * algorithm: rasterize every triangle at minVoxelSize into a uniform grid,
   * then merge bottom-up — full surface and color fidelity at min resolution,
   * with merging bounded by coplanarity/color tolerances. `'octree'` is the
   * legacy top-down adaptive subdivision: smaller files on texture-heavy
   * models, but a merged leaf carries one color (texture detail lost) and
   * tilted-flat surfaces stair-step at merged-leaf scale.
   */
  algorithm?: 'surface' | 'octree';
  /**
   * Smart-object parts (v12): the parts table and rig to write, and which joint
   * a source node's triangles belong to (0 = body). Every leaf, at every LOD,
   * takes the joint of the triangle closest to its centre — the same rule
   * material slots use — so a `BM_part_blades` node's voxels turn with the
   * blades whatever angle the blades were authored at.
   */
  smartParts?: { table: VxlV3Part[]; rig: VxlV3RigInput; jointOfNode: (nodeName: string) => number };
  /**
   * Optional callback fired once per LOD pass (LOD 0 + each additional).
   * `index` is 0-based and `total` includes LOD 0. Used to drive a progress
   * indicator like "Voxelizing LOD 2 of 3...".
   */
  onProgress?: (info: { index: number; total: number; label: string }) => void;
  /**
   * Enable sub-cell displacement on surface-touching leaves: each leaf's
   * cube center shifts toward the closest point on the actual surface so
   * adjacent leaves on a tilted plane track the slope smoothly instead
   * of stair-stepping at grid boundaries. Output uses VXL v5 (per-leaf
   * displacement bytes).
   *
   * Off by default — only `voxelizeGLBToVxlWorld` (the level path)
   * enables it. Asset voxelization stays on v3/v4 so existing
   * `VoxelObject.loadFromFile` consumers don't break.
   */
  enableDisplacement?: boolean;
  /**
   * If set, voxels slide along this single axis so the cube's face
   * nearest the surface (in that axis' direction) sits on the
   * surface. Use `'y'` for horizontal driving / walking surfaces,
   * `'x'` / `'z'` for vertical walls. Missing / undefined = no
   * displacement (grid-aligned).
   *
   * **Only one axis** — multi-axis displacement opens gaps where
   * adjacent cells' normals tilt slightly differently and their
   * cubes drift apart laterally. With a single fixed axis, all
   * voxels in this pass slide together along the same line so
   * neighbours always touch.
   */
  displacementAxis?: 'x' | 'y' | 'z';
}

export interface VoxelizeResult {
  /** v3 / v4 binary VXL bytes. Upload as application/octet-stream. */
  vxlBytes: Uint8Array;
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  /** meters — the height the model was actually voxelized at (after targetHeight/fitBox/cm scaling); persist this so a re-voxelize keeps the size */
  effectiveTargetHeight: number;
  /**
   * meters — the LOD0 voxel size actually achieved, which is the requested `minVoxelSize` until
   * the surface pass overruns `SURFACE_LOD0_LEAF_BUDGET` and re-bakes coarser to stay renderable.
   * Persist THIS as the asset's `voxelSize`: recording the request instead leaves world.json
   * asserting a resolution the uploaded `.vxl` contradicts, and the gap is a silent doubling.
   *
   * Optional only for the engine-API compatibility rule (a shipped consumer may destructure this
   * type); every code path here sets it, so a caller's fallback is unreachable in practice.
   */
  effectiveMinVoxelSize?: number;
  totalVoxels: number;
  nodeCount: number;
  fragmentCount: number;
  colliderBoxCount: number;
  trimeshTriangles: number;
  /** LOD 0 + additional LOD counts (>=1). Equals 1 + (additionalLods?.length ?? 0). */
  lodCount: number;
  /** Per-LOD leaf counts, primary first. Useful for UI labels and asset-card stats. */
  voxelsPerLod: number[];
  /** Material slots baked from `BM_slot_*` GLB materials; empty for most assets. */
  slotNames: string[];
  warning?: string;
}

// ─── Constants ───────────────────────────────────────────────────────

const FLATNESS_THRESHOLD = 0.965; // cos(~15°) — normal variation below this is "flat"
/** Max stair-step error a merged leaf may add on a TILTED flat surface, in units of
 *  the pass min voxel size: leaf qualifies only while `size × slant ≤ min × this`.
 *  2 keeps gentle ramps cheap (a 7° ramp still merges 16× min) while a 45° surface
 *  is capped at 2× min — the visible steps stay at min-voxel scale. */
const SLANT_STEP_FACTOR = 2;

// ─── Math utilities ──────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function snapDown(v: number, step: number): number {
  return Math.floor(v / step) * step;
}

export function snapUp(v: number, step: number): number {
  return Math.ceil(v / step) * step;
}

// ─── Color-space conversion ──────────────────────────────────────────

function srgbToLinear(u8: number): number {
  const c = u8 / 255;
  if (c <= 0.04045) return c / 12.92;
  return ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(linear: number): number {
  const c = clamp(linear, 0, 1);
  const srgb = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return clamp(Math.round(srgb * 255), 0, 255);
}

function rgb888To565(r: number, g: number, b: number): number {
  const r5 = (r >> 3) & 0x1f;
  const g6 = (g >> 2) & 0x3f;
  const b5 = (b >> 3) & 0x1f;
  return (r5 << 11) | (g6 << 5) | b5;
}

// ─── Geometry helpers ────────────────────────────────────────────────

interface BaryResult {
  point: THREE.Vector3;
  bary: { u: number; v: number; w: number };
}

/**
 * Closest point on triangle (Ericson, "Real-Time Collision Detection").
 * Returns the point and its barycentric coordinates.
 */
function closestPointToTriangle(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): BaryResult {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const ap = new THREE.Vector3().subVectors(p, a);

  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0)
    return { point: a.clone(), bary: { u: 1, v: 0, w: 0 } };

  const bp = new THREE.Vector3().subVectors(p, b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3)
    return { point: b.clone(), bary: { u: 0, v: 1, w: 0 } };

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const point = a.clone().add(ab.clone().multiplyScalar(v));
    return { point, bary: { u: 1 - v, v, w: 0 } };
  }

  const cp = new THREE.Vector3().subVectors(p, c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6)
    return { point: c.clone(), bary: { u: 0, v: 0, w: 1 } };

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const point = a.clone().add(ac.clone().multiplyScalar(w));
    return { point, bary: { u: 1 - w, v: 0, w } };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const point = b
      .clone()
      .add(new THREE.Vector3().subVectors(c, b).multiplyScalar(w));
    return { point, bary: { u: 0, v: 1 - w, w } };
  }

  // Inside face region
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const u = 1 - v - w;
  const point = a
    .clone()
    .multiplyScalar(u)
    .add(b.clone().multiplyScalar(v))
    .add(c.clone().multiplyScalar(w));
  return { point, bary: { u, v, w } };
}

// ─── Triangle-box overlap (Akenine-Möller) ───────────────────────────

/**
 * Returns true if triangle (v0,v1,v2 — relative to box centre) overlaps
 * an axis-aligned box centred at the origin with half-extents `half`.
 */
function triBoxOverlap(
  half: THREE.Vector3,
  v0: THREE.Vector3,
  v1: THREE.Vector3,
  v2: THREE.Vector3,
): boolean {
  const e0 = new THREE.Vector3().subVectors(v1, v0);
  const e1 = new THREE.Vector3().subVectors(v2, v1);
  const e2 = new THREE.Vector3().subVectors(v0, v2);

  const f: [number, number, number] = [Math.abs(e0.x), Math.abs(e0.y), Math.abs(e0.z)];
  const g: [number, number, number] = [Math.abs(e1.x), Math.abs(e1.y), Math.abs(e1.z)];
  const h: [number, number, number] = [Math.abs(e2.x), Math.abs(e2.y), Math.abs(e2.z)];

  function axisTest(
    aa: number, bb: number, fa: number, fb: number,
    v0a: number, v0b: number, v1a: number, v1b: number,
    v2a: number, v2b: number, ha: number, hb: number,
  ): boolean {
    const p0 = aa * v0a - bb * v0b;
    const p1 = aa * v1a - bb * v1b;
    const p2 = aa * v2a - bb * v2b;
    const min = Math.min(p0, p1, p2);
    const max = Math.max(p0, p1, p2);
    const rad = fa * ha + fb * hb;
    return !(min > rad || max < -rad);
  }

  // 9 separating-axis tests
  if (!axisTest(e0.z, e0.y, f[2], f[1], v0.y, v0.z, v1.y, v1.z, v2.y, v2.z, half.y, half.z)) return false;
  if (!axisTest(e0.z, e0.x, f[2], f[0], v0.x, v0.z, v1.x, v1.z, v2.x, v2.z, half.x, half.z)) return false;
  if (!axisTest(e0.y, e0.x, f[1], f[0], v0.x, v0.y, v1.x, v1.y, v2.x, v2.y, half.x, half.y)) return false;

  if (!axisTest(e1.z, e1.y, g[2], g[1], v0.y, v0.z, v1.y, v1.z, v2.y, v2.z, half.y, half.z)) return false;
  if (!axisTest(e1.z, e1.x, g[2], g[0], v0.x, v0.z, v1.x, v1.z, v2.x, v2.z, half.x, half.z)) return false;
  if (!axisTest(e1.y, e1.x, g[1], g[0], v0.x, v0.y, v1.x, v1.y, v2.x, v2.y, half.x, half.y)) return false;

  if (!axisTest(e2.z, e2.y, h[2], h[1], v0.y, v0.z, v1.y, v1.z, v2.y, v2.z, half.y, half.z)) return false;
  if (!axisTest(e2.z, e2.x, h[2], h[0], v0.x, v0.z, v1.x, v1.z, v2.x, v2.z, half.x, half.z)) return false;
  if (!axisTest(e2.y, e2.x, h[1], h[0], v0.x, v0.y, v1.x, v1.y, v2.x, v2.y, half.x, half.y)) return false;

  // AABB overlap
  if (Math.min(v0.x, v1.x, v2.x) > half.x || Math.max(v0.x, v1.x, v2.x) < -half.x) return false;
  if (Math.min(v0.y, v1.y, v2.y) > half.y || Math.max(v0.y, v1.y, v2.y) < -half.y) return false;
  if (Math.min(v0.z, v1.z, v2.z) > half.z || Math.max(v0.z, v1.z, v2.z) < -half.z) return false;

  // Plane-box overlap
  const normal = new THREE.Vector3().crossVectors(e0, new THREE.Vector3().subVectors(v2, v0));
  const vmin = new THREE.Vector3(
    normal.x > 0 ? -half.x : half.x,
    normal.y > 0 ? -half.y : half.y,
    normal.z > 0 ? -half.z : half.z,
  );
  const vmax = new THREE.Vector3(
    normal.x > 0 ? half.x : -half.x,
    normal.y > 0 ? half.y : -half.y,
    normal.z > 0 ? half.z : -half.z,
  );
  const d = -normal.dot(v0);
  if (normal.dot(vmin) + d > 0) return false;
  if (normal.dot(vmax) + d >= 0) return true;
  return false;
}

// ─── Triangle structure ──────────────────────────────────────────────

export interface Triangle {
  v0: THREE.Vector3;
  v1: THREE.Vector3;
  v2: THREE.Vector3;
  normal: THREE.Vector3;
  material: THREE.MeshStandardMaterial | null;
  uv0?: THREE.Vector2;
  uv1?: THREE.Vector2;
  uv2?: THREE.Vector2;
  col0?: { r: number; g: number; b: number };
  col1?: { r: number; g: number; b: number };
  col2?: { r: number; g: number; b: number };
  /**
   * Name of the topmost-named ancestor node in the GLB scene that this
   * triangle came from. Used by the level voxelizer to filter triangles
   * by per-object LOD offset (`voxelizeGLBToVxlWorld` runs one octree
   * pass per distinct offset, each over the subset whose `sourceNodeName`
   * maps to that offset). Empty string when no named ancestor was found.
   *
   * Asset voxelization (single-LOD `voxelizeGLB`) ignores this — there's
   * no per-object dial there.
   */
  sourceNodeName?: string;
}

// ─── Octree Node ─────────────────────────────────────────────────────

class OctreeNode {
  min: THREE.Vector3;
  size: number;
  color: number = 0; // RGB565, 0 if empty
  children: (OctreeNode | null)[] | null = null;
  /**
   * Sub-cell displacement of the leaf cube's CENTER from the cell-center
   * grid position, in world units. Set by `buildNode` for surface-touching
   * leaves: the cube slides toward the closest point on the actual surface,
   * which lets adjacent leaves on a tilted plane track the slope smoothly
   * instead of stair-stepping. Components are clamped to `[-size/2, +size/2]`
   * so the cube stays inside its cell. Zero / undefined for interior
   * (flood-fill) leaves and for leaves where the surface already sits at
   * the cell center.
   */
  dx: number = 0;
  dy: number = 0;
  dz: number = 0;

  constructor(min: THREE.Vector3, size: number, color: number = 0) {
    this.min = min;
    this.size = size;
    this.color = color;
  }
}

// ─── Mesh traversal helpers ─────────────────────────────────────────

export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry) {
      meshes.push(obj);
    }
  });
  return filterEnvironmentMeshes(meshes);
}

/**
 * Filter out environment/background meshes (e.g. Sketchfab environment spheres).
 * Detects meshes whose world-space bounding box fully encloses all other meshes
 * and is disproportionately large compared to the content inside.
 */
function filterEnvironmentMeshes(meshes: THREE.Mesh[]): THREE.Mesh[] {
  if (meshes.length <= 1) return meshes;
  // A smart prop's body encloses its small part nodes by design (a tower and
  // its blades) — that is not an environment sphere, so never filter it.
  if (meshes.some((mesh) => hasBmPartAncestor(mesh))) return meshes;

  const boxes: THREE.Box3[] = meshes.map((mesh) => {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    return bb.clone().applyMatrix4(mesh.matrixWorld);
  });

  const filtered: THREE.Mesh[] = [];

  for (let i = 0; i < meshes.length; i++) {
    const box = boxes[i]!;
    const size = new THREE.Vector3();
    box.getSize(size);
    const volume = size.x * size.y * size.z;

    const othersBox = new THREE.Box3();
    for (let j = 0; j < meshes.length; j++) {
      if (j !== i) othersBox.union(boxes[j]!);
    }

    if (!othersBox.isEmpty()) {
      const othersSize = new THREE.Vector3();
      othersBox.getSize(othersSize);
      const othersVolume = othersSize.x * othersSize.y * othersSize.z;

      if (box.containsBox(othersBox) && volume > othersVolume * 8) {
        console.warn(
          `[GLBVoxelizer] Filtered out environment mesh "${meshes[i]!.name || '(unnamed)'}" — ` +
          `volume ${volume.toFixed(1)} is ${(volume / othersVolume).toFixed(0)}x larger than content`
        );
        continue;
      }
    }

    filtered.push(meshes[i]!);
  }

  return filtered.length > 0 ? filtered : meshes;
}

/** True for a mesh under a `BM_part_*` node (or named so itself). */
function hasBmPartAncestor(mesh: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = mesh;
  while (node) {
    if (isBmPartNodeName(node.name)) return true;
    node = node.parent;
  }
  return false;
}

interface GeometryAttrs {
  positions: Float32Array | number[];
  uvs: Float32Array | number[] | null;
  colors: Float32Array | number[] | null;
  indices: Uint16Array | Uint32Array | number[] | null;
}

export function getGeometryAttributes(mesh: THREE.Mesh): GeometryAttrs | null {
  const geom = mesh.geometry;
  const posAttr = geom.getAttribute('position');
  const uvAttr = geom.getAttribute('uv');
  const colAttr = geom.getAttribute('color');
  const indexAttr = geom.getIndex();

  if (!posAttr) return null;

  const positions = (posAttr as THREE.BufferAttribute).array as Float32Array;
  const uvs = uvAttr ? (uvAttr as THREE.BufferAttribute).array as Float32Array : null;
  const colors = colAttr ? (colAttr as THREE.BufferAttribute).array as Float32Array : null;
  const indices = indexAttr ? indexAttr.array as Uint16Array | Uint32Array : null;

  return { positions, uvs, colors, indices };
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function getMaterialBaseColor(material: THREE.MeshStandardMaterial | null): RGBA {
  const c = material?.color;
  const r = c ? Math.round(clamp(c.r, 0, 1) * 255) : 255;
  const g = c ? Math.round(clamp(c.g, 0, 1) * 255) : 255;
  const b = c ? Math.round(clamp(c.b, 0, 1) * 255) : 255;
  const a = material?.opacity !== undefined
    ? Math.round(clamp(material.opacity, 0, 1) * 255)
    : 255;
  return { r, g, b, a };
}

// ─── Texture sampling (browser-native, replaces Jimp) ───────────────

export interface PixelData {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

const textureDataCache = new WeakMap<THREE.Texture, PixelData | null>();

/**
 * Extracts raw RGBA pixel data from a Three.js texture.
 *
 * - DataTexture / CompressedTexture with `.image.data` => use directly.
 * - HTMLImageElement / ImageBitmap / HTMLCanvasElement => draw to offscreen
 *   canvas and read back via getImageData().
 * - Results are cached per-texture via WeakMap.
 */
function ensureImageData(
  texture: THREE.Texture,
): PixelData | null {
  const cached = textureDataCache.get(texture);
  if (cached !== undefined) return cached;

  const image = texture?.image as {
    width?: number;
    height?: number;
    data?: Uint8Array | Uint8ClampedArray;
  } | null;

  if (!image) {
    textureDataCache.set(texture, null);
    return null;
  }

  if (image.data && image.width && image.height) {
    const result: PixelData = { width: image.width, height: image.height, data: image.data };
    textureDataCache.set(texture, result);
    return result;
  }

  if (image.width && image.height) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      textureDataCache.set(texture, null);
      return null;
    }
    ctx.drawImage(image as CanvasImageSource, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result: PixelData = { width: imgData.width, height: imgData.height, data: imgData.data };
    textureDataCache.set(texture, result);
    return result;
  }

  textureDataCache.set(texture, null);
  return null;
}

function sampleTextureRGBA(
  texture: THREE.Texture,
  uv: THREE.Vector2,
): RGBA | null {
  const image = ensureImageData(texture);
  if (!image) return null;

  const w = image.width;
  const h = image.height;
  const data = image.data;

  let u = uv.x;
  let v = uv.y;

  // Repeat wrapping
  u = u - Math.floor(u);
  v = v - Math.floor(v);

  const x = clamp(Math.floor(u * w), 0, w - 1);
  const y = clamp(Math.floor(v * h), 0, h - 1);
  const idx = (y * w + x) * 4;
  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? 0;
  const b = data[idx + 2] ?? 0;
  const a = data[idx + 3] ?? 255;
  return { r, g, b, a };
}

// ─── Material color sampling ────────────────────────────────────────

interface SampleColorParams {
  material: THREE.MeshStandardMaterial | null;
  uv: THREE.Vector2 | null;
  vertexColorRGB: { r: number; g: number; b: number } | null;
  useSRGB: boolean;
}

function sampleMaterialColor({ material, uv, vertexColorRGB, useSRGB }: SampleColorParams): RGBA {
  const base = getMaterialBaseColor(material);
  let r = base.r;
  let g = base.g;
  let b = base.b;
  let a = base.a;

  const map = material?.map;
  if (map && uv) {
    const tex = sampleTextureRGBA(map, uv);
    if (tex) {
      if (useSRGB) {
        const lr = srgbToLinear(tex.r);
        const lg = srgbToLinear(tex.g);
        const lb = srgbToLinear(tex.b);
        const br = srgbToLinear(r);
        const bg = srgbToLinear(g);
        const bb = srgbToLinear(b);
        r = linearToSrgb(lr * br);
        g = linearToSrgb(lg * bg);
        b = linearToSrgb(lb * bb);
      } else {
        r = Math.round((tex.r * r) / 255);
        g = Math.round((tex.g * g) / 255);
        b = Math.round((tex.b * b) / 255);
      }
      a = Math.round((tex.a * a) / 255);
    }
  }

  if (vertexColorRGB) {
    r = Math.round((r * vertexColorRGB.r) / 255);
    g = Math.round((g * vertexColorRGB.g) / 255);
    b = Math.round((b * vertexColorRGB.b) / 255);
  }

  return { r, g, b, a };
}

// ─── Octree helpers ─────────────────────────────────────────────────

function getIntersectingTriangles(
  nodeMin: THREE.Vector3,
  nodeSize: number,
  candidates: Triangle[],
  nodeBox: THREE.Box3,
  triAABB: THREE.Box3,
  centerTmp: THREE.Vector3,
  halfExt: THREE.Vector3,
): Triangle[] {
  const intersecting: Triangle[] = [];
  const cx = nodeMin.x + nodeSize / 2;
  const cy = nodeMin.y + nodeSize / 2;
  const cz = nodeMin.z + nodeSize / 2;
  centerTmp.set(cx, cy, cz);
  halfExt.set(nodeSize / 2, nodeSize / 2, nodeSize / 2);
  nodeBox.min.copy(nodeMin);
  nodeBox.max.set(nodeMin.x + nodeSize, nodeMin.y + nodeSize, nodeMin.z + nodeSize);

  const ta = new THREE.Vector3();
  const tb = new THREE.Vector3();
  const tc = new THREE.Vector3();

  for (const tri of candidates) {
    triAABB.makeEmpty();
    triAABB.expandByPoint(tri.v0);
    triAABB.expandByPoint(tri.v1);
    triAABB.expandByPoint(tri.v2);
    if (!nodeBox.intersectsBox(triAABB)) continue;

    ta.copy(tri.v0).sub(centerTmp);
    tb.copy(tri.v1).sub(centerTmp);
    tc.copy(tri.v2).sub(centerTmp);
    if (triBoxOverlap(halfExt, ta, tb, tc)) {
      intersecting.push(tri);
    }
  }
  return intersecting;
}

function findClosestPointAndBary(
  point: THREE.Vector3,
  triangles: Triangle[],
): { tri: Triangle; bary: BaryResult } | null {
  let minDistSq = Infinity;
  let bestTri: Triangle | null = null;
  let bestBary: BaryResult | null = null;
  for (const tri of triangles) {
    const bary = closestPointToTriangle(point, tri.v0, tri.v1, tri.v2);
    const distSq = bary.point.distanceToSquared(point);
    if (distSq < minDistSq) {
      minDistSq = distSq;
      bestTri = tri;
      bestBary = bary;
    }
  }
  if (bestTri && bestBary) {
    return { tri: bestTri, bary: bestBary };
  }
  return null;
}

function isFlat(triangles: Triangle[], threshold: number = FLATNESS_THRESHOLD): boolean {
  if (triangles.length === 0) return true;
  const avgNormal = new THREE.Vector3();
  for (const tri of triangles) {
    avgNormal.add(tri.normal);
  }
  avgNormal.normalize();
  let minDot = 1;
  for (const tri of triangles) {
    const dot = tri.normal.dot(avgNormal);
    if (dot < minDot) minDot = dot;
  }
  return minDot > threshold;
}

/**
 * How far a flat region's surface tilts off its dominant axis, as
 * tan(angle) of the average normal against the nearest axis: 0 for an
 * axis-aligned plane, 1 at 45°. A big cube approximates an axis-aligned
 * plane within one voxel of error, but a TILTED plane steps by
 * `leafSize × slant` — a 3 m leaf on a 30° bridge arch is a 1.7 m stair.
 * Leaf size must therefore be capped so `size × slant` stays near the
 * min voxel size (see buildNode).
 */
function slantOfSurface(triangles: Triangle[]): number {
  const avgNormal = new THREE.Vector3();
  for (const tri of triangles) avgNormal.add(tri.normal);
  if (avgNormal.lengthSq() < 1e-12) return 0;
  avgNormal.normalize();
  const dom = Math.max(Math.abs(avgNormal.x), Math.abs(avgNormal.y), Math.abs(avgNormal.z));
  if (dom < 1e-6) return 1;
  return Math.sqrt(Math.max(0, 1 - dom * dom)) / dom;
}

function sampleColorAtPoint(
  point: THREE.Vector3,
  triangles: Triangle[],
  useSRGB: boolean,
): number | null {
  const cp = findClosestPointAndBary(point, triangles);
  if (!cp) return null;
  const { tri, bary } = cp;

  let uv: THREE.Vector2 | null = null;
  if (tri.uv0 && tri.uv1 && tri.uv2) {
    uv = new THREE.Vector2()
      .addScaledVector(tri.uv0, bary.bary.u)
      .addScaledVector(tri.uv1, bary.bary.v)
      .addScaledVector(tri.uv2, bary.bary.w);
  }

  let vcol: { r: number; g: number; b: number } | null = null;
  if (tri.col0 && tri.col1 && tri.col2) {
    vcol = {
      r: tri.col0.r * bary.bary.u + tri.col1.r * bary.bary.v + tri.col2.r * bary.bary.w,
      g: tri.col0.g * bary.bary.u + tri.col1.g * bary.bary.v + tri.col2.g * bary.bary.w,
      b: tri.col0.b * bary.bary.u + tri.col1.b * bary.bary.v + tri.col2.b * bary.bary.w,
    };
  }

  const rgba = sampleMaterialColor({ material: tri.material, uv, vertexColorRGB: vcol, useSRGB });
  if (rgba.a < 20) return null;
  return rgb888To565(rgba.r, rgba.g, rgba.b);
}

/**
 * Linear-RGB variant of `sampleColorAtPoint` for the scene voxelizer.
 *
 * Identical sampling path (closest triangle → barycentric UV / vertex
 * color → `sampleMaterialColor`), but returns floating-point linear RGB
 * in [0,1] instead of a lossy RGB565 integer — the VxlScene palette
 * stores RGB888 and the renderer feeds these straight into Three.js
 * vertex colors (which Three treats as linear). `sampleMaterialColor`
 * returns sRGB-encoded 0–255 channels (it re-encodes via `linearToSrgb`
 * when `useSRGB`), so we sRGB→linear decode here when `useSRGB`, else
 * divide by 255 (the data is already linear on that path).
 *
 * Returns `null` for fully-transparent samples (same alpha cutoff as the
 * 565 path), letting the caller fall back to a default color.
 */
export function sampleLinearColorAtPoint(
  point: THREE.Vector3,
  triangles: Triangle[],
  useSRGB: boolean,
): { r: number; g: number; b: number } | null {
  const cp = findClosestPointAndBary(point, triangles);
  if (!cp) return null;
  const { tri, bary } = cp;

  let uv: THREE.Vector2 | null = null;
  if (tri.uv0 && tri.uv1 && tri.uv2) {
    uv = new THREE.Vector2()
      .addScaledVector(tri.uv0, bary.bary.u)
      .addScaledVector(tri.uv1, bary.bary.v)
      .addScaledVector(tri.uv2, bary.bary.w);
  }

  let vcol: { r: number; g: number; b: number } | null = null;
  if (tri.col0 && tri.col1 && tri.col2) {
    vcol = {
      r: tri.col0.r * bary.bary.u + tri.col1.r * bary.bary.v + tri.col2.r * bary.bary.w,
      g: tri.col0.g * bary.bary.u + tri.col1.g * bary.bary.v + tri.col2.g * bary.bary.w,
      b: tri.col0.b * bary.bary.u + tri.col1.b * bary.bary.v + tri.col2.b * bary.bary.w,
    };
  }

  const rgba = sampleMaterialColor({ material: tri.material, uv, vertexColorRGB: vcol, useSRGB });
  if (rgba.a < 20) return null;
  if (useSRGB) {
    return { r: srgbToLinear(rgba.r), g: srgbToLinear(rgba.g), b: srgbToLinear(rgba.b) };
  }
  return { r: rgba.r / 255, g: rgba.g / 255, b: rgba.b / 255 };
}

// ─── Main entry point ───────────────────────────────────────────────

/**
 * Voxelize a GLB model into the VXL v3/v4 octree format.
 *
 * Thin wrapper around `extractGlbForVoxelization` + `voxelizeFromExtracted`.
 * Both helpers are exported so callers (e.g. the chunked-world voxelizer)
 * can run extraction once and feed multiple per-chunk voxelization passes
 * from a single GLB load.
 *
 * @param glbBuffer  The raw bytes of a .glb file.
 * @param options    Voxelization parameters.
 * @returns          VXL bytes, bounds, and stats.
 */
export async function voxelizeGLB(
  glbBuffer: ArrayBuffer,
  options: VoxelizeOptions,
): Promise<VoxelizeResult> {
  const extracted = await extractGlbForVoxelization(glbBuffer, options);
  return voxelizeFromExtracted(extracted, options);
}

/**
 * Phase 2 of voxelization: optional interior flood-fill, per-LOD octree
 * build, and encode the result as a standalone VXL3 v3/v4 blob.
 *
 * Takes pre-extracted GLB data (from `extractGlbForVoxelization`). Both
 * `voxelizeGLB` and the chunked-world voxelizer go through this function
 * — every improvement to interior fill, color sampling, LOD logic, etc.
 * flows to both consumers automatically.
 */
export async function voxelizeFromExtracted(
  extracted: ExtractedGlb,
  options: VoxelizeOptions,
): Promise<VoxelizeResult> {
  const {
    minVoxelSize,
    maxVoxelSize,
    fillInterior = true,
    useSRGB = true,
    algorithm = 'surface',
  } = options;

  if (maxVoxelSize < minVoxelSize) {
    throw new Error('maxVoxelSize must be >= minVoxelSize');
  }

  const {
    allTriangles, rawBounds, bounds, rootMin, rootSize, centerX, centerZ,
    modelWidth, modelHeight, modelDepth,
  } = extracted;

  console.log(
    `[GLBVoxelizer] Model dimensions: ${modelWidth.toFixed(2)}×${modelHeight.toFixed(2)}×${modelDepth.toFixed(2)}m, ` +
    `voxel range: ${minVoxelSize}–${maxVoxelSize}m`,
  );

  // ── 5. Pre-compute interior map via flood fill ─────────────────
  //
  // Ray-casting every empty octree node against all triangles is O(nodes × tris)
  // and prohibitively slow for real models. Instead we build a coarse occupancy
  // grid, mark surface cells, then flood-fill from the boundary to find exterior.
  // Interior = empty + not reachable from outside. This is O(grid) total.

  let interiorGrid: Uint8Array | null = null; // 1 = interior
  let igNx = 0, igNy = 0, igNz = 0;
  // Use minVoxelSize so that small gaps (e.g. between railing posts) are resolved
  // by the flood-fill instead of being sealed over. Cap at 128 cells per axis to
  // keep memory reasonable for very large models.
  const MAX_IG_CELLS = 128;
  const igVS = Math.max(minVoxelSize, rootSize / MAX_IG_CELLS);

  if (fillInterior && allTriangles.length > 0) {
    igNx = Math.max(1, Math.ceil(rootSize / igVS)) + 2; // +2 pad for flood-fill seeding
    igNy = igNx;
    igNz = igNx;
    const igTotal = igNx * igNy * igNz;

    const igOcc = new Uint8Array(igTotal);
    const igHalf = new THREE.Vector3(igVS / 2, igVS / 2, igVS / 2);
    const igCenter = new THREE.Vector3();
    const igTa = new THREE.Vector3();
    const igTb = new THREE.Vector3();
    const igTc = new THREE.Vector3();

    // Mark surface cells using triangle AABB + precise triBoxOverlap
    for (const tri of allTriangles) {
      const tMinX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
      const tMinY = Math.min(tri.v0.y, tri.v1.y, tri.v2.y);
      const tMinZ = Math.min(tri.v0.z, tri.v1.z, tri.v2.z);
      const tMaxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
      const tMaxY = Math.max(tri.v0.y, tri.v1.y, tri.v2.y);
      const tMaxZ = Math.max(tri.v0.z, tri.v1.z, tri.v2.z);

      const ix0 = clamp(Math.floor((tMinX - rootMin.x) / igVS), 0, igNx - 1);
      const iy0 = clamp(Math.floor((tMinY - rootMin.y) / igVS), 0, igNy - 1);
      const iz0 = clamp(Math.floor((tMinZ - rootMin.z) / igVS), 0, igNz - 1);
      const ix1 = clamp(Math.floor((tMaxX - rootMin.x) / igVS) + 1, 0, igNx - 1);
      const iy1 = clamp(Math.floor((tMaxY - rootMin.y) / igVS) + 1, 0, igNy - 1);
      const iz1 = clamp(Math.floor((tMaxZ - rootMin.z) / igVS) + 1, 0, igNz - 1);

      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const gi = (iy * igNz + iz) * igNx + ix;
            if (igOcc[gi]) continue; // already marked
            igCenter.set(
              rootMin.x + (ix + 0.5) * igVS,
              rootMin.y + (iy + 0.5) * igVS,
              rootMin.z + (iz + 0.5) * igVS,
            );
            igTa.copy(tri.v0).sub(igCenter);
            igTb.copy(tri.v1).sub(igCenter);
            igTc.copy(tri.v2).sub(igCenter);
            if (triBoxOverlap(igHalf, igTa, igTb, igTc)) {
              igOcc[gi] = 1;
            }
          }
        }
      }
    }

    // Flood-fill exterior from boundary cells
    const igExterior = new Uint8Array(igTotal);
    const q = new Int32Array(igTotal);
    let qh = 0, qt = 0;

    function igIdx(x: number, y: number, z: number): number {
      return (y * igNz + z) * igNx + x;
    }
    function igSeed(x: number, y: number, z: number): void {
      const i = igIdx(x, y, z);
      if (igExterior[i] || igOcc[i]) return;
      igExterior[i] = 1;
      q[qt++] = i;
    }

    for (let x = 0; x < igNx; x++) { for (let z = 0; z < igNz; z++) { igSeed(x, 0, z); igSeed(x, igNy - 1, z); } }
    for (let y = 0; y < igNy; y++) { for (let z = 0; z < igNz; z++) { igSeed(0, y, z); igSeed(igNx - 1, y, z); } }
    for (let x = 0; x < igNx; x++) { for (let y = 0; y < igNy; y++) { igSeed(x, y, 0); igSeed(x, y, igNz - 1); } }

    const igDeltas: [number, number, number][] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    while (qh < qt) {
      const ci = q[qh++]!;
      const cx0 = ci % igNx;
      const yz0 = (ci - cx0) / igNx;
      const cz0 = yz0 % igNz;
      const cy0 = (yz0 - cz0) / igNz;
      for (const [dx, dy, dz] of igDeltas) {
        const nx0 = cx0 + dx, ny0 = cy0 + dy, nz0 = cz0 + dz;
        if (nx0 < 0 || nx0 >= igNx || ny0 < 0 || ny0 >= igNy || nz0 < 0 || nz0 >= igNz) continue;
        const ni = igIdx(nx0, ny0, nz0);
        if (igExterior[ni] || igOcc[ni]) continue;
        igExterior[ni] = 1;
        q[qt++] = ni;
      }
    }

    // Interior = not occupied AND not exterior
    interiorGrid = new Uint8Array(igTotal);
    for (let i = 0; i < igTotal; i++) {
      if (!igOcc[i] && !igExterior[i]) interiorGrid[i] = 1;
    }
  }

  // O(1) interior lookup: map a world-space point to the coarse grid
  function isInterior(point: THREE.Vector3): boolean {
    if (!interiorGrid) return false;
    const ix = clamp(Math.floor((point.x - rootMin.x) / igVS), 0, igNx - 1);
    const iy = clamp(Math.floor((point.y - rootMin.y) / igVS), 0, igNy - 1);
    const iz = clamp(Math.floor((point.z - rootMin.z) / igVS), 0, igNz - 1);
    return interiorGrid[(iy * igNz + iz) * igNx + ix] === 1;
  }

  /**
   * Sample the interior grid over the leaf's entire AABB and return
   * true if ANY sub-cell is marked interior. Replaces the single-point
   * `isInterior(nodeCtr)` check at leaf-creation sites — that one
   * sampled the upper-corner sub-cell of the 2×2×2 cluster a 0.25m
   * leaf covers (interior grid is 0.125m), so when the flood-fill
   * leaked into the solid through a non-manifold edge or T-junction,
   * regular-grid holes appeared in the output wherever the sampled
   * sub-cell happened to be on the "leaked" side. Checking the leaf's
   * full volume is robust to those one-cell leaks.
   *
   * Cost: bounded by the leaf's sub-cell count — for a 0.25m leaf vs
   * 0.125m grid, at most 2³=8 lookups. Cheap.
   */
  function isInteriorVolume(min: THREE.Vector3, size: number): boolean {
    if (!interiorGrid) return false;
    const ix0 = clamp(Math.floor((min.x - rootMin.x) / igVS), 0, igNx - 1);
    const iy0 = clamp(Math.floor((min.y - rootMin.y) / igVS), 0, igNy - 1);
    const iz0 = clamp(Math.floor((min.z - rootMin.z) / igVS), 0, igNz - 1);
    const ix1 = clamp(Math.ceil((min.x + size - rootMin.x) / igVS) - 1, 0, igNx - 1);
    const iy1 = clamp(Math.ceil((min.y + size - rootMin.y) / igVS) - 1, 0, igNy - 1);
    const iz1 = clamp(Math.ceil((min.z + size - rootMin.z) / igVS) - 1, 0, igNz - 1);
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const rowBase = (iy * igNz + iz) * igNx;
        for (let ix = ix0; ix <= ix1; ix++) {
          if (interiorGrid[rowBase + ix] === 1) return true;
        }
      }
    }
    return false;
  }

  // For interior voxels, find the nearest surface color with a bounded search radius.
  function getInteriorColor(point: THREE.Vector3): number {
    // Find the closest surface triangle within a bounded radius
    const searchRadius = igVS * 3;
    let minDistSq = searchRadius * searchRadius;
    let bestColor = rgb888To565(128, 128, 128); // fallback gray
    for (const tri of allTriangles) {
      // Quick reject: check if triangle centroid is within search radius
      const tcx = (tri.v0.x + tri.v1.x + tri.v2.x) / 3;
      const tcy = (tri.v0.y + tri.v1.y + tri.v2.y) / 3;
      const tcz = (tri.v0.z + tri.v1.z + tri.v2.z) / 3;
      const dx = point.x - tcx, dy = point.y - tcy, dz = point.z - tcz;
      const centroidDistSq = dx * dx + dy * dy + dz * dz;
      if (centroidDistSq > minDistSq * 4) continue; // generous early-out

      const bary = closestPointToTriangle(point, tri.v0, tri.v1, tri.v2);
      const distSq = bary.point.distanceToSquared(point);
      if (distSq < minDistSq) {
        minDistSq = distSq;
        let uv: THREE.Vector2 | null = null;
        if (tri.uv0 && tri.uv1 && tri.uv2) {
          uv = new THREE.Vector2()
            .addScaledVector(tri.uv0, bary.bary.u)
            .addScaledVector(tri.uv1, bary.bary.v)
            .addScaledVector(tri.uv2, bary.bary.w);
        }
        let vcol: { r: number; g: number; b: number } | null = null;
        if (tri.col0 && tri.col1 && tri.col2) {
          vcol = {
            r: tri.col0.r * bary.bary.u + tri.col1.r * bary.bary.v + tri.col2.r * bary.bary.w,
            g: tri.col0.g * bary.bary.u + tri.col1.g * bary.bary.v + tri.col2.g * bary.bary.w,
            b: tri.col0.b * bary.bary.u + tri.col1.b * bary.bary.v + tri.col2.b * bary.bary.w,
          };
        }
        const rgba = sampleMaterialColor({ material: tri.material, uv, vertexColorRGB: vcol, useSRGB });
        if (rgba.a >= 20) {
          bestColor = rgb888To565(rgba.r, rgba.g, rgba.b);
        }
      }
    }
    return bestColor;
  }

  // ── 6. Build octree (per-LOD pass) ─────────────────────────────────

  const nodeBox = new THREE.Box3();
  const triAABB = new THREE.Box3();
  const centerTmp = new THREE.Vector3();
  const halfExt = new THREE.Vector3();

  // Cap counts only nodes retained in the final tree (leaves + internal
  // parents). Previous versions counted every recursive visit including
  // empty-space traversals, which exhausted the budget on large models
  // before reaching actual geometry.
  const MAX_OCTREE_NODES = 5_000_000;

  // Shift octree positions to match normalized bounds:
  // X/Z centered, Y bottom at 0. Shared across all LOD passes.
  const shiftX = -centerX;
  const shiftY = -rawBounds.minY;
  const shiftZ = -centerZ;

  function countOccupiedAndNodes(
    node: OctreeNode | null,
    stats: { voxels: number; nodes: number },
  ): void {
    if (!node) return;
    stats.nodes++;
    if (node.color > 0 && !node.children) {
      stats.voxels++;
    }
    if (node.children) {
      node.children.forEach(child => countOccupiedAndNodes(child, stats));
    }
  }

  interface MeshingPassResult {
    fragments: VxlV3Fragment[];
    /** Flattened leaves (normalized frame) — collider estimation input. */
    leaves: OctreeLeaf[];
    actualMinVoxelSize: number;
    totalVoxels: number;
    nodeCount: number;
    cappedAtMaxNodes: boolean;
  }

  // Triangles bridged to the vxlscene raster kernel — built once, shared by
  // every surface-algorithm LOD pass. Each triangle carries a color closure
  // sampling THAT triangle (barycentric UV/vertex-color via the shared
  // material sampler), which is how the level bake colors cells too.
  let rasterTrisCache: RasterTriangle[] | null = null;
  const rasterColorScratch = new THREE.Vector3();
  function getRasterTriangles(): RasterTriangle[] {
    if (rasterTrisCache) return rasterTrisCache;
    rasterTrisCache = allTriangles.map((tri): RasterTriangle => {
      const single = [tri];
      return {
        v0: [tri.v0.x, tri.v0.y, tri.v0.z],
        v1: [tri.v1.x, tri.v1.y, tri.v1.z],
        v2: [tri.v2.x, tri.v2.y, tri.v2.z],
        normal: [tri.normal.x, tri.normal.y, tri.normal.z],
        nodeName: '',
        sampleColor: (point: [number, number, number]) => {
          const c = sampleLinearColorAtPoint(rasterColorScratch.set(point[0], point[1], point[2]), single, useSRGB);
          // Transparent samples have no cell color of their own — fall back to
          // mid-grey (the octree path skips such cells entirely; a rare parity
          // difference on alpha-cutout models).
          return c ?? { r: 0.5, g: 0.5, b: 0.5 };
        },
      };
    });
    return rasterTrisCache;
  }

  /**
   * LOD0 leaf ceiling for one surface-algorithm pass. Above this the render
   * cost turns pathological (the octree mesh's hidden-face occupancy grid
   * overflows and every leaf emits all six faces), so the pass re-bakes at a
   * doubled min voxel until the count fits — full fidelity at the coarser
   * size beats an unrenderable asset at the requested one.
   */
  const SURFACE_LOD0_LEAF_BUDGET = 600_000;

  /**
   * Surface-raster pass (`algorithm: 'surface'`): rasterize at exactly
   * `passMinVS` (no power-of-two inflation), merge bottom-up, then reuse the
   * shared shift/fragment/encode tail. See SurfaceAssetVoxelizer.
   */
  async function runSurfaceMeshingPass(passMinVS: number, passMaxVS: number): Promise<MeshingPassResult> {
    let effMinVS = passMinVS;
    let rawLeaves = (await bakeSurfaceAssetLeaves(getRasterTriangles(), {
      minVoxelSize: effMinVS,
      maxVoxelSize: passMaxVS,
      fillInterior,
    })).leaves;
    while (rawLeaves.length > SURFACE_LOD0_LEAF_BUDGET) {
      effMinVS *= 2;
      console.warn(`[GLBVoxelizer] surface pass produced ${rawLeaves.length.toLocaleString()} leaves at min=${effMinVS / 2}m — re-baking at ${effMinVS}m to stay renderable.`);
      rawLeaves = (await bakeSurfaceAssetLeaves(getRasterTriangles(), {
        minVoxelSize: effMinVS,
        maxVoxelSize: Math.max(passMaxVS, effMinVS),
        fillInterior,
      })).leaves;
    }
    if (rawLeaves.length === 0) {
      return { fragments: [], leaves: [], actualMinVoxelSize: effMinVS, totalVoxels: 0, nodeCount: 0, cappedAtMaxNodes: false };
    }
    const passLeaves: OctreeLeaf[] = rawLeaves.map((l) => ({
      ...l, x: l.x + shiftX, y: l.y + shiftY, z: l.z + shiftZ,
    }));
    expandBoundsToFitLeaves(bounds, passLeaves, effMinVS);
    const passFragments = passMinVS === minVoxelSize && options.preFragment
      ? partitionLeavesIntoFragments(
          passLeaves,
          options.preFragment.targetFragments ?? 50,
          effMinVS,
          options.preFragment.individualVoxels ?? 0,
        )
      : [singleFragmentOf(passLeaves)];
    return {
      fragments: passFragments,
      leaves: passLeaves,
      actualMinVoxelSize: effMinVS,
      totalVoxels: passLeaves.length,
      nodeCount: passLeaves.length,
      // Report budget coarsening through the existing warning channel.
      cappedAtMaxNodes: effMinVS !== passMinVS,
    };
  }

  async function runMeshingPass(passMinVS: number, passMaxVS: number): Promise<MeshingPassResult> {
    // Per-leaf sub-cell displacement is implemented only by the octree pass
    // (dx/dy/dz on built nodes) — route displacement bakes there regardless
    // of the algorithm choice.
    const useOctree = algorithm === 'octree'
      || options.enableDisplacement === true
      || options.displacementAxis !== undefined;
    return useOctree
      ? runOctreeMeshingPass(passMinVS, passMaxVS)
      : runSurfaceMeshingPass(passMinVS, passMaxVS);
  }

  /**
   * Run one octree-build + flatten + fragment pass for a given voxel-size
   * budget (`algorithm: 'octree'`). Shares triangle list and interior-grid
   * state with every other pass; the heavy work here is the recursive
   * `buildNode` walk. Returns the per-LOD outputs the encoder needs.
   */
  function runOctreeMeshingPass(passMinVS: number, passMaxVS: number): MeshingPassResult {
    let nodeCount = 0;

    function buildNode(
      nodeMin: THREE.Vector3,
      nodeSize: number,
      candidates: Triangle[],
    ): OctreeNode | null {
      if (nodeCount >= MAX_OCTREE_NODES) return null;

      const cx = nodeMin.x + nodeSize / 2;
      const cy = nodeMin.y + nodeSize / 2;
      const cz = nodeMin.z + nodeSize / 2;
      const nodeCtr = new THREE.Vector3(cx, cy, cz);

      const intersecting = getIntersectingTriangles(
        nodeMin, nodeSize, candidates, nodeBox, triAABB, centerTmp, halfExt,
      );

      if (intersecting.length === 0) {
        if (!fillInterior) return null;
        // Volume-sample the interior grid over the whole cell, not just
        // its centre — single-point sampling produced regular-grid
        // holes when flood-fill leaked one cell into the solid through
        // a non-manifold edge in the GLB (the sample then landed on
        // the leaked sub-cell while the leaf's other sub-cells were
        // still interior).
        if (isInteriorVolume(nodeMin, nodeSize)) {
          const color = getInteriorColor(nodeCtr);
          nodeCount++;
          return new OctreeNode(nodeMin, nodeSize, color);
        }
        return null;
      }

      // Has surface triangles — decide whether to make a leaf or subdivide.
      const isSmallEnough = nodeSize <= passMinVS;
      const isWithinMax = nodeSize <= passMaxVS;
      const sizeRatio = Math.max(1, nodeSize / passMinVS);
      const adaptiveThreshold = 1 - (1 - FLATNESS_THRESHOLD) / sizeRatio;
      const flat = isFlat(intersecting, adaptiveThreshold);
      let canBeLeaf = (flat || isSmallEnough) && isWithinMax;

      // Flat is not enough for a LARGE leaf — the flat surface must also be
      // near axis-aligned. A tilted plane (bridge arch, cable, ramp) staircases
      // by `nodeSize × slant` however flat it is, so cap the leaf size where
      // that step error would exceed ~2 min-voxels. Axis-aligned surfaces
      // (slant ≈ 0) keep merging up to maxVoxelSize as before.
      if (canBeLeaf && !isSmallEnough && nodeSize > passMinVS) {
        const slant = slantOfSurface(intersecting);
        if (nodeSize * slant > passMinVS * SLANT_STEP_FACTOR) {
          canBeLeaf = false;
        }
      }

      // Find closest surface point to the cell center once — reused
      // below for both the coverage check (large leaves) and the per-leaf
      // displacement (any surface-touching leaf).
      const cp = findClosestPointAndBary(nodeCtr, intersecting);
      const closestSurfacePt = cp ? cp.bary.point : null;

      // Coverage check: for nodes larger than passMinVS, verify the surface
      // actually covers this node rather than just clipping a corner/edge.
      if (canBeLeaf && nodeSize > passMinVS && nodeSize / 2 >= passMinVS && closestSurfacePt) {
        const distSq = closestSurfacePt.distanceToSquared(nodeCtr);
        if (distSq > nodeSize * nodeSize * 0.25) {
          canBeLeaf = false;
        }
      }

      /**
       * Apply per-leaf displacement along the user-selected axis
       * (`options.displacementAxis`). For `'y'` (typical floor /
       * track case), the cube slides only in Y so its TOP face
       * lands on the surface — body below, surface looks like a
       * smooth slab of cube tops instead of cubes half-sticking up.
       *
       * **Single fixed axis** is the key to gap-free output: every
       * voxel in this pass slides along the same axis only, so
       * neighbours can't drift apart laterally regardless of
       * surface-normal variation. The per-axis `±size` clamp lets
       * the surface-boundary case (two cells share the surface
       * plane) work cleanly: the upper cell's full displacement
       * reaches `-size` to coincide with the lower cell's cube,
       * avoiding the "half-cell stair-step on flat track" artifact.
       *
       * No-op when `displacementAxis` is undefined OR `enableDisplacement`
       * is false: voxels stay grid-aligned (stair-step on slopes,
       * but no gaps anywhere). The legacy `enableDisplacement` flag
       * is kept for backwards compatibility with the asset
       * voxelizer (which doesn't set displacementAxis).
       */
      const setDisplacement = (node: OctreeNode): void => {
        const axis = options.displacementAxis;
        if (!axis && !options.enableDisplacement) return;
        if (!cp) return;
        if (!axis) return; // displacementAxis missing — no displacement.
        const surfacePt = cp.bary.point;
        const triNormal = cp.tri.normal;
        const half = nodeSize * 0.5;
        const range = nodeSize;
        if (axis === 'y') {
          const targetY = surfacePt.y - triNormal.y * half;
          node.dx = 0;
          node.dy = clamp(targetY - nodeCtr.y, -range, range);
          node.dz = 0;
        } else if (axis === 'x') {
          const targetX = surfacePt.x - triNormal.x * half;
          node.dx = clamp(targetX - nodeCtr.x, -range, range);
          node.dy = 0;
          node.dz = 0;
        } else {
          const targetZ = surfacePt.z - triNormal.z * half;
          node.dx = 0;
          node.dy = 0;
          node.dz = clamp(targetZ - nodeCtr.z, -range, range);
        }
      };

      if (canBeLeaf) {
        const color = sampleColorAtPoint(nodeCtr, intersecting, useSRGB);
        if (color === null) return null;
        nodeCount++;
        const node = new OctreeNode(nodeMin, nodeSize, color);
        setDisplacement(node);
        return node;
      }

      // Cannot subdivide below passMinVS — force leaf
      if (nodeSize / 2 < passMinVS) {
        const color = sampleColorAtPoint(nodeCtr, intersecting, useSRGB);
        if (color === null) return null;
        nodeCount++;
        const node = new OctreeNode(nodeMin, nodeSize, color);
        setDisplacement(node);
        return node;
      }

      // Subdivide into 8 children
      const node = new OctreeNode(nodeMin, nodeSize);
      node.children = [];
      const halfSize = nodeSize / 2;
      for (let i = 0; i < 8; i++) {
        const offsetX = (i & 1) ? halfSize : 0;
        const offsetY = (i & 2) ? halfSize : 0;
        const offsetZ = (i & 4) ? halfSize : 0;
        const childMin = nodeMin.clone().add(new THREE.Vector3(offsetX, offsetY, offsetZ));
        const child = buildNode(childMin, halfSize, intersecting);
        node.children.push(child);
      }

      if (node.children.every(c => c === null)) return null;
      nodeCount++;
      return node;
    }

    const passRoot = buildNode(rootMin, rootSize, allTriangles);
    if (!passRoot) {
      return {
        fragments: [], leaves: [], actualMinVoxelSize: passMinVS,
        totalVoxels: 0, nodeCount: 0, cappedAtMaxNodes: nodeCount >= MAX_OCTREE_NODES,
      };
    }

    const passStats = { voxels: 0, nodes: 0 };
    countOccupiedAndNodes(passRoot, passStats);

    const passLeaves: OctreeLeaf[] = [];
    flattenLeavesShifted(passRoot, shiftX, shiftY, shiftZ, passLeaves);

    const passActualMinVS = computeActualMinLeafSize(passLeaves, passMinVS);

    // Expand the shared bounds outward to fit this LOD's leaves. Each pass
    // can only grow the bounds; LOD 0 sets the baseline and subsequent
    // (coarser) passes typically fit inside it.
    expandBoundsToFitLeaves(bounds, passLeaves, passActualMinVS);

    // Pre-fragmentation only applies to LOD 0 (debris/explosion semantics).
    // Coarser LODs are render-only stand-ins, so they're always one fragment.
    const passFragments = passMinVS === minVoxelSize && options.preFragment
      ? partitionLeavesIntoFragments(
          passLeaves,
          options.preFragment.targetFragments ?? 50,
          passActualMinVS,
          options.preFragment.individualVoxels ?? 0,
        )
      : [singleFragmentOf(passLeaves)];

    return {
      fragments: passFragments,
      leaves: passLeaves,
      actualMinVoxelSize: passActualMinVS,
      totalVoxels: passStats.voxels,
      nodeCount: passStats.nodes,
      cappedAtMaxNodes: nodeCount >= MAX_OCTREE_NODES,
    };
  }

  const additionalLodOpts = options.additionalLods ?? [];
  const totalLods = 1 + additionalLodOpts.length;

  options.onProgress?.({ index: 0, total: totalLods, label: totalLods > 1 ? `Voxelizing LOD 1 of ${totalLods}…` : 'Voxelizing…' });

  const lod0 = await runMeshingPass(minVoxelSize, maxVoxelSize);
  // Smart-object joints, per leaf, from triangle provenance. Every LOD carries
  // the column: a blade that rejoined the body at the first LOD switch would
  // stop turning at distance.
  const jointOfTriangle = options.smartParts
    ? allTriangles.map((t) => options.smartParts!.jointOfNode(t.sourceNodeName ?? ''))
    : null;
  const tagJoints = (leaves: OctreeLeaf[]): void => {
    if (!jointOfTriangle) return;
    const owner = nearestOwnerForLeaves(leaves, allTriangles, (i) => jointOfTriangle[i]!);
    for (let i = 0; i < leaves.length; i++) if (owner[i]! > 0) leaves[i]!.bone = owner[i]!;
  };
  tagJoints(lod0.leaves);
  if (lod0.totalVoxels === 0) {
    throw new Error('Voxelization resulted in empty model');
  }

  let warning: string | undefined;
  if (lod0.cappedAtMaxNodes) {
    warning = algorithm === 'octree'
      ? `Octree was capped at ${MAX_OCTREE_NODES.toLocaleString()} retained nodes ` +
        `(model: ${modelWidth.toFixed(1)}×${modelHeight.toFixed(1)}×${modelDepth.toFixed(1)}m, ` +
        `minVoxel: ${minVoxelSize}m). ` +
        `Try increasing Min Voxel Size or using Variable Size mode with a larger Max Voxel Size.`
      : `Voxel count exceeded the renderable budget at Min Voxel Size ${minVoxelSize}m ` +
        `(model: ${modelWidth.toFixed(1)}×${modelHeight.toFixed(1)}×${modelDepth.toFixed(1)}m) — ` +
        `baked at ${lod0.actualMinVoxelSize}m instead. Increase Min Voxel Size to silence this.`;
    console.warn(warning);
  }

  // Physics uses a coarser grid than the visual to keep collider complexity
  // manageable. 4× the min voxel size, clamped to [0.1, 0.5]. Physics is
  // always derived from LOD 0 (the gameplay/destruction-relevant geometry).
  //
  // The 0.1 m floor is a BUILDING's tolerance, and applying it to a small prop
  // makes the collider the wrong shape rather than a coarse one: rasterization
  // is conservative, so each face inflates by up to a whole cell, and a 0.3 m
  // prop on a 0.25 m grid collides as a 0.5 m block the player hovers on. Cap
  // the step so the model's thinnest axis always spans several cells.
  // (`greedyMeshOctreeLeaves` enforces the same bound at rasterization time, so
  // assets baked before this still collide correctly — this keeps the stored
  // value honest and the collider estimate below accurate.)
  const thinnestAxis = Math.min(modelWidth, modelHeight, modelDepth);
  const physicsGridStep = Math.max(
    minVoxelSize,
    Math.min(Math.max(minVoxelSize * 4, 0.1), 0.5, thinnestAxis / 4),
  );
  const colliderBoxCount = estimateColliderCount(lod0.leaves, physicsGridStep);
  const trimeshTriangles = colliderBoxCount * 12;

  // Additional LOD passes — each shares triangles + interior grid with LOD 0.
  const additionalLods: VxlV3LodLevel[] = [];
  const voxelsPerLod: number[] = [lod0.totalVoxels];
  for (let i = 0; i < additionalLodOpts.length; i++) {
    const lodOpt = additionalLodOpts[i]!;
    options.onProgress?.({ index: i + 1, total: totalLods, label: `Voxelizing LOD ${i + 2} of ${totalLods}…` });
    const lod = await runMeshingPass(lodOpt.minVoxelSize, lodOpt.maxVoxelSize);
    tagJoints(lod.leaves);
    if (lod.totalVoxels === 0 || lod.fragments.length === 0) {
      console.warn(`[GLBVoxelizer] LOD ${i + 1} produced no leaves at min=${lodOpt.minVoxelSize}, max=${lodOpt.maxVoxelSize}; skipping.`);
      continue;
    }
    additionalLods.push({
      minVoxelSize: lod.actualMinVoxelSize,
      maxVoxelSize: lodOpt.maxVoxelSize,
      fragments: lod.fragments,
    });
    voxelsPerLod.push(lod.totalVoxels);
  }

  // Material slots: a `BM_slot_*` material in the source GLB becomes a material
  // in the baked asset, so its voxels can be lit, dimmed or flashed at runtime
  // without being singled out by colour. Mutates LOD0 leaves in place (fragments
  // hold the same leaf objects); LODs above 0 stay on the base material, matching
  // how emissive is already LOD0-only.
  const slotAssign = assignVoxelSlotsFromTriangles(lod0.leaves, allTriangles);
  if (slotAssign.dropped.length > 0) {
    console.warn(`[GLBVoxelizer] material slot budget exceeded — these render as ordinary paint: ${slotAssign.dropped.join(', ')}`);
  }
  if (slotAssign.slots.length > 0) {
    console.log(`🎨 ${slotAssign.slots.length} material slot(s) [${slotAssign.slots.map(s => s.name).join(', ')}] over ${slotAssign.assigned.toLocaleString()} voxels`);
  }

  const vxlBytes = await encodeVxlV3({
    minVoxelSize: lod0.actualMinVoxelSize,
    maxVoxelSize,
    physicsGridStep,
    bounds,
    // Render through the shared color-palette atlas (sRGB cells, one shared material/
    // texture across all voxel objects → fewer state changes; colors match vwld terrain)
    // instead of per-object vertex colors.
    useAtlas: true,
    fragments: lod0.fragments,
    ...(additionalLods.length > 0 ? { additionalLods } : {}),
    ...(slotAssign.slots.length > 0 ? { slots: slotAssign.slots } : {}),
    ...(options.smartParts ? { rig: options.smartParts.rig, parts: options.smartParts.table } : {}),
  });

  return {
    vxlBytes,
    bounds,
    effectiveTargetHeight: modelHeight,
    effectiveMinVoxelSize: lod0.actualMinVoxelSize,
    totalVoxels: lod0.totalVoxels,
    nodeCount: lod0.nodeCount,
    fragmentCount: lod0.fragments.length,
    colliderBoxCount,
    trimeshTriangles,
    lodCount: 1 + additionalLods.length,
    voxelsPerLod,
    slotNames: slotAssign.slots.map((s) => s.name),
    warning,
  };
}

// ─── v3 helpers: octree → leaf list → optional fragments ────────────

/**
 * Walk the internal voxelizer octree and emit one `OctreeLeaf` per leaf node.
 * Positions are shifted to match the normalized bounds frame the format
 * expects (X/Z centered around 0, Y bottom at 0). Colors come from the
 * voxelizer's internal RGB565 encoding.
 */
function flattenLeavesShifted(
  node: OctreeNode | null,
  shiftX: number, shiftY: number, shiftZ: number,
  out: OctreeLeaf[],
): void {
  if (!node) return;
  if (node.children) {
    for (const child of node.children) flattenLeavesShifted(child, shiftX, shiftY, shiftZ, out);
    return;
  }
  if (node.color <= 0) return;
  const r5 = (node.color >> 11) & 0x1F;
  const g6 = (node.color >> 5) & 0x3F;
  const b5 = node.color & 0x1F;
  out.push({
    x: node.min.x + shiftX,
    y: node.min.y + shiftY,
    z: node.min.z + shiftZ,
    size: node.size,
    r: ((r5 << 3) | (r5 >> 2)) / 255,
    g: ((g6 << 2) | (g6 >> 4)) / 255,
    b: ((b5 << 3) | (b5 >> 2)) / 255,
  });
}

function singleFragmentOf(leaves: OctreeLeaf[]): VxlV3Fragment {
  const aabb = leafAabb(leaves);
  return { aabbMin: aabb.min, aabbMax: aabb.max, leaves };
}

/**
 * Color-aware spatial clustering: seed `target` fragments from a uniform
 * spatial grid (so the count target is met), then iteratively reassign
 * leaves at fragment boundaries to whichever face-adjacent fragment matches
 * their color best. This pulls naturally distinct regions (a brightly-coloured
 * door inside a dull wall, etc.) into their own fragment without forcing
 * equal voxel counts. Finally, each fragment is split into its connected
 * components so a single fragment never contains disjoint pieces (which
 * would float independently of each other when detached on explosion).
 *
 * `minSize` is the cell size used to build the face-adjacency map.
 */
function partitionLeavesIntoFragments(
  leaves: OctreeLeaf[],
  target: number,
  minSize: number,
  individualVoxels: number,
): VxlV3Fragment[] {
  if (leaves.length === 0) return [];
  if (target <= 1) return [singleFragmentOf(leaves)];

  const n = leaves.length;

  // ── 1. Seed assignment via uniform spatial grid ───────────────────
  const whole = leafAabb(leaves);
  const dx = whole.max[0] - whole.min[0];
  const dy = whole.max[1] - whole.min[1];
  const dz = whole.max[2] - whole.min[2];
  const totalVolume = Math.max(1e-6, dx * dy * dz);
  const binSide = Math.max(minSize, Math.cbrt(totalVolume / target));

  const assignment = new Int32Array(n);
  const bucketKeyToId = new Map<string, number>();
  let fragCount = 0;
  for (let i = 0; i < n; i++) {
    const leaf = leaves[i]!;
    const bx = Math.floor((leaf.x + leaf.size * 0.5) / binSide);
    const by = Math.floor((leaf.y + leaf.size * 0.5) / binSide);
    const bz = Math.floor((leaf.z + leaf.size * 0.5) / binSide);
    const key = `${bx},${by},${bz}`;
    let id = bucketKeyToId.get(key);
    if (id === undefined) {
      id = fragCount++;
      bucketKeyToId.set(key, id);
    }
    assignment[i] = id;
  }

  // ── 2. Build face-adjacency map (leafIdx → set of neighbour leafIdx) ─
  // Use the smallest leaf size as the cell-grid resolution: each leaf
  // occupies (leaf.size/minSize)^3 cells. Two leaves are face-adjacent if
  // any of their cells share a face.
  const adj: Set<number>[] = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = new Set<number>();

  // Cell map: integer (ix,iy,iz) → owning leafIdx. The map is occupancy-
  // sparse (only filled cells are stored), so memory scales with total
  // occupied volume in minSize units, not the AABB cube.
  const cellToLeaf = new Map<string, number>();
  const cellCoordsForLeaf = (leaf: OctreeLeaf) => {
    const ix0 = Math.round((leaf.x - whole.min[0]) / minSize);
    const iy0 = Math.round((leaf.y - whole.min[1]) / minSize);
    const iz0 = Math.round((leaf.z - whole.min[2]) / minSize);
    const span = Math.max(1, Math.round(leaf.size / minSize));
    return { ix0, iy0, iz0, span };
  };

  for (let i = 0; i < n; i++) {
    const { ix0, iy0, iz0, span } = cellCoordsForLeaf(leaves[i]!);
    for (let dz = 0; dz < span; dz++)
      for (let dy = 0; dy < span; dy++)
        for (let dx = 0; dx < span; dx++)
          cellToLeaf.set(`${ix0 + dx},${iy0 + dy},${iz0 + dz}`, i);
  }

  const addNeighbour = (i: number, key: string) => {
    const j = cellToLeaf.get(key);
    if (j === undefined || j === i) return;
    adj[i]!.add(j);
    adj[j]!.add(i);
  };

  for (let i = 0; i < n; i++) {
    const { ix0, iy0, iz0, span } = cellCoordsForLeaf(leaves[i]!);
    for (let dy = 0; dy < span; dy++)
      for (let dz = 0; dz < span; dz++) {
        addNeighbour(i, `${ix0 - 1},${iy0 + dy},${iz0 + dz}`);
        addNeighbour(i, `${ix0 + span},${iy0 + dy},${iz0 + dz}`);
      }
    for (let dx = 0; dx < span; dx++)
      for (let dz = 0; dz < span; dz++) {
        addNeighbour(i, `${ix0 + dx},${iy0 - 1},${iz0 + dz}`);
        addNeighbour(i, `${ix0 + dx},${iy0 + span},${iz0 + dz}`);
      }
    for (let dx = 0; dx < span; dx++)
      for (let dy = 0; dy < span; dy++) {
        addNeighbour(i, `${ix0 + dx},${iy0 + dy},${iz0 - 1}`);
        addNeighbour(i, `${ix0 + dx},${iy0 + dy},${iz0 + span}`);
      }
  }

  // ── 3. SLIC-style colour-driven refinement ────────────────────────
  // Each iteration recomputes per-fragment mean colour, then visits every
  // leaf; if a face-adjacent fragment's mean is closer to the leaf colour
  // than the leaf's current fragment, switch it. Restricting moves to
  // face-adjacent fragments keeps regions geometrically connected during
  // iteration. We never empty a fragment (the safeguard preserves the
  // seeded fragment count).
  const sumR = new Float64Array(fragCount);
  const sumG = new Float64Array(fragCount);
  const sumB = new Float64Array(fragCount);
  const count = new Int32Array(fragCount);
  const avgR = new Float64Array(fragCount);
  const avgG = new Float64Array(fragCount);
  const avgB = new Float64Array(fragCount);

  const recomputeAverages = () => {
    sumR.fill(0); sumG.fill(0); sumB.fill(0); count.fill(0);
    for (let i = 0; i < n; i++) {
      const f = assignment[i]!;
      const leaf = leaves[i]!;
      sumR[f] = sumR[f]! + leaf.r;
      sumG[f] = sumG[f]! + leaf.g;
      sumB[f] = sumB[f]! + leaf.b;
      count[f] = count[f]! + 1;
    }
    for (let f = 0; f < fragCount; f++) {
      const c = count[f]!;
      if (c > 0) {
        avgR[f] = sumR[f]! / c;
        avgG[f] = sumG[f]! / c;
        avgB[f] = sumB[f]! / c;
      }
    }
  };

  const MAX_ITERATIONS = 8;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    recomputeAverages();
    let changes = 0;
    for (let i = 0; i < n; i++) {
      const cur = assignment[i]!;
      if (count[cur]! <= 1) continue;
      const leaf = leaves[i]!;
      let bestFrag = cur;
      const dr0 = leaf.r - avgR[cur]!;
      const dg0 = leaf.g - avgG[cur]!;
      const db0 = leaf.b - avgB[cur]!;
      let bestDist = dr0 * dr0 + dg0 * dg0 + db0 * db0;
      for (const j of adj[i]!) {
        const f = assignment[j]!;
        if (f === cur) continue;
        const dr = leaf.r - avgR[f]!;
        const dg = leaf.g - avgG[f]!;
        const db = leaf.b - avgB[f]!;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) { bestDist = d; bestFrag = f; }
      }
      if (bestFrag !== cur) {
        // Incrementally update sums/averages so later leaves in the same
        // pass see fresh statistics. Cheaper than redoing the full sweep.
        sumR[cur] = sumR[cur]! - leaf.r;
        sumG[cur] = sumG[cur]! - leaf.g;
        sumB[cur] = sumB[cur]! - leaf.b;
        sumR[bestFrag] = sumR[bestFrag]! + leaf.r;
        sumG[bestFrag] = sumG[bestFrag]! + leaf.g;
        sumB[bestFrag] = sumB[bestFrag]! + leaf.b;
        count[cur] = count[cur]! - 1;
        count[bestFrag] = count[bestFrag]! + 1;
        const cc = count[cur]!;
        avgR[cur] = sumR[cur]! / cc;
        avgG[cur] = sumG[cur]! / cc;
        avgB[cur] = sumB[cur]! / cc;
        const bc = count[bestFrag]!;
        avgR[bestFrag] = sumR[bestFrag]! / bc;
        avgG[bestFrag] = sumG[bestFrag]! / bc;
        avgB[bestFrag] = sumB[bestFrag]! / bc;
        assignment[i] = bestFrag;
        changes++;
      }
    }
    if (changes === 0) break;
  }

  // ── 4. Connectivity split ────────────────────────────────────────
  // Boundary swaps can leave a fragment in two disjoint pieces. BFS each
  // fragment-coloured region through the adjacency graph and emit a fresh
  // fragment id per connected component.
  const visited = new Uint8Array(n);
  const finalAssign = new Int32Array(n);
  let outCount = 0;
  const stack: number[] = [];
  for (let seed = 0; seed < n; seed++) {
    if (visited[seed]) continue;
    const fragId = assignment[seed]!;
    const newId = outCount++;
    stack.length = 0;
    stack.push(seed);
    visited[seed] = 1;
    finalAssign[seed] = newId;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of adj[cur]!) {
        if (visited[next]) continue;
        if (assignment[next]! !== fragId) continue;
        visited[next] = 1;
        finalAssign[next] = newId;
        stack.push(next);
      }
    }
  }

  // ── 5. Merge-down pass ────────────────────────────────────────────
  // Hollow / shelled objects (a jail with bars + walls) make step 1's
  // uniform 3-D bins straddle multiple disconnected wall slices, so the
  // connectivity split in step 4 multiplies the fragment count well past
  // the user's target. Pull it back down by greedily merging the smallest
  // fragment into whichever face-adjacent neighbour matches it best in
  // colour, repeatedly, until we either hit `target` or run out of merges
  // (which happens when every remaining fragment has no neighbours — only
  // possible if the object itself has more connected components than
  // `target`, in which case the natural minimum wins).
  const fSumR = new Float64Array(outCount);
  const fSumG = new Float64Array(outCount);
  const fSumB = new Float64Array(outCount);
  const fCount = new Int32Array(outCount);
  const fragAdj: Set<number>[] = new Array(outCount);
  const fragLeafIdx: number[][] = new Array(outCount);
  for (let f = 0; f < outCount; f++) { fragAdj[f] = new Set<number>(); fragLeafIdx[f] = []; }

  for (let i = 0; i < n; i++) {
    const f = finalAssign[i]!;
    const leaf = leaves[i]!;
    fSumR[f] = fSumR[f]! + leaf.r;
    fSumG[f] = fSumG[f]! + leaf.g;
    fSumB[f] = fSumB[f]! + leaf.b;
    fCount[f] = fCount[f]! + 1;
    fragLeafIdx[f]!.push(i);
  }
  for (let i = 0; i < n; i++) {
    const fa = finalAssign[i]!;
    for (const j of adj[i]!) {
      const fb = finalAssign[j]!;
      if (fa !== fb) {
        fragAdj[fa]!.add(fb);
        fragAdj[fb]!.add(fa);
      }
    }
  }

  // `unmergeable` keeps the loop from re-selecting fragments that have no
  // neighbours to merge into (a truly isolated connected component). They
  // stay in the output untouched.
  const unmergeable = new Uint8Array(outCount);
  let activeCount = outCount;
  while (activeCount > target) {
    // Find the smallest still-active mergeable fragment.
    let smallest = -1;
    let smallestSize = Infinity;
    for (let f = 0; f < outCount; f++) {
      const c = fCount[f]!;
      if (c === 0 || unmergeable[f]) continue;
      if (c < smallestSize) { smallestSize = c; smallest = f; }
    }
    if (smallest === -1) break;

    const neigh = fragAdj[smallest]!;
    if (neigh.size === 0) {
      unmergeable[smallest] = 1;
      continue;
    }

    // Pick the colour-closest neighbour.
    const sc = smallestSize;
    const sR = fSumR[smallest]! / sc;
    const sG = fSumG[smallest]! / sc;
    const sB = fSumB[smallest]! / sc;
    let best = -1;
    let bestDist = Infinity;
    for (const nb of neigh) {
      const nc = fCount[nb]!;
      const dr = sR - fSumR[nb]! / nc;
      const dg = sG - fSumG[nb]! / nc;
      const db = sB - fSumB[nb]! / nc;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; best = nb; }
    }
    if (best === -1) break;

    // Merge `smallest` into `best`.
    fSumR[best] = fSumR[best]! + fSumR[smallest]!;
    fSumG[best] = fSumG[best]! + fSumG[smallest]!;
    fSumB[best] = fSumB[best]! + fSumB[smallest]!;
    fCount[best] = fCount[best]! + sc;
    for (const leafIdx of fragLeafIdx[smallest]!) {
      finalAssign[leafIdx] = best;
      fragLeafIdx[best]!.push(leafIdx);
    }
    fragLeafIdx[smallest] = [];
    fSumR[smallest] = 0; fSumG[smallest] = 0; fSumB[smallest] = 0;
    fCount[smallest] = 0;
    // Rewire adjacency: every neighbour of `smallest` becomes a neighbour
    // of `best` (and forgets `smallest`).
    for (const nb of neigh) {
      fragAdj[nb]!.delete(smallest);
      if (nb !== best) {
        fragAdj[nb]!.add(best);
        fragAdj[best]!.add(nb);
      }
    }
    fragAdj[best]!.delete(smallest);
    fragAdj[smallest]!.clear();
    activeCount--;
  }

  // ── 6. Materialise fragments ─────────────────────────────────────
  const fragLists: OctreeLeaf[][] = new Array(outCount);
  for (let i = 0; i < outCount; i++) fragLists[i] = [];
  for (let i = 0; i < n; i++) fragLists[finalAssign[i]!]!.push(leaves[i]!);

  const merged: VxlV3Fragment[] = [];
  for (const list of fragLists) {
    if (list.length === 0) continue;
    const aabb = leafAabb(list);
    merged.push({ aabbMin: aabb.min, aabbMax: aabb.max, leaves: list });
  }

  // ── 7. Oversize-fragment split ────────────────────────────────────
  // Very large fragments cause physics issues — broadphase pairs against
  // every other object inside their AABB even when only a corner is in
  // play. If any fragment's AABB exceeds half the object's AABB on an
  // axis, split it down the middle on that axis. Both halves go back
  // through the same check so a fragment that's oversized on multiple
  // axes ends up cut into four (or eight) pieces. This is the very last
  // step — no connectivity re-check, which means a halved fragment may
  // contain two disjoint pieces of geometry; that's fine for physics
  // (one body with two colliders) and was authorised explicitly.
  const halfObjX = (whole.max[0] - whole.min[0]) * 0.5;
  const halfObjY = (whole.max[1] - whole.min[1]) * 0.5;
  const halfObjZ = (whole.max[2] - whole.min[2]) * 0.5;
  const fragments: VxlV3Fragment[] = [];
  const splitQueue: VxlV3Fragment[] = merged;
  while (splitQueue.length > 0) {
    const frag = splitQueue.pop()!;
    const dx = frag.aabbMax[0] - frag.aabbMin[0];
    const dy = frag.aabbMax[1] - frag.aabbMin[1];
    const dz = frag.aabbMax[2] - frag.aabbMin[2];
    let axis = -1;
    let excess = 0;
    if (dx > halfObjX) { axis = 0; excess = dx - halfObjX; }
    if (dy > halfObjY && dy - halfObjY > excess) { axis = 1; excess = dy - halfObjY; }
    if (dz > halfObjZ && dz - halfObjZ > excess) { axis = 2; }
    if (axis === -1) { fragments.push(frag); continue; }
    // Jittered midpoint so identical-extent fragments don't all cut at the
    // same plane (visually obvious for stacked or arrayed objects). The
    // split point ends up somewhere in the 35 %–65 % range; recursion
    // handles cases where the larger half is still oversized.
    const minA = frag.aabbMin[axis]!;
    const maxA = frag.aabbMax[axis]!;
    const t = 0.5 + (Math.random() - 0.5) * 0.3;
    const mid = minA + (maxA - minA) * t;
    const lower: OctreeLeaf[] = [];
    const upper: OctreeLeaf[] = [];
    for (const leaf of frag.leaves) {
      const c = axis === 0 ? leaf.x + leaf.size * 0.5
        : axis === 1 ? leaf.y + leaf.size * 0.5
        : leaf.z + leaf.size * 0.5;
      if (c < mid) lower.push(leaf); else upper.push(leaf);
    }
    if (lower.length === 0 || upper.length === 0) {
      // All leaves landed on one side of the midplane — splitting again
      // wouldn't change anything, so accept the fragment as-is.
      fragments.push(frag);
      continue;
    }
    const la = leafAabb(lower);
    const ua = leafAabb(upper);
    splitQueue.push({ aabbMin: la.min, aabbMax: la.max, leaves: lower });
    splitQueue.push({ aabbMin: ua.min, aabbMax: ua.max, leaves: upper });
  }

  // ── 8. Stray-voxel detachment ─────────────────────────────────────
  // Pull a sprinkling of 1-4-voxel mini-fragments off random fragment
  // edges. They're not physically significant — they exist purely so
  // explosions throw a few individual chips around as well as the big
  // chunks, which reads as much more dramatic debris.
  if (individualVoxels > 0) {
    detachStrayVoxels(fragments, individualVoxels);
  }
  return fragments;
}

/**
 * Peel `count` mini-fragments (1-4 face-adjacent leaves each) off random
 * fragments and append them as standalone fragments. Mutates `fragments`
 * in place. Source fragments must keep at least `MIN_REMAINING` leaves
 * so the bulk fragment doesn't disappear from underneath us — small
 * fragments are simply skipped as donors.
 */
function detachStrayVoxels(fragments: VxlV3Fragment[], count: number): void {
  const MIN_REMAINING = 5;
  const MAX_CLUSTER = 4;
  const EPS = 1e-5;

  const touches = (a: OctreeLeaf, b: OctreeLeaf): boolean => {
    const ax1 = a.x + a.size, ay1 = a.y + a.size, az1 = a.z + a.size;
    const bx1 = b.x + b.size, by1 = b.y + b.size, bz1 = b.z + b.size;
    const xOverlap = a.x < bx1 - EPS && b.x < ax1 - EPS;
    const yOverlap = a.y < by1 - EPS && b.y < ay1 - EPS;
    const zOverlap = a.z < bz1 - EPS && b.z < az1 - EPS;
    const xFlush = Math.abs(ax1 - b.x) < EPS || Math.abs(bx1 - a.x) < EPS;
    const yFlush = Math.abs(ay1 - b.y) < EPS || Math.abs(by1 - a.y) < EPS;
    const zFlush = Math.abs(az1 - b.z) < EPS || Math.abs(bz1 - a.z) < EPS;
    if (xFlush && yOverlap && zOverlap) return true;
    if (yFlush && xOverlap && zOverlap) return true;
    if (zFlush && xOverlap && yOverlap) return true;
    return false;
  };

  const originalCount = fragments.length;
  for (let extraction = 0; extraction < count; extraction++) {
    // Pick a donor fragment with enough leaves left. Only consider the
    // originals — we don't want to peel further pieces off the already-
    // peeled mini-fragments.
    const candidates: number[] = [];
    for (let i = 0; i < originalCount; i++) {
      if (fragments[i]!.leaves.length >= MIN_REMAINING + 1) candidates.push(i);
    }
    if (candidates.length === 0) break;
    const donorIdx = candidates[Math.floor(Math.random() * candidates.length)]!;
    const donor = fragments[donorIdx]!;

    // Seed from a random leaf, then grow up to `clusterSize` leaves by
    // walking face-touching neighbours that still belong to this fragment.
    const clusterSize = 1 + Math.floor(Math.random() * MAX_CLUSTER);
    const taken = new Set<number>();
    const seedIdx = Math.floor(Math.random() * donor.leaves.length);
    taken.add(seedIdx);
    const queue: number[] = [seedIdx];
    while (queue.length > 0 && taken.size < clusterSize) {
      const cur = queue.shift()!;
      const curLeaf = donor.leaves[cur]!;
      for (let j = 0; j < donor.leaves.length; j++) {
        if (taken.has(j)) continue;
        if (touches(curLeaf, donor.leaves[j]!)) {
          taken.add(j);
          queue.push(j);
          if (taken.size >= clusterSize) break;
        }
      }
    }

    // Bail if taking these would leave the donor under MIN_REMAINING.
    if (donor.leaves.length - taken.size < MIN_REMAINING) continue;

    const takenLeaves: OctreeLeaf[] = [];
    const remaining: OctreeLeaf[] = [];
    for (let i = 0; i < donor.leaves.length; i++) {
      if (taken.has(i)) takenLeaves.push(donor.leaves[i]!);
      else remaining.push(donor.leaves[i]!);
    }
    donor.leaves = remaining;
    const donorAabb = leafAabb(remaining);
    donor.aabbMin = donorAabb.min;
    donor.aabbMax = donorAabb.max;
    const strayAabb = leafAabb(takenLeaves);
    fragments.push({ aabbMin: strayAabb.min, aabbMax: strayAabb.max, leaves: takenLeaves });
  }
}

/**
 * Walk the leaf list and report the smallest `leaf.size`. Falls back to
 * `requested` if the list is empty.
 */
function computeActualMinLeafSize(leaves: OctreeLeaf[], requested: number): number {
  let min = Infinity;
  for (const l of leaves) {
    if (l.size < min) min = l.size;
  }
  return isFinite(min) ? min : requested;
}

function leafAabb(leaves: OctreeLeaf[]): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const l of leaves) {
    if (l.x < minX) minX = l.x;
    if (l.y < minY) minY = l.y;
    if (l.z < minZ) minZ = l.z;
    const ex = l.x + l.size, ey = l.y + l.size, ez = l.z + l.size;
    if (ex > maxX) maxX = ex;
    if (ey > maxY) maxY = ey;
    if (ez > maxZ) maxZ = ez;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
