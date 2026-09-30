/**
 * AssetVehicleRenderer — renders a vehicle whose visuals come from an
 * imported vehicle asset (bmVehicle GLB): the chassis is the asset's body
 * (VXL VoxelObject or GLB clone) and each wheel is either a BM_wheel_*
 * node from the source GLB or a parametric wheel.
 *
 * Everything async happened earlier (VehicleAssetVisual); this renderer is
 * a dumb sync consumer so it can run inside the RapierVehicle constructor.
 * Contract notes (see RapierVehicle.createChassis/visualUpdate):
 * - the engine adds the returned root to the scene and OVERWRITES its
 *   userData — nothing load-bearing may live on the root;
 * - wheels are returned one per wheelConfigs[i], in order, world-positioned
 *   initially; the engine re-syncs position/quaternion every frame and
 *   assumes the neutral pose of an upright cylinder.
 */

import * as THREE from 'three';
import type { VehicleConfig, WheelConfig } from 'engine/Vehicle.js';
import type { VehicleRenderer } from 'engine/VehicleRenderer.js';

export interface AssetVehicleRendererOptions {
  /** Asset-frame chassis visual (origin at body ground-center). */
  chassisObject: THREE.Object3D;
  /** Chassis-local Y where the asset origin sits (the platform top). */
  bodyLiftY: number;
  /** One wheel mesh per wheel config, SAME order as config.wheels. */
  wheelMeshes: THREE.Mesh[];
}

export class AssetVehicleRenderer implements VehicleRenderer {
  private readonly options: AssetVehicleRendererOptions;

  constructor(options: AssetVehicleRendererOptions) {
    this.options = options;
  }

  createChassisMesh(_config: VehicleConfig, position: THREE.Vector3): THREE.Object3D {
    const group = new THREE.Group();
    group.name = 'AssetVehicle';
    group.position.copy(position);
    const body = this.options.chassisObject;
    body.position.set(0, this.options.bodyLiftY, 0);
    group.add(body);
    return group;
  }

  createWheelMeshes(
    _config: VehicleConfig,
    position: THREE.Vector3,
    wheelConfigs?: WheelConfig[],
  ): THREE.Mesh[] {
    const configs = wheelConfigs ?? [];
    return this.options.wheelMeshes.slice(0, configs.length).map((mesh, i) => {
      const config = configs[i]!;
      mesh.position.copy(position).add(config.position);
      return mesh;
    });
  }
}
