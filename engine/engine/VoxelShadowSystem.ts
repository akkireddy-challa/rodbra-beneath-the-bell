/**
 * VoxelShadowSystem.ts
 * 
 * Handles shadow mesh generation and dynamic light spheres for VoxelWorld.
 * Extracted from VoxelWorld.ts for better code organization.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, uniform, uniformArray, Loop, Break, If, Discard,
    vec3, vec4, float, int,
    positionWorld,
} from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';
import type { BlockID } from 'engine/VoxelGeometry.js';

const CHUNK_SIZE = 16;

/** Interface for accessing voxel data from chunks */
export interface VoxelChunkProvider {
    getChunks(): Map<string, { get(x: number, y: number, z: number): BlockID; colors: { get(x: number, y: number, z: number): number } }>;
    getBounds(): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null;
    getVoxelSize(): number;
    getParentGroup(): THREE.Object3D;
    isPlacedObject(): boolean;
    shouldSkipShadowMesh(): boolean;
}

interface LightSphere {
    position: THREE.Vector3;
    radius: number;
    color: THREE.Color;
    intensity: number;
    id: number;
}

interface LightSphereState {
    count: { value: number };
    positions: THREE.Vector3[];
    radii: number[];
    colors: THREE.Vector3[];
    intensities: number[];
}

export class VoxelShadowSystem {
    private provider: VoxelChunkProvider;

    // Shadow mesh — vanilla ShadowMaterial, no light-sphere uniforms (they were
    // attached via onBeforeCompile but the default shadow shader never used them).
    private shadowMesh: THREE.Mesh | null = null;
    private shadowMaterial: THREE.ShadowMaterial | null = null;

    // Light receiver mesh — TSL/NodeMaterial. Light-sphere data lives in
    // `lightSphereState`, which is mutated in place by updateLightSphereUniforms.
    private lightReceiverMesh: THREE.Mesh | null = null;
    private lightReceiverMaterial: THREE.Material | null = null;
    private lightSphereState: LightSphereState | null = null;
    
    // Light spheres
    private lightSpheres: LightSphere[] = [];
    private nextLightSphereId: number = 0;
    private readonly MAX_LIGHT_SPHERES = 32;
    
    // Debouncing
    private shadowUpdatePending = false;
    private shadowUpdateTimeoutId: ReturnType<typeof setTimeout> | null = null;
    private readonly SHADOW_DEBOUNCE_MS = 100;
    
    constructor(provider: VoxelChunkProvider) {
        this.provider = provider;
    }
    
    /** Get the shadow mesh for visibility control */
    getShadowMesh(): THREE.Mesh | null { return this.shadowMesh; }
    
    /** Get the light receiver mesh for visibility control */
    getLightReceiverMesh(): THREE.Mesh | null { return this.lightReceiverMesh; }
    
    /** Debounced shadow mesh update - prevents redundant rebuilds during rapid terrain changes */
    scheduleShadowUpdate(): void {
        if (this.shadowUpdateTimeoutId !== null) clearTimeout(this.shadowUpdateTimeoutId);
        this.shadowUpdatePending = true;
        this.shadowUpdateTimeoutId = setTimeout(() => {
            this.updateShadowMesh();
            this.shadowUpdatePending = false;
            this.shadowUpdateTimeoutId = null;
        }, this.SHADOW_DEBOUNCE_MS);
    }
    
    /** Update the global shadow mesh (outer shell geometry without internal faces) */
    updateShadowMesh(): void {
        const parentGroup = this.provider.getParentGroup();
        
        // Remove old shadow mesh
        if (this.shadowMesh) {
            parentGroup.remove(this.shadowMesh);
            this.shadowMesh.geometry.dispose();
            (this.shadowMesh.material as THREE.Material).dispose();
            this.shadowMesh = null;
            this.shadowMaterial = null;
        }
        
        // Remove old light receiver mesh
        if (this.lightReceiverMesh) {
            parentGroup.remove(this.lightReceiverMesh);
            this.lightReceiverMesh.geometry.dispose();
            (this.lightReceiverMesh.material as THREE.Material).dispose();
            this.lightReceiverMesh = null;
            this.lightReceiverMaterial = null;
            this.lightSphereState = null;
        }
        
        // Skip shadow mesh creation for placed objects or when explicitly disabled
        if (this.provider.isPlacedObject() || this.provider.shouldSkipShadowMesh()) return;
        
        // Generate new shadow mesh
        const newShadowMesh = this.generateGlobalShadowMesh();
        if (newShadowMesh) {
            parentGroup.add(newShadowMesh);
            this.shadowMesh = newShadowMesh;
            this.shadowMesh.visible = true;
            console.log('[VoxelShadow] Created shadow mesh with', newShadowMesh.geometry.getAttribute('position')?.count || 0, 'vertices');
            
            // Create light receiver mesh using the same geometry
            const lightReceiverMesh = this.generateLightReceiverMesh(newShadowMesh.geometry);
            if (lightReceiverMesh) {
                parentGroup.add(lightReceiverMesh);
                this.lightReceiverMesh = lightReceiverMesh;
                this.lightReceiverMesh.visible = true;
            }
        }
    }
    
