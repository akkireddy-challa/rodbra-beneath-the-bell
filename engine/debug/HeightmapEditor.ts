import * as THREE from 'three';
import { DebugCameraController } from './DebugCameraController.js';
import type { EngineLike } from 'types/game.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';

export type HeightmapTool = 'additive' | 'flatten';
export type HeightmapShape = 'square' | 'circle';

export interface HeightmapToolSettings {
    tool: HeightmapTool;
    shape: HeightmapShape;
    size: number;
    strength: number;
    smoothness: number;
    mode: 'camera' | 'tool';
}

export class HeightmapEditor {
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private engine: EngineLike;
    private raycaster: THREE.Raycaster;
    private debugCameraController: DebugCameraController | null = null;
    private isEnabled: boolean = false;
    
    private toolPreview: THREE.Group | null = null;
    private previewMesh: THREE.Mesh | null = null;
    private currentGroundPosition: THREE.Vector3 | null = null;
    
    private settings: HeightmapToolSettings = {
        tool: 'additive',
        shape: 'circle',
        size: 10,
        strength: 0.5,
        smoothness: 0,
        mode: 'camera'
    };
    
    private mouse: THREE.Vector2 = new THREE.Vector2();
    private lastMouseX: number = -999;
    private lastMouseY: number = -999;
    private groundObjects: THREE.Object3D[] = [];
    private originalCameraController: any = null;
    private playerController: any = null;
    private groundObjectsCache: THREE.Object3D[] = [];
    private groundObjectsCacheTime: number = 0;
    private readonly GROUND_CACHE_DURATION = 60000; // Cache for 60 seconds - ground objects don't change during editing
    private lastPreviewUpdateTime: number = 0;
    private readonly PREVIEW_UPDATE_THROTTLE = 16; // Update preview max 60fps (16ms between updates)
    private bodiesToDestroy: any[] = []; // Queue bodies for destruction after physics step
    private physicsUpdateQueue: Array<{ type: 'remove' | 'add'; body: any; bodyIndex?: number }> = []; // Queue physics world modifications
    private shiftKeyPressed: boolean = false; // Track shift key state for temporary tool mode
    
    constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, engine: EngineLike) {
        this.scene = scene;
        this.camera = camera;
        this.engine = engine;
        this.raycaster = new THREE.Raycaster();
        this.raycaster.layers.set(0);
        
        if (!engine.renderer) {
            throw new Error('Engine renderer is required for HeightmapEditor');
        }
        
        this.debugCameraController = new DebugCameraController(camera, engine.renderer.domElement);
        
        this.setupEventListeners();
    }
    
    private boundOnMouseMove: ((event: MouseEvent) => void) | null = null;
    private boundOnMouseDown: ((event: MouseEvent) => void) | null = null;
    private boundOnMouseUp: ((event: MouseEvent) => void) | null = null;
    
    private boundOnCanvasClick: ((event: MouseEvent) => void) | null = null;
    private boundOnWindowFocus: (() => void) | null = null;
    private boundOnKeyDown: ((event: KeyboardEvent) => void) | null = null;
    private boundOnKeyUp: ((event: KeyboardEvent) => void) | null = null;
    
    private setupEventListeners(): void {
        if (!this.engine.renderer) return;
        const domElement = this.engine.renderer.domElement;
        
        // Store bound references so we can remove them later
        this.boundOnMouseMove = this.onMouseMove.bind(this);
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
        this.boundOnCanvasClick = this.onCanvasClick.bind(this);
        this.boundOnWindowFocus = this.onWindowFocus.bind(this);
        this.boundOnKeyDown = this.onKeyDown.bind(this);
        this.boundOnKeyUp = this.onKeyUp.bind(this);
        
        // Mouse listeners
        domElement.addEventListener('mousemove', this.boundOnMouseMove);
        domElement.addEventListener('mousedown', this.boundOnMouseDown);
        domElement.addEventListener('mouseup', this.boundOnMouseUp);
        domElement.addEventListener('click', this.boundOnCanvasClick);
        
        // Listen for window focus to re-activate camera controller
        window.addEventListener('focus', this.boundOnWindowFocus);
        
        // Keyboard listeners for shift key tracking (only for tool preview, not movement)
        window.addEventListener('keydown', this.boundOnKeyDown);
        window.addEventListener('keyup', this.boundOnKeyUp);
    }
    
    private onCanvasClick(event: MouseEvent): void {
        if (!this.isEnabled) return;
        
        // Focus the window when clicking on canvas in heightmap editor mode
        // This ensures keyboard input works after clicking toggle in creator panel
        window.focus();
        if (this.engine.renderer) {
            this.engine.renderer.domElement.focus();
        }
        
        // Re-activate camera controller to ensure listeners are attached
        if (this.debugCameraController) {
            this.debugCameraController.activate(this.camera);
        }
    }
    
    private onWindowFocus(): void {
        if (!this.isEnabled) return;
        
        // When window regains focus and heightmap editor is enabled, ensure camera controller is active
        if (this.debugCameraController && !this.debugCameraController.isActive) {
            this.debugCameraController.activate(this.camera);
        }
    }
    
    private onKeyDown(event: KeyboardEvent): void {
        if (!this.isEnabled) return;
        
        // Track shift key for temporary tool mode
        if (event.key === 'Shift' || event.shiftKey) {
            this.shiftKeyPressed = true;
        }
    }
    
    private onKeyUp(event: KeyboardEvent): void {
        if (!this.isEnabled) return;
        
        // Track shift key release
        if (event.key === 'Shift' || !event.shiftKey) {
            this.shiftKeyPressed = false;
            // Hide tool preview when shift is released in camera mode
            if (this.settings.mode === 'camera' && this.toolPreview) {
                this.toolPreview.visible = false;
            }
        }
    }
    
    private isMouseDown: boolean = false;
    private affectedRegions: Set<string> = new Set();
    private wasApplyingTool: boolean = false;
    private originalHeightmapData: Float32Array | null = null; // Store original heightmap for cancel
    private isEditing: boolean = false; // Track if we're in editing mode
    
    private onMouseDown(event: MouseEvent): void {
        if (!this.isEnabled || !this.engine.renderer) return;
        
        // Check if shift is pressed for temporary tool mode
        const shiftPressed = event.shiftKey;
        const effectiveMode = (this.settings.mode === 'camera' && shiftPressed) ? 'tool' : this.settings.mode;
        
        if (effectiveMode === 'tool' && event.button === 0) {
            // Tool mode: apply tool, prevent camera rotation
            event.preventDefault();
            event.stopPropagation();
            this.isMouseDown = true;
            this.wasApplyingTool = true;
            
            // Store original heightmap state when starting to edit
            if (!this.isEditing) {
                this.startEditing();
            }
            
            this.affectedRegions.clear();
            this.updateMousePosition(event);
            if (this.currentGroundPosition) {
                this.applyTool();
            }
        } else {
            // Camera mode: allow camera rotation
            this.wasApplyingTool = false;
            if (this.debugCameraController && this.debugCameraController.isActive) {
                this.debugCameraController.onMouseDown(event);
            }
        }
    }
    
    private onMouseUp(event: MouseEvent): void {
        // Check if shift is pressed for temporary tool mode
        const shiftPressed = event.shiftKey;
        const effectiveMode = (this.settings.mode === 'camera' && shiftPressed) ? 'tool' : this.settings.mode;
        
        if (event.button === 0) {
            // No longer update vegetation/foliage on mouse up during editing
            // Physics colliders are not updated during editing - only on Save
            this.isMouseDown = false;
            this.wasApplyingTool = false;
        }
        
        // Only forward mouse up to camera controller if NOT in tool mode
        if (effectiveMode !== 'tool' && this.debugCameraController && this.debugCameraController.isActive) {
            this.debugCameraController.onMouseUp(event);
        } else if (effectiveMode === 'tool') {
            // Prevent camera rotation in tool mode
            event.preventDefault();
            event.stopPropagation();
        }
    }
    
    private updateMousePosition(event: MouseEvent): void {
        if (!this.isEnabled || !this.engine.renderer) return;
        
        const rect = this.engine.renderer.domElement.getBoundingClientRect();
        const newMouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const newMouseY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        
        const mouseMoved = Math.abs(newMouseX - this.lastMouseX) > 0.001 || Math.abs(newMouseY - this.lastMouseY) > 0.001;
        
        if (mouseMoved) {
            this.mouse.x = newMouseX;
            this.mouse.y = newMouseY;
            this.lastMouseX = newMouseX;
            this.lastMouseY = newMouseY;
            
            // Update preview on mouse movement
            // Update if we're in tool mode OR camera mode with shift pressed
            const shouldShowTool = this.settings.mode === 'tool' || (this.settings.mode === 'camera' && this.shiftKeyPressed);
            if (shouldShowTool) {
                this.updateToolPreview();
            }
        }
    }
    
    private onMouseMove(event: MouseEvent): void {
        this.updateMousePosition(event);
        
        // Check if shift is pressed for temporary tool mode
        const shiftPressed = event.shiftKey;
        const effectiveMode = (this.settings.mode === 'camera' && shiftPressed) ? 'tool' : this.settings.mode;
        
        if (effectiveMode === 'tool') {
            // Tool mode: prevent camera rotation, apply tool if dragging
            event.preventDefault();
            event.stopPropagation();
            
            // Apply tool continuously while dragging
            if (this.isMouseDown && this.currentGroundPosition) {
                this.applyTool();
            }
        } else {
            // Camera mode: allow camera rotation
            if (this.debugCameraController && this.debugCameraController.isActive) {
                this.debugCameraController.onMouseMove(event);
            }
        }
    }
    
    private updateToolPreview(): void {
        if (!this.isEnabled) return;

        // Throttle updates to 60fps (16ms between updates)
        const now = Date.now();
        if (now - this.lastPreviewUpdateTime < this.PREVIEW_UPDATE_THROTTLE) {
            return;
        }
        this.lastPreviewUpdateTime = now;
        
        // Determine if we should show the tool preview
        // Show in tool mode OR camera mode with shift pressed
        const shouldShowTool = this.settings.mode === 'tool' || (this.settings.mode === 'camera' && this.shiftKeyPressed);
        
        if (!shouldShowTool) {
            // Hide preview when not in tool mode and shift is not pressed
            if (this.toolPreview) {
                this.toolPreview.visible = false;
            }
            return;
        }
        
        // Use cached ground objects - find them once, reuse forever
        if (this.groundObjectsCache.length === 0) {
            this.getGroundObjects();
            // If still no ground found, hide preview and return
            if (this.groundObjects.length === 0) {
                if (this.toolPreview) {
                    this.toolPreview.visible = false;
                }
                return;
            }
        } else {
            this.groundObjects = this.groundObjectsCache;
        }
        
        // Raycast from camera through mouse to ground
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.groundObjects, false);
        
        if (intersects.length > 0 && intersects[0]) {
            const hitPoint = intersects[0].point;
            this.currentGroundPosition = hitPoint.clone();
            
            // Update preview mesh position
            if (!this.toolPreview) {
                this.toolPreview = new THREE.Group();
                this.toolPreview.name = 'HeightmapToolPreview';
                this.scene.add(this.toolPreview);
            }
            
            if (!this.previewMesh) {
                this.createPreviewMesh();
            }
            
            if (this.previewMesh) {
                // Update geometry if settings changed
                const needsUpdate = this.previewMesh.userData.lastShape !== this.settings.shape || 
                                  this.previewMesh.userData.lastSize !== this.settings.size ||
                                  this.previewMesh.userData.lastTool !== this.settings.tool;
                
                if (needsUpdate) {
                    // Dispose old geometry/material
                    if (this.previewMesh.geometry) {
                        this.previewMesh.geometry.dispose();
                    }
                    if (this.previewMesh.material) {
                        (this.previewMesh.material as THREE.Material).dispose();
                    }
                    
                    // Create new geometry
                    const halfSize = this.settings.size / 2;
                    let geometry: THREE.BufferGeometry;
                    if (this.settings.shape === 'circle') {
                        const segments = 32;
                        geometry = new THREE.RingGeometry(0, halfSize, segments);
                    } else {
                        geometry = new THREE.PlaneGeometry(this.settings.size, this.settings.size);
                    }
                    
                    const material = new THREE.MeshBasicMaterial({
                        color: this.settings.tool === 'additive' ? 0x00ff00 : 0xff0000,
                        side: THREE.DoubleSide,
                        transparent: true,
                        opacity: 0.5,
                        depthWrite: false
                    });
                    
                    this.previewMesh.geometry = geometry;
                    this.previewMesh.material = material;
                    this.previewMesh.rotation.x = -Math.PI / 2;
                    
                    this.previewMesh.userData.lastShape = this.settings.shape;
                    this.previewMesh.userData.lastSize = this.settings.size;
                    this.previewMesh.userData.lastTool = this.settings.tool;
                }
                
                // Position preview at hit point (flat plane, slightly above ground)
                this.toolPreview.position.set(hitPoint.x, hitPoint.y + 0.01, hitPoint.z);
                this.toolPreview.visible = true;
            }
        } else {
            this.currentGroundPosition = null;
            if (this.toolPreview) {
                this.toolPreview.visible = false;
            }
        }
    }
    
    
    private getGroundObjects(): void {
        const now = Date.now();
        if (this.groundObjectsCache.length > 0 && (now - this.groundObjectsCacheTime) < this.GROUND_CACHE_DURATION) {
            this.groundObjects = this.groundObjectsCache;
            return;
        }
        
        this.findGroundObjects();
        this.groundObjectsCache = [...this.groundObjects];
        this.groundObjectsCacheTime = now;
    }
    
    private findGroundObjects(): void {
        this.groundObjects = [];
        
        // ALWAYS get ground mesh directly from WorldGenerator - never traverse scene
        const worldGenerator = this.getWorldGenerator();
        if (!worldGenerator) {
            console.warn('[HeightmapEditor] WorldGenerator not found');
            return;
        }
        
        // Check for groundChunkGroup first (chunked-ground world generators)
        const groundChunkGroup = (worldGenerator as any).groundChunkGroup;
        if (groundChunkGroup instanceof THREE.Group) {
            // Chunked ground: get all chunk meshes from groundChunkGroup
            groundChunkGroup.traverse((object) => {
                if (object instanceof THREE.Mesh && object.visible) {
                    this.groundObjects.push(object);
                }
            });
            if (this.groundObjects.length > 0) {
                console.log(`[HeightmapEditor] Found ${this.groundObjects.length} ground chunks from groundChunkGroup`);
                return;
            }
        }
        
        // Fallback: check for groundChunkData (alternative chunk tracking)
        const groundChunkData = (worldGenerator as any).groundChunkData;
        if (Array.isArray(groundChunkData) && groundChunkData.length > 0) {
            groundChunkData.forEach((chunk: any) => {
                if (chunk.visualMesh && chunk.visualMesh instanceof THREE.Mesh && chunk.visualMesh.visible) {
                    this.groundObjects.push(chunk.visualMesh);
                }
            });
            if (this.groundObjects.length > 0) {
                console.log(`[HeightmapEditor] Found ${this.groundObjects.length} ground chunks from groundChunkData`);
                return;
            }
        }
        
        // Fallback: check for single groundMesh (older games)
        const groundMesh = (worldGenerator as any).groundMesh;
        if (groundMesh) {
            if (groundMesh instanceof THREE.Mesh) {
                // Single mesh - most common case
                this.groundObjects = [groundMesh];
                console.log('[HeightmapEditor] Found single groundMesh');
            } else if (groundMesh instanceof THREE.Group) {
                // Group of meshes - add all child meshes
                groundMesh.traverse((object) => {
                    if (object instanceof THREE.Mesh && object.visible) {
                        this.groundObjects.push(object);
                    }
                });
                if (this.groundObjects.length > 0) {
                    console.log(`[HeightmapEditor] Found ${this.groundObjects.length} ground meshes from groundMesh Group`);
                }
            }
        }
        
        if (this.groundObjects.length === 0) {
            console.warn('[HeightmapEditor] No ground objects found! Cannot show tool preview.');
        }
    }
    
    
    private adjustPreviewToHeightmap(position: THREE.Vector3): void {
        if (!this.previewMesh || !this.toolPreview) return;
        
        const worldGenerator = this.getWorldGenerator();
        if (!worldGenerator) {
            this.toolPreview.position.y = position.y + 0.01;
            return;
        }
        
        const centerHeight = worldGenerator.getHeightAt(position.x, position.z);
        if (centerHeight !== undefined && centerHeight !== null) {
            this.toolPreview.position.y = centerHeight + 0.01;
        } else {
            this.toolPreview.position.y = position.y + 0.01;
        }
    }
    
    private createPreviewMesh(): void {
        const geometry = new THREE.RingGeometry(0, 1, 32);
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.5
        });
        
        this.previewMesh = new THREE.Mesh(geometry, material);
        this.previewMesh.name = 'HeightmapBrushPreview';
        this.previewMesh.rotation.x = -Math.PI / 2;
        this.toolPreview!.add(this.previewMesh);
    }
    
    private getWorldGenerator(): any {
        const genreModule = (this.engine as any).genreModule;
        if (genreModule && genreModule.worldGenerator) {
            return genreModule.worldGenerator;
        }
        return null;
    }
    
    private getHeightmapSystem(): any {
        const worldGenerator = this.getWorldGenerator();
        if (worldGenerator && worldGenerator.heightmapSystem) {
            return worldGenerator.heightmapSystem;
        }
        return null;
    }
    
    private applyTool(): void {
        if (!this.currentGroundPosition) return;
        
        const heightmapSystem = this.getHeightmapSystem();
        if (!heightmapSystem) {
            return;
        }
        
        const centerX = this.currentGroundPosition.x;
        const centerZ = this.currentGroundPosition.z;
        const radius = this.settings.size / 2;
        const smoothnessPercent = this.settings.smoothness / 100;
        
        if (this.settings.tool === 'flatten') {
            const targetHeight = heightmapSystem.getHeightAt(centerX, centerZ);
            this.applyHeightmapModification(heightmapSystem, centerX, centerZ, radius, targetHeight, true);
        } else {
            const currentHeight = heightmapSystem.getHeightAt(centerX, centerZ);
            // Strength is 1/10th of the UI value
            const targetHeight = currentHeight + (this.settings.strength * 0.1);
            this.applyHeightmapModification(heightmapSystem, centerX, centerZ, radius, targetHeight, false);
        }
        
        const worldGenerator = this.getWorldGenerator();
        if (worldGenerator) {
            // Calculate affected chunks from affected regions
            const affectedChunkKeys = this.calculateAffectedChunkKeys(worldGenerator);
            
            // Update only visual meshes (no physics colliders) during editing
            if (worldGenerator.updateVisualMeshesOnly) {
                worldGenerator.updateVisualMeshesOnly(affectedChunkKeys);
            } else if (worldGenerator.regenerateGroundMesh) {
                // Fallback: use regenerateGroundMesh but it will update physics too
                worldGenerator.regenerateGroundMesh(affectedChunkKeys);
            } else if (worldGenerator.regenerateTerrain) {
                worldGenerator.regenerateTerrain();
            }
            
            // Physics colliders will NOT be updated during editing - only on Save
        }
    }
    
    private applyHeightmapModification(
        heightmapSystem: any,
        centerX: number,
        centerZ: number,
        radius: number,
        targetHeight: number,
        isFlatten: boolean
    ): void {
        const heightmapData = heightmapSystem.getHeightmapData();
        if (!heightmapData) return;
        
        const { width, height, minX, maxX, minZ, maxZ, heights } = heightmapData;
        const cellSizeX = (maxX - minX) / (width - 1);
        const cellSizeZ = (maxZ - minZ) / (height - 1);
        
        const smoothnessPercent = this.settings.smoothness / 100;
        const smoothRadius = radius * smoothnessPercent;
        const fullEffectRadius = radius - smoothRadius;
        
        const minXIdx = Math.max(0, Math.floor((centerX - radius - minX) / cellSizeX));
        const maxXIdx = Math.min(width - 1, Math.ceil((centerX + radius - minX) / cellSizeX));
        const minZIdx = Math.max(0, Math.floor((centerZ - radius - minZ) / cellSizeZ));
        const maxZIdx = Math.min(height - 1, Math.ceil((centerZ + radius - minZ) / cellSizeZ));
        
        const worldGenerator = this.getWorldGenerator();
        const worldSize = worldGenerator ? (worldGenerator as any).worldSize : 256;
        const regionSizeMeters = 8;
        const halfWorld = worldSize / 2;
        
        for (let zIdx = minZIdx; zIdx <= maxZIdx; zIdx++) {
            for (let xIdx = minXIdx; xIdx <= maxXIdx; xIdx++) {
                const worldX = minX + (xIdx / (width - 1)) * (maxX - minX);
                const worldZ = minZ + (zIdx / (height - 1)) * (maxZ - minZ);
                
                let distance: number;
                if (this.settings.shape === 'circle') {
                    distance = Math.sqrt((worldX - centerX) ** 2 + (worldZ - centerZ) ** 2);
                } else {
                    const dx = Math.abs(worldX - centerX);
                    const dz = Math.abs(worldZ - centerZ);
                    distance = Math.max(dx, dz);
                }
                
                if (distance <= radius) {
                    const index = zIdx * width + xIdx;
                    const currentHeight = heights[index] ?? 0;
                    
                    let effectStrength = 1.0;
                    
                    if (smoothnessPercent > 0 && distance > fullEffectRadius) {
                        const smoothDistance = distance - fullEffectRadius;
                        const smoothRange = smoothRadius;
                        effectStrength = 1.0 - (smoothDistance / smoothRange);
                        effectStrength = Math.max(0, Math.min(1, effectStrength));
                    }
                    
                    if (isFlatten) {
                        const heightDelta = (targetHeight - currentHeight) * effectStrength;
                        heights[index] = currentHeight + heightDelta;
                    } else {
                        // Strength is 1/10th of the UI value
                        const heightDelta = (this.settings.strength * 0.1) * effectStrength;
                        heights[index] = currentHeight + heightDelta;
                    }
                    
                    const regionX = Math.floor((worldX + halfWorld) / regionSizeMeters);
                    const regionZ = Math.floor((worldZ + halfWorld) / regionSizeMeters);
                    const regionKey = `${regionX}_${regionZ}`;
                    this.affectedRegions.add(regionKey);
                }
            }
        }
        
        // Mark heightmap as dirty since it was modified
        if (heightmapSystem.markDirty) {
            heightmapSystem.markDirty();
        }
    }
    
    /**
     * Start editing mode - store original heightmap state.
     */
    private startEditing(): void {
        const heightmapSystem = this.getHeightmapSystem();
        if (!heightmapSystem) return;
        
        const heightmapData = heightmapSystem.getHeightmapData();
        if (!heightmapData) return;
        
        // Store a copy of the original heightmap data
        this.originalHeightmapData = new Float32Array(heightmapData.heights);
        this.isEditing = true;
        
        console.log('📝 Heightmap editing started - original state saved');
    }
    
    /**
     * Cancel editing - restore original heightmap state.
     */
    async cancelEditing(): Promise<void> {
        if (!this.isEditing || !this.originalHeightmapData) {
            console.log('⚠️ No editing session to cancel');
            return;
        }
        
        const heightmapSystem = this.getHeightmapSystem();
        if (!heightmapSystem) {
            console.error('❌ Cannot cancel: heightmap system not found');
            return;
        }
        
        const heightmapData = heightmapSystem.getHeightmapData();
        if (!heightmapData) {
            console.error('❌ Cannot cancel: no heightmap data');
            return;
        }
        
        // Restore original heightmap data
        heightmapData.heights.set(this.originalHeightmapData);
        
        // Update all visual meshes to reflect restored heightmap
        const worldGenerator = this.getWorldGenerator();
        if (worldGenerator && worldGenerator.updateVisualMeshesOnly) {
            worldGenerator.updateVisualMeshesOnly(); // Update all chunks
        }
        
        // Clear editing state
        this.originalHeightmapData = null;
        this.isEditing = false;
        this.affectedRegions.clear();
        
        console.log('✅ Heightmap editing cancelled - original state restored');
    }
    
    /**
     * Save and apply heightmap changes - send to creator to save to backend and reload.
     */
    async saveAndApplyHeightmap(): Promise<void> {
        if (!this.isEditing) {
            console.log('⚠️ No editing session to save');
            return;
        }
        
        const heightmapSystem = this.getHeightmapSystem();
        if (!heightmapSystem) {
            console.error('❌ Cannot save: heightmap system not found');
            return;
        }
        
        const heightmapData = heightmapSystem.getHeightmapData();
        if (!heightmapData) {
            console.error('❌ Cannot save: no heightmap data');
            return;
        }
        
        // Send heightmap data to creator (parent window) to save
        // Creator will handle the authenticated API call
        safePostMessageToCreator({
            type: 'SAVE_HEIGHTMAP',
            data: {
                heightmapData: {
                    width: heightmapData.width,
                    height: heightmapData.height,
                    heights: Array.from(heightmapData.heights), // Convert Float32Array to regular array
                    minX: heightmapData.minX,
                    maxX: heightmapData.maxX,
                    minZ: heightmapData.minZ,
                    maxZ: heightmapData.maxZ,
                    minY: heightmapData.minY,
                    maxY: heightmapData.maxY
                }
            }
        });

        // Clear editing state
        this.originalHeightmapData = null;
        this.isEditing = false;
        this.affectedRegions.clear();

        console.log('✅ Heightmap data sent to creator for saving');
    }

    private updateVegetationAndFoliage(): void {
        // This method is no longer used during editing - physics colliders are not updated
        // It's kept for backward compatibility but should not be called
        console.warn('⚠️ updateVegetationAndFoliage called but should not be used during heightmap editing');
    }
    
    /**
     * Calculate which chunk keys are affected based on affected regions.
     */
    private calculateAffectedChunkKeys(worldGenerator: any): Set<string> {
        const affectedChunkKeys = new Set<string>();
        
        // Get chunk size from WorldGenerator (should be 16)
        const chunkSize = 16; // WorldGenerator.GROUND_CHUNK_SIZE
        const worldSizeX = (worldGenerator as any).groundSettings?.worldSizeX || (worldGenerator as any).worldSize || 256;
        const worldSizeZ = (worldGenerator as any).groundSettings?.worldSizeZ || (worldGenerator as any).worldSize || 256;
        const halfWorldX = worldSizeX / 2;
        const halfWorldZ = worldSizeZ / 2;
        const chunksPerSideX = Math.ceil(worldSizeX / chunkSize);
        const chunksPerSideZ = Math.ceil(worldSizeZ / chunkSize);
        
        // Convert affected regions to affected chunks
        const regionSizeMeters = 8;
        const halfWorld = Math.max(halfWorldX, halfWorldZ); // Use max for region calculation
        
        for (const regionKey of this.affectedRegions) {
            const parts = regionKey.split('_');
            if (parts.length !== 2) continue;
            
            const regionX = Number(parts[0]);
            const regionZ = Number(parts[1]);
            
            if (isNaN(regionX) || isNaN(regionZ)) continue;
            
            // Calculate region bounds
            const centerX = (regionX * regionSizeMeters) - halfWorld + (regionSizeMeters / 2);
            const centerZ = (regionZ * regionSizeMeters) - halfWorld + (regionSizeMeters / 2);
            const minX = centerX - regionSizeMeters / 2;
            const maxX = centerX + regionSizeMeters / 2;
            const minZ = centerZ - regionSizeMeters / 2;
            const maxZ = centerZ + regionSizeMeters / 2;
            
            // Calculate chunk coordinates for this region
            const minChunkX = Math.max(0, Math.floor((minX + halfWorldX) / chunkSize));
            const maxChunkX = Math.min(chunksPerSideX - 1, Math.floor((maxX + halfWorldX) / chunkSize));
            const minChunkZ = Math.max(0, Math.floor((minZ + halfWorldZ) / chunkSize));
            const maxChunkZ = Math.min(chunksPerSideZ - 1, Math.floor((maxZ + halfWorldZ) / chunkSize));
            
            // Add all chunks that overlap with this region
            for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
                for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
                    affectedChunkKeys.add(`${chunkX}_${chunkZ}`);
                }
            }
        }
        
        return affectedChunkKeys;
    }

    private regenerateAffectedGroundPhysics(worldGenerator: any, affectedAreas: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>): void {
        if (!this.engine.physicsWorld) {
            return;
        }
        
        const worldBodies = worldGenerator.getWorldBodies();
        if (!worldBodies || worldBodies.length === 0) {
            return;
        }
        
        const chunkSize = 16;
        const worldSize = (worldGenerator as any).worldSize || 256;
        const chunksPerSide = Math.ceil(worldSize / chunkSize);
        const halfWorld = worldSize / 2;
        
        // Calculate which chunks are affected
        const affectedChunks = new Set<string>();
        
        for (const area of affectedAreas) {
            // Calculate chunk coordinates for this area
            const minChunkX = Math.max(0, Math.floor((area.minX + halfWorld) / chunkSize));
            const maxChunkX = Math.min(chunksPerSide - 1, Math.floor((area.maxX + halfWorld) / chunkSize));
            const minChunkZ = Math.max(0, Math.floor((area.minZ + halfWorld) / chunkSize));
            const maxChunkZ = Math.min(chunksPerSide - 1, Math.floor((area.maxZ + halfWorld) / chunkSize));
            
            // Add all chunks that overlap with this area
            for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
                for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
                    affectedChunks.add(`${chunkX}_${chunkZ}`);
                }
            }
        }
        
        if (affectedChunks.size === 0) {
            return;
        }
        
        // Get heightmap data for recreation
        const heightmapSystem = this.getHeightmapSystem();
        if (!heightmapSystem) {
            return;
        }
        
        const heightmapData = heightmapSystem.getHeightmapData();
        if (!heightmapData) {
            return;
        }
        
        const { minX, maxX, minZ, maxZ } = heightmapData;
        const physicsResolutionPerChunk = 32;
        
        // Remove and recreate affected chunks using queue system
        const bodiesToRemove: Array<{ body: any; chunkX: number; chunkZ: number; bodyIndex: number }> = [];
        
        // First, collect all bodies to remove
        for (const chunkKey of affectedChunks) {
            const parts = chunkKey.split('_');
            if (parts.length !== 2) continue;
            
            const chunkX = parseInt(parts[0]!, 10);
            const chunkZ = parseInt(parts[1]!, 10);
            
            if (isNaN(chunkX) || isNaN(chunkZ)) continue;
            
            // Calculate body index for this chunk
            const bodyIndex = chunkZ * chunksPerSide + chunkX;
            
            if (bodyIndex >= 0 && bodyIndex < worldBodies.length) {
                const body = worldBodies[bodyIndex];
                if (body) {
                    bodiesToRemove.push({ body, chunkX, chunkZ, bodyIndex });
                }
            }
        }
        
        if (bodiesToRemove.length === 0) return;
        
        // Queue bodies for removal from physics world (don't modify during simulation)
        // Remove from array immediately (safe to do)
        bodiesToRemove.sort((a, b) => b.bodyIndex - a.bodyIndex);
        for (const { body, bodyIndex } of bodiesToRemove) {
            // Queue for removal from physics world
            this.physicsUpdateQueue.push({ type: 'remove', body });
            
            // Remove from array immediately (safe - array manipulation doesn't affect physics simulation)
            if (worldBodies[bodyIndex] === body) {
                worldBodies.splice(bodyIndex, 1);
            } else {
                const index = worldBodies.indexOf(body);
                if (index !== -1) {
                    worldBodies.splice(index, 1);
                }
            }
            
            // Queue for destruction after physics step
            this.bodiesToDestroy.push(body);
        }
        
        // Recreate affected chunks (in order) - but don't add to physics world yet
        const chunksToRecreate = bodiesToRemove.sort((a, b) => a.bodyIndex - b.bodyIndex);
        
        for (const { chunkX, chunkZ, bodyIndex } of chunksToRecreate) {
            try {
                // Temporarily store the current length to detect if body was auto-added
                const originalWorldBodiesLength = worldBodies.length;
                
                // Create the physics chunk (this will add it to worldBodies array)
                // createPhysicsChunk builds collision mesh from heightmap data
                const body = (worldGenerator as any).createPhysicsChunk(
                    heightmapData,
                    chunkX,
                    chunkZ,
                    chunkSize,
                    physicsResolutionPerChunk,
                    minX,
                    maxX,
                    minZ,
                    maxZ
                );
                
                if (!body) {
                    continue;
                }
                
                // Validate body is complete before queuing
                if (!body.getMotionState || !body.getCollisionShape) {
                    // Remove from worldBodies if it was added
                    const index = worldBodies.indexOf(body);
                    if (index !== -1) {
                        worldBodies.splice(index, 1);
                    }
                    continue;
                }
                
                // createPhysicsChunk adds to worldBodies automatically
                // We need to ensure it's at the correct position
                const wasAdded = worldBodies.length > originalWorldBodiesLength;
                if (wasAdded) {
                    // Body was added at the end, move it to correct position
                    const lastIndex = worldBodies.length - 1;
                    if (worldBodies[lastIndex] === body) {
                        worldBodies.splice(lastIndex, 1);
                        worldBodies.splice(bodyIndex, 0, body);
                    }
                } else {
                    // Body might already be in array, ensure correct position
                    const currentIndex = worldBodies.indexOf(body);
                    if (currentIndex !== -1 && currentIndex !== bodyIndex) {
                        worldBodies.splice(currentIndex, 1);
                        worldBodies.splice(bodyIndex, 0, body);
                    }
                }
                
                // Queue for addition to physics world (don't add during simulation)
                this.physicsUpdateQueue.push({ type: 'add', body });
            } catch (error) {
                // Silently continue - chunk recreation failed
            }
        }
    }
    
    private regenerateGroundPhysics(worldGenerator: any): void {
        if (!this.engine.physicsWorld) {
            return;
        }
        
        const worldBodies = worldGenerator.getWorldBodies();
        if (!worldBodies || worldBodies.length === 0) {
            return;
        }
        
        // Find and remove all ground physics bodies
        // Ground bodies are typically at the start of the array (created first)
        // We need to remove them from physics world and destroy them
        const bodiesToRemove: any[] = [];
        const chunkSize = 16;
        const worldSize = (worldGenerator as any).worldSize || 256;
        const chunksPerSide = Math.ceil(worldSize / chunkSize);
        const expectedGroundBodies = chunksPerSide * chunksPerSide;
        
        // Remove first N bodies (ground physics chunks)
        for (let i = 0; i < Math.min(expectedGroundBodies, worldBodies.length); i++) {
            const body = worldBodies[i];
            if (body) {
                this.engine.physicsWorld!.removeRigidBody(body);
                // Rapier handles cleanup automatically when body is removed
                bodiesToRemove.push(body);
            }
        }
        
        // Remove bodies from array
        for (const body of bodiesToRemove) {
            const index = worldBodies.indexOf(body);
            if (index !== -1) {
                worldBodies.splice(index, 1);
            }
        }
        
        // Recreate ground physics with updated heightmap
        if (worldGenerator.createGroundPhysics) {
            worldGenerator.createGroundPhysics();
        }
        
    }
    
    private updateTreesAndRocks(world: THREE.Object3D, heightmapSystem: any, affectedAreas: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>): void {
        const processedObjects = new Set<THREE.Object3D>();
        
        world.traverse((object) => {
            if (processedObjects.has(object)) return;
            
            const name = object.name.toLowerCase();
            const isTree = name.includes('tree') || name.includes('trunk') || name.includes('leaves');
            const isRock = name.includes('rock') || name.includes('stone');
            
            if (!isTree && !isRock) return;
            
            const worldPos = new THREE.Vector3();
            object.getWorldPosition(worldPos);
            
            for (const area of affectedAreas) {
                if (worldPos.x >= area.minX && worldPos.x <= area.maxX &&
                    worldPos.z >= area.minZ && worldPos.z <= area.maxZ) {
                    
                    const newHeight = heightmapSystem.getHeightAt(worldPos.x, worldPos.z);
                    if (newHeight !== undefined && newHeight !== null) {
                        const currentLocalY = object.position.y;
                        const currentWorldY = worldPos.y;
                        const heightDelta = newHeight - (currentWorldY - currentLocalY);
                        
                        if (isRock) {
                            const mesh = object as THREE.Mesh;
                            if (mesh.geometry && mesh.geometry.type === 'BoxGeometry') {
                                const geometry = mesh.geometry as THREE.BoxGeometry;
                                const rockHeight = geometry.parameters.height;
                                object.position.y = heightDelta + rockHeight / 2 + 0.001;
                            } else {
                                object.position.y = heightDelta + 0.001;
                            }
                        } else {
                            object.position.y = heightDelta + 0.001;
                        }
                        
                        processedObjects.add(object);
                    }
                    break;
                }
            }
        });
    }
    
    public setSettings(settings: HeightmapToolSettings): void {
        const previousMode = this.settings.mode;
        this.settings = { ...settings };
        
        // Ensure controller is active (but don't force re-activate if already active)
        if (this.isEnabled && this.debugCameraController && !this.debugCameraController.isActive) {
            this.debugCameraController.activate(this.camera);
        }
        
        // Hide tool preview when switching from Tool mode to Camera mode
        if (previousMode === 'tool' && this.settings.mode === 'camera' && !this.shiftKeyPressed) {
            if (this.toolPreview) {
                this.toolPreview.visible = false;
            }
        }
        
        // Update tool preview immediately when switching to tool mode
        if (this.isEnabled && this.settings.mode === 'tool') {
            // Initialize mouse position to center if not set
            if (this.lastMouseX === -999 || this.lastMouseY === -999) {
                this.mouse.x = 0;
                this.mouse.y = 0;
                this.lastMouseX = 0;
                this.lastMouseY = 0;
            }
            this.updateToolPreview();
        }
        
        // Preview is updated in updateToolPreview() which is called from onMouseMove and update()
    }
    
    public setEnabled(enabled: boolean): void {
        if (enabled === this.isEnabled) return;
        
        this.isEnabled = enabled;
        
        if (enabled) {
            this.saveCameraAndPlayerState();
            this.disablePlayerAndCamera();
            
            // Always activate camera controller - WASD works in both camera and tool modes
            if (this.debugCameraController) {
                this.debugCameraController.activate(this.camera);
            }
            
            if (!this.toolPreview) {
                this.toolPreview = new THREE.Group();
                this.toolPreview.name = 'HeightmapToolPreview';
                this.scene.add(this.toolPreview);
            }
            
            this.toolPreview.visible = false;
            
            window.focus();
            if (this.engine.renderer && this.engine.renderer.domElement) {
                this.engine.renderer.domElement.focus();
            }
            
        } else {
            if (this.debugCameraController) {
                this.debugCameraController.deactivate();
            }
            
            this.restorePlayerAndCamera();
            
            if (this.toolPreview) {
                this.toolPreview.visible = false;
            }
        }
    }
    
    private saveCameraAndPlayerState(): void {
        const playerController = this.engine.getPlayerController();
        if (playerController) {
            this.playerController = playerController;
            if ((playerController as any).cameraController) {
                this.originalCameraController = (playerController as any).cameraController;
            }
        }
        
        if (!this.playerController && this.engine.genreModule) {
            // Access genre-specific playerController property
            const game = this.engine.genreModule as { playerController?: any; cameraController?: any };
            if (game?.playerController) {
                this.playerController = game.playerController;
                if (this.playerController.cameraController) {
                    this.originalCameraController = this.playerController.cameraController;
                }
            }
        }
    }
    
    private disablePlayerAndCamera(): void {
        if (this.playerController) {
            if (this.playerController.cameraController && this.playerController.cameraController.setEnabled) {
                this.playerController.cameraController.setEnabled(false);
            }
            
            if (typeof (this.playerController as any).setControlsEnabled === 'function') {
                (this.playerController as any).setControlsEnabled(false);
            } else if (typeof (this.playerController as any).setEnabled === 'function') {
                (this.playerController as any).setEnabled(false);
            }
        }
    }
    
    private restorePlayerAndCamera(): void {
        if (this.playerController) {
            if (this.originalCameraController && this.originalCameraController.setEnabled) {
                this.originalCameraController.setEnabled(true);
            }
            
            if (typeof (this.playerController as any).setControlsEnabled === 'function') {
                (this.playerController as any).setControlsEnabled(true);
            } else if (typeof (this.playerController as any).setEnabled === 'function') {
                (this.playerController as any).setEnabled(true);
            }
        }
    }
    
    public update(deltaTime: number): void {
        if (!this.isEnabled) return;
        
        // Process physics world modifications after physics step completes
        // This prevents WASM errors from modifying physics world during simulation
        if (this.physicsUpdateQueue.length > 0 && this.engine.physicsWorld) {
            // Process removes first, then adds
            const removes = this.physicsUpdateQueue.filter(u => u.type === 'remove');
            const adds = this.physicsUpdateQueue.filter(u => u.type === 'add');
            
            // Remove bodies first
            for (const update of removes) {
                try {
                    if (update.body) {
                        this.engine.physicsWorld.removeRigidBody(update.body);
                    }
                } catch (error) {
                    // Silently continue - body removal failed
                }
            }
            
            // Add bodies immediately after removes (before next physics step)
            // Validate each body thoroughly before adding to prevent WASM errors
            for (const update of adds) {
                try {
                    const body = update.body;
                    if (!body) {
                        continue;
                    }
                    
                    // Validate body has all required methods
                    if (!body.getMotionState || !body.getCollisionShape) {
                        continue;
                    }
                    
                    // Validate shape exists and is valid
                    const shape = body.getCollisionShape();
                    if (!shape) {
                        continue;
                    }
                    
                    // Validate motion state exists
                    const motionState = body.getMotionState();
                    if (!motionState) {
                        continue;
                    }
                    
                    // Check if body is already in the physics world
                    // We track this ourselves by checking if body is in worldBodies array
                    // and assume if it's in the queue, it's new
                    
                    // All validations passed, safe to add
                    this.engine.physicsWorld.addRigidBody(body);
                } catch (error) {
                    // Don't add invalid bodies - they'll cause WASM errors
                }
            }
            
            this.physicsUpdateQueue = [];
        }
        
        // Clear queued physics bodies after physics step completes
        // Rapier handles cleanup automatically when bodies are removed from the world
        if (this.bodiesToDestroy.length > 0) {
            this.bodiesToDestroy = [];
        }
        
        // Update tool preview every frame when in tool mode OR when shift is pressed in Camera mode
        // This ensures the tool follows the mouse/camera even when mouse isn't moving
        if (this.settings.mode === 'tool' || (this.settings.mode === 'camera' && this.shiftKeyPressed)) {
            this.updateToolPreview();
        }
        
        // Camera controller stays active in both modes - WASD always works
        if (this.debugCameraController) {
            if (!this.debugCameraController.isActive) {
                this.debugCameraController.activate(this.camera);
            }
            this.debugCameraController.update(deltaTime);
        }
    }
    
    public dispose(): void {
        // Remove event listeners
        if (this.engine.renderer) {
            const domElement = this.engine.renderer.domElement;
            if (this.boundOnMouseMove) {
                domElement.removeEventListener('mousemove', this.boundOnMouseMove);
            }
            if (this.boundOnMouseDown) {
                domElement.removeEventListener('mousedown', this.boundOnMouseDown);
            }
            if (this.boundOnMouseUp) {
                domElement.removeEventListener('mouseup', this.boundOnMouseUp);
            }
            if (this.boundOnCanvasClick) {
                domElement.removeEventListener('click', this.boundOnCanvasClick);
            }
        }
        
        if (this.boundOnWindowFocus) {
            window.removeEventListener('focus', this.boundOnWindowFocus);
        }
        
        // Remove keyboard listeners for shift key tracking
        if (this.boundOnKeyDown) {
            window.removeEventListener('keydown', this.boundOnKeyDown);
        }
        if (this.boundOnKeyUp) {
            window.removeEventListener('keyup', this.boundOnKeyUp);
        }
        
        if (this.toolPreview) {
            if (this.previewMesh && this.previewMesh.geometry) {
                this.previewMesh.geometry.dispose();
            }
            if (this.previewMesh && this.previewMesh.material) {
                (this.previewMesh.material as THREE.Material).dispose();
            }
            this.scene.remove(this.toolPreview);
            this.toolPreview = null;
            this.previewMesh = null;
        }
        
        if (this.debugCameraController) {
            this.debugCameraController.deactivate();
        }
    }
}

