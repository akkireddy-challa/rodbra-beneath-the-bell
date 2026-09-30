/**
 * extractGlbForVoxelization — Phase 1 of GLB voxelization, factored out
 * of `GLBVoxelizer.ts` to keep that file under the 2000-line ESLint cap.
 *
 * Loads the GLB, decodes embedded textures, applies optional targetHeight
 * pre-scale + cm-scale auto-detection, collects all visible meshes'
 * triangles, and computes the centered bounds + octree root. The result
 * is consumed by `voxelizeFromExtracted` (in `GLBVoxelizer.ts`) to run
 * the per-LOD octree build, and by `VxlWorldVoxelizer` to feed many
 * per-chunk voxelization passes from a single GLB load.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';
import {
    type Triangle,
    type PixelData,
    snapDown, snapUp, collectMeshes, getGeometryAttributes,
} from 'engine/GLBVoxelizer.js';
import { isBmWheelNodeName } from 'engine/vehicle/BmVehicleFitment.js';


/**
 * Union of every mesh's world-space AABB. Returns an empty Box3 when no mesh
 * contributes a bounding box (equivalent to the old "min stayed at Infinity"
 * sentinel — callers test `.isEmpty()`).
 */
function meshWorldBounds(meshes: THREE.Mesh[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (bb) box.union(bb.clone().applyMatrix4(mesh.matrixWorld));
  }
  return box;
}


/**
 * Pre-extracted GLB data ready for octree voxelization. Returned by
 * `extractGlbForVoxelization`; consumed by `voxelizeFromExtracted`.
 *
 * Triangles live in world coordinates after any pre-scale transforms
 * (targetHeight, cm-detection) have been applied to the scene. The
 * octree builds in those same coordinates; leaves are shifted by
 * (-centerX, -rawBounds.minY, -centerZ) into the normalized space
 * described by `bounds`.
 */