    /** Generate the global shadow mesh - outer shell geometry for shadow receiving */
    private generateGlobalShadowMesh(): THREE.Mesh | null {
        const positions: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        let vertexCount = 0;
        
        const chunks = this.provider.getChunks();
        const bounds = this.provider.getBounds();
        const voxelSize = this.provider.getVoxelSize();
        
        // Face templates (local coords relative to voxel center)
        const faceTemplates = [
            [[-0.5,-0.5,-0.5],[-0.5,0.5,-0.5],[0.5,0.5,-0.5],[0.5,-0.5,-0.5]], // -Z
            [[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]],     // +Z
            [[-0.5,-0.5,-0.5],[-0.5,-0.5,0.5],[-0.5,0.5,0.5],[-0.5,0.5,-0.5]], // -X
            [[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[0.5,0.5,0.5],[0.5,-0.5,0.5]],     // +X
            [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,-0.5,0.5],[-0.5,-0.5,0.5]], // -Y
            [[-0.5,0.5,-0.5],[-0.5,0.5,0.5],[0.5,0.5,0.5],[0.5,0.5,-0.5]]      // +Y
        ];
        
        const directions = [[0,0,-1], [0,0,1], [-1,0,0], [1,0,0], [0,-1,0], [0,1,0]];
        
        for (const [key, chunk] of chunks.entries()) {
            const parts = key.split(',');
            if (parts.length !== 3) continue;
            const cx = parseInt(parts[0]!, 10), cy = parseInt(parts[1]!, 10), cz = parseInt(parts[2]!, 10);
            if (isNaN(cx) || isNaN(cy) || isNaN(cz)) continue;
            
            const chunkWorldBaseX = (bounds?.minX ?? 0) + cx * CHUNK_SIZE * voxelSize;
            const chunkWorldBaseY = (bounds?.minY ?? 0) + cy * CHUNK_SIZE * voxelSize;
            const chunkWorldBaseZ = (bounds?.minZ ?? 0) + cz * CHUNK_SIZE * voxelSize;
            
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const block = chunk.get(lx, ly, lz);
                        if (block === 0) continue;
                        
                        const rgb24 = chunk.colors.get(lx, ly, lz);
                        const r = ((rgb24 >> 16) & 255) / 255;
                        const g = ((rgb24 >> 8) & 255) / 255;
                        const b = (rgb24 & 255) / 255;
                        
                        const center = new THREE.Vector3(
                            chunkWorldBaseX + lx * voxelSize + voxelSize / 2,
                            chunkWorldBaseY + ly * voxelSize + voxelSize / 2,
                            chunkWorldBaseZ + lz * voxelSize + voxelSize / 2
                        );
                        
                        for (let d = 0; d < 6; d++) {
                            const dir = directions[d]!;
                            const dx = dir[0]!, dy = dir[1]!, dz = dir[2]!;
                            const nx = lx + dx, ny = ly + dy, nz = lz + dz;
                            let neighborSolid = false;
                            
                            if (nx >= 0 && nx < CHUNK_SIZE && ny >= 0 && ny < CHUNK_SIZE && nz >= 0 && nz < CHUNK_SIZE) {
                                neighborSolid = chunk.get(nx, ny, nz) !== 0;
                            } else {
                                const acx = cx + (dx < 0 ? -1 : dx > 0 ? 1 : 0);
                                const acy = cy + (dy < 0 ? -1 : dy > 0 ? 1 : 0);
                                const acz = cz + (dz < 0 ? -1 : dz > 0 ? 1 : 0);
                                const adjChunk = chunks.get(`${acx},${acy},${acz}`);
                                if (adjChunk) {
                                    const alx = (nx + CHUNK_SIZE) % CHUNK_SIZE;
                                    const aly = (ny + CHUNK_SIZE) % CHUNK_SIZE;
                                    const alz = (nz + CHUNK_SIZE) % CHUNK_SIZE;
                                    neighborSolid = adjChunk.get(alx, aly, alz) !== 0;
                                }
                            }
                            
                            if (!neighborSolid) {
                                // Check if vertical face is under a floor (for shadow suppression)
                                let isUnderFloor = false;
                                if (d >= 0 && d <= 3) { // Vertical faces only
                                    for (let checkY = ly + 1; checkY < CHUNK_SIZE && !isUnderFloor; checkY++) {
                                        if (chunk.get(lx, checkY, lz) !== 0) isUnderFloor = true;
                                    }
                                }
                                
                                const template = faceTemplates[d]!;
                                for (const vtx of template) {
                                    positions.push(
                                        center.x + vtx[0]! * voxelSize,
                                        center.y + vtx[1]! * voxelSize,
                                        center.z + vtx[2]! * voxelSize
                                    );
                                    colors.push(r, g, b, isUnderFloor ? 0.0 : 1.0);
                                }
                                indices.push(vertexCount, vertexCount + 1, vertexCount + 2, vertexCount, vertexCount + 2, vertexCount + 3);
                                vertexCount += 4;
                            }
                        }
                    }
                }
            }
        }
        
        if (positions.length === 0) return null;
        
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        
        // Plain shadow material — the previous onBeforeCompile attached light-sphere
        // uniforms but the default shadow shader never referenced them, so dropping
        // that side-channel makes no visual difference.
        const material = new THREE.ShadowMaterial({ opacity: 0.5, transparent: true, vertexColors: true });
        this.shadowMaterial = material;
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        mesh.frustumCulled = false;
        mesh.renderOrder = 1000;
        mesh.name = 'VoxelShadowMesh';
        
        return mesh;
    }
    
    /** Generate light receiver mesh for additive lighting effects. */
    private generateLightReceiverMesh(geometry: THREE.BufferGeometry): THREE.Mesh | null {
        const MAX = this.MAX_LIGHT_SPHERES;

        // Mutable JS-side state — both backends reference these arrays directly
        // (TSL uniformArray under WebGPU; ShaderMaterial.uniforms[name].value
        // under WebGL), so writes from updateLightSphereUniforms reach the GPU.
        const positions = Array.from({ length: MAX }, () => new THREE.Vector3());
        const colors = Array.from({ length: MAX }, () => new THREE.Vector3());
        const radii: number[] = new Array(MAX).fill(0);
        const intensities: number[] = new Array(MAX).fill(0);

        let material: THREE.Material;
        let countRef: { value: number };

        if (isWebGpuActive()) {
            // countN is a float uniform — TSL `uniform(number)` only types as float;
            // we compare against `i.toFloat()` below.
            const countN = uniform(0);

            const positionsN = uniformArray(positions, 'vec3' as const);
            const colorsN = uniformArray(colors, 'vec3' as const);
            const radiiN = uniformArray(radii, 'float' as const);
            const intensitiesN = uniformArray(intensities, 'float' as const);

            const nodeMat = new MeshBasicNodeMaterial({
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
            });

            nodeMat.colorNode = Fn(() => {
                const totalLight = vec3(0, 0, 0).toVar();

                Loop({ start: int(0), end: int(MAX), type: 'int' }, ({ i }) => {
                    If(i.toFloat().greaterThanEqual(countN), () => { Break(); });

                    const pos = positionsN.element(i);
                    const radius = radiiN.element(i);
                    const dist = positionWorld.distance(pos);

                    If(dist.lessThan(radius), () => {
                        const falloff = float(1).sub(dist.div(radius)).toVar();
                        const sq = falloff.mul(falloff);
                        totalLight.assign(
                            totalLight.add(colorsN.element(i).mul(intensitiesN.element(i)).mul(sq))
                        );
                    });
                });

                Discard(totalLight.length().lessThan(0.01));
                return vec4(totalLight, 1.0);
            })();

            material = nodeMat;
            countRef = countN as unknown as { value: number };
        } else {
            const vertexShader = `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPos.xyz;
                    gl_Position = projectionMatrix * viewMatrix * worldPos;
                }
            `;
            const fragmentShader = `
                uniform int uLightSphereCount;
                uniform vec3 uLightSpherePositions[${MAX}];
                uniform float uLightSphereRadii[${MAX}];
                uniform vec3 uLightSphereColors[${MAX}];
                uniform float uLightSphereIntensities[${MAX}];
                varying vec3 vWorldPosition;
                void main() {
                    vec3 totalLight = vec3(0.0);
                    for (int i = 0; i < ${MAX}; i++) {
                        if (i >= uLightSphereCount) break;
                        float dist = distance(vWorldPosition, uLightSpherePositions[i]);
                        float radius = uLightSphereRadii[i];
                        if (dist < radius) {
                            float falloff = 1.0 - (dist / radius);
                            falloff = falloff * falloff;
                            totalLight += uLightSphereColors[i] * uLightSphereIntensities[i] * falloff;
                        }
                    }
                    if (length(totalLight) < 0.01) discard;
                    gl_FragColor = vec4(totalLight, 1.0);
                }
            `;

            const shaderMat = new THREE.ShaderMaterial({
                vertexShader, fragmentShader,
                transparent: true, blending: THREE.AdditiveBlending,
                depthWrite: false, side: THREE.DoubleSide,
                uniforms: {
                    uLightSphereCount: { value: 0 },
                    uLightSpherePositions: { value: positions },
                    uLightSphereRadii: { value: radii },
                    uLightSphereColors: { value: colors },
                    uLightSphereIntensities: { value: intensities },
                },
            });

            material = shaderMat;
            countRef = shaderMat.uniforms.uLightSphereCount as { value: number };
        }

        this.lightReceiverMaterial = material;
        this.lightSphereState = { count: countRef, positions, radii, colors, intensities };

        const mesh = new THREE.Mesh(geometry, material);
        mesh.receiveShadow = false;
        mesh.castShadow = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = 1002;
        mesh.name = 'VoxelLightReceiverMesh';

        return mesh;
    }
    
    /** Add a light sphere for additive lighting effects */
    addLightSphere(position: THREE.Vector3, radius: number, color: THREE.Color = new THREE.Color(1, 0.5, 0), intensity: number = 1.0): number {
        if (this.lightSpheres.length >= this.MAX_LIGHT_SPHERES) this.lightSpheres.shift();
        const id = this.nextLightSphereId++;
        this.lightSpheres.push({ position: position.clone(), radius, color: color.clone(), intensity, id });
        this.updateLightSphereUniforms();
        return id;
    }
    
    /** Remove a light sphere by ID */
    removeLightSphere(id: number): void {
        const index = this.lightSpheres.findIndex(ls => ls.id === id);
        if (index !== -1) { this.lightSpheres.splice(index, 1); this.updateLightSphereUniforms(); }
    }
    
    /** Remove all light spheres */
    clearLightSpheres(): void { this.lightSpheres = []; this.updateLightSphereUniforms(); }
    
    /** Update light sphere position */
    updateLightSpherePosition(id: number, newPosition: THREE.Vector3): void {
        const ls = this.lightSpheres.find(l => l.id === id);
        if (ls) { ls.position.copy(newPosition); this.updateLightSphereUniforms(); }
    }
    
    /** Push the current light spheres into the receiver material's uniform arrays. */
    private updateLightSphereUniforms(): void {
        const state = this.lightSphereState;
        if (!state) return;

        state.count.value = this.lightSpheres.length;
        for (let i = 0; i < this.MAX_LIGHT_SPHERES; i++) {
            const ls = this.lightSpheres[i];
            if (ls) {
                state.positions[i]!.copy(ls.position);
                state.radii[i] = ls.radius;
                state.colors[i]!.set(ls.color.r, ls.color.g, ls.color.b);
                state.intensities[i] = ls.intensity;
            } else {
                state.positions[i]!.set(0, 0, 0);
                state.radii[i] = 0;
                state.colors[i]!.set(0, 0, 0);
                state.intensities[i] = 0;
            }
        }
    }
    
    /** Clean up resources */
    dispose(): void {
        const parentGroup = this.provider.getParentGroup();
        if (this.shadowMesh) {
            parentGroup.remove(this.shadowMesh);
            this.shadowMesh.geometry.dispose();
            (this.shadowMesh.material as THREE.Material).dispose();
            this.shadowMesh = null;
        }
        if (this.lightReceiverMesh) {
            parentGroup.remove(this.lightReceiverMesh);
            this.lightReceiverMesh.geometry.dispose();
            (this.lightReceiverMesh.material as THREE.Material).dispose();
            this.lightReceiverMesh = null;
        }
        if (this.shadowUpdateTimeoutId !== null) clearTimeout(this.shadowUpdateTimeoutId);
    }
}
