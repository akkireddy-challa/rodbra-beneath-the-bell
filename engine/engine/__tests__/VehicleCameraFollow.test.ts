import * as THREE from 'three';
import { VehicleCamera } from 'engine/VehicleCamera.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';

/**
 * Chase-camera behaviour on terrain: it must never end up inside the ground
 * (driving downhill puts rising terrain exactly where the chase position wants
 * to sit), a steep hill behind should push it UP rather than into the slope, a
 * roof overhead must not, a drop should lift it, and trimming the wheel must not
 * whip the view.
 */

const DT = 1 / 60;

/** DOM stub — the camera only attaches listeners and sets a cursor. */
function domStub(): HTMLElement {
  return {
    addEventListener: () => {},
    removeEventListener: () => {},
    style: {},
  } as unknown as HTMLElement;
}

interface RayHit {
  hasHit: boolean;
  hitPoint: THREE.Vector3;
  hitDistance: number;
  hitRigidBody: { isFixed: () => boolean } | null;
}

const miss = (): RayHit => ({
  hasHit: false, hitPoint: new THREE.Vector3(), hitDistance: 0, hitRigidBody: null,
});

/**
 * A world defined by which points are solid, ray-marched for the first SURFACE
 * CROSSING. Two things make it faithful where a vertical-probe-only stub is not:
 * it blocks the line-of-sight tests the camera actually relies on, and — like a
 * real trimesh — a ray that starts inside solid reports nothing until it exits,
 * so "buried" cannot be papered over with a hit at distance zero.
 *
 * `group` is the collision group the world registers on. Baked (`.vwld`) levels
 * put their whole world — road, hills, tunnels — on ENVIRONMENT, so that is the
 * default: a camera that probes TERRAIN alone sees an empty world here, exactly
 * as it did in the game.
 */
function engineWithSolid(
  isSolid: (p: THREE.Vector3) => boolean,
  group: number = CollisionGroup.ENVIRONMENT,
): unknown {
  const at = (origin: THREE.Vector3, direction: THREE.Vector3, t: number): THREE.Vector3 =>
    origin.clone().addScaledVector(direction, t);

  return {
    physicsWorld: {
      raycast: (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, mask: number) => {
        if ((mask & group) === 0) return miss();
        const step = 0.1;
        let prevT = 0;
        let prevSolid = isSolid(at(origin, direction, 0));
        for (let t = step; t <= maxDistance + step; t += step) {
          const clamped = Math.min(t, maxDistance);
          if (isSolid(at(origin, direction, clamped)) !== prevSolid) {
            // Bisect down to ~1.5 mm so probe results are surface-accurate.
            let lo = prevT;
            let hi = clamped;
            for (let i = 0; i < 6; i++) {
              const mid = (lo + hi) / 2;
              if (isSolid(at(origin, direction, mid)) === prevSolid) lo = mid; else hi = mid;
            }
            return {
              hasHit: true,
              hitPoint: at(origin, direction, hi),
              hitDistance: hi,
              hitRigidBody: { isFixed: () => true },
            };
          }
          prevT = clamped;
          if (clamped >= maxDistance) break;
        }
        return miss();
      },
    },
  };
}

/** Engine whose world is a flat floor at `groundY`; `null` = open space, no world at all. */
function engineWithFloor(groundY: number | null): unknown {
  if (groundY === null) return engineWithSolid(() => false);
  return engineWithSolid((p) => p.y < groundY);
}

function makeCamera(groundY: number | null) {
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
  const target = new THREE.Object3D();
  target.updateMatrixWorld(true);
  const vehicleCamera = new VehicleCamera(camera, target, domStub(), engineWithFloor(groundY), 1);
  return { camera, target, vehicleCamera };
}

/** Move the vehicle and step the camera, keeping matrices current. */
function drive(
  target: THREE.Object3D,
  vehicleCamera: VehicleCamera,
  frames: number,
  perFrame: (t: THREE.Object3D, i: number) => void,
): void {
  for (let i = 0; i < frames; i++) {
    perFrame(target, i);
    target.updateMatrixWorld(true);
    vehicleCamera.update(DT);
  }
}

