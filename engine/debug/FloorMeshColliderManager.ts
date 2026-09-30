import * as THREE from 'three';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getAgentUrl } from 'engine/agentUrl.js';

export interface MeshColliderData {
    id: string;
    type: 'floor_mesh';
    vertices: number[];
    indices: number[];
    bounds: {
        minX: number; maxX: number;
        minY: number; maxY: number;
        minZ: number; maxZ: number;
    };
    worldOrigin: { x: number; y: number; z: number };
    cellSize: number;
}

export class FloorMeshColliderManager {
    private scene: THREE.Scene;
    private physicsWorld: PhysicsWorld;
    private floorMeshColliders: Array<{ data: MeshColliderData; mesh: THREE.Mesh; body: RAPIER.RigidBody }> = [];

    constructor(scene: THREE.Scene, physicsWorld: PhysicsWorld) {
        this.scene = scene;
        this.physicsWorld = physicsWorld;
    }

    createFloorMeshCollider(floorMeshData: MeshColliderData): void {
        const RAPIER = getRapier();
        if (!RAPIER) {
            console.warn('[FloorMeshColliderManager] Rapier not initialized');
            return;
        }

        // Create THREE.js mesh for visualization
        const geometry = new THREE.BufferGeometry();
        const vertices = new Float32Array(floorMeshData.vertices);
        const indices = new Uint32Array(floorMeshData.indices);
        
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();
        
        const material = new THREE.MeshStandardMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
            wireframe: false
        });
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.visible = false; // Hidden by default - visibility controlled by Splats editor UI
        this.scene.add(mesh);
        
        // Create Rapier trimesh collider
        const rapierWorld = this.physicsWorld.getRapierWorld();
        if (!rapierWorld) {
            console.warn('[FloorMeshColliderManager] Physics world not available');
            return;
        }

        // Create static rigid body at origin (mesh is already in world space)
        const bodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(0, 0, 0);
        const body = rapierWorld.createRigidBody(bodyDesc);

        // Create trimesh collider
        const colliderDesc = RAPIER.ColliderDesc.trimesh(
            new Float32Array(floorMeshData.vertices),
            new Uint32Array(floorMeshData.indices)
        );
        
        if (colliderDesc) {
            colliderDesc.setFriction(0.8);
            colliderDesc.setRestitution(0.2);
            rapierWorld.createCollider(colliderDesc, body);
        }
        
        // Store the collider
        this.floorMeshColliders.push({ data: floorMeshData, mesh, body });
    }

    clearAll(): void {
        const rapierWorld = this.physicsWorld.getRapierWorld();
        
        this.floorMeshColliders.forEach(collider => {
            this.scene.remove(collider.mesh);
            collider.mesh.geometry.dispose();
            (collider.mesh.material as THREE.Material).dispose();
            
            // Remove body from physics world - Rapier handles cleanup automatically
            if (rapierWorld && collider.body) {
                rapierWorld.removeRigidBody(collider.body);
            }
        });
        
        this.floorMeshColliders = [];
    }

    getFloorMeshColliders(): Array<{ data: MeshColliderData; mesh: THREE.Mesh; body: RAPIER.RigidBody }> {
        return this.floorMeshColliders;
    }

    getCount(): number {
        return this.floorMeshColliders.length;
    }
    
    async saveToS3(gameId: string): Promise<string | null> {
        if (this.floorMeshColliders.length === 0) {
            console.log('[FloorMesh] No floor meshes to save');
            return null;
        }
        
        const AI_AGENT_URL = getAgentUrl();
        // Include timestamp in filename for version history and proper cache busting
        const timestamp = Date.now();
        const filename = `${gameId}-floor-meshes-${timestamp}.json`;
        const meshData = this.floorMeshColliders.map(c => c.data);
        const jsonString = JSON.stringify({ meshes: meshData }, null, 2);
        
        console.log(`[FloorMesh] Saving ${meshData.length} floor meshes to ${filename}...`);
        
        // Use the save-collider-file endpoint (same as manual colliders)
        const saveResponse = await fetch(`${AI_AGENT_URL}/api/save-collider-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                filename,
                content: jsonString,
                isBase64: false
            })
        });
        
        if (saveResponse.ok) {
            const result = await saveResponse.json();
            console.log(`[FloorMesh] ✅ Saved to S3: ${result.s3Url}`);
            return result.s3Url;
        } else {
            const errorText = await saveResponse.text();
            console.error('[FloorMesh] Failed to save floor meshes:', saveResponse.status, errorText);
            return null;
        }
    }
    
    async loadFromUrl(url: string): Promise<void> {
        try {
            console.log(`[FloorMesh] Loading floor meshes from S3: ${url}`);
            const response = await fetch(url);
            if (!response.ok) {
                console.warn(`[FloorMesh] Failed to fetch: ${response.statusText}`);
                return;
            }
            
            const data = await response.json();
            if (data.meshes && Array.isArray(data.meshes)) {
                console.log(`[FloorMesh] Loaded ${data.meshes.length} floor meshes from S3`);
                for (const meshData of data.meshes) {
                    this.createFloorMeshCollider(meshData);
                }
            }
        } catch (error) {
            console.warn(`[FloorMesh] Error loading floor meshes:`, error);
        }
    }
}
