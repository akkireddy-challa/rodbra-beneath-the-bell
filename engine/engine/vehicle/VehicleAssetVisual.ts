/**
 * Vehicle asset visual loading — the async half of spawnFromAsset.
 *
 * `createChassisMesh` is synchronous (called inside the RapierVehicle
 * constructor), so everything network-bound happens HERE first: the chassis
 * visual (VXL VoxelObject or GLB clone) and the wheel visuals (BM_wheel_*
 * nodes from the source GLB, or parametric fallbacks). The spawner awaits
 * this, then constructs the vehicle with an AssetVehicleRenderer holding
 * the ready objects.
 *
 * Frames: the chassis object is normalized to the ASSET frame (origin at
 * the wheel-excluded body's ground-center: X/Z centered, y = 0 at the body
 * base) — VXL assets already are; GLB scenes are wrapped and offset. Wheel
 * meshes are normalized to the engine's neutral wheel pose (spin axis =
 * local +Y; authored GLB wheels have the axle along X and get the inverse
 * of the sync's cylinderAlign).
 */

import * as THREE from 'three';
import type { EngineLike, Asset } from 'types/game.js';
import type { VehicleAssetFitment, VehicleFitmentAxle } from 'types/vehicleFitment.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { ROUNDED_EDGES_RADIUS_VOXELS } from 'engine/VoxelRoundedMesh.js';
import { resolveVehicleFinish } from 'engine/VoxelSurfaceFinish.js';
import { isBmWheelNodeName } from 'engine/vehicle/BmVehicleFitment.js';
import { buildParametricWheelMesh } from 'engine/renderers/VehicleWheelBuilder.js';
import { createTransformOnlyMesh } from 'engine/TransformOnlyMesh.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';

export interface LoadedWheelNode {
  name: string;
  /** Authored node translation, re-centered into the asset frame. */
  position: THREE.Vector3;
  /** Neutral-pose wheel mesh (spin axis local +Y), centered at origin. */
  mesh: THREE.Mesh;
}

export interface LoadedVehicleVisual {
  /** Asset-frame chassis visual, ready to parent (origin ground-center). */
  chassisObject: THREE.Object3D;
  /** Wheel visuals from the source GLB (empty when it has none). */
  wheelNodes: LoadedWheelNode[];
  /**
   * Tire colour for parametrically rebuilt wheels, when this vehicle's paint overrode the
   * default. Carried on the visual rather than passed to `wheelMeshForAxleSide` so its five
   * call sites (spawner, showroom, network, ghosts) need no change — and so a caller
   * cannot rebuild a wheel in the wrong colour by forgetting an argument.
   */
  tireColor?: number;
}

/**
 * Per-URL caches for the two things a vehicle visual downloads.
 *
 * Karts are loaded at least twice — the showroom builds every kart for selection, then the
 * level load builds the chosen one again — and nothing was shared between those. Measured
 * on a published circuit: the player's 181 KB source GLB was re-fetched during the level
 * load and took 5.3s, because it queued behind the scenery downloads and wore the GPU
 * warmup's name in the profile.
 *
 * The PROMISE is cached rather than the result, so concurrent callers (the showroom builds
 * several karts at once) share one request instead of racing to start their own.
 *
 * Safe to hand the same objects out repeatedly: `splitGlbScene` clones the scene before
 * touching it, and the vxl entry is an immutable ArrayBuffer that `loadFromFile` only
 * reads. Failures are evicted so a later attempt can retry rather than replaying the error
 * for the rest of the session.
 */
const glbSceneCache = new Map<string, Promise<THREE.Object3D>>();
const vxlBufferCache = new Map<string, Promise<ArrayBuffer>>();

function cached<T>(store: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit) return hit;
  const p = load().catch((err) => { store.delete(key); throw err; });
  store.set(key, p);
  return p;
}

/**
 * Drop both caches. For teardown between GAMES — not between levels, where keeping them is
 * the entire point.
 */
export function clearVehicleAssetCache(): void {
  glbSceneCache.clear();
  vxlBufferCache.clear();
}

function isVxlAsset(asset: Asset): boolean {
  return asset.type === 'vxl' || asset.type === 'voxels' || asset.url.toLowerCase().endsWith('.vxl');
}

