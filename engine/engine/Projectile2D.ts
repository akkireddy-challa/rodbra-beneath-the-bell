import * as THREE from 'three';
import { keepShaderAlive } from 'engine/effects/ShaderKeepAlive.js';
import RAPIER2D from '@dimforge/rapier2d-compat';
import { getRapier2D } from 'engine/physics/RapierPhysics2D.js';
import type { PhysicsWorld2D, ContactInfo2D } from 'engine/physics/PhysicsWorld2D.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';

export interface ProjectileVisualConfig2D {
    geometry?: THREE.BufferGeometry;
    material?: THREE.Material;
    customMesh?: THREE.Object3D;
    castShadow?: boolean;
    bloomLayer?: boolean;
    /** Physics collision radius in meters (default: 0.05m = 5cm) */
    collisionRadius?: number;
    /** Z-depth for the visual mesh (default: 0). Use for visual layering only — physics is strictly 2D. */
    visualZ?: number;
    trail?: {
        enabled: boolean;
        length?: number;
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material;
        opacityFalloff?: boolean;
    };
    explosion?: ExplosionConfig2D;

    /**
     * Gravity scale for ballistic trajectory. Default: 0 (straight-line bullet).
     * Set to 1.0 for realistic gravity, higher for exaggerated arcs.
     */
    gravityScale?: number;

    /**
     * Wind vector applied as continuous force (meters/second²).
     * Example: { x: 5, y: 0 } pushes projectile rightward.
     */
    windVector?: { x: number; y: number };
}

export interface ExplosionConfig2D {
    enabled: boolean;
    radius: number;
    duration: number;
    color?: number;
    damage?: number;
    damageRadius?: number;
}

/**
 * 2D projectile using Rapier2D physics.
 *
 * This is the Physics2D genre equivalent of `Projectile.ts` (which is 3D-only).
 * All physics happen on the X/Y plane; the visual mesh is placed at a configurable
 * Z depth for rendering order but Z has no physics meaning.
 *
 * **Ballistic usage:** Set `gravityScale: 1.0` in `visualConfig` and pass the
 * desired launch velocity as `speed`. The projectile receives that velocity once
 * at spawn; after that only gravity (and optional wind) act on it. Do NOT apply
 * additional forces to `getRigidBody()` — the physics engine handles the arc.
 */
export class Projectile2D {
    private mesh: THREE.Object3D;
    private rigidBody: RAPIER2D.RigidBody | null = null;
    private physicsWorld: PhysicsWorld2D;
    private scene: THREE.Scene;
    private age: number = 0;
    private lifetime: number = 10;
    private hasHitSomething: boolean = false;
    private onHitCallback: ((projectile: Projectile2D, hitBody?: RAPIER2D.RigidBody) => void) | null = null;
    private direction: { x: number; y: number };
    private speed: number;
    private collisionRadius: number;
    private collisionMask: number;
    private visualZ: number;
    private damage: number = 25;
    private isEnemyProjectile: boolean = false;
    private onPlayerHitCallback: ((projectile: Projectile2D) => void) | null = null;

    private gravityScale: number;
    private windVector: { x: number; y: number } | undefined;

    private trail: THREE.Mesh[] = [];
    private trailConfig: ProjectileVisualConfig2D['trail'] | undefined;
    private explosionConfig: ExplosionConfig2D | undefined;
    private explosion: Explosion2D | null = null;

    private hitBody: RAPIER2D.RigidBody | null = null;

    private static _defaultTrailGeo: THREE.SphereGeometry | null = null;
    private static _defaultTrailMat: THREE.MeshBasicMaterial | null = null;

