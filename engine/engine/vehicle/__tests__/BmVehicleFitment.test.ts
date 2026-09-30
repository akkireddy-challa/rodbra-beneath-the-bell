import {
  deriveVehicleFitment,
  isBmWheelNodeName,
  type AuthoredBounds,
} from 'engine/vehicle/BmVehicleFitment.js';

/** Sedan-like authored data (body centered on z=0, y=0 = ground plane). */
const SEDAN_BOUNDS: AuthoredBounds = {
  min: { x: -0.925, y: 0.16, z: -2.15 },
  max: { x: 0.925, y: 1.44, z: 2.15 },
};

function sedanExtras(): Record<string, unknown> {
  return {
    bmVehicle: {
      version: 1,
      axles: [
        { z: 1.3, y: 0.33, radius: 0.33, width: 0.22, track: 1.6, steering: true, driven: true, wheelStyle: 'alloy5' },
        { z: -1.3, y: 0.33, radius: 0.33, width: 0.22, track: 1.6, driven: true },
      ],
      collisionBoxes: [
        { position: { x: 0, y: 0.8, z: 0 }, size: { x: 1.7, y: 1.28, z: 4.2 } },
      ],
      mass: 1500,
      preferredVoxelSizeM: 0.08,
    },
  };
}

describe('deriveVehicleFitment', () => {
  test('returns null for plain assets (no extras / no bmVehicle / no axles)', () => {
    const opts = { bodyBounds: SEDAN_BOUNDS, hasWheelNodes: true };
    expect(deriveVehicleFitment(undefined, opts)).toBeNull();
    expect(deriveVehicleFitment({}, opts)).toBeNull();
    expect(deriveVehicleFitment({ bmVehicle: { axles: [] } }, opts)).toBeNull();
    expect(deriveVehicleFitment({ bmVehicle: 'nope' }, opts)).toBeNull();
  });

  test('sedan derivation: platform dims, axles kept, no warnings', () => {
    const result = deriveVehicleFitment(sedanExtras(), {
      bodyBounds: SEDAN_BOUNDS,
      hasWheelNodes: true,
    });
    expect(result).not.toBeNull();
    const { fitment, warnings } = result!;
    expect(warnings).toHaveLength(0);
    expect(fitment.platform.width).toBeCloseTo(1.85 * 0.96, 5);
    expect(fitment.platform.length).toBeCloseTo(4.3 * 0.96, 5);
    expect(fitment.axles).toHaveLength(2);
    expect(fitment.axles[0]!.z).toBeCloseTo(1.3, 5);
    expect(fitment.axles[0]!.steering).toBe(true);
    expect(fitment.axles[0]!.wheelStyle).toBe('alloy5');
    expect(fitment.axles[1]!.steering).toBe(false);
    expect(fitment.mass).toBe(1500);
    expect(fitment.hasWheelNodes).toBe(true);
    expect(fitment.preferredVoxelSizeM).toBeCloseTo(0.08, 5);
    expect(fitment.collisionBoxes).toHaveLength(1);
  });

  test('off-center body bounds re-center axles into the asset frame', () => {
    // Same sedan but the GLB bounds sit shifted +0.5 in z (e.g. a rear wing
    // was excluded from authoring symmetry).
    const shifted: AuthoredBounds = {
      min: { x: -0.925, y: 0.16, z: -1.65 },
      max: { x: 0.925, y: 1.44, z: 2.65 },
    };
    const result = deriveVehicleFitment(sedanExtras(), {
      bodyBounds: shifted,
      hasWheelNodes: false,
    })!;
    // zCenter = 0.5, so authored 1.3 → 0.8 in the re-centered asset frame.
    expect(result.fitment.axles[0]!.z).toBeCloseTo(0.8, 5);
    expect(result.fitment.bodyBounds.min[2]).toBeCloseTo(-2.15, 5);
    expect(result.fitment.bodyBounds.max[2]).toBeCloseTo(2.15, 5);
  });

  test('appliedScale rescales geometry and mass (volume)', () => {
    const half: AuthoredBounds = {
      min: { x: -0.4625, y: 0.08, z: -1.075 },
      max: { x: 0.4625, y: 0.72, z: 1.075 },
    };
    const result = deriveVehicleFitment(sedanExtras(), {
      bodyBounds: half,
      hasWheelNodes: false,
      appliedScale: 0.5,
    })!;
    expect(result.fitment.axles[0]!.radius).toBeCloseTo(0.165, 5);
    expect(result.fitment.axles[0]!.z).toBeCloseTo(0.65, 5);
    expect(result.fitment.mass).toBeCloseTo(1500 / 8, 5);
  });

  test('defaults + repairs: steering fallback, track derivation, axle clamp warning', () => {
    const extras = {
      bmVehicle: {
        axles: [
          { z: 0.6, radius: 0.3 },            // no y/width/track/steering
          { z: 99, radius: 0.3 },             // far outside the body span
          { z: -0.6, radius: -1 },            // unusable radius
        ],
      },
    };
    const bounds: AuthoredBounds = {
      min: { x: -0.8, y: 0.1, z: -1.5 },
      max: { x: 0.8, y: 1.2, z: 1.5 },
    };
    const result = deriveVehicleFitment(extras, { bodyBounds: bounds, hasWheelNodes: false })!;
    expect(result.fitment.axles).toHaveLength(2);
    // Frontmost usable axle gets steering by default.
    const front = result.fitment.axles.reduce((a, b) => (b.z > a.z ? b : a));
    expect(front.steering).toBe(true);
    // Track derived from body width minus tire width.
    expect(result.fitment.axles[0]!.track).toBeGreaterThan(1.0);
    expect(result.warnings.some((w) => w.includes('outside the body span'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('no usable radius'))).toBe(true);
    // Fallback collision box covers the body.
    expect(result.fitment.collisionBoxes).toHaveLength(1);
    expect(result.fitment.mass).toBeCloseTo(result.fitment.platform.width * result.fitment.platform.length * 50, 5);
  });
});

describe('isBmWheelNodeName', () => {
  test('matches the wheel node prefix only', () => {
    expect(isBmWheelNodeName('BM_wheel_FL')).toBe(true);
    expect(isBmWheelNodeName('BM_wheel_M1R')).toBe(true);
    expect(isBmWheelNodeName('BM_wheels')).toBe(false);
    expect(isBmWheelNodeName('wheel_FL')).toBe(false);
    expect(isBmWheelNodeName(undefined)).toBe(false);
  });
});
