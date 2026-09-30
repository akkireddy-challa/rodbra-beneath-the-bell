import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import type { Interactable } from 'types/interactable.js';
import type { EngineLike } from 'types/game.js';
import { ShootableComponent, Projectile, type ProjectileConfig } from 'engine/ShootableComponent.js';
import { t } from 'engine/i18n/index.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';

/**
 * Example cannon implementation for testing ShootableComponent
 * Implements Interactable interface for player interaction
 */
export class ExampleCannon implements Interactable {
  group: THREE.Group;
  shootable: ShootableComponent;
  private activeProjectiles: Projectile[] = [];
  private engine: EngineLike;
  private interactableComponent: InteractableComponent | null = null;

  constructor(engine: EngineLike) {
    if (!engine.scene || !engine.physicsWorld) {
      throw new Error('ExampleCannon requires scene and physicsWorld to be initialized');
    }

    this.engine = engine;
    this.group = new THREE.Group();
    this.group.name = 'ExampleCannon';

    // Create cannon barrel (procedural)
    // CylinderGeometry is vertical (Y-axis) by default, rotate around X to point forward (Z-axis)
    const barrelGeometry = new THREE.CylinderGeometry(0.3, 0.3, 3, 16);
    const barrelMaterial = createClassedPartMaterial('metal', { color: 0x333333 });
    const barrel = new THREE.Mesh(barrelGeometry, barrelMaterial);
    barrel.rotation.x = Math.PI / 2; // Rotate to point along Z-axis
    barrel.position.set(0, 0.5, 1.5); // Raise it above the base
    barrel.castShadow = true;
    barrel.receiveShadow = true;

    // Create cannon base
    const baseGeometry = new THREE.BoxGeometry(1, 1, 1);
    const baseMaterial = createClassedPartMaterial('metal', { color: 0x555555 });
    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    base.position.y = 0.5; // Raise base so bottom sits on ground
    base.castShadow = true;
    base.receiveShadow = true;

    this.group.add(base);
    this.group.add(barrel);
    this.group.name = 'ExampleCannon';
    this.engine.scene!.add(this.group);

    // Configure shootable component. The shot is 'neon' at the old 0.5 glow
    // (glow is in units of the voxel full-glow, 3.0), with its authored
    // off-hue emissive kept as a postscript.
    const shotMaterial = createClassedPartMaterial('neon', { color: 0xff4400, glow: 0.5 / 3 });
    shotMaterial.emissive.setHex(0xff2200);
    const projectileConfig: ProjectileConfig = {
      speed: 50,
      visualConfig: {
        geometry: new THREE.SphereGeometry(0.2, 16, 16),
        material: shotMaterial,
        castShadow: true,
        bloomLayer: true,
        trail: {
          enabled: true,
          length: 8,
          opacityFalloff: true
        }
      }
    };

    // Muzzle is at the end of the barrel
    // Barrel center is at (0, 0.5, 1.5), barrel length is 3, so muzzle end is at z = 1.5 + 1.5 = 3.0
    // Y position matches barrel center height: 0.5
    this.shootable = new ShootableComponent(
      new THREE.Vector3(0, 0.5, 3),
      0.5, // 0.5 shots per second (2 second cooldown)
      projectileConfig
    );

    // Create trigger sensor for interaction detection (static object, creates its own body)
    this.interactableComponent = new InteractableComponent(engine.physicsWorld, {
      interactable: this,
      object3D: this.group,
      radius: 3.0,
    });
  }

  // Interactable interface implementation
  onInteractStart(): boolean {
    this.fire();
    return true;
  }

  getInteractStartDisplayName(): string {
    return t('game.interaction.fireCannon');
  }

  interactionEnabled(): boolean {
    return this.shootable.canShoot();
  }

  fire() {
    if (!this.engine.physicsWorld) return;

    const projectile = this.shootable.shoot(this.group, this.engine.physicsWorld, this.engine);
    if (projectile) {
      this.activeProjectiles.push(projectile);
      console.log('Cannon fired!');
    } else {
      console.log('Cannon is cooling down...');
    }
  }

  update(deltaTime: number = 0.016) {
    if (!this.engine.scene || !this.engine.physicsWorld) return;

    // Update all active projectiles
    this.activeProjectiles.forEach(projectile => projectile.update(deltaTime));

    // Remove expired projectiles
    this.activeProjectiles = this.activeProjectiles.filter(projectile => {
      if (projectile.isExpired()) {
        projectile.dispose();
        return false;
      }
      return true;
    });
  }

  // Aim the cannon
  aimAt(target: THREE.Vector3) {
    this.group.lookAt(target);
  }

  setPosition(x: number, y: number, z: number) {
    this.group.position.set(x, y, z);
  }

  dispose() {
    // Dispose interactable trigger sensor
    if (this.interactableComponent) {
      this.interactableComponent.dispose();
      this.interactableComponent = null;
    }

    if (!this.engine.scene) return;

    // Dispose all active projectiles
    this.activeProjectiles.forEach(projectile => {
      projectile.dispose();
    });
    this.activeProjectiles = [];

    // Remove cannon from scene
    this.engine.scene.remove(this.group);

    // Dispose geometries and materials
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (object.material instanceof THREE.Material) {
          object.material.dispose();
        }
      }
    });
  }
}