    constructor(
        position: { x: number; y: number },
        direction: { x: number; y: number },
        speed: number,
        physicsWorld: PhysicsWorld2D,
        scene: THREE.Scene,
        onHitCallback?: (projectile: Projectile2D, hitBody?: RAPIER2D.RigidBody) => void,
        visualConfig?: ProjectileVisualConfig2D,
        customCollisionMask?: number,
    ) {
        this.physicsWorld = physicsWorld;
        this.scene = scene;
        this.onHitCallback = onHitCallback ?? null;
        this.speed = speed;
        this.collisionRadius = visualConfig?.collisionRadius ?? 0.05;
        this.collisionMask = customCollisionMask ?? CollisionMask.PROJECTILE;
        this.visualZ = visualConfig?.visualZ ?? 0;
        this.gravityScale = visualConfig?.gravityScale ?? 0;
        this.windVector = visualConfig?.windVector;
        this.trailConfig = visualConfig?.trail;
        this.explosionConfig = visualConfig?.explosion;

        const len = Math.sqrt(direction.x * direction.x + direction.y * direction.y) || 1;
        this.direction = { x: direction.x / len, y: direction.y / len };

        // Visual mesh
        if (visualConfig?.customMesh) {
            this.mesh = visualConfig.customMesh.clone();
        } else {
            const geometry = visualConfig?.geometry ?? new THREE.SphereGeometry(0.12, 16, 16);
            const material = visualConfig?.material ?? new THREE.MeshStandardMaterial({
                color: 0xffff00,
                emissive: 0xffff00,
                emissiveIntensity: 3.0,
                roughness: 0.2,
                metalness: 0.0,
                toneMapped: false,
            });
            this.mesh = new THREE.Mesh(geometry, material);
            // Every shot builds and disposes this material; keep its program
            // compiled between shots (see ShaderKeepAlive).
            if (!visualConfig?.material) keepShaderAlive(scene, 'projectile2d:default-body', material);
        }

        this.mesh.name = 'Projectile2D';
        this.mesh.position.set(position.x, position.y, this.visualZ);
        this.mesh.castShadow = visualConfig?.castShadow ?? false;

        if (visualConfig?.bloomLayer ?? true) {
            this.mesh.layers.set(1);
        }

        scene.add(this.mesh);

        // Trail
        if (this.trailConfig?.enabled) {
            const trailLength = this.trailConfig.length ?? 8;
            const geo = this.trailConfig.geometry ?? Projectile2D._getDefaultTrailGeo();
            const fadesOut = this.trailConfig.opacityFalloff !== false;
            for (let i = 0; i < trailLength; i++) {
                // With opacity falloff each segment needs its own material for its
                // own opacity; otherwise the shared default material is reused.
                const mat: THREE.Material = this.trailConfig.material
                    ?? (fadesOut
                        ? new THREE.MeshBasicMaterial({
                            color: 0xffaa00,
                            transparent: true,
                            opacity: 0.6 * (1.0 - i / trailLength),
                            depthWrite: false,
                            toneMapped: false,
                        })
                        : Projectile2D._getDefaultTrailMat());

                const seg = new THREE.Mesh(geo, mat);
                if (i === 0 && !this.trailConfig.material) keepShaderAlive(scene, 'projectile2d:trail', mat);
                seg.name = `Projectile2DTrail_${i}`;
                seg.position.set(position.x, position.y, this.visualZ);
                seg.visible = false;
                scene.add(seg);
                this.trail.push(seg);
            }
        }

        this.rigidBody = this.createPhysicsBody(position, this.direction, speed);
    }

    // ── Physics body ──

    private createPhysicsBody(
        position: { x: number; y: number },
        dir: { x: number; y: number },
        speed: number,
    ): RAPIER2D.RigidBody | null {
        const R = getRapier2D();

        // Initial velocity is set once here; after this only gravity (via
        // gravityScale) and optional wind act on the body.  No soft-CCD
        // prediction — it fights gravity near surfaces and causes erratic
        // acceleration in 2D platformer layouts where the ground is always
        // close.  Regular CCD is sufficient for tunneling prevention.
        const bodyDesc = R.RigidBodyDesc.dynamic()
            .setTranslation(position.x, position.y)
            .setLinvel(dir.x * speed, dir.y * speed)
            .setGravityScale(this.gravityScale)
            .setLinearDamping(0)
            .setAngularDamping(0)
            .setCanSleep(false)
            .setCcdEnabled(true);

        const body = this.physicsWorld.createRigidBody(bodyDesc);
        body.lockRotations(true, true);

        const collisionGroups = (this.collisionMask << 16) | CollisionGroup.PROJECTILE;
        const colliderDesc = R.ColliderDesc.ball(this.collisionRadius)
            .setFriction(0)
            .setRestitution(0)
            .setCollisionGroups(collisionGroups)
            .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);

        this.physicsWorld.createCollider(colliderDesc, body);

        this.physicsWorld.setUserData(body, { __type: 'projectile2d', projectile: this });

        this.physicsWorld.registerCollisionCallback(body, (contact: ContactInfo2D) => {
            this.onPhysicsCollision(contact);
        });

