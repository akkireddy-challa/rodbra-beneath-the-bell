import {
  SUSPENSION_MAX_TRAVEL_FRACTION,
  WHEEL_GUARD_GROUND_CLEARANCE_FRACTION,
  wheelGuardBox,
  type WheelGuardInput,
} from 'engine/vehicle/WheelGuards.js';

/** A sedan front wheel as VehicleSpawner.spawnFromAsset builds it. */
const SEDAN_WHEEL: WheelGuardInput = {
  position: { x: 0.8, y: 0.315, z: 1.3 },
  radius: 0.33,
  width: 0.22,
  suspensionRestLength: 0.594,
};

/** Chassis-local Y of the wheel's contact patch at a given suspension length. */
function contactPatchY(wheel: WheelGuardInput, suspensionLength: number): number {
  return wheel.position.y - suspensionLength - wheel.radius;
}

describe('wheelGuardBox', () => {
  test('covers the tyre it stands in — full width, most of its height', () => {
    const guard = wheelGuardBox(SEDAN_WHEEL)!;
    expect(guard).not.toBeNull();
    // Full tyre width, centered on the wheel: the outer face is the tyre's.
    expect(guard.size.width).toBeCloseTo(SEDAN_WHEEL.width);
    expect(guard.position.x).toBeCloseTo(SEDAN_WHEEL.position.x);
    expect(guard.position.z).toBeCloseTo(SEDAN_WHEEL.position.z);
    // Height: everything but the bottom slice held back for ground clearance.
    expect(guard.size.height).toBeCloseTo(
      SEDAN_WHEEL.radius * (2 - WHEEL_GUARD_GROUND_CLEARANCE_FRACTION),
    );
    // Length stays inside the tyre silhouette so it can't catch on a step.
    expect(guard.size.length).toBeLessThan(SEDAN_WHEEL.radius * 2);
  });

  test('clears the ground even with the suspension fully compressed', () => {
    const guard = wheelGuardBox(SEDAN_WHEEL)!;
    const guardBottom = guard.position.y - guard.size.height / 2;
    const shortest = SEDAN_WHEEL.suspensionRestLength * (1 - SUSPENSION_MAX_TRAVEL_FRACTION);
    // Worst case: the chassis at its lowest, so the ground at its highest.
    expect(guardBottom).toBeGreaterThan(contactPatchY(SEDAN_WHEEL, shortest));
    expect(guardBottom - contactPatchY(SEDAN_WHEEL, shortest))
      .toBeCloseTo(SEDAN_WHEEL.radius * WHEEL_GUARD_GROUND_CLEARANCE_FRACTION);
    // And by a wider margin at rest, where the car actually drives.
    expect(guardBottom).toBeGreaterThan(
      contactPatchY(SEDAN_WHEEL, SEDAN_WHEEL.suspensionRestLength),
    );
  });

  test('a big soft-sprung wheel still clears the ground', () => {
    // Monster-truck proportions: the long spring is what would sink a guard
    // placed off the wheel's resting position instead of its compressed one.
    const wheel: WheelGuardInput = {
      position: { x: 1.4, y: 0.9, z: 1.8 },
      radius: 0.8,
      width: 0.55,
      suspensionRestLength: 1.2,
    };
    const guard = wheelGuardBox(wheel)!;
    const guardBottom = guard.position.y - guard.size.height / 2;
    const shortest = wheel.suspensionRestLength * (1 - SUSPENSION_MAX_TRAVEL_FRACTION);
    expect(guardBottom).toBeGreaterThan(contactPatchY(wheel, shortest));
  });

  test('mirrored wheels give mirrored guards', () => {
    const left = wheelGuardBox(SEDAN_WHEEL)!;
    const right = wheelGuardBox({
      ...SEDAN_WHEEL,
      position: { ...SEDAN_WHEEL.position, x: -SEDAN_WHEEL.position.x },
    })!;
    expect(right.position.x).toBeCloseTo(-left.position.x);
    expect(right.position.y).toBeCloseTo(left.position.y);
    expect(right.size).toEqual(left.size);
  });

  test('zero suspension travel is fine — the guard hangs off the mount', () => {
    const guard = wheelGuardBox({ ...SEDAN_WHEEL, suspensionRestLength: 0 })!;
    const guardBottom = guard.position.y - guard.size.height / 2;
    expect(guardBottom).toBeGreaterThan(contactPatchY({ ...SEDAN_WHEEL, suspensionRestLength: 0 }, 0));
  });

  test('a degenerate wheel yields no guard rather than a zero-size collider', () => {
    expect(wheelGuardBox({ ...SEDAN_WHEEL, radius: 0 })).toBeNull();
    expect(wheelGuardBox({ ...SEDAN_WHEEL, width: 0 })).toBeNull();
    expect(wheelGuardBox({ ...SEDAN_WHEEL, radius: -1 })).toBeNull();
  });
});
