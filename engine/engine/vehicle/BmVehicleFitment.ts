/**
 * bmVehicle GLB extension — engine-side parsing, validation, and fitment
 * derivation.
 *
 * A vehicle GLB carries `scene.extras.bmVehicle` (authored frame: +Z
 * forward, +Y up, meters, y = 0 = ground contact plane, body length
 * centered on z = 0) plus wheel meshes in nodes named `BM_wheel_*`. This
 * module turns those extras + the wheel-excluded body bounds into the
 * `VehicleAssetFitment` stored on the asset record. It is PURE (no THREE,
 * no engine state) so it unit-tests headlessly and can run in any import
 * path.
 *
 * Validation is warnings-first: a malformed field is repaired with a note;
 * derivation returns null only when there is no usable vehicle at all
 * (missing / wrong-shaped extras, zero usable axles) — the caller then
 * treats the GLB as a plain asset, never an error.
 */

import type {
  BmWheelStyle,
  VehicleAssetFitment,
  VehicleFitmentAxle,
  VehicleFitmentBox,
} from 'types/vehicleFitment.js';

export const BM_VEHICLE_EXTRAS_KEY = 'bmVehicle';
export const BM_WHEEL_NODE_PREFIX = 'BM_wheel_';

export interface FitmentDerivation {
  fitment: VehicleAssetFitment;
  warnings: string[];
}

export interface AuthoredBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface DeriveFitmentOptions {
  /** Wheel-excluded model bounds in the GLB's (possibly pre-scaled) frame. */
  bodyBounds: AuthoredBounds;
  /** Source GLB ships BM_wheel_* nodes. */
  hasWheelNodes: boolean;
  /**
   * Uniform scale the import applied to the model (fitBox / targetHeight /
   * cm auto-detection). Extras are authored in the ORIGINAL frame, so all
   * axle geometry is multiplied by this. Default 1.
   */
  appliedScale?: number;
}

// ── Tolerant readers ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function readVec3(v: unknown): { x: number; y: number; z: number } | undefined {
  if (!isRecord(v)) return undefined;
  const x = finiteNumber(v.x);
  const y = finiteNumber(v.y);
  const z = finiteNumber(v.z);
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return { x, y, z };
}

const WHEEL_STYLES: readonly BmWheelStyle[] = ['steel', 'alloy5', 'alloy6', 'lug', 'moon', 'classic'];

