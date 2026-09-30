import {
  downforceGravityScale,
  DEFAULT_DOWNFORCE_MODEL,
} from 'engine/vehicle/VehicleDownforce.js';
import { resolveVehicleHandling, HANDLING_DEFAULTS } from 'engine/vehicleHandling.js';
import { deriveVehicleFitment } from 'engine/vehicle/BmVehicleFitment.js';
import * as THREE from 'three';

/**
 * The complaint this exists for: after top speeds went up, cars crested hills and
 * flew for miles. A raycast vehicle has no aerodynamics, so a jump is purely
 * ballistic and its range grows with the SQUARE of speed. Downforce is the real
 * mechanism that counters it, and being a v² law it self-selects the fast case —
 * these tests pin down that slow driving is left alone.
 */

const DT = 1 / 60;
const G = 9.81;
const AIR = false;
const GROUND = true;

/**
 * Ballistic flight from the ground and back, integrated under whatever gravity
 * the downforce model asks for.
 * @returns horizontal distance covered before landing (metres).
 */
function jumpDistance(speed: number, liftoffSpeed: number, downforceG: number): number {
  let y = 0;
  let vy = liftoffSpeed;
  let distance = 0;
  for (let step = 0; step < 100_000; step++) {
    vy -= G * downforceGravityScale(speed, downforceG, AIR) * DT;
    y += vy * DT;
    distance += speed * DT;
    if (y <= 0) break;
  }
  return distance;
}

describe('VehicleDownforce', () => {
  it('produces exactly its rated load at the reference speed', () => {
    const { referenceSpeed, groundedFraction } = DEFAULT_DOWNFORCE_MODEL;
    // A coefficient of 1 means "one car weight of load" — gravity doubles in air.
    expect(downforceGravityScale(referenceSpeed, 1, AIR)).toBeCloseTo(2, 6);
    expect(downforceGravityScale(referenceSpeed, 1, GROUND)).toBeCloseTo(1 + groundedFraction, 6);
  });

  it('grows with the SQUARE of speed', () => {
    // All below the cap, which is exercised separately.
    const half = downforceGravityScale(15, 1, AIR) - 1;
    const full = downforceGravityScale(30, 1, AIR) - 1;
    const overSpeed = downforceGravityScale(45, 1, AIR) - 1;
    expect(half).toBeCloseTo(full / 4, 6);          // half the speed → a quarter of the load
    expect(overSpeed).toBeCloseTo(full * 2.25, 6);  // 1.5× the speed → 2.25× the load
  });

  it('does nothing at a standstill or crawling pace', () => {
    expect(downforceGravityScale(0, 1, AIR)).toBe(1);
    // 4 m/s: under 2% of the car's weight — invisible, as it should be.
    expect(downforceGravityScale(4, 1, AIR)).toBeLessThan(1.02);
  });

  it('caps the load so a very fast car cannot bury itself', () => {
    const { maxG } = DEFAULT_DOWNFORCE_MODEL;
    // Uncapped, a 3.0-coefficient racer at 100 m/s would make 33 g.
    expect(downforceGravityScale(100, 3, AIR)).toBeCloseTo(1 + maxG, 6);
  });

  it('applies only a share of the load while the suspension can react it', () => {
    const { groundedFraction } = DEFAULT_DOWNFORCE_MODEL;
    const air = downforceGravityScale(40, 1.5, AIR) - 1;
    const ground = downforceGravityScale(40, 1.5, GROUND) - 1;
    expect(ground).toBeCloseTo(air * groundedFraction, 6);
    expect(ground).toBeGreaterThan(0); // still presses the tyres down for grip
  });

  it('is inert for a car with no downforce', () => {
    for (const speed of [0, 10, 30, 60, 120]) {
      expect(downforceGravityScale(speed, 0, AIR)).toBe(1);
      expect(downforceGravityScale(speed, 0, GROUND)).toBe(1);
    }
  });

  it('shrugs off a non-finite velocity', () => {
    expect(downforceGravityScale(NaN, 1, AIR)).toBe(1);
    expect(downforceGravityScale(Infinity, 1, AIR)).toBe(1);
  });

  // --- the behaviour the user actually reported -----------------------------

  it('roughly halves a jump taken too fast, but leaves it a jump', () => {
    // 30 m/s (108 km/h) off a crest with 12 m/s of lift — "keeps flying and goes
    // really far". Ballistic, this covers ~73 m.
    const ballistic = jumpDistance(30, 12, 0);
    const withAero = jumpDistance(30, 12, HANDLING_DEFAULTS.downforceG);
    expect(ballistic).toBeGreaterThan(60);
    expect(withAero).toBeLessThan(ballistic * 0.6);
    expect(withAero).toBeGreaterThan(ballistic * 0.3); // still airborne, not a brick
  });

  it('barely touches the same jump taken slowly', () => {
    // The whole point of a v² law: this is the deliberate, fun jump. Same lift,
    // a third of the speed.
    const ballistic = jumpDistance(10, 12, 0);
    const withAero = jumpDistance(10, 12, HANDLING_DEFAULTS.downforceG);
    expect(withAero).toBeGreaterThan(ballistic * 0.85);
  });

  it('separates a winged racer from a kart at the same speed', () => {
    // "Some other cars don't have as much downforce."
    const racer = jumpDistance(35, 10, 2.5);
    const kart = jumpDistance(35, 10, 0.3);
    expect(racer).toBeLessThan(kart * 0.55);
  });

  // --- plumbing -------------------------------------------------------------

  it('survives the bmVehicle asset parser, which drops unknown fields', () => {
    // A designed vehicle's downforce passes through several whitelists on its way
    // to the engine, each of which silently discards anything it does not name.
    // This is the one the AI-authored asset actually goes through.
    const derive = (downforce: unknown) => deriveVehicleFitment(
      {
        bmVehicle: {
          axles: [{ z: 1.2, halfTrack: 0.8, radius: 0.34, width: 0.25, steering: true, drive: true }],
          handling: { topSpeed: 50, downforce },
        },
      },
      {
        bodyBounds: {
          min: new THREE.Vector3(-0.9, 0, -2),
          max: new THREE.Vector3(0.9, 1.2, 2),
        },
        hasWheelNodes: false,
      },
    )?.fitment.handling;

    expect(derive(2.5)?.downforce).toBe(2.5);
    expect(derive(0)?.downforce).toBe(0);           // an explicit "no aero" must not be lost
    expect(derive(99)?.downforce).toBe(4);          // clamped, not dropped
    expect(derive(undefined)?.downforce).toBeUndefined(); // absent → engine default
    expect(derive(2.5)?.topSpeed).toBe(50);         // sanity: the row really parsed
  });

  it('reaches the vehicle through handling, per car and unscaled by size', () => {
    expect(resolveVehicleHandling(undefined, 1).downforceG).toBe(HANDLING_DEFAULTS.downforceG);
    expect(resolveVehicleHandling({ downforce: 2.5 }, 1).downforceG).toBe(2.5);
    expect(resolveVehicleHandling({ downforce: 0 }, 1).downforceG).toBe(0);
    // Aero load is already per unit of the car's own weight, so a quarter-scale
    // kart must not inherit a quarter of the coefficient.
    expect(resolveVehicleHandling({ downforce: 2 }, 0.25).downforceG).toBe(2);
    expect(resolveVehicleHandling(undefined, 0.25).downforceG).toBe(HANDLING_DEFAULTS.downforceG);
  });
});
