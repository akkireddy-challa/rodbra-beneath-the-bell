import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { LegacyNavMesh } from 'engine/LegacyNavMesh.js';
import { getDefaultCharacterUrl } from 'engine/CharacterConfig.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

export class GlbNPC {
    private character: THREE.Object3D;
    private characterBody: RAPIER.RigidBody | null = null;
    private physicsWorld: PhysicsWorld;
    private engine: EngineLike;
    private navMesh: LegacyNavMesh;
    private mixer: THREE.AnimationMixer | null = null;

    constructor(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        engine: EngineLike,
        spawnPosition: THREE.Vector3,
        navMesh: LegacyNavMesh,
        glbUrl: string = getDefaultCharacterUrl()
    ) {
        this.navMesh = navMesh;
        this.physicsWorld = physicsWorld;
        this.engine = engine;
        
        this.character = new THREE.Group();
        this.character.name = 'GlbNPC';
        this.character.position.copy(spawnPosition);
        scene.add(this.character);
        
        this.characterBody = this.createPhysicsBody(spawnPosition);
        
        // Register NPC body with game if the method exists (genre-specific)
        const genreModule = this.engine.genreModule as { registerNPCBody?: (body: RAPIER.RigidBody, npc: GlbNPC) => void };
        if (genreModule?.registerNPCBody && this.characterBody) {
            genreModule.registerNPCBody(this.characterBody, this);
        }

        this.loadGlbCharacter(glbUrl);
    }
    
    private async loadGlbCharacter(url: string): Promise<void> {
        try {
            const gltf = await this.engine.loader.loadAsync(url);
            
            gltf.scene.traverse((child: THREE.Object3D) => {
                if ((child as any).isMesh) {
                    const mesh = child as THREE.Mesh;
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    child.layers.set(1);
                }
            });
            
            const box = new THREE.Box3().setFromObject(gltf.scene);
            const size = new THREE.Vector3();
            box.getSize(size);
            const currentHeight = size.y;
            
            if (currentHeight > 0) {
                const targetHeight = 1.75;
                const scale = targetHeight / currentHeight;
                gltf.scene.scale.setScalar(scale);
            }
            
            this.character.add(gltf.scene);
            
            if (gltf.animations && gltf.animations.length > 0) {
                this.mixer = new THREE.AnimationMixer(gltf.scene);
                const action = this.mixer.clipAction(gltf.animations[0]);
                action.setLoop(THREE.LoopRepeat, Infinity);
                action.play();
            }
        } catch (error) {
            console.error('Failed to load GLB NPC:', error);
        }
    }
    
    private createPhysicsBody(position: THREE.Vector3): RAPIER.RigidBody | null {
        const RAPIER = getRapier();
        if (!RAPIER) {
            console.warn('[GlbNPC] Rapier not initialized');
            return null;
        }

        const rapierWorld = this.physicsWorld.getRapierWorld();
        if (!rapierWorld) {
            console.warn('[GlbNPC] Physics world not available');
            return null;
        }

        const radius = 0.3;
        const height = 1.75;
        const halfHeight = height / 2;
        const capsuleHalfHeight = (height - 2 * radius) / 2;
        
        const physicsY = position.y + halfHeight;
        
        // Create dynamic rigid body
        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(position.x, physicsY, position.z)
            .setLinearDamping(0.5)
            .setAngularDamping(1.0)
            .lockRotations(); // Lock all rotations - NPC doesn't tip over
        const body = rapierWorld.createRigidBody(bodyDesc);

        // Create capsule collider
        const colliderDesc = RAPIER.ColliderDesc.capsule(capsuleHalfHeight, radius);
        colliderDesc.setFriction(0.8);
        colliderDesc.setMass(70);
        rapierWorld.createCollider(colliderDesc, body);

        // Store owner info in userData (for collision detection)
        (body as any).__ownerNPCName = this.character.name || 'GlbNPC';
        (body as any).__type = 'npc_main';
        
        return body;
    }
    
    update(deltaTime: number): void {
        this.applyGrounding();
        
        if (this.mixer) {
            this.mixer.update(deltaTime);
        }
        
        this.syncCharacterWithPhysics();
    }
    
    private syncCharacterWithPhysics(): void {
        if (!this.characterBody) return;
        
        const translation = this.characterBody.translation();
        const halfHeight = 0.875;
        
        this.character.position.set(translation.x, translation.y - halfHeight, translation.z);
    }
    
    private applyGrounding(): void {
        if (!this.characterBody) return;
        
        const RAPIER = getRapier();
        if (!RAPIER) return;
        
        const rapierWorld = this.physicsWorld.getRapierWorld();
        if (!rapierWorld) return;
        
        const currentPos = this.characterBody.translation();
        
        // Raycast downward to find ground
        const ray = new RAPIER.Ray(
            { x: currentPos.x, y: currentPos.y, z: currentPos.z },
            { x: 0, y: -1, z: 0 }
        );
        
        const hit = rapierWorld.castRay(ray, 10, true);
        
        if (hit) {
            const hitPoint = ray.pointAt(hit.timeOfImpact);
            const groundY = hitPoint.y;
            
            if (currentPos.y < groundY + 0.875) {
                this.characterBody.setTranslation(
                    { x: currentPos.x, y: groundY + 0.875, z: currentPos.z },
                    true
                );
            }
        }
    }
    
    explodeIntoBlocks(): void {
        if (this.character && this.character.parent) {
            this.character.parent.remove(this.character);
        }
        if (this.characterBody) {
            const rapierWorld = this.physicsWorld.getRapierWorld();
            if (rapierWorld) {
                rapierWorld.removeRigidBody(this.characterBody);
            }
            this.characterBody = null;
        }
    }
    
    dispose(): void {
        if (this.character && this.character.parent) {
            this.character.parent.remove(this.character);
        }

        if (this.characterBody) {
            const rapierWorld = this.physicsWorld.getRapierWorld();
            if (rapierWorld) {
                rapierWorld.removeRigidBody(this.characterBody);
            }
            this.characterBody = null;
        }

        this.character.traverse((obj: THREE.Object3D) => {
            const mesh = obj as THREE.Mesh;
            if (mesh.isMesh) {
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) {
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach(m => m.dispose());
                    } else {
                        mesh.material.dispose();
                    }
                }
            }
        });
    }
    
    getCharacter(): THREE.Object3D {
        return this.character;
    }

    getPhysicsBody(): RAPIER.RigidBody | null {
        return this.characterBody;
    }
}
