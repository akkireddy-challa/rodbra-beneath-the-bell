/**
 * Smart objects: generated voxel props with moving parts and lights.
 *
 * Two shapes live here, and they are deliberately in two coordinate spaces:
 *
 * - `SmartObjectSpec` is what the Asset Forger's analysis emits, in MASTER
 *   GRID SPACE (integer cells of the HFVX master, engine axes, Y up). It is
 *   the durable source: kept on the asset record so a re-voxelize at another
 *   size can re-split the voxels without a second vision call. Mirrors
 *   `src/lib/smart-object.ts` in asset-forger and the zod schema in
 *   `shared/asset-core/src/smart-object.ts`.
 *
 * - `SmartObjectFitment` is what the BAKE derives, in METRES in the compiled
 *   asset's frame (bottom-centre origin, the same frame as `boundingBox`). It
 *   is what the runtime reads. The pattern is `vehicleFitment`: authoring data
 *   in, typed per-asset fitment out, a runtime system that reads the fitment.
 *
 * The parts themselves — which voxel belongs to which part — are not on the
 * record at all. They are baked into the `.vxl` as its v12 part channel, so the
 * geometry and its segmentation travel as one file.
 */

import type { Vector3Like } from 'types/game.js';

export type GridVec3 = [number, number, number];

export interface GridBox {
  /** Inclusive corners, master grid cells. */
  min: GridVec3;
  max: GridVec3;
}

/** The closed motion vocabulary. Mirrors `VxlV3PartMotion` in engine/VxlV3Parts.ts. */
export type SmartObjectMotion =
  | { kind: 'spin'; axis: GridVec3; rpm: number }
  /** Hangs from a hinge on its parent and stays level while the parent turns (a ferris-wheel cabin). */
  | { kind: 'upright' }
  | { kind: 'pendulum'; axis: GridVec3; amplitudeDeg: number; periodS: number }
  | { kind: 'none' };

export interface SmartObjectSpecPart {
  name: string;
  /** Another part's name; absent means the static body. */
  parent?: string;
  box: GridBox;
  exclude?: GridBox[];
  /** Grid coordinates, may be fractional (cell centres are at +0.5). */
  pivot: GridVec3;
  motion: SmartObjectMotion;
  voxelCount?: number;
}

export interface SmartObjectSpecLight {
  name: string;
  position: GridVec3;
  /** `#rrggbb` */
  color: string;
  intensity?: number;
  distance?: number;
  flicker?: boolean;
  /** When set, the light rides this part. */
  part?: string;
}

/** The Forger's verdict, in master grid space. See the file header. */
export interface SmartObjectSpec {
  version: 1;
  grid: number;
  bounds?: GridBox;
  object?: string;
  parts: SmartObjectSpecPart[];
  lights: SmartObjectSpecLight[];
  /**
   * Inside a part's box, connected components smaller than this fraction of
   * the largest are body slivers the box clipped, not the part. The bake
   * applies the same rule the analysis did, so the two agree on every voxel.
   */
  minComponentFraction?: number;
  warnings?: string[];
  notes?: string;
  model?: string;
}

/** One part as the runtime sees it: pivot in metres, in the asset's own frame. */
export interface SmartObjectPartFitment {
  name: string;
  /** Another part's name; absent means the body. */
  parent?: string;
  /** Pivot in the asset frame (metres). A `spin` rotates about `motion.axis` through here. */
  pivot: Vector3Like;
  motion: SmartObjectMotion;
}

/**
 * Derived at bake and consumed by `SmartObjectSystem`. Lights are not here:
 * they go on `Asset.light` / `Asset.lights`, the emitter contract the engine
 * already has, so a lamp post lights the street through the same pool a torch
 * does.
 */
export interface SmartObjectFitment {
  version: 1;
  parts: SmartObjectPartFitment[];
  /**
   * The grid-space spec this was derived from, kept so a re-voxelize re-splits
   * without a new analysis. Absent on a PLACEHOLDER, whose parts come from its
   * own authored primitives (`SmartPropSpec`) and are re-derived from the GLB's
   * extras or the procedural `production.spec` on every bake instead.
   */
  source?: SmartObjectSpec;
}

/**
 * What a placeholder declares about itself, in its authored frame — the
 * engine's mirror of asset-core's `smartPropSpecSchema`. No boxes: the lane
 * that bakes it knows which primitives belong to which named part.
 */
export interface SmartPropPartSpec {
  name: string;
  parent?: string;
  motion: SmartObjectMotion;
  /** Authored frame. Default: the part's box centre (top centre for upright/pendulum). */
  pivot?: Vector3Like;
}

export interface SmartPropLightSpec {
  name: string;
  /** Placed at this part's pivot when no `position` is given. */
  part?: string;
  position?: Vector3Like;
  color: string;
  intensity?: number;
  distance?: number;
  flicker?: boolean;
}

export interface SmartPropSpec {
  parts: SmartPropPartSpec[];
  lights?: SmartPropLightSpec[];
}