export interface ExtractedGlb {
  /** All triangles from every visible mesh, in world coords. */
  allTriangles: Triangle[];
  /** Raw GLB AABB after any scene-level scaling, snapped to minVoxelSize. */
  rawBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  /** Normalized bounds (X/Z centered, Y bottom at 0) — used for the encoded VXL3 output. */
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  /** Octree root start in world coords. */
  rootMin: THREE.Vector3;
  /** Octree root edge length. */
  rootSize: number;
  /** Center X of `rawBounds`. */
  centerX: number;
  /** Center Z of `rawBounds`. */
  centerZ: number;
  /** Model X size in world units (post-scale). */
  modelWidth: number;
  /** Model Y size in world units (post-scale). */
  modelHeight: number;
  /** Model Z size in world units (post-scale). */
  modelDepth: number;
  /** Net uniform scale applied to the scene (targetHeight/fitBox × cm auto-scale). */
  appliedScale: number;
  /** glTF scene extras (GLTFLoader copies them into scene.userData) — carries `bmVehicle`. */
  sceneExtras: Record<string, unknown> | null;
  /** BM_wheel_* nodes were present (and excluded from triangles + bounds). */
  hasBmWheelNodes: boolean;
  /**
   * Model AABB in the scaled frame BEFORE the asset re-base — the frame the
   * bmVehicle extras live in (× appliedScale). Vehicle fitment derivation
   * re-centers against these bounds, matching the re-base shift exactly.
   */
  preRebaseBounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

/**
 * Phase 1 of voxelization: load the GLB, decode embedded textures, apply
 * optional targetHeight pre-scale + cm-scale auto-detection, collect all
 * visible meshes' triangles, and compute the centered bounds + octree root.
 *
 * Exported so the chunked-world voxelizer can run this once and feed many
 * per-chunk voxelization passes from a single GLB load.
 */
export async function extractGlbForVoxelization(
  glbBuffer: ArrayBuffer,
  options: {
    minVoxelSize: number;
    targetHeight?: number;
    /**
     * Allocated placeholder box (meters). When set and `targetHeight` is
     * unset, the effective target height is computed so the whole model
     * fits inside this box while preserving its proportions:
     * `min(height, x * objH/objW, z * objH/objD)`. Ignored when
     * `targetHeight` is supplied.
     */
    fitBox?: { x: number; z: number; height: number };
    /**
     * When true, skip the cm→m auto-scale heuristic regardless of model
     * height. Set by the level voxelizer (`voxelizeGLBToVxlWorld`): a
     * level-sized GLB can legitimately exceed 100m, and silently
     * shrinking it by 100× produces a sub-meter world the user can't see.
     * Asset voxelization keeps the heuristic on — that path expects
     * placeable models, where >100 units is almost always centimeters.
     */
    disableCmAutoScale?: boolean;
  },
): Promise<ExtractedGlb> {
  const { minVoxelSize, targetHeight, fitBox, disableCmAutoScale } = options;

  // ── 1. Load GLB ──────────────────────────────────────────────────

  interface GLTFResult {
    scene: THREE.Group;
    scenes?: THREE.Group[];
    parser: {
      json: {
        images?: { bufferView?: number; uri?: string }[];
        textures?: { source?: number }[];
        materials?: { pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
      };
      associations: Map<THREE.Material, { materials?: number }>;
      getDependency(type: string, index: number): Promise<ArrayBuffer>;
    };
  }

  const loader = createGltfLoader();
  const gltf = await new Promise<GLTFResult>((resolve, reject) => {
    loader.parse(
      glbBuffer,
      '',
      (g) => resolve(g as GLTFResult),
      (e) => reject(e),
    );
  });

  const scene = gltf.scene ?? gltf.scenes?.[0];
  if (!scene) throw new Error('No scene found in GLB');

  // Scene extras (GLTFLoader copies glTF scene extras into userData) — the
  // bmVehicle extension travels here.
  const sceneExtras = scene.userData && Object.keys(scene.userData).length > 0
    ? (scene.userData as Record<string, unknown>)
    : null;

  // Vehicle wheel nodes are visual-only at runtime (the engine syncs them to
  // live suspension) — detach them BEFORE any mesh collection so they are
  // excluded from triangles AND every bounds pass (fitBox fit, cm-detect,
  // re-base) in one place.
  const wheelNodes: THREE.Object3D[] = [];
  scene.traverse((node) => {
    if (isBmWheelNodeName(node.name)) wheelNodes.push(node);
  });
  for (const node of wheelNodes) node.removeFromParent();
  const hasBmWheelNodes = wheelNodes.length > 0;
  if (hasBmWheelNodes) scene.updateMatrixWorld(true);
  let appliedScale = 1;

  // ── 1b. Manually extract & decode embedded textures ─────────────
  try {
    const parser = gltf.parser;
    const json = parser?.json;
    if (parser && json?.images && json?.textures && json?.materials) {
      const decodedImages: (PixelData | null)[] = new Array(json.images.length).fill(null);

      for (let imageIndex = 0; imageIndex < json.images.length; imageIndex++) {
        const imageDef = json.images[imageIndex];
        if (!imageDef) continue;

        let bytes: ArrayBuffer | null = null;
        if (imageDef.bufferView !== undefined) {
          bytes = await parser.getDependency('bufferView', imageDef.bufferView);
        } else if (imageDef.uri && typeof imageDef.uri === 'string' && imageDef.uri.startsWith('data:')) {
          const comma = imageDef.uri.indexOf(',');
          const meta = imageDef.uri.slice(0, comma);
          const data = imageDef.uri.slice(comma + 1);
          const isBase64 = meta.includes(';base64');
          const binaryStr = isBase64 ? atob(data) : decodeURIComponent(data);
          const arr = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) arr[i] = binaryStr.charCodeAt(i);
          bytes = arr.buffer;
        }

        if (!bytes) continue;

        const blob = new Blob([bytes]);
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        ctx.drawImage(bitmap, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        decodedImages[imageIndex] = {
          width: imgData.width,
          height: imgData.height,
          data: imgData.data,
        };
        bitmap.close();
      }

      const materialInstances = new Set<THREE.Material>();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material) {
          if (Array.isArray(obj.material)) {
            for (const m of obj.material) materialInstances.add(m);
          } else {
            materialInstances.add(obj.material);
          }
        }
      });

      for (const mat of materialInstances) {
        const assoc = parser.associations?.get(mat);
        const matIndex = assoc?.materials;
        if (matIndex === undefined) continue;

        const matDef = json.materials?.[matIndex];
        const pbr = matDef?.pbrMetallicRoughness;
        const baseColorTex = pbr?.baseColorTexture;
        if (!baseColorTex) continue;

        const texDef = json.textures?.[baseColorTex.index];
        const imageIndex = texDef?.source;
        if (imageIndex === undefined) continue;

        const image = decodedImages[imageIndex];
        if (!image) continue;

        const tex = new THREE.Texture();
        tex.image = image;
        tex.flipY = false;
        tex.needsUpdate = true;
        (mat as THREE.MeshStandardMaterial).map = tex;
        (mat as THREE.MeshStandardMaterial).needsUpdate = true;
      }
    }
  } catch {
    // If manual texture extraction fails, proceed with baseColorFactor-only sampling.
  }

  // ── 2. Optional pre-scale to target height ───────────────────────

  // Effective target height. Starts from the explicit `targetHeight`; when
  // a `fitBox` is supplied instead, we derive a height that makes the whole
  // model fit inside the allocated box while preserving its proportions.
  let th = targetHeight;

  if (fitBox && targetHeight === undefined) {
    const meshesFit = collectMeshes(scene);
    if (meshesFit.length === 0) throw new Error('No meshes found in GLB');

    const fitUnion = meshWorldBounds(meshesFit);
    if (!fitUnion.isEmpty()) {
      const cw = fitUnion.max.x - fitUnion.min.x;
      const ch = fitUnion.max.y - fitUnion.min.y;
      const cd = fitUnion.max.z - fitUnion.min.z;
      // Skip degenerate models (flat on any axis) — proportional scaling
      // would divide by zero / scale to nothing; fall through to the
      // default (unscaled + cm-autoscale) behavior.
      if (cw > 0 && ch > 0 && cd > 0) {
        // Yaw-align before fitting: generated GLBs arrive with arbitrary
        // horizontal orientation. If the allocated box and the model are both
        // clearly elongated but their LONG axes disagree, fitting as-is
        // crushes the model's length into the box's narrow axis (a ~4.5 m
        // sedan forced into a 1.8 m width slot bakes at ~40% size). Rotate
        // the model 90° about Y so long matches long — placed instances then
        // also read correctly (the car lies along the road like its
        // placeholder did). Near-square shapes are left alone: the fit is
        // orientation-insensitive there and rotating would flip-flop.
        const ELONGATED = 1.15;
        const boxAspect = Math.max(fitBox.x, fitBox.z) / Math.max(1e-6, Math.min(fitBox.x, fitBox.z));
        const modelAspect = Math.max(cw, cd) / Math.max(1e-6, Math.min(cw, cd));
        let w = cw, d = cd;
        if (boxAspect >= ELONGATED && modelAspect >= ELONGATED && (fitBox.x >= fitBox.z) !== (cw >= cd)) {
          scene.rotation.y += Math.PI / 2;
          scene.updateMatrixWorld(true);
          // Extents swap exactly under a 90° yaw (axis permutation).
          w = cd;
          d = cw;
          console.log('[GLBVoxelizer] fitBox: rotated model 90° to align its long axis with the allocated box');
        }
        th = Math.min(fitBox.height, (fitBox.x * ch) / w, (fitBox.z * ch) / d);
      }
    }
  }

  if (th !== undefined) {
    if (!Number.isFinite(th) || th <= 0) {
      throw new Error(`Invalid targetHeight: ${th}`);
    }

    const meshesPre = collectMeshes(scene);
    if (meshesPre.length === 0) throw new Error('No meshes found in GLB');

    const preBounds = meshWorldBounds(meshesPre);
    if (preBounds.isEmpty()) {
      throw new Error('Failed to compute pre-scale bounds for target height');
    }

    const currentHeight = preBounds.max.y - preBounds.min.y;
    if (!(currentHeight > 0)) {
      throw new Error(`Cannot apply targetHeight because current height is ${currentHeight}`);
    }

    const scaleFactor = th / currentHeight;
    scene.scale.multiplyScalar(scaleFactor);
    scene.updateMatrixWorld(true);
    appliedScale *= scaleFactor;
  }

  // ── 3. Collect meshes & compute world bounds ─────────────────────

  const meshes = collectMeshes(scene);
  if (meshes.length === 0) throw new Error('No meshes found in GLB');

  // For each mesh, find the topmost-named ancestor below the scene root.
  // The level voxelizer uses this to filter triangles by per-object LOD
  // offset — one octree pass per distinct offset, each over the subset
  // whose `sourceNodeName` is mapped to that offset. We walk up to (but
  // not including) the scene root and keep the highest-up named node,
  // so a Blender export of "Scene > Track > Track_mesh" stamps every
  // Track triangle with `Track` (not `Track_mesh`). Empty string when
  // no named ancestor exists.
  const meshTopLevelName = new Map<THREE.Mesh, string>();
  for (const mesh of meshes) {
    let topNamed = '';
    let node: THREE.Object3D | null = mesh;
    while (node && node !== scene) {
      if (node.name) topNamed = node.name;
      node = node.parent;
    }
    meshTopLevelName.set(mesh, topNamed);
  }

  const worldBox = meshWorldBounds(meshes);
  if (worldBox.isEmpty()) throw new Error('Failed to compute bounds');

  let gMinX = worldBox.min.x, gMinY = worldBox.min.y, gMinZ = worldBox.min.z;
  let gMaxX = worldBox.max.x, gMaxY = worldBox.max.y, gMaxZ = worldBox.max.z;

  const rawBounds = {
    minX: snapDown(gMinX, minVoxelSize),
    minY: snapDown(gMinY, minVoxelSize),
    minZ: snapDown(gMinZ, minVoxelSize),
    maxX: snapUp(gMaxX, minVoxelSize),
    maxY: snapUp(gMaxY, minVoxelSize),
    maxZ: snapUp(gMaxZ, minVoxelSize),
  };

  let modelWidth = rawBounds.maxX - rawBounds.minX;
  let modelHeight = rawBounds.maxY - rawBounds.minY;
  let modelDepth = rawBounds.maxZ - rawBounds.minZ;

  // Auto-detect centimeter-scale models: many 3D authoring tools (Blender,
  // 3ds Max, SketchUp) export in centimeters. If no targetHeight was set
  // and the model exceeds a reasonable threshold, scale it down by 100×.
  // Suppressed on the level-voxelize path (`disableCmAutoScale`) — levels
  // can legitimately be hundreds of meters tall.
  const CM_DETECTION_THRESHOLD = 100; // meters — anything taller is likely cm
  if (!disableCmAutoScale && th === undefined && modelHeight > CM_DETECTION_THRESHOLD) {
    const cmScale = 0.01;
    console.log(
      `[GLBVoxelizer] Model height is ${modelHeight.toFixed(1)} units — likely centimeters. ` +
      `Auto-scaling by ${cmScale}× to convert to meters.`,
    );
    scene.scale.multiplyScalar(cmScale);
    scene.updateMatrixWorld(true);
    appliedScale *= cmScale;

    // Recompute bounds after rescale
    const rescaledBox = meshWorldBounds(meshes);
    gMinX = rescaledBox.min.x; gMinY = rescaledBox.min.y; gMinZ = rescaledBox.min.z;
    gMaxX = rescaledBox.max.x; gMaxY = rescaledBox.max.y; gMaxZ = rescaledBox.max.z;
    rawBounds.minX = snapDown(gMinX, minVoxelSize);
    rawBounds.minY = snapDown(gMinY, minVoxelSize);
    rawBounds.minZ = snapDown(gMinZ, minVoxelSize);
    rawBounds.maxX = snapUp(gMaxX, minVoxelSize);
    rawBounds.maxY = snapUp(gMaxY, minVoxelSize);
    rawBounds.maxZ = snapUp(gMaxZ, minVoxelSize);
    modelWidth = rawBounds.maxX - rawBounds.minX;
    modelHeight = rawBounds.maxY - rawBounds.minY;
    modelDepth = rawBounds.maxZ - rawBounds.minZ;
  }

  // Scaled-but-unrebased bounds — the frame vehicle extras are derived in.
  const preRebaseBounds = {
    min: { x: gMinX, y: gMinY, z: gMinZ },
    max: { x: gMaxX, y: gMaxY, z: gMaxZ },
  };

  // ── 3b. Rebase ASSET bakes to the canonical frame the published bounds
  // CLAIM: x/z centered on the origin, base at y=0. Without physically moving
  // the geometry, the octree keeps the source GLB's own frame — placement puts
  // the GLB ORIGIN at the instance position, so a mesh authored with a centered
  // pivot (typical for AI-generated models) renders floating half its height
  // above where a base-at-origin placeholder sat. Level bakes keep their world
  // coordinates (same gate as the cm-autoscale above — that path sets
  // `disableCmAutoScale`).
  if (!disableCmAutoScale) {
    const offX = (gMinX + gMaxX) / 2;
    const offY = gMinY;
    const offZ = (gMinZ + gMaxZ) / 2;
    if (Math.abs(offX) > 1e-6 || Math.abs(offY) > 1e-6 || Math.abs(offZ) > 1e-6) {
      scene.position.x -= offX;
      scene.position.y -= offY;
      scene.position.z -= offZ;
      scene.updateMatrixWorld(true);
      gMinX -= offX; gMaxX -= offX;
      gMinY -= offY; gMaxY -= offY;
      gMinZ -= offZ; gMaxZ -= offZ;
      rawBounds.minX = snapDown(gMinX, minVoxelSize);
      rawBounds.minY = snapDown(gMinY, minVoxelSize);
      rawBounds.minZ = snapDown(gMinZ, minVoxelSize);
      rawBounds.maxX = snapUp(gMaxX, minVoxelSize);
      rawBounds.maxY = snapUp(gMaxY, minVoxelSize);
      rawBounds.maxZ = snapUp(gMaxZ, minVoxelSize);
      modelWidth = rawBounds.maxX - rawBounds.minX;
      modelHeight = rawBounds.maxY - rawBounds.minY;
      modelDepth = rawBounds.maxZ - rawBounds.minZ;
    }
  }

  const centerX = (rawBounds.minX + rawBounds.maxX) / 2;
  const centerZ = (rawBounds.minZ + rawBounds.maxZ) / 2;
  const modelSize = Math.max(modelWidth, modelHeight, modelDepth);

  const bounds = {
    minX: -modelWidth / 2,
    minY: 0,
    minZ: -modelDepth / 2,
    maxX: modelWidth / 2,
    maxY: modelHeight,
    maxZ: modelDepth / 2,
  };

  // Pad to cubic root for the octree
  const rootMin = new THREE.Vector3(
    centerX - modelSize / 2,
    rawBounds.minY,
    centerZ - modelSize / 2,
  );
  const rootSize = modelSize;

  // ── 4. Collect all triangles ─────────────────────────────────────

  const allTriangles: Triangle[] = [];
  const tmpV0 = new THREE.Vector3();
  const tmpV1 = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpEdge1 = new THREE.Vector3();
  const tmpEdge2 = new THREE.Vector3();

  for (const mesh of meshes) {
    const attrs = getGeometryAttributes(mesh);
    if (!attrs) continue;
    const { positions, uvs, colors, indices } = attrs;
    const material = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as THREE.MeshStandardMaterial;
    const matrixWorld = mesh.matrixWorld;

    const triCount = indices ? indices.length / 3 : positions.length / 9;

    for (let t = 0; t < triCount; t++) {
      const i0 = indices ? indices[t * 3]! : t * 3;
      const i1 = indices ? indices[t * 3 + 1]! : t * 3 + 1;
      const i2 = indices ? indices[t * 3 + 2]! : t * 3 + 2;

      const p0i = i0 * 3;
      const p1i = i1 * 3;
      const p2i = i2 * 3;

      tmpV0.set(positions[p0i] ?? 0, positions[p0i + 1] ?? 0, positions[p0i + 2] ?? 0).applyMatrix4(matrixWorld);
      tmpV1.set(positions[p1i] ?? 0, positions[p1i + 1] ?? 0, positions[p1i + 2] ?? 0).applyMatrix4(matrixWorld);
      tmpV2.set(positions[p2i] ?? 0, positions[p2i + 1] ?? 0, positions[p2i + 2] ?? 0).applyMatrix4(matrixWorld);

      tmpEdge1.subVectors(tmpV1, tmpV0);
      tmpEdge2.subVectors(tmpV2, tmpV0);
      const normal = new THREE.Vector3().crossVectors(tmpEdge1, tmpEdge2).normalize();

      let uv0: THREE.Vector2 | undefined;
      let uv1: THREE.Vector2 | undefined;
      let uv2: THREE.Vector2 | undefined;
      if (uvs) {
        const u0i = i0 * 2;
        const u1i = i1 * 2;
        const u2i = i2 * 2;
        uv0 = new THREE.Vector2(uvs[u0i], uvs[u0i + 1]);
        uv1 = new THREE.Vector2(uvs[u1i], uvs[u1i + 1]);
        uv2 = new THREE.Vector2(uvs[u2i], uvs[u2i + 1]);
      }

      let col0: { r: number; g: number; b: number } | undefined;
      let col1: { r: number; g: number; b: number } | undefined;
      let col2: { r: number; g: number; b: number } | undefined;
      if (colors) {
        const c0i = i0 * 3;
        const c1i = i1 * 3;
        const c2i = i2 * 3;
        col0 = {
          r: Math.round((colors[c0i] ?? 1) * 255),
          g: Math.round((colors[c0i + 1] ?? 1) * 255),
          b: Math.round((colors[c0i + 2] ?? 1) * 255),
        };
        col1 = {
          r: Math.round((colors[c1i] ?? 1) * 255),
          g: Math.round((colors[c1i + 1] ?? 1) * 255),
          b: Math.round((colors[c1i + 2] ?? 1) * 255),
        };
        col2 = {
          r: Math.round((colors[c2i] ?? 1) * 255),
          g: Math.round((colors[c2i + 1] ?? 1) * 255),
          b: Math.round((colors[c2i + 2] ?? 1) * 255),
        };
      }

      allTriangles.push({
        v0: tmpV0.clone(),
        v1: tmpV1.clone(),
        v2: tmpV2.clone(),
        normal,
        material,
        uv0,
        uv1,
        uv2,
        col0,
        col1,
        col2,
        sourceNodeName: meshTopLevelName.get(mesh) ?? '',
      });
    }
  }

  return {
    allTriangles, rawBounds, bounds, rootMin, rootSize,
    centerX, centerZ, modelWidth, modelHeight, modelDepth,
    appliedScale, sceneExtras, hasBmWheelNodes, preRebaseBounds,
  };
}