describe('VehicleCamera terrain handling', () => {
  it('never sinks below the ground when the vehicle drops into a pit', () => {
    const { camera, target, vehicleCamera } = makeCamera(0);
    // Vehicle descends well below the surrounding floor; the naive chase point
    // (vehicleY + height) would be underground for most of the run.
    let lowest = Infinity;
    drive(target, vehicleCamera, 180, (t, i) => {
      t.position.set(0, -i * 0.08, i * 0.2);
    });
    // Sample the settled state over more frames.
    drive(target, vehicleCamera, 60, (t) => {
      lowest = Math.min(lowest, camera.position.y);
      t.position.y -= 0.08;
      t.position.z += 0.2;
    });
    expect(lowest).toBeGreaterThan(0); // strictly above the floor
  });

  it('climbs out when it starts BURIED deep below the surface', () => {
    // The real failure: off-track down a steep hill left the camera metres under
    // the terrain. A probe that only looks a little way up starts underground
    // too, finds nothing (a downward ray cannot see the surface above it), so
    // the clamp switches off and the camera stays buried — a latching failure,
    // not a dip. Spawning 40 m under a floor at y=0 reproduces it.
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
    const target = new THREE.Object3D();
    target.position.set(0, -40, 0);
    target.updateMatrixWorld(true);
    const vehicleCamera = new VehicleCamera(camera, target, domStub(), engineWithFloor(0), 1);

    // Already above ground on the very first frame — the snap is clamped too.
    expect(camera.position.y).toBeGreaterThan(0);

    drive(target, vehicleCamera, 60, (t) => { t.position.z += 0.1; });
    expect(camera.position.y).toBeGreaterThan(0);
  });

  it('holds the floor on a frame whose ground probe finds nothing', () => {
    // Off the edge of the terrain, a hole in the collider, a physics hiccup —
    // any missed sample. Skipping the clamp on those frames is what let the
    // camera sink and stay sunk; the last known ground must keep holding.
    let probesAllowed = true;
    const engine = {
      physicsWorld: {
        raycast: (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) => {
          const miss = { hasHit: false, hitPoint: new THREE.Vector3(), hitDistance: 0, hitRigidBody: null };
          if (!probesAllowed || direction.y > -0.99) return miss;
          const distance = origin.y - 0;
          if (distance < 0 || distance > maxDistance) return miss;
          return {
            hasHit: true,
            hitPoint: new THREE.Vector3(origin.x, 0, origin.z),
            hitDistance: distance,
            hitRigidBody: { isFixed: () => true },
          };
        },
      },
    };
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
    const target = new THREE.Object3D();
    target.updateMatrixWorld(true);
    const vehicleCamera = new VehicleCamera(camera, target, domStub(), engine, 1);

    drive(target, vehicleCamera, 60, (t) => { t.position.z += 0.2; });
    probesAllowed = false; // every probe misses from here on
    drive(target, vehicleCamera, 240, (t) => { t.position.y -= 0.3; t.position.z += 0.2; });

    expect(camera.position.y).toBeGreaterThan(0);
  });

  it('rides higher while descending than while level (drop exaggeration)', () => {
    // No ground, so only the descent boost moves the camera vertically.
    const level = makeCamera(null);
    drive(level.target, level.vehicleCamera, 120, (t) => { t.position.z += 0.3; });
    const levelHeight = level.camera.position.y - level.target.position.y;

    const falling = makeCamera(null);
    drive(falling.target, falling.vehicleCamera, 120, (t) => {
      t.position.z += 0.3;
      t.position.y -= 0.25; // ~15 m/s descent
    });
    const fallingHeight = falling.camera.position.y - falling.target.position.y;

    expect(fallingHeight).toBeGreaterThan(levelHeight + 0.5);
  });

  it('eases back down once the descent ends', () => {
    const { camera, target, vehicleCamera } = makeCamera(null);
    drive(target, vehicleCamera, 120, (t) => { t.position.y -= 0.25; t.position.z += 0.3; });
    const boosted = camera.position.y - target.position.y;
    drive(target, vehicleCamera, 240, (t) => { t.position.z += 0.3; }); // level out
    const settled = camera.position.y - target.position.y;
    expect(settled).toBeLessThan(boosted - 0.5);
  });

  // The world behind a car is a hill in these two: flat where the car stands
  // (z >= 0), rising 3:1 behind it, which puts the resting chase point ~24 m
  // inside the slope. Both collision groups are exercised because BAKED (.vwld)
  // levels — every forged track — register their entire world on ENVIRONMENT
  // while the legacy procedural voxel world uses TERRAIN; probing only one of
  // them made the camera blind to the ground on half the games in existence.
  const hillHeight = (z: number): number => (z >= 0 ? 0 : Math.min(40, -3 * z));

  for (const [label, group] of [
    ['a baked ENVIRONMENT world', CollisionGroup.ENVIRONMENT],
    ['a procedural TERRAIN world', CollisionGroup.TERRAIN],
  ] as const) {
    it(`climbs a steep hill behind the car instead of sitting inside it — ${label}`, () => {
      const engine = engineWithSolid((p) => p.y < hillHeight(p.z), group);
      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
      const target = new THREE.Object3D();
      target.updateMatrixWorld(true);
      const vehicleCamera = new VehicleCamera(camera, target, domStub(), engine, 1);

      // Car parked at the foot of the slope, so the hill stays right behind it.
      drive(target, vehicleCamera, 120, () => {});

      // Above the terrain, with air to spare — not scraping through it.
      expect(camera.position.y).toBeGreaterThan(hillHeight(camera.position.z) + 0.5);
      // It climbed rather than collapsing onto the bumper: the raise keeps the
      // distance to the car, the pull-in fallback would have thrown it away.
      expect(camera.position.distanceTo(target.position)).toBeGreaterThan(5);
      expect(camera.position.y).toBeGreaterThan(5);
    });
  }

  it('stays clear of the ground all the way over rolling hills', () => {
    // The end-to-end guarantee, driven rather than posed: 350 m of sinusoidal
    // terrain at ~21 m/s, crests and dips included, with the camera never once
    // below the surface it is flying over.
    const h = (z: number) => 6 * Math.sin(z / 12);
    const engine = engineWithSolid((p) => p.y < h(p.z));
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
    const target = new THREE.Object3D();
    target.position.set(0, h(0), 0);
    target.updateMatrixWorld(true);
    const vehicleCamera = new VehicleCamera(camera, target, domStub(), engine, 1);

    let worst = Infinity;
    drive(target, vehicleCamera, 1000, (t) => {
      t.position.z += 0.35;
      t.position.y = h(t.position.z);
    });
    drive(target, vehicleCamera, 1000, (t) => {
      worst = Math.min(worst, camera.position.y - h(camera.position.z));
      t.position.z += 0.35;
      t.position.y = h(t.position.z);
    });

    expect(worst).toBeGreaterThan(0);
  });

  it('ignores a post that sweeps through the line for a couple of frames', () => {
    // Fence posts, trees, the start-arch beam: things that block the view of the
    // car for two or three frames and are gone. Reacting to those threw the
    // camera 3.6 m into the air in a single frame and dropped it back — every
    // lap, at the start line. Posts every 4 m, dead centre behind the car (a
    // worse case than any real track), must not move it at all.
    const post = (p: THREE.Vector3) => {
      const zMod = ((p.z % 4) + 4) % 4;
      return p.y < 2 && zMod < 0.5 && Math.abs(p.x) < 0.3;
    };
    const engine = engineWithSolid((p) => p.y < 0 || post(p));
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
    const target = new THREE.Object3D();
    target.updateMatrixWorld(true);
    const vehicleCamera = new VehicleCamera(camera, target, domStub(), engine, 1);

    drive(target, vehicleCamera, 60, (t) => { t.position.z += 0.4; }); // settle
    let maxJump = 0;
    let prevHeight = camera.position.y - target.position.y;
    drive(target, vehicleCamera, 300, (t) => {
      t.position.z += 0.4; // 24 m/s
      const height = camera.position.y - target.position.y;
      maxJump = Math.max(maxJump, Math.abs(height - prevHeight));
      prevHeight = height;
    });

    expect(maxJump).toBeLessThan(0.05);
  });

  it('stays under a roof overhead instead of being shoved through it', () => {
    // A bridge deck / tunnel roof over the track. A ground probe that starts
    // ABOVE the camera reports the deck as "ground" and the clamp then lifts the
    // camera through it — the failure mode that comes free with any naive
    // "always clamp above the surface" rule. Ground at 0, deck at 5..6.
    const engine = engineWithSolid((p) => p.y < 0 || (p.y > 5 && p.y < 6));
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
    const target = new THREE.Object3D();
    target.updateMatrixWorld(true);
    const vehicleCamera = new VehicleCamera(camera, target, domStub(), engine, 1);

    drive(target, vehicleCamera, 120, (t) => { t.position.z += 0.2; });

    expect(camera.position.y).toBeLessThan(5);
    expect(camera.position.y).toBeGreaterThan(0);
  });

  it('does not swing the view on a small steering correction', () => {
    const { camera, target, vehicleCamera } = makeCamera(null);
    drive(target, vehicleCamera, 120, (t) => { t.position.z += 0.3; });

    const before = new THREE.Vector3();
    camera.getWorldDirection(before);
    // A trim of the wheel: 0.3 rad of vehicle yaw in one frame.
    drive(target, vehicleCamera, 1, (t) => { t.rotation.y = 0.3; });
    const after = new THREE.Vector3();
    camera.getWorldDirection(after);

    // The camera must lag well behind the car's new heading, not adopt it.
    // Measured: aiming off the SMOOTHED yaw swings 0.0007 rad in that frame;
    // aiming off the live heading (the old behaviour) swings 0.045 — 65x more,
    // which is the "camera snaps when I trim the wheel" complaint. 2% of the
    // steering input sits an order of magnitude clear of both.
    const swing = before.angleTo(after);
    expect(swing).toBeLessThan(0.3 * 0.02);
  });
});