function readWheelStyle(v: unknown): BmWheelStyle {
  return typeof v === 'string' && (WHEEL_STYLES as readonly string[]).includes(v)
    ? (v as BmWheelStyle)
    : 'steel';
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * Read `extras.bmVehicle` from a GLB scene-extras object and derive the
 * asset fitment. `sceneExtras` is whatever the import path found at
 * `scenes[0].extras` (or `gltf.scene.userData`).
 */
/** Shared with the forge's DEFAULT_RUBBER_COLOR and VehicleWheelBuilder's TIRE_COLOR. */
const DEFAULT_TIRE_COLOR = '#16181c';

export function deriveVehicleFitment(
  sceneExtras: unknown,
  options: DeriveFitmentOptions,
): FitmentDerivation | null {
  if (!isRecord(sceneExtras)) return null;
  const raw = sceneExtras[BM_VEHICLE_EXTRAS_KEY];
  if (!isRecord(raw)) return null;
  const rawAxles = Array.isArray(raw.axles) ? raw.axles : [];
  if (rawAxles.length === 0) return null;

  const warnings: string[] = [];
  const scale = options.appliedScale !== undefined && options.appliedScale > 0
    ? options.appliedScale
    : 1;
  const { bodyBounds } = options;
  const bodyWidth = Math.max(bodyBounds.max.x - bodyBounds.min.x, 0.3);
  const bodyLength = Math.max(bodyBounds.max.z - bodyBounds.min.z, 0.5);
  const zCenter = (bodyBounds.max.z + bodyBounds.min.z) / 2;
  const xCenter = (bodyBounds.max.x + bodyBounds.min.x) / 2;

  const axles: VehicleFitmentAxle[] = [];
  rawAxles.slice(0, 8).forEach((entry, i) => {
    if (!isRecord(entry)) {
      warnings.push(`bmVehicle: axle ${i} is not an object — skipped.`);
      return;
    }
    const rawRadius = finiteNumber(entry.radius);
    if (rawRadius === undefined || rawRadius <= 0) {
      warnings.push(`bmVehicle: axle ${i} has no usable radius — skipped.`);
      return;
    }
    const radius = clamp(rawRadius * scale, 0.03, 3);
    const rawZ = finiteNumber(entry.z);
    if (rawZ === undefined) {
      warnings.push(`bmVehicle: axle ${i} has no z — skipped.`);
      return;
    }
    // Authored z, scaled and re-centered into the asset frame.
    let z = rawZ * scale - zCenter;
    const zLo = bodyBounds.min.z - zCenter + radius * 0.4;
    const zHi = bodyBounds.max.z - zCenter - radius * 0.4;
    if (z < zLo || z > zHi) {
      const fixed = clamp(z, zLo, zHi);
      warnings.push(`bmVehicle: axle ${i} z=${z.toFixed(2)} outside the body span — clamped to ${fixed.toFixed(2)}.`);
      z = fixed;
    }
    const width = clamp((finiteNumber(entry.width) ?? rawRadius * 0.6) * scale, 0.03, 1.4);
    const y = clamp((finiteNumber(entry.y) ?? rawRadius) * scale, radius * 0.5, radius * 2);
    const track = clamp(
      (finiteNumber(entry.track) ?? 0) * scale || Math.max(bodyWidth - width * 1.05, width * 1.4),
      width * 1.2,
      bodyWidth * 2.5,
    );
    axles.push({
      z,
      y,
      radius,
      width,
      track,
      steering: typeof entry.steering === 'boolean' ? entry.steering : false,
      driven: typeof entry.driven === 'boolean' ? entry.driven : true,
      dual: entry.dual === true,
      wheelStyle: readWheelStyle(entry.wheelStyle),
    });
  });
  if (axles.length === 0) return null;
  if (!axles.some((a) => a.steering)) {
    // Default: frontmost axle steers (highest z = front, +Z forward).
    const front = axles.reduce((best, a) => (a.z > best.z ? a : best));
    front.steering = true;
  }

  const platform = {
    width: clamp(bodyWidth * 0.96, 0.4, 6),
    length: clamp(bodyLength * 0.96, 0.6, 30),
  };

  // Collision boxes: authored (scaled + re-centered) or one body-bounds box.
  const collisionBoxes: VehicleFitmentBox[] = [];
  if (Array.isArray(raw.collisionBoxes)) {
    for (const entry of raw.collisionBoxes.slice(0, 12)) {
      if (!isRecord(entry)) continue;
      const position = readVec3(entry.position);
      const size = readVec3(entry.size);
      if (!position || !size || size.x <= 0 || size.y <= 0 || size.z <= 0) continue;
      collisionBoxes.push({
        position: {
          x: position.x * scale - xCenter,
          y: position.y * scale,
          z: position.z * scale - zCenter,
        },
        size: { x: size.x * scale, y: size.y * scale, z: size.z * scale },
      });
    }
  }
  if (collisionBoxes.length === 0) {
    collisionBoxes.push({
      position: {
        x: 0,
        y: (bodyBounds.min.y + bodyBounds.max.y) / 2,
        z: 0,
      },
      size: {
        x: bodyWidth * 0.92,
        y: Math.max(bodyBounds.max.y - bodyBounds.min.y, 0.2),
        z: bodyLength * 0.94,
      },
    });
    if (Array.isArray(raw.collisionBoxes) && raw.collisionBoxes.length > 0) {
      warnings.push('bmVehicle: collisionBoxes were unusable — replaced with a body-bounds box.');
    }
  }

  // Mass scales with volume when the model was rescaled at import.
  const authoredMass = finiteNumber(raw.mass);
  const mass = authoredMass !== undefined && authoredMass > 5
    ? clamp(authoredMass * scale * scale * scale, 20, 100_000)
    : platform.width * platform.length * 50; // createPlatform's own default rule

  const fitment: VehicleAssetFitment = {
    version: 1,
    platform,
    axles,
    bodyBounds: {
      min: [bodyBounds.min.x - xCenter, bodyBounds.min.y, bodyBounds.min.z - zCenter],
      max: [bodyBounds.max.x - xCenter, bodyBounds.max.y, bodyBounds.max.z - zCenter],
    },
    hasWheelNodes: options.hasWheelNodes,
    collisionBoxes,
    mass,
  };

  // A forge-generated GLB embeds the spec it was built from. That is the signal that its
  // wheel meshes came from these very axles rather than from an artist, and so that the
  // runtime may rebuild them instead of downloading the GLB to get them back.
  const spec = isRecord(raw.spec) ? raw.spec : null;
  if (spec) {
    fitment.wheelsFromSpec = true;
    const paint = isRecord(spec.paint) ? spec.paint : null;
    const rubber = paint && typeof paint.rubber === 'string' ? paint.rubber : null;
    // Only when it OVERRIDES the default — carrying the default around would imply a
    // decision nobody made, and the two sides already agree on it.
    if (rubber && rubber.toLowerCase() !== DEFAULT_TIRE_COLOR) fitment.tireColor = rubber;
  }

  if (isRecord(raw.handling)) {
    const topSpeed = finiteNumber(raw.handling.topSpeed);
    const accelerationScale = finiteNumber(raw.handling.accelerationScale);
    const maxSteerAngle = finiteNumber(raw.handling.maxSteerAngle);
    const downforce = finiteNumber(raw.handling.downforce);
    const handling: VehicleAssetFitment['handling'] = {};
    if (topSpeed !== undefined) handling.topSpeed = clamp(topSpeed, 2, 150);
    if (accelerationScale !== undefined) handling.accelerationScale = clamp(accelerationScale, 0.1, 5);
    if (maxSteerAngle !== undefined) handling.maxSteerAngle = clamp(maxSteerAngle, 0.05, 1.2);
    if (downforce !== undefined) handling.downforce = clamp(downforce, 0, 4);
    if (Object.keys(handling).length > 0) fitment.handling = handling;
  }
  const voxel = finiteNumber(raw.preferredVoxelSizeM);
  if (voxel !== undefined) fitment.preferredVoxelSizeM = clamp(voxel, 0.02, 0.5);
  const seat = readVec3(raw.seat);
  if (seat) {
    fitment.seat = {
      x: seat.x * scale - xCenter,
      y: seat.y * scale,
      z: seat.z * scale - zCenter,
    };
  }

  return { fitment, warnings };
}

/** Whether a GLB node name marks a wheel mesh (stripped from body bakes). */
export function isBmWheelNodeName(name: string | undefined): boolean {
  return typeof name === 'string' && name.startsWith(BM_WHEEL_NODE_PREFIX);
}