        return body;
    }

    // ── Collision handling ──

    private onPhysicsCollision(contact: ContactInfo2D): void {
        if (this.hasHitSomething) return;

        const isBodyA = contact.bodyA.handle === this.rigidBody?.handle;
        const otherBody = isBodyA ? contact.bodyB : contact.bodyA;

        const userData = this.physicsWorld.getUserData(otherBody) as Record<string, unknown> | undefined;
        if (userData?.__type === 'projectile2d') return;

        this.hitBody = otherBody;

        if (this.isEnemyProjectile && !otherBody.isFixed()) {
            if (userData?.__type === 'player' && this.onPlayerHitCallback) {
                this.onPlayerHitCallback(this);
            }
        }

        this.onHit();
    }

    // ── Update ──

    update(deltaTime: number): void {
        if (this.explosion) {
            this.explosion.update(deltaTime);
            return;
        }

        if (!this.rigidBody || this.hasHitSomething) return;

        if (this.windVector) {
            this.rigidBody.applyImpulse(
                { x: this.windVector.x * deltaTime, y: this.windVector.y * deltaTime },
                true,
            );
        }

        this.age += deltaTime;
        if (this.age > this.lifetime) return;

        const pos = this.rigidBody.translation();

        // Trail: shift each segment to its predecessor's pose, then snap head to mesh.
        if (this.trail.length > 0) {
            for (let i = this.trail.length - 1; i > 0; i--) {
                const cur = this.trail[i]!;
                const prev = this.trail[i - 1]!;
                cur.position.copy(prev.position);
                cur.visible = prev.visible;
            }
            const head = this.trail[0]!;
            head.position.copy(this.mesh.position);
            head.visible = true;
        }

        this.mesh.position.set(pos.x, pos.y, this.visualZ);
    }

    // ── Hit ──

    private onHit(): void {
        if (this.hasHitSomething) return;
        this.hasHitSomething = true;

        if (this.rigidBody) {
            this.rigidBody.setLinvel({ x: 0, y: 0 }, true);
            this.rigidBody.setEnabled(false);
        }

        if (this.explosionConfig?.enabled) {
            this.triggerExplosion();
        }

        if (this.onHitCallback) {
            this.onHitCallback(this, this.hitBody ?? undefined);
        }
    }

    private triggerExplosion(): void {
        if (!this.explosionConfig || this.explosion) return;

        const pos = this.getPosition();
        this.explosion = new Explosion2D(
            new THREE.Vector3(pos.x, pos.y, this.visualZ),
            this.explosionConfig,
            this.scene,
        );

        this.mesh.visible = false;
        this.trail.forEach(t => { t.visible = false; });
    }

    // ── Queries ──

    isExpired(): boolean {
        if (this.explosion) return this.explosion.isFinished();
        if (this.hasHitSomething) return !this.explosionConfig?.enabled;
        return this.age > this.lifetime;
    }

    hasHit(): boolean {
        return this.hasHitSomething;
    }

    getPosition(): { x: number; y: number } {
        if (this.rigidBody) {
            const t = this.rigidBody.translation();
            return { x: t.x, y: t.y };
        }
        return { x: this.mesh.position.x, y: this.mesh.position.y };
    }

    getPosition3D(): THREE.Vector3 {
        const p = this.getPosition();
        return new THREE.Vector3(p.x, p.y, this.visualZ);
    }

    getMesh(): THREE.Object3D {
        return this.mesh;
    }

    getDirection(): { x: number; y: number } {
        return { ...this.direction };
    }

    getSpeed(): number {
        return this.speed;
    }

    getDamage(): number {
        return this.damage;
    }

    setDamage(damage: number): void {
        this.damage = Math.max(0, damage);
    }

    getIsEnemyProjectile(): boolean {
        return this.isEnemyProjectile;
    }

    setEnemyProjectile(onPlayerHit: (projectile: Projectile2D) => void): this {
        this.isEnemyProjectile = true;
        this.onPlayerHitCallback = onPlayerHit;
        return this;
    }

    getVelocity(): { x: number; y: number } {
        if (!this.rigidBody) return { x: 0, y: 0 };
        return this.rigidBody.linvel();
    }

    setWindVector(windVector: { x: number; y: number } | undefined): void {
        this.windVector = windVector;
    }

    getGravityScale(): number {
        return this.gravityScale;
    }

    getHitBody(): RAPIER2D.RigidBody | null {
        return this.hitBody;
    }

    getExplosion(): Explosion2D | null {
        return this.explosion;
    }

    getRigidBody(): RAPIER2D.RigidBody | null {
        return this.rigidBody;
    }

    // ── Dispose ──

    dispose(): void {
        if (this.explosion) {
            this.explosion.dispose();
            this.explosion = null;
        }

        if (this.mesh.parent) {
            this.mesh.parent.remove(this.mesh);
        }

        const userGeo = this.trailConfig?.geometry;
        const userMat = this.trailConfig?.material;
        for (const seg of this.trail) {
            if (seg.parent) seg.parent.remove(seg);
            if (seg.geometry !== Projectile2D._defaultTrailGeo && seg.geometry !== userGeo) {
                seg.geometry.dispose();
            }
            if (seg.material !== Projectile2D._defaultTrailMat && seg.material !== userMat) {
                (seg.material as THREE.Material).dispose();
            }
        }
        this.trail = [];

        if (this.rigidBody) {
            this.physicsWorld.removeRigidBody(this.rigidBody);
            this.rigidBody = null;
        }

        this.mesh.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const m = child as THREE.Mesh;
                m.geometry?.dispose();
                if (m.material) {
                    if (Array.isArray(m.material)) m.material.forEach(mat => mat.dispose());
                    else m.material.dispose();
                }
            }
        });
    }

    // ── Shared geometry/material ──

    private static _getDefaultTrailGeo(): THREE.SphereGeometry {
        return Projectile2D._defaultTrailGeo ??= new THREE.SphereGeometry(0.06, 8, 8);
    }

    private static _getDefaultTrailMat(): THREE.MeshBasicMaterial {
        return Projectile2D._defaultTrailMat ??= new THREE.MeshBasicMaterial({
            color: 0xffaa00,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            toneMapped: false,
        });
    }
}


