/**
 * Parametric vehicle wheels — tire + rim + spokes per BmWheelStyle.
 *
 * NEUTRAL POSE CONTRACT: the engine's wheel sync composes
 * `chassis × steer(Y) × spin(X) × cylinderAlign(Z, +π/2)` and assumes each
 * wheel mesh is an UPRIGHT CYLINDER (spin axis = local +Y) — see
 * RapierVehicle.visualUpdate. Everything built here follows that: the axle
 * runs along local Y, duals stack along Y.
 *
 * Used as the fallback wheel look when a vehicle asset's source GLB has no
 * BM_wheel_* nodes, and available to legacy renderers as an upgrade from
 * the plain dark cylinder.
 */

import * as THREE from 'three';
import type { BmWheelStyle } from 'types/vehicleFitment.js';
import { createTransformOnlyMesh } from 'engine/TransformOnlyMesh.js';
import { createClassedPartMaterial, type ClassedPartMaterial } from 'engine/ClassedPartMaterial.js';

const TIRE_COLOR = 0x16181c;
const RIM_SILVER = 0xb9bdc4;
const CHROME = 0xd9dde2;
const HUB_DARK = 0x43464c;
const DISH_DARK = 0x2a2c31;
const SEGMENTS = 18;

/**
 * Wheels ride the material-class ladder like every other classed surface:
 * `metal`/`chrome` rims render the engine's tuned metals (Physical + IBL on
 * high, Phong on medium, Lambert on low) instead of the old always-on
 * MeshStandardMaterial — the last full-PBR-everywhere material on the vehicle
 * path. Materials are cached per (class, colour) within ONE wheel build;
 * the wheel's consumer owns and disposes what it gets (dispose is idempotent
 * across the shared instances).
 */
type WheelPartClass = 'matte' | 'metal' | 'chrome';
type WheelMaterialFactory = (color: number, className: WheelPartClass) => ClassedPartMaterial;

function materialFactory(): WheelMaterialFactory {
  const cache = new Map<string, ClassedPartMaterial>();
  return (color, className) => {
    const key = `${className}:${color}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const created = createClassedPartMaterial(className, { color });
    cache.set(key, created);
    return created;
  };
}

function cylinder(radius: number, height: number, material: ClassedPartMaterial): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, SEGMENTS), material);
  mesh.castShadow = true;
  return mesh;
}

/**
 * Place a detail mesh on the wheel's rim circle: `radius` out from the axle at
 * `angle`, facing outwards. The axle runs along local Y, so the circle lies in
 * the XZ plane (see the neutral-pose contract above).
 */
function placeAroundAxle(mesh: THREE.Mesh, angle: number, radius: number): void {
  mesh.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
  mesh.rotation.y = angle;
}

/** One wheel assembly (root mesh = tire; details are children). */
function singleWheel(radius: number, width: number, style: BmWheelStyle, tireColor = TIRE_COLOR): THREE.Mesh {
  const mat = materialFactory();
  const tire = cylinder(radius, width, mat(tireColor, 'matte'));

  switch (style) {
    case 'steel':
      tire.add(cylinder(radius * 0.58, width + 0.015, mat(RIM_SILVER, 'metal')));
      tire.add(cylinder(radius * 0.18, width + 0.035, mat(HUB_DARK, 'matte')));
      break;
    case 'moon':
      tire.add(cylinder(radius * 0.8, width + 0.015, mat(CHROME, 'chrome')));
      tire.add(cylinder(radius * 0.14, width + 0.03, mat(HUB_DARK, 'matte')));
      break;
    case 'classic': {
      tire.add(cylinder(radius * 0.55, width + 0.015, mat(RIM_SILVER, 'metal')));
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius * 0.66, radius * 0.05, 8, SEGMENTS),
        mat(CHROME, 'chrome'),
      );
      ring.rotation.x = Math.PI / 2; // torus into the wheel plane (XZ)
      tire.add(ring);
      tire.add(cylinder(radius * 0.16, width + 0.03, mat(CHROME, 'chrome')));
      break;
    }
    case 'lug': {
      tire.add(cylinder(radius * 0.5, width + 0.02, mat(RIM_SILVER, 'metal')));
      tire.add(cylinder(radius * 0.16, width + 0.04, mat(HUB_DARK, 'matte')));
      const treads = 10;
      for (let i = 0; i < treads; i++) {
        const tread = new THREE.Mesh(
          new THREE.BoxGeometry(radius * 0.16, width * 1.06, radius * 0.14),
          mat(TIRE_COLOR, 'matte'),
        );
        placeAroundAxle(tread, (Math.PI * 2 * i) / treads, radius * 0.94);
        tire.add(tread);
      }
      break;
    }
    case 'alloy5':
    case 'alloy6': {
      const spokes = style === 'alloy5' ? 5 : 6;
      tire.add(cylinder(radius * 0.6, width + 0.008, mat(DISH_DARK, 'metal')));
      tire.add(cylinder(radius * 0.15, width + 0.035, mat(RIM_SILVER, 'metal')));
      const hubR = radius * 0.15;
      const rimInner = radius * 0.58;
      const len = rimInner - hubR;
      // Spokes bridge hub to rim, so they sit half a length out from the hub.
      const mid = hubR + len / 2;
      for (let i = 0; i < spokes; i++) {
        const spoke = new THREE.Mesh(
          new THREE.BoxGeometry(radius * 0.17, width + 0.02, len),
          mat(RIM_SILVER, 'metal'),
        );
        placeAroundAxle(spoke, (Math.PI * 2 * i) / spokes, mid);
        tire.add(spoke);
      }
      break;
    }
  }
  return tire;
}

export interface ParametricWheelOptions {
  radius: number;
  width: number;
  style: BmWheelStyle;
  /** Twin tires (truck rear axles) — stacked along the axle. */
  dual: boolean;
  /**
   * Tire colour, when the vehicle's paint overrode the shared default. Optional because
   * the forge and this builder already agree on that default (#16181c), so an unpainted
   * vehicle needs to carry nothing.
   */
  tireColor?: number;
}

export const DEFAULT_PARAMETRIC_WHEEL: ParametricWheelOptions = {
  radius: 0.4,
  width: 0.3,
  style: 'steel',
  dual: false,
};

/** Build one wheel mesh in the engine's neutral pose (spin axis local +Y). */
export function buildParametricWheelMesh(options: ParametricWheelOptions): THREE.Mesh {
  const { radius, width, style, dual, tireColor } = options;
  if (!dual) return singleWheel(radius, width, style, tireColor);
  // Duals: the engine owns the root's position/quaternion each frame, so the
  // root must stay centered — a transform-only Mesh with twin tire children.
  // NOT `new THREE.Mesh()`: an attribute-less geometry cannot build a WebGPU
  // pipeline and throws inside render(), blanking the whole frame. See
  // TransformOnlyMesh.ts.
  const root = createTransformOnlyMesh();
  const twinOffset = width * 0.55 + 0.012;
  for (const offset of [twinOffset, -twinOffset]) {
    const tire = singleWheel(radius, width, style, tireColor);
    tire.position.y = offset;
    root.add(tire);
  }
  return root;
}