async function loadVxlChassis(asset: Asset, engine: EngineLike): Promise<THREE.Object3D> {
  const buffer = await cached(vxlBufferCache, asset.url, async () => {
    const response = await fetch(ASSET_MAP.get(asset.url) ?? asset.url);
    if (!response.ok) {
      throw new Error(`vehicle asset fetch failed: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
  });
  // No metadata peek before construction: the VXL3 header carries `useAtlas` and the
  // voxel size, and `loadFromFile` applies both over what is passed here — see
  // engine/__tests__/NoWholeBufferJsonPeek.test.ts.
  const roundedEdges = asset.voxelizeSettings?.roundedEdges === true;
  // Flat unless world.json's renderConfig.vehicleFinish asks for paint.
  const finish = resolveVehicleFinish(engine.getRenderConfig?.()?.vehicleFinish);
  const voxelObject = new VoxelObject({
    voxelSize: asset.voxelSize ?? 0.5,
    useAtlas: true,
    shadows: true,
    ...(roundedEdges ? { voxelRoundingRadiusVoxels: ROUNDED_EDGES_RADIUS_VOXELS } : {}),
    ...(finish ? { finish } : {}),
  });
  await voxelObject.loadFromFile(buffer);
  return voxelObject;
}

interface GlbParts {
  body: THREE.Object3D;
  wheels: Array<{ name: string; node: THREE.Object3D; translation: THREE.Vector3 }>;
}

/** Ground-center recenter offset of a (wheel-less) GLB body. */
function glbBodyRecenter(body: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(body);
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return new THREE.Vector3();
  return new THREE.Vector3(
    (box.min.x + box.max.x) / 2,
    box.min.y,
    (box.min.z + box.max.z) / 2,
  );
}

/** Flag every mesh under `root` as a shadow caster and receiver. */
function enableShadows(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

/** Clone a loaded GLB scene, detaching BM_wheel_* subtrees from the body. */
function splitGlbScene(scene: THREE.Object3D): GlbParts {
  const clone = scene.clone(true);
  const wheels: GlbParts['wheels'] = [];
  const toDetach: THREE.Object3D[] = [];
  clone.traverse((node) => {
    if (isBmWheelNodeName(node.name)) toDetach.push(node);
  });
  // Wheel node translations are authored relative to the scene root; if a
  // Blender export nests them, the world offset is what matters — so resolve
  // every matrix once, while the tree is still whole.
  clone.updateMatrixWorld(true);
  for (const node of toDetach) {
    const world = new THREE.Vector3();
    node.getWorldPosition(world);
    node.removeFromParent();
    wheels.push({ name: node.name, node, translation: world });
  }
  enableShadows(clone);
  return { body: clone, wheels };
}

/**
 * Wrap a detached wheel node into the engine's neutral wheel pose.
 *
 * The wrapper is a transform node only. It has to be a Mesh rather than a
 * Group because `VehicleRenderer.createWheelMeshes` is typed `THREE.Mesh[]` —
 * a shipped engine interface that published games implement, so it cannot be
 * widened here — hence `createTransformOnlyMesh`, which is safe to submit to
 * WebGPU. A plain `new THREE.Mesh()` blanks the entire frame; see
 * TransformOnlyMesh.ts.
 */
function normalizeWheelNode(entry: GlbParts['wheels'][number]): THREE.Mesh {
  const wrapper = createTransformOnlyMesh(entry.name);
  const inner = new THREE.Group();
  // The sync applies cylinderAlign(Z, +π/2) last, mapping an upright
  // cylinder's Y axis onto the chassis X axle. Authored wheels already have
  // the axle along X, so pre-apply the inverse.
  inner.rotation.z = -Math.PI / 2;
  entry.node.position.set(0, 0, 0);
  // Wheel nodes are detached before splitGlbScene's shadow pass, so flag them
  // here — otherwise the tyres never cast a shadow and the car looks to float.
  enableShadows(entry.node);
  inner.add(entry.node);
  wrapper.add(inner);
  return wrapper;
}

/**
 * Load everything spawnFromAsset needs. The GLB is loaded when the asset is
 * GLB-native OR when the fitment says wheel nodes exist (VXL assets keep
 * their source GLB in `sourceGlbUrl`).
 */
export async function loadVehicleAssetVisual(
  engine: EngineLike,
  asset: Asset,
  fitment: VehicleAssetFitment,
): Promise<LoadedVehicleVisual> {
  const vxl = isVxlAsset(asset);
  const glbUrl = vxl ? asset.sourceGlbUrl : (asset.url ?? asset.sourceGlbUrl);
  // A GLB-native asset always needs its GLB (it IS the chassis). A VXL one needs it only
  // to harvest wheel meshes — and not even then when those wheels came from the forge,
  // because the forge built them from the very axles in this fitment, using the same
  // styles and the same constants as `VehicleWheelBuilder`. Rebuilding them locally is
  // pixel-identical and saves ~200 KB per kart against a 3 KB chassis.
  //
  // `wheelsFromSpec` is absent on assets imported before it existed and on hand-authored
  // GLBs whose wheel meshes are arbitrary art; both keep fetching, which is why this reads
  // as "only skip when we KNOW we can rebuild" rather than "skip unless told otherwise".
  const canRebuildWheels = fitment.wheelsFromSpec === true;
  const wantsGlb = !vxl || (fitment.hasWheelNodes && !canRebuildWheels);

  let glbParts: GlbParts | null = null;
  if (wantsGlb && glbUrl) {
    if (!engine.loader) throw new Error('GLTF loader not available');
    const loader = engine.loader;
    const scene = await cached(glbSceneCache, glbUrl, async () => {
      const gltf = await loader.loadAsync(ASSET_MAP.get(glbUrl) ?? glbUrl);
      return gltf.scene as THREE.Object3D;
    });
    // splitGlbScene clones before it detaches anything, so the cached scene stays whole.
    glbParts = splitGlbScene(scene);
  }

  // Authored-frame re-centering, measured on the body BEFORE it is offset below.
  // A GLB chassis is moved by it; a VXL chassis is already re-based (X/Z centered,
  // base y=0) but its wheel translations still come from the source GLB's frame,
  // so they need the same shift. Zero when no GLB was loaded (no wheels either).
  const recenter = glbParts ? glbBodyRecenter(glbParts.body) : new THREE.Vector3();

  let chassisObject: THREE.Object3D;
  if (vxl) {
    chassisObject = await loadVxlChassis(asset, engine);
  } else {
    if (!glbParts) throw new Error(`vehicle asset '${asset.name}' has no loadable GLB`);
    const wrapper = new THREE.Group();
    wrapper.name = `${asset.name}_body`;
    glbParts.body.position.set(-recenter.x, -recenter.y, -recenter.z);
    wrapper.add(glbParts.body);
    chassisObject = wrapper;
  }

  const wheelNodes: LoadedWheelNode[] = (glbParts?.wheels ?? []).map((entry) => ({
    name: entry.name,
    position: entry.translation.clone().sub(recenter),
    mesh: normalizeWheelNode(entry),
  }));

  const tireColor = fitment.tireColor ? new THREE.Color(fitment.tireColor).getHex() : undefined;
  return { chassisObject, wheelNodes, ...(tireColor !== undefined ? { tireColor } : {}) };
}

/**
 * Pick the wheel visual for one axle side: the nearest loaded wheel node
 * (matched by position — robust to arbitrary BM_wheel_* naming), or a
 * parametric wheel when none is close enough.
 */
export function wheelMeshForAxleSide(
  visual: LoadedVehicleVisual,
  axle: VehicleFitmentAxle,
  side: 1 | -1,
): THREE.Mesh {
  const target = new THREE.Vector3(side * (axle.track / 2), axle.y, axle.z);
  let best: LoadedWheelNode | null = null;
  let bestDist = Infinity;
  for (const node of visual.wheelNodes) {
    const d = node.position.distanceTo(target);
    if (d < bestDist) {
      bestDist = d;
      best = node;
    }
  }
  // Accept a node when it is clearly THIS corner's wheel (within roughly a
  // wheel radius of the expected hub). Reuse-by-clone keeps one node usable
  // for multiple corners if an author supplied fewer nodes than wheels.
  if (best && bestDist < Math.max(axle.radius * 1.5, 0.4)) {
    return best.mesh.clone(true);
  }
  return buildParametricWheelMesh({
    radius: axle.radius,
    width: axle.width,
    style: axle.wheelStyle,
    dual: axle.dual,
    ...(visual.tireColor !== undefined ? { tireColor: visual.tireColor } : {}),
  });
}