/**
 * Per-particle animation state stashed on the explosion meshes.
 * `__kind` selects the branch of `Explosion2D.update()` that animates it, and
 * so which of the optional fields below that branch reads. Mirrors
 * `ExplosionParticle` in `Projectile.ts`.
 */
type ExplosionParticle2D = THREE.Mesh & {
    __kind: 'fireball' | 'spark' | 'core' | 'debris';
    /** Direction (fireball) or velocity (spark, debris), in the XY plane. */
    __vx: number;
    __vy: number;
    __gravity?: number;
    __rotationSpeed?: number;
    __baseScale?: number;
};

/** A mesh carrying the required particle state; the per-kind fields are set by the caller. */
function makeParticle(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    kind: ExplosionParticle2D['__kind'],
): ExplosionParticle2D {
    return Object.assign(new THREE.Mesh(geometry, material), { __kind: kind, __vx: 0, __vy: 0 });
}

/**
 * Lightweight 2D explosion effect (visual only, no physics).
 * Shared geometries are cached statically to avoid per-explosion allocation.
 */
export class Explosion2D {
    private static _fireballGeo: THREE.SphereGeometry | null = null;
    private static _sparkGeo: THREE.SphereGeometry | null = null;
    private static _coreGeo: THREE.SphereGeometry | null = null;
    private static _debrisGeo: THREE.BoxGeometry | null = null;

    private position: THREE.Vector3;
    private config: ExplosionConfig2D;
    private scene: THREE.Scene;
    private age = 0;
    private meshes: ExplosionParticle2D[] = [];
    private finished = false;

    constructor(position: THREE.Vector3, config: ExplosionConfig2D, scene: THREE.Scene) {
        this.position = position.clone();
        this.config = config;
        this.scene = scene;
        this.createVisual();
    }

