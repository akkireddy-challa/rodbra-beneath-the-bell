/**
 * VehicleAssetFitment — the derived, validated vehicle data stored on an
 * Asset record when its source GLB carries the `bmVehicle` scene extras.
 *
 * All coordinates are in the ASSET frame: +Z forward, +Y up, meters, X/Z
 * centered on the (wheel-excluded) body bounds, y = 0 = ground contact
 * plane. This is authored-frame data — chassis-space mapping (suspension
 * mounts, body lift) happens in VehicleSpawner at spawn time so it can
 * evolve without re-importing assets. Derivation + validation live in
 * `engine/vehicle/BmVehicleFitment.ts`.
 */

export type BmWheelStyle = 'steel' | 'alloy5' | 'alloy6' | 'lug' | 'moon' | 'classic';

export interface VehicleFitmentAxle {
  /** Axle center, asset frame (z: body-centered, y: height above ground). */
  z: number;
  y: number;
  radius: number;
  /** Tire width. */
  width: number;
  /** Wheel-center to wheel-center. */
  track: number;
  steering: boolean;
  driven: boolean;
  dual: boolean;
  /** Wheel look when the source GLB has no BM_wheel_* nodes. */
  wheelStyle: BmWheelStyle;
}

export interface VehicleFitmentBox {
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
}

export interface VehicleAssetFitment {
  version: 1;
  /** Drives the auto-configured platform base (width/length). */
  platform: { width: number; length: number };
  axles: VehicleFitmentAxle[];
  /**
   * Asset-frame body AABB, wheel nodes excluded.
   *
   * The tuples are worth keeping for engine code, but they do NOT survive a round trip through
   * world.json: this fitment is stored on the `Asset` record, and tsc infers `number[]` from a
   * JSON array, which is not COMPARABLE to a 3-tuple. That is why `bundle/WorldDataLoader.ts`
   * casts world.json through `unknown` — a checked cast there stops compiling the moment a game
   * holds a vehicle asset, in a file no creator or coding agent may edit. Tuples anywhere else in
   * GameData-reachable types are safe only because of that cast; the ajv schema generated from
   * these types cannot see the problem, since it validates values and a 3-element array is valid.
   */
  bodyBounds: { min: [number, number, number]; max: [number, number, number] };
  /** Source GLB ships BM_wheel_* nodes (else wheels are engine-parametric). */
  hasWheelNodes: boolean;
  /**
   * The source GLB carried a forge `spec`, so its BM_wheel_* meshes were themselves built
   * parametrically from the axles above — same styles, same constants, same proportions as
   * `VehicleWheelBuilder`. The runtime can therefore rebuild those wheels EXACTLY and skip
   * downloading the GLB, which for a voxel kart is ~200 KB fetched to recover four wheels
   * beside a 3 KB chassis.
   *
   * Absent for a hand-authored GLB (Blender), whose wheel meshes are arbitrary art that no
   * parameter set reproduces — those must keep loading the GLB. Optional because assets
   * imported before this existed carry no answer, and "unknown" has to mean "fetch it".
   */
  wheelsFromSpec?: boolean;
  /**
   * Tire colour from the spec's paint, when it overrides the default. Only meaningful with
   * `wheelsFromSpec`; absent means the shared default, which the forge and the engine
   * already agree on (#16181c both sides).
   */
  tireColor?: string;
  collisionBoxes: VehicleFitmentBox[];
  mass: number;
  handling?: { topSpeed?: number; accelerationScale?: number; maxSteerAngle?: number; downforce?: number };
  preferredVoxelSizeM?: number;
  /** Reserved for future visible-driver work. */
  seat?: { x: number; y: number; z: number };
}