    private createVisual(): void {
        const color = this.config.color ?? 0xff4400;
        const radius = this.config.radius;
        const count = Math.min(Math.floor(radius * 2), 30);

        // Fireballs
        const fbGeo = Explosion2D._fireballGeo ??= new THREE.SphereGeometry(1, 10, 10);
        for (let i = 0; i < Math.max(8, count); i++) {
            const cv = Math.random();
            const fc = cv < 0.3 ? 0xffff00 : cv < 0.6 ? 0xffaa00 : color;
            const mat = new THREE.MeshBasicMaterial({ color: fc, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
            const m = makeParticle(fbGeo, mat, 'fireball');
            if (i === 0) keepShaderAlive(this.scene, 'explosion2d:fireball', mat);
            const size = 0.2 + Math.random() * 0.3;
            m.scale.setScalar(size);
            m.position.copy(this.position);
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * 0.5;
            m.position.x += Math.cos(angle) * r;
            m.position.y += Math.sin(angle) * r;
            m.__vx = Math.cos(angle);
            m.__vy = Math.sin(angle) + 0.3;
            m.__baseScale = size;
            m.layers.set(1);
            this.scene.add(m);
            this.meshes.push(m);
        }

        // Sparks
        const spGeo = Explosion2D._sparkGeo ??= new THREE.SphereGeometry(1, 6, 6);
        for (let i = 0; i < Math.max(12, count * 2); i++) {
            const mat = new THREE.MeshBasicMaterial({ color: Math.random() < 0.5 ? 0xffffaa : 0xffaa00, transparent: true, opacity: 1, toneMapped: false });
            const m = makeParticle(spGeo, mat, 'spark');
            if (i === 0) keepShaderAlive(this.scene, 'explosion2d:spark', mat);
            m.scale.setScalar(0.05);
            m.position.copy(this.position);
            const angle = Math.random() * Math.PI * 2;
            const spd = 1 + Math.random();
            m.__vx = Math.cos(angle) * spd;
            m.__vy = Math.sin(angle) * spd + 0.5;
            m.__gravity = 0.5 + Math.random() * 0.5;
            m.layers.set(1);
            this.scene.add(m);
            this.meshes.push(m);
        }

        // Core flash
        const cGeo = Explosion2D._coreGeo ??= new THREE.SphereGeometry(1, 12, 12);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, toneMapped: false });
        const core = makeParticle(cGeo, coreMat, 'core');
        keepShaderAlive(this.scene, 'explosion2d:core', coreMat);
        core.scale.setScalar(0.5);
        core.position.copy(this.position);
        core.layers.set(1);
        core.__baseScale = 0.5;
        this.scene.add(core);
        this.meshes.push(core);

        // Debris
        const dGeo = Explosion2D._debrisGeo ??= new THREE.BoxGeometry(1, 1, 1);
        for (let i = 0; i < Math.max(10, count); i++) {
            const mat = new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.9 });
            const m = makeParticle(dGeo, mat, 'debris');
            if (i === 0) keepShaderAlive(this.scene, 'explosion2d:debris', mat);
            m.scale.setScalar(0.08);
            m.position.copy(this.position);
            const angle = Math.random() * Math.PI * 2;
            const spd = 0.5 + Math.random() * 1.5;
            m.__vx = Math.cos(angle) * spd;
            m.__vy = 0.8 + Math.random() * 1.2;
            m.__gravity = 2 + Math.random();
            m.__rotationSpeed = (Math.random() - 0.5) * 10;
            this.scene.add(m);
            this.meshes.push(m);
        }
    }

    update(deltaTime: number): void {
        if (this.finished) return;
        this.age += deltaTime;
        const progress = this.age / this.config.duration;
        if (progress >= 1.0) { this.finished = true; return; }

        const radius = this.config.radius;

        for (const mesh of this.meshes) {
            const mat = mesh.material as THREE.MeshBasicMaterial;

            switch (mesh.__kind) {
                case 'core': {
                    const p = Math.min(progress * 4, 1);
                    mesh.scale.setScalar((mesh.__baseScale ?? 0.5) * (1 + p * radius * 0.3));
                    mat.opacity = 1 - p;
                    break;
                }
                case 'fireball':
                    this.drift(mesh, radius * 0.5 * deltaTime);
                    mesh.scale.setScalar((mesh.__baseScale ?? 0.3) * (1 + progress * radius * 0.15));
                    mat.opacity = 0.9 * (1 - progress * progress);
                    break;
                case 'spark':
                    mesh.__vy -= (mesh.__gravity ?? 1) * deltaTime * 3;
                    this.drift(mesh, radius * 0.8 * deltaTime);
                    mat.opacity = 1 - progress * progress;
                    break;
                case 'debris':
                    mesh.__vy -= (mesh.__gravity ?? 2) * deltaTime * 2;
                    this.drift(mesh, radius * 0.15 * deltaTime);
                    mesh.rotation.z += (mesh.__rotationSpeed ?? 5) * deltaTime;
                    if (progress > 0.7) mat.opacity = 0.9 * (1 - (progress - 0.7) / 0.3);
                    break;
            }
        }
    }

    /** Advance a particle along its own velocity, scaled by this frame's step. */
    private drift(mesh: ExplosionParticle2D, step: number): void {
        mesh.position.x += mesh.__vx * step;
        mesh.position.y += mesh.__vy * step;
    }

    isFinished(): boolean { return this.finished; }

    getPosition(): THREE.Vector3 { return this.position.clone(); }
    getDamageRadius(): number { return this.config.damageRadius ?? this.config.radius; }
    getBaseDamage(): number { return this.config.damage ?? 0; }

    calculateDamageAtPosition(targetPos: THREE.Vector3): number {
        const dist = this.position.distanceTo(targetPos);
        const dr = this.getDamageRadius();
        if (dist >= dr) return 0;
        return this.getBaseDamage() * (1 - dist / dr);
    }

    dispose(): void {
        for (const m of this.meshes) {
            if (m.parent) m.parent.remove(m);
            (m.material as THREE.Material).dispose();
        }
        this.meshes = [];
    }
}
