import * as THREE from 'three';
// three's WEBGPU build is what `three` resolves to (one module instance —
// r185's node lighting matches lights by class identity, and a split across the
// core and webgpu builds renders every scene unlit). That build has no
// WebGLRenderer, so the classic renderer is imported from its own module. The
// classic path is duck-typed (isMesh / isDirectionalLight), so it renders
// objects built by the webgpu bundle without trouble.
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { DebugCameraController } from 'debug/DebugCameraController.js';
import { getAgentUrl } from 'engine/agentUrl.js';

export interface CameraMarkerData {
    id: number;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number }; // Euler angles in radians
    timestamp: number; // Time in seconds to reach this marker
}

export interface CameraPathData {
    markers: CameraMarkerData[];
}

/**
 * One keyframe of an authored fly-through (`bitmagic trailer record --flythrough`). Either an
 * Euler `rotation` (radians, camera convention: -Z forward) or a `lookAt` point the camera should
 * face from `position`; `lookAt` is the form a person or an agent can write by hand.
 */
export interface FlythroughMarker {
    position: { x: number; y: number; z: number };
    rotation?: { x: number; y: number; z: number };
    lookAt?: { x: number; y: number; z: number };
    /** Seconds from the start of the path. */
    timestamp: number;
}

export interface FlythroughPath {
    version: 1;
    name?: string;
    markers: FlythroughMarker[];
}

export class CameraPathEditor {
    private scene: THREE.Scene;
    private camera: THREE.Camera;
    private domElement: HTMLElement;
    
    private markers: Array<{ data: CameraMarkerData; helper: THREE.Group }> = [];
    private selectedMarker: { data: CameraMarkerData; helper: THREE.Group } | null = null;
    private isEnabled: boolean = false;
    private gameId: string = '';
    
    private debugCameraController: DebugCameraController | null = null;
    
    private raycaster: THREE.Raycaster;
    private mouse: THREE.Vector2;
    private ground: THREE.Mesh | null = null;
    
    private boundOnMouseDown: (event: MouseEvent) => void;
    private boundOnMouseUp: (event: MouseEvent) => void;
    private boundOnMouseMove: (event: MouseEvent) => void;
    private boundOnKeyDown: (event: KeyboardEvent) => void;
    
    private uiContainer: HTMLDivElement | null = null;
    private previewContainer: HTMLDivElement | null = null;
    private previewRenderer: THREE.WebGLRenderer | null = null;
    private previewCamera: THREE.PerspectiveCamera | null = null;
    
    private isDragging: boolean = false;
    private dragStartMouse: THREE.Vector2 = new THREE.Vector2();
    private dragStartPosition: THREE.Vector3 = new THREE.Vector3();
    private hasMovedWhileDragging: boolean = false;
    
    private isRecordingPath: boolean = false;
    private recordingStartTime: number = 0;
    private currentRecordingTime: number = 0;
    private onRecordingComplete: (() => void) | null = null;
    private getGameDataCallback: (() => any) | null = null;
    
    constructor(scene: THREE.Scene, camera: THREE.Camera, domElement: HTMLElement) {
        this.scene = scene;
        this.camera = camera;
        this.domElement = domElement;
        
        this.raycaster = new THREE.Raycaster();
        this.raycaster.layers.set(0);
        this.mouse = new THREE.Vector2();
        
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
        this.boundOnMouseMove = this.onMouseMove.bind(this);
        this.boundOnKeyDown = this.onKeyDown.bind(this);
        
        // Create debug camera controller for free movement
        if (camera instanceof THREE.PerspectiveCamera) {
            this.debugCameraController = new DebugCameraController(camera, domElement);
        }
        
        // Ground plane is created lazily when editor is enabled
    }
    
    private setupGroundPlane(): void {
        if (this.ground) return; // Already created
        
        const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
        const groundMaterial = new THREE.MeshBasicMaterial({ visible: false });
        this.ground = new THREE.Mesh(groundGeometry, groundMaterial);
        this.ground.name = 'CameraPathEditorGround';
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.y = 0;
        this.ground.layers.set(0);
    }
    
    private addGroundToScene(): void {
        if (this.ground && !this.ground.parent) {
            this.scene.add(this.ground);
        }
    }
    
    private removeGroundFromScene(): void {
        if (this.ground && this.ground.parent) {
            this.scene.remove(this.ground);
        }
    }
    
    setEnabled(enabled: boolean): void {
        if (enabled === this.isEnabled) return;
        
        this.isEnabled = enabled;
        
        if (enabled) {
            // Create and add ground plane for raycasting
            this.setupGroundPlane();
            this.addGroundToScene();
            
            // Activate debug camera for free movement
            // Keep current camera position/rotation (don't reset)
            if (this.debugCameraController) {
                this.debugCameraController.activate(this.camera as THREE.PerspectiveCamera);
            }
            
            // ONLY keyboard listener - NO mouse listeners
            document.addEventListener('keydown', this.boundOnKeyDown);
            this.setMarkersVisible(true);
            this.showUI();
            this.setupPreviewWindow();
            
            console.log('🎥 Camera Path Editor enabled - gameplay paused, WASD to move');
        } else {
            // Deactivate debug camera
            if (this.debugCameraController) {
                this.debugCameraController.deactivate();
            }
            
            // Remove ground plane from scene when not in use
            this.removeGroundFromScene();
            
            // Don't restore camera - keep current position
            
            document.removeEventListener('keydown', this.boundOnKeyDown);
            this.setMarkersVisible(false);
            this.hideUI();
            this.hidePreviewWindow();
            this.selectedMarker = null;
            this.isDragging = false;
            
            console.log('🎥 Camera Path Editor disabled - gameplay resumed');
        }
    }
    
    isEditorEnabled(): boolean {
        return this.isEnabled;
    }
    
    private setMarkersVisible(visible: boolean): void {
        this.markers.forEach(marker => {
            marker.helper.visible = visible;
        });
        
        // Also control parent group visibility for performance
        if (this.markers.length > 0 && this.markers[0]) {
            const parent = this.markers[0].helper.parent;
            if (parent && parent !== this.scene) {
                parent.visible = visible;
            }
        }
    }
    
    private createMarkerHelper(data: CameraMarkerData): THREE.Group {
        const group = new THREE.Group();
        
        // Create arrow shaft (cylinder)
        const shaftGeometry = new THREE.CylinderGeometry(0.05, 0.05, 1, 8);
        const shaftMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
        const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
        shaft.position.z = 0.5;
        shaft.rotation.x = Math.PI / 2;
        group.add(shaft);
        
        // Create arrow head (cone)
        const headGeometry = new THREE.ConeGeometry(0.15, 0.3, 8);
        const headMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
        const head = new THREE.Mesh(headGeometry, headMaterial);
        head.position.z = 1;
        head.rotation.x = Math.PI / 2;
        group.add(head);
        
        // Create "up" indicator (small cylinder pointing up from the center)
        const upGeometry = new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8);
        const upMaterial = new THREE.MeshStandardMaterial({ color: 0x0000ff });
        const upIndicator = new THREE.Mesh(upGeometry, upMaterial);
        upIndicator.position.y = 0.25;
        group.add(upIndicator);
        
        // Create ID label (using a sprite with canvas texture)
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(0, 0, 128, 64);
            ctx.fillStyle = 'white';
            ctx.font = 'bold 32px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`#${data.id}`, 64, 32);
        }
        
        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.scale.set(0.5, 0.25, 1);
        sprite.position.y = 0.7;
        group.add(sprite);
        
        // Set position and rotation
        group.position.set(data.position.x, data.position.y, data.position.z);
        group.rotation.set(data.rotation.x, data.rotation.y, data.rotation.z);
        
        // Hidden by default
        group.visible = false;
        
        group.layers.set(0);
        this.scene.add(group);
        
        return group;
    }
    
    private updateMarkerHelper(marker: { data: CameraMarkerData; helper: THREE.Group }): void {
        marker.helper.position.set(marker.data.position.x, marker.data.position.y, marker.data.position.z);
        marker.helper.rotation.set(marker.data.rotation.x, marker.data.rotation.y, marker.data.rotation.z);
        
        // Update color based on selection
        const isSelected = marker === this.selectedMarker;
        const color = isSelected ? 0xffff00 : 0x00ff00;
        
        marker.helper.children.forEach(child => {
            if (child instanceof THREE.Mesh && child.geometry instanceof THREE.CylinderGeometry && child.material instanceof THREE.MeshStandardMaterial) {
                if (child.position.y === 0) { // Not the up indicator
                    child.material.color.setHex(color);
                }
            } else if (child instanceof THREE.Mesh && child.geometry instanceof THREE.ConeGeometry && child.material instanceof THREE.MeshStandardMaterial) {
                child.material.color.setHex(color);
            }
        });
        
        // Update ID label
        const sprite = marker.helper.children.find(c => c instanceof THREE.Sprite) as THREE.Sprite;
        if (sprite) {
            const canvas = document.createElement('canvas');
            canvas.width = 128;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.fillStyle = isSelected ? 'rgba(255, 255, 0, 0.9)' : 'rgba(0, 0, 0, 0.7)';
                ctx.fillRect(0, 0, 128, 64);
                ctx.fillStyle = isSelected ? 'black' : 'white';
                ctx.font = 'bold 32px monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`#${marker.data.id}`, 64, 32);
            }
            sprite.material.map = new THREE.CanvasTexture(canvas);
            sprite.material.needsUpdate = true;
        }
    }
    
    private onMouseDown(event: MouseEvent): void {
        if (!this.isEnabled) return;
        
        const target = event.target as HTMLElement;
        if (target.closest('#camera-path-editor-ui') || target.closest('#camera-path-preview')) {
            return;
        }
        
        // Only intercept LMB for marker operations
        if (event.button !== 0) {
            return;
        }
        
        this.updateMousePosition(event);
        
        if (event.shiftKey) {
            // Creating a marker - block this event completely
            event.stopPropagation();
            event.preventDefault();
            event.stopImmediatePropagation();
            this.createMarkerAtMouse();
            return;
        }
        
        // Check if we clicked on a marker
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const markerHelpers = this.markers.map(m => m.helper);
        
        const intersects: THREE.Intersection[] = [];
        markerHelpers.forEach(helper => {
            helper.traverse(obj => {
                if (obj instanceof THREE.Mesh) {
                    const result = this.raycaster.intersectObject(obj);
                    intersects.push(...result);
                }
            });
        });
        
        if (intersects.length > 0) {
            // Clicked on a marker - block this event completely
            event.stopPropagation();
            event.preventDefault();
            event.stopImmediatePropagation();
            
            const selectedObject = intersects[0]?.object;
            if (selectedObject) {
                let selectedHelper: THREE.Group | null = null;
                
                let parent = selectedObject.parent;
                while (parent) {
                    if (parent instanceof THREE.Group && markerHelpers.includes(parent)) {
                        selectedHelper = parent;
                        break;
                    }
                    parent = parent.parent;
                }
                
                if (selectedHelper) {
                    this.selectedMarker = this.markers.find(m => m.helper === selectedHelper) || null;
                    this.updateMarkerHighlights();
                    this.updateUI();
                    this.updatePreviewCamera();
                    console.log('Selected marker:', this.selectedMarker?.data);
                    
                    // Start dragging - now add mousemove and mouseup listeners
                    this.isDragging = true;
                    this.hasMovedWhileDragging = false;
                    this.dragStartMouse.copy(this.mouse);
                    if (this.selectedMarker) {
                        this.dragStartPosition.copy(this.selectedMarker.helper.position);
                    }
                    
                    // Add drag listeners ONLY when dragging
                    this.domElement.addEventListener('mousemove', this.boundOnMouseMove, true);
                    this.domElement.addEventListener('mouseup', this.boundOnMouseUp, true);
                }
            }
        } else {
            // Didn't click on anything - deselect marker and let event pass through to debug camera
            if (this.selectedMarker) {
                this.selectedMarker = null;
                this.updateMarkerHighlights();
                this.updateUI();
            }
            // Don't stop propagation - let event pass through to debug camera
        }
    }
    
    private onMouseUp(event: MouseEvent): void {
        if (!this.isEnabled) return;
        
        // Only handle LMB
        if (event.button !== 0) {
            return;
        }
        
        // Only block event if we were dragging a marker
        if (this.isDragging) {
            event.stopPropagation();
            event.preventDefault();
            event.stopImmediatePropagation();
            
            // Remove drag listeners when done dragging
            this.domElement.removeEventListener('mousemove', this.boundOnMouseMove, true);
            this.domElement.removeEventListener('mouseup', this.boundOnMouseUp, true);
        }
        
        this.isDragging = false;
        this.hasMovedWhileDragging = false;
    }
    
    private onMouseMove(event: MouseEvent): void {
        if (!this.isEnabled) return;
        
        // Only intercept mouse move if we're dragging a marker
        if (!this.isDragging || !this.selectedMarker || !this.ground) {
            return; // Let event pass through to debug camera for rotation
        }
        
        const currentMouse = new THREE.Vector2(
            ((event.clientX - this.domElement.getBoundingClientRect().left) / this.domElement.getBoundingClientRect().width) * 2 - 1,
            -((event.clientY - this.domElement.getBoundingClientRect().top) / this.domElement.getBoundingClientRect().height) * 2 + 1
        );
        
        const mouseDelta = currentMouse.distanceTo(this.dragStartMouse);
        if (mouseDelta < 0.01) {
            return;
        }
        
        this.hasMovedWhileDragging = true;
        event.stopPropagation();
        event.preventDefault();
        event.stopImmediatePropagation();
        
        this.updateMousePosition(event);
        
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.ground);
        
        if (intersects.length > 0 && intersects[0]) {
            const point = intersects[0].point;
            
            const snappedX = Math.round(point.x * 20) / 20;
            const snappedZ = Math.round(point.z * 20) / 20;
            
            this.selectedMarker.data.position.x = snappedX;
            this.selectedMarker.data.position.z = snappedZ;
            
            this.updateMarkerHelper(this.selectedMarker);
            this.updateUI();
        }
    }
    
    private onKeyDown(event: KeyboardEvent): void {
        if (!this.isEnabled) return;
        
        // O key = Create marker at current camera position
        if (event.key === 'o' || event.key === 'O') {
            event.preventDefault();
            event.stopPropagation();
            this.createMarkerAtCamera();
        } else if (event.key === 'Delete' && this.selectedMarker) {
            event.preventDefault();
            event.stopPropagation();
            this.deleteSelectedMarker();
        } else if (event.key === 'F5') {
            event.preventDefault();
            event.stopPropagation();
            this.saveCameraPath();
        }
    }
    
    private createMarkerAtCamera(): void {
        // Get current camera rotation
        const cameraRotation = new THREE.Euler().setFromQuaternion(this.camera.quaternion);
        
        // Find next available ID
        const nextId = this.markers.length > 0 
            ? Math.max(...this.markers.map(m => m.data.id)) + 1 
            : 1;
        
        // Default timestamp: add 2 seconds to the last marker's timestamp, or start at 0
        const lastTimestamp = this.markers.length > 0 
            ? Math.max(...this.markers.map(m => m.data.timestamp)) 
            : -2;
        
        const markerData: CameraMarkerData = {
            id: nextId,
            position: { 
                x: this.camera.position.x, 
                y: this.camera.position.y, 
                z: this.camera.position.z
            },
            rotation: { 
                x: cameraRotation.x, 
                y: cameraRotation.y, 
                z: cameraRotation.z 
            },
            timestamp: lastTimestamp + 2
        };
        
        const helper = this.createMarkerHelper(markerData);
        this.markers.push({ data: markerData, helper });
        this.selectedMarker = this.markers[this.markers.length - 1] || null;
        this.updateMarkerHighlights();
        this.updateUI();
        
        console.log('Created camera marker at current position:', markerData);
    }
    
    private updateMousePosition(event: MouseEvent): void {
        this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    }
    
    private createMarkerAtMouse(): void {
        if (!this.ground) return;
        
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.ground);
        
        if (intersects.length > 0 && intersects[0]) {
            const point = intersects[0].point;
            
            // Get current camera rotation for the new marker
            const cameraRotation = new THREE.Euler().setFromQuaternion(this.camera.quaternion);
            
            // Find next available ID
            const nextId = this.markers.length > 0 
                ? Math.max(...this.markers.map(m => m.data.id)) + 1 
                : 1;
            
            // Default timestamp: add 2 seconds to the last marker's timestamp, or start at 0
            const lastTimestamp = this.markers.length > 0 
                ? Math.max(...this.markers.map(m => m.data.timestamp)) 
                : -2;
            
            const markerData: CameraMarkerData = {
                id: nextId,
                position: { 
                    x: Math.round(point.x * 20) / 20, 
                    y: this.camera.position.y, 
                    z: Math.round(point.z * 20) / 20 
                },
                rotation: { 
                    x: cameraRotation.x, 
                    y: cameraRotation.y, 
                    z: cameraRotation.z 
                },
                timestamp: lastTimestamp + 2
            };
            
            const helper = this.createMarkerHelper(markerData);
            this.markers.push({ data: markerData, helper });
            this.selectedMarker = this.markers[this.markers.length - 1] || null;
            this.updateMarkerHighlights();
            this.updateUI();
            
            console.log('Created camera marker:', markerData);
        }
    }
    
    
    private deleteSelectedMarker(): void {
        if (!this.selectedMarker) return;
        
        const index = this.markers.indexOf(this.selectedMarker);
        if (index >= 0) {
            const marker = this.markers[index];
            if (!marker) return;
            
            this.scene.remove(marker.helper);
            marker.helper.traverse(obj => {
                if (obj instanceof THREE.Mesh) {
                    obj.geometry.dispose();
                    if (obj.material instanceof THREE.Material) {
                        obj.material.dispose();
                    }
                }
            });
            
            this.markers.splice(index, 1);
            this.selectedMarker = null;
            this.updateUI();
            
            console.log('Deleted marker');
        }
    }
    
    private updateMarkerHighlights(): void {
        this.markers.forEach(marker => {
            this.updateMarkerHelper(marker);
        });
    }
    
    updateSelectedMarkerPosition(axis: 'x' | 'y' | 'z', value: number): void {
        if (!this.selectedMarker) return;
        
        const snapped = Math.round(value * 20) / 20;
        this.selectedMarker.data.position[axis] = snapped;
        
        this.updateMarkerHelper(this.selectedMarker);
        this.updatePreviewCamera();
    }
    
    updateSelectedMarkerRotation(axis: 'x' | 'y' | 'z', value: number): void {
        if (!this.selectedMarker) return;
        
        this.selectedMarker.data.rotation[axis] = value;
        
        this.updateMarkerHelper(this.selectedMarker);
        this.updatePreviewCamera();
    }
    
    updateSelectedMarkerTimestamp(value: number): void {
        if (!this.selectedMarker) return;
        
        this.selectedMarker.data.timestamp = Math.max(0, value);
        this.updateUI();
    }
    
    setGameId(gameId: string): void {
        this.gameId = gameId;
    }
    
    setGameDataCallback(callback: () => any): void {
        this.getGameDataCallback = callback;
    }
    
    async loadCameraPath(gameId: string): Promise<void> {
        this.gameId = gameId;

        // Use in-memory game data instead of fetching from disk
        const gameData = this.getGameDataCallback?.();
        const baseCameraPathUrl = gameData?.worldProfileData?.cameraPathUrl;
        if (!baseCameraPathUrl) {
            console.log(`ℹ️ No camera path URL found in gameData`);
            return;
        }
        
        // Add cache busting
        const timestamp = Date.now();
        const cameraPathUrl = `${baseCameraPathUrl.split('?')[0]}?v=${timestamp}`;
        console.log(`🎥 Attempting to load camera path from: ${cameraPathUrl}`);

        try {
            const response = await fetch(cameraPathUrl);
            console.log(`   Fetch response status: ${response.status}`);

            if (response.ok) {
                const data: CameraPathData = await response.json();
                console.log(`✅ Loaded ${data.markers.length} camera markers from ${cameraPathUrl}`);

                data.markers.forEach(markerData => {
                    const helper = this.createMarkerHelper(markerData);
                    this.markers.push({ data: markerData, helper });
                });

                console.log(`✅ All camera markers added to scene`);
            } else {
                console.log(`ℹ️ No camera path file found at ${cameraPathUrl} (status: ${response.status})`);
            }
        } catch (error) {
            console.log(`ℹ️ Error loading camera path: ${error}`);
        }
    }
    
    private extractFilename(url: string): string {
        try {
            const urlObj = new URL(url, window.location.href);
            const pathname = urlObj.pathname;
            const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
            console.log(`Extracted filename from ${url}: ${filename}`);
            return filename;
        } catch {
            const filename = url.substring(url.lastIndexOf('/') + 1);
            console.log(`Extracted filename (fallback) from ${url}: ${filename}`);
            return filename;
        }
    }
    
    async saveCameraPath(): Promise<void> {
        if (!this.gameId) {
            console.error('❌ No gameId set - cannot save camera path');
            this.showSaveNotification('unknown', false);
            return;
        }
        
        const data: CameraPathData = {
            markers: this.markers.map(m => m.data)
        };
        
        const jsonString = JSON.stringify(data, null, 2);
        const timestamp = Date.now();
        const filename = `camera-path-${this.gameId}-${timestamp}.json`;
        
        console.log('💾 Saving camera path:', data);
        console.log(`   Filename: ${filename}`);
        
        try {
            const response = await fetch(`${getAgentUrl()}/api/save-collider-file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    filename: filename,
                    content: jsonString,
                    isBase64: false
                })
            });
            
            if (response.ok) {
                const result = await response.json();
                if (result.success && result.s3Url) {
                    console.log(`✅ Camera path saved successfully to ${result.s3Url}`);
                    
                    // Save camera path URL to world.json
                    await this.saveCameraPathUrlToWorldJson(result.s3Url);
                    
                    this.showSaveNotification(filename, true);
                } else {
                    console.error('Failed to get S3 URL from response:', result);
                    this.showSaveNotification(filename, false);
                }
            } else {
                const errorText = await response.text();
                console.error('Failed to save camera path:', response.status, errorText);
                this.showSaveNotification(filename, false);
            }
        } catch (error) {
            console.error('Error saving camera path:', error);
            this.showSaveNotification(filename, false);
        }
    }
    
    private async saveCameraPathUrlToWorldJson(cameraPathUrl: string): Promise<void> {
        try {
            // Use partial update that only modifies cameraPathUrl
            const partialWorldData = {
                worldProfileData: {
                    cameraPathUrl: cameraPathUrl
                }
            };
            
            console.log(`[SaveCameraPathUrl] Saving cameraPathUrl to world.json: ${cameraPathUrl}`);
            
            const saveResponse = await fetch(`${getAgentUrl()}/api/write-world-json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ worldData: partialWorldData })
            });
            
            if (saveResponse.ok) {
                await saveResponse.json();
                console.log('[SaveCameraPathUrl] ✅ cameraPathUrl saved to world.json');
            } else {
                console.error('[SaveCameraPathUrl] Failed to save cameraPathUrl to world.json:', saveResponse.statusText);
            }
        } catch (error) {
            console.error('[SaveCameraPathUrl] Error saving cameraPathUrl to world.json:', error);
        }
    }
    
    private showSaveNotification(filename: string, success: boolean): void {
        const notification = document.createElement('div');
        const bgColor = success ? 'rgba(76, 175, 80, 0.95)' : 'rgba(244, 67, 54, 0.95)';
        
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: ${bgColor};
            color: white;
            padding: 20px 40px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 16px;
            z-index: 2000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            text-align: center;
        `;
        
        if (success) {
            notification.innerHTML = `
                <strong>✅ Camera Path Saved!</strong><br>
                <span style="font-size: 14px; color: #e0e0e0;">Saved: ${filename}</span><br>
                <span style="font-size: 12px; color: #ffeb3b;">📁 game/spz/${filename}</span>
            `;
        } else {
            notification.innerHTML = `
                <strong>❌ Save Failed</strong><br>
                <span style="font-size: 14px; color: #e0e0e0;">Could not save: ${filename}</span>
            `;
        }
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                document.body.removeChild(notification);
            }
        }, 3000);
    }
    
    private setupPreviewWindow(): void {
        if (this.previewContainer) return;
        
        this.previewContainer = document.createElement('div');
        this.previewContainer.id = 'camera-path-preview';
        this.previewContainer.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 320px;
            height: 180px;
            background: rgba(0, 0, 0, 0.9);
            border: 2px solid #00ff00;
            border-radius: 8px;
            overflow: hidden;
            z-index: 1001;
            display: ${this.selectedMarker ? 'block' : 'none'};
        `;
        
        document.body.appendChild(this.previewContainer);
        
        this.previewRenderer = new WebGLRenderer({ antialias: true });
        this.previewRenderer.setSize(320, 180);
        this.previewRenderer.setPixelRatio(window.devicePixelRatio);
        this.previewContainer.appendChild(this.previewRenderer.domElement);
        
        this.previewCamera = new THREE.PerspectiveCamera(60, 320 / 180, 0.1, 1000);
        
        this.updatePreviewCamera();
    }
    
    private hidePreviewWindow(): void {
        if (this.previewContainer) {
            document.body.removeChild(this.previewContainer);
            this.previewContainer = null;
        }
        
        if (this.previewRenderer) {
            this.previewRenderer.dispose();
            this.previewRenderer = null;
        }
        
        this.previewCamera = null;
    }
    
    private updatePreviewCamera(): void {
        if (!this.previewCamera || !this.selectedMarker) {
            if (this.previewContainer) {
                this.previewContainer.style.display = 'none';
            }
            return;
        }
        
        if (this.previewContainer) {
            this.previewContainer.style.display = 'block';
        }
        
        const marker = this.selectedMarker.data;
        this.previewCamera.position.set(marker.position.x, marker.position.y, marker.position.z);
        this.previewCamera.rotation.set(marker.rotation.x, marker.rotation.y, marker.rotation.z);
    }
    
    update(deltaTime: number): void {
        if (!this.isEnabled) return;
        
        // Update debug camera controller
        if (this.debugCameraController) {
            this.debugCameraController.update(deltaTime);
        }
    }
    
    updatePreview(): void {
        if (!this.previewRenderer || !this.previewCamera || !this.selectedMarker) return;
        
        this.previewRenderer.render(this.scene, this.previewCamera);
    }
    
    getCatmullRomSpline(): THREE.CatmullRomCurve3 | null {
        if (this.markers.length < 2) return null;
        
        const sortedMarkers = [...this.markers].sort((a, b) => a.data.id - b.data.id);
        const points = sortedMarkers.map(m => new THREE.Vector3(m.data.position.x, m.data.position.y, m.data.position.z));
        
        // Use centripetal parameterization for smoother velocity
        return new THREE.CatmullRomCurve3(points, false, 'centripetal');
    }
    
    /** Drop every marker (and its helper) so a new path can be set, or the editor starts clean. */
    clearPath(): void {
        this.markers.forEach(marker => {
            this.scene.remove(marker.helper);
            marker.helper.traverse((obj) => {
                if (obj instanceof THREE.Mesh) {
                    obj.geometry.dispose();
                    if (obj.material instanceof THREE.Material) {
                        obj.material.dispose();
                    }
                }
            });
        });
        this.markers = [];
        this.selectedMarker = null;
        if (this.isEnabled) this.updateUI();
    }

    /**
     * Replace the path with an authored one. Markers are numbered in order, `lookAt` is resolved to
     * a camera-convention Euler (looking down -Z from position), and helpers stay hidden — this is
     * for recording a fly-through, not for editing. Throws on a malformed path so the caller can
     * report it; nothing is changed in that case.
     */
    setPathData(path: FlythroughPath): void {
        if (!path || !Array.isArray(path.markers) || path.markers.length < 2) {
            throw new Error('a fly-through needs at least two markers');
        }
        const eye = new THREE.Vector3();
        const target = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        const matrix = new THREE.Matrix4();
        const resolved: CameraMarkerData[] = path.markers.map((marker, index) => {
            const p = marker.position;
            if (!p || ![p.x, p.y, p.z, marker.timestamp].every(Number.isFinite)) {
                throw new Error(`marker ${index}: position and timestamp must be finite numbers`);
            }
            let rotation: { x: number; y: number; z: number };
            if (marker.lookAt && [marker.lookAt.x, marker.lookAt.y, marker.lookAt.z].every(Number.isFinite)) {
                eye.set(p.x, p.y, p.z);
                target.set(marker.lookAt.x, marker.lookAt.y, marker.lookAt.z);
                // Matrix4.lookAt is the camera-convention form: -Z ends up pointing at the target.
                matrix.lookAt(eye, target, up);
                const euler = new THREE.Euler().setFromRotationMatrix(matrix);
                rotation = { x: euler.x, y: euler.y, z: euler.z };
            } else if (marker.rotation && [marker.rotation.x, marker.rotation.y, marker.rotation.z].every(Number.isFinite)) {
                rotation = { x: marker.rotation.x, y: marker.rotation.y, z: marker.rotation.z };
            } else {
                throw new Error(`marker ${index}: needs a lookAt point or a rotation`);
            }
            return { id: index + 1, position: { x: p.x, y: p.y, z: p.z }, rotation, timestamp: marker.timestamp };
        });
        for (let i = 1; i < resolved.length; i++) {
            if (resolved[i]!.timestamp <= resolved[i - 1]!.timestamp) {
                throw new Error(`marker ${i}: timestamps must be strictly ascending`);
            }
        }
        this.clearPath();
        for (const data of resolved) {
            const helper = this.createMarkerHelper(data);
            helper.visible = this.isEnabled;
            this.markers.push({ data, helper });
        }
        if (this.isEnabled) this.updateUI();
    }

    evaluateCameraPathAtTime(time: number): { position: THREE.Vector3; rotation: THREE.Euler } | null {
        if (this.markers.length === 0) return null;
        
        const sortedMarkers = [...this.markers].sort((a, b) => a.data.id - b.data.id);
        
        if (sortedMarkers.length === 1) {
            const marker = sortedMarkers[0];
            if (!marker) return null;
            return {
                position: new THREE.Vector3(marker.data.position.x, marker.data.position.y, marker.data.position.z),
                rotation: new THREE.Euler(marker.data.rotation.x, marker.data.rotation.y, marker.data.rotation.z)
            };
        }
        
        const firstMarker = sortedMarkers[0];
        const lastMarker = sortedMarkers[sortedMarkers.length - 1];
        
        if (!firstMarker || !lastMarker) return null;
        
        if (time <= firstMarker.data.timestamp) {
            return {
                position: new THREE.Vector3(firstMarker.data.position.x, firstMarker.data.position.y, firstMarker.data.position.z),
                rotation: new THREE.Euler(firstMarker.data.rotation.x, firstMarker.data.rotation.y, firstMarker.data.rotation.z)
            };
        }
        
        if (time >= lastMarker.data.timestamp) {
            return {
                position: new THREE.Vector3(lastMarker.data.position.x, lastMarker.data.position.y, lastMarker.data.position.z),
                rotation: new THREE.Euler(lastMarker.data.rotation.x, lastMarker.data.rotation.y, lastMarker.data.rotation.z)
            };
        }
        
        const spline = this.getCatmullRomSpline();
        if (!spline) return null;
        
        // Find which segment we're in
        let segmentIndex = 0;
        for (let i = 0; i < sortedMarkers.length - 1; i++) {
            const current = sortedMarkers[i];
            const next = sortedMarkers[i + 1];
            if (!current || !next) continue;
            
            if (time >= current.data.timestamp && time <= next.data.timestamp) {
                segmentIndex = i;
                break;
            }
        }
        
        const prevMarker = sortedMarkers[segmentIndex];
        const nextMarker = sortedMarkers[segmentIndex + 1];
        if (!prevMarker || !nextMarker) return null;
        
        // Calculate global time parameter across entire path
        // This ensures smooth velocity transitions between segments
        const totalDuration = lastMarker.data.timestamp - firstMarker.data.timestamp;
        const globalT = (time - firstMarker.data.timestamp) / totalDuration;
        
        // Use Catmull-Rom spline with global parameter for smooth position
        const position = spline.getPoint(Math.max(0, Math.min(1, globalT)));
        
        // For rotation, we need to find all quaternions and slerp through them smoothly
        // Find the two markers we're between for rotation interpolation
        const localT = (time - prevMarker.data.timestamp) / (nextMarker.data.timestamp - prevMarker.data.timestamp);
        
        // Apply ease-in-out to rotation only (for smooth angular velocity)
        const easeT = this.easeInOutCubic(localT);
        
        const prevQuat = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(prevMarker.data.rotation.x, prevMarker.data.rotation.y, prevMarker.data.rotation.z)
        );
        const nextQuat = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(nextMarker.data.rotation.x, nextMarker.data.rotation.y, nextMarker.data.rotation.z)
        );
        
        const interpQuat = new THREE.Quaternion().slerpQuaternions(prevQuat, nextQuat, easeT);
        const rotation = new THREE.Euler().setFromQuaternion(interpQuat);
        
        return { position, rotation };
    }
    
    private easeInOutCubic(t: number): number {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
    
    getTotalPathDuration(): number {
        if (this.markers.length === 0) return 0;
        const sorted = [...this.markers].sort((a, b) => a.data.id - b.data.id);
        const last = sorted[sorted.length - 1];
        return last ? last.data.timestamp : 0;
    }
    
    startRecordingPath(onComplete: () => void): void {
        if (this.markers.length === 0) {
            console.warn('Cannot start camera path recording: no markers defined');
            return;
        }
        
        this.isRecordingPath = true;
        this.recordingStartTime = Date.now();
        this.currentRecordingTime = 0;
        this.onRecordingComplete = onComplete;
        
        // Hide all markers during recording
        this.setMarkersVisible(false);
        
        const sortedMarkers = [...this.markers].sort((a, b) => a.data.id - b.data.id);
        const firstMarker = sortedMarkers[0];
        if (firstMarker) {
            this.camera.position.set(firstMarker.data.position.x, firstMarker.data.position.y, firstMarker.data.position.z);
            this.camera.rotation.set(firstMarker.data.rotation.x, firstMarker.data.rotation.y, firstMarker.data.rotation.z);
        }
        
        console.log(`🎥 Camera path recording started (${this.getTotalPathDuration()}s)`);
    }
    
    updateRecordingPath(deltaTime: number): boolean {
        if (!this.isRecordingPath) return false;
        
        this.currentRecordingTime += deltaTime;
        
        const totalDuration = this.getTotalPathDuration();
        if (this.currentRecordingTime >= totalDuration) {
            console.log('🎥 Camera path recording complete');
            this.isRecordingPath = false;
            
            // Restore marker visibility if editor is still enabled
            if (this.isEnabled) {
                this.setMarkersVisible(true);
            }
            
            if (this.onRecordingComplete) {
                this.onRecordingComplete();
            }
            return false;
        }
        
        const cameraState = this.evaluateCameraPathAtTime(this.currentRecordingTime);
        if (cameraState) {
            this.camera.position.copy(cameraState.position);
            this.camera.rotation.copy(cameraState.rotation);
        }
        
        return true;
    }
    
    isRecording(): boolean {
        return this.isRecordingPath;
    }
    
    private showUI(): void {
        if (this.uiContainer) return;
        
        this.uiContainer = document.createElement('div');
        this.uiContainer.id = 'camera-path-editor-ui';
        this.uiContainer.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 15px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 12px;
            z-index: 1000;
            min-width: 250px;
        `;
        
        this.uiContainer.addEventListener('mousedown', (e) => e.stopPropagation());
        this.uiContainer.addEventListener('mouseup', (e) => e.stopPropagation());
        this.uiContainer.addEventListener('mousemove', (e) => e.stopPropagation());
        this.uiContainer.addEventListener('click', (e) => e.stopPropagation());
        
        document.body.appendChild(this.uiContainer);
        this.updateUI();
    }
    
    private hideUI(): void {
        if (this.uiContainer) {
            document.body.removeChild(this.uiContainer);
            this.uiContainer = null;
        }
    }
    
    private updateUI(): void {
        if (!this.uiContainer) return;
        
        let html = `
            <div style="margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #444;">
                <strong>Camera Path Editor</strong><br>
                <span style="font-size: 10px; color: #aaa;">
                    WASD+QE: Move Camera<br>
                    Scroll: Adjust Speed<br>
                    O: Create Marker at Camera<br>
                    Delete: Remove Selected<br>
                    F5: Save Path<br>
                    F9: Record Path
                </span>
            </div>
            <div style="margin-bottom: 10px; padding: 5px; background: rgba(255, 200, 0, 0.2); border-radius: 4px;">
                <strong style="color: #ffc800;">⏸ PAUSED</strong>
            </div>
            <div style="margin-bottom: 10px;">
                Markers: ${this.markers.length}
            </div>
        `;
        
        if (this.selectedMarker) {
            const d = this.selectedMarker.data;
            html += `
                <div style="margin-bottom: 10px; padding: 10px; background: rgba(255,255,0,0.1); border-radius: 4px;">
                    <strong style="color: #ff0;">Marker #${d.id}</strong>
                </div>
                <div style="margin-bottom: 10px;">
                    <strong>Position (0.05 steps):</strong><br>
                    ${this.createSlider('pos-x', 'X', d.position.x, -50, 50, 'position')}
                    ${this.createSlider('pos-y', 'Y', d.position.y, 0, 20, 'position')}
                    ${this.createSlider('pos-z', 'Z', d.position.z, -50, 50, 'position')}
                </div>
                <div style="margin-bottom: 10px;">
                    <strong>Rotation (radians):</strong><br>
                    ${this.createSlider('rot-x', 'X', d.rotation.x, -Math.PI, Math.PI, 'rotation')}
                    ${this.createSlider('rot-y', 'Y', d.rotation.y, -Math.PI, Math.PI, 'rotation')}
                    ${this.createSlider('rot-z', 'Z', d.rotation.z, -Math.PI, Math.PI, 'rotation')}
                </div>
                <div style="margin-bottom: 10px;">
                    <strong>Timestamp (seconds):</strong><br>
                    ${this.createSlider('timestamp', 'T', d.timestamp, 0, 60, 'timestamp')}
                </div>
            `;
        }
        
        html += `
            <button id="save-camera-path-btn" style="width: 100%; padding: 8px; margin-top: 10px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
                💾 Save Camera Path (${this.markers.length} markers)
            </button>
        `;
        
        this.uiContainer.innerHTML = html;
        
        setTimeout(() => {
            if (this.selectedMarker) {
                this.attachSliderListeners();
            }
            
            const saveBtn = document.getElementById('save-camera-path-btn');
            if (saveBtn) {
                saveBtn.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }, { capture: true });
                saveBtn.addEventListener('mouseup', (e) => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                }, { capture: true });
                saveBtn.addEventListener('click', (e) => {
                    console.log('💾 Save camera path button clicked!');
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    this.saveCameraPath();
                }, { capture: true });
            }
        }, 10);
    }
    
    private createSlider(id: string, label: string, value: number, min: number, max: number, type: string): string {
        return `
            <div style="margin: 5px 0; display: flex; align-items: center;">
                <label style="width: 15px; margin-right: 5px;">${label}:</label>
                <div id="${id}-drag" class="drag-value" style="
                    background: #444;
                    color: white;
                    padding: 4px 8px;
                    border-radius: 3px;
                    cursor: ew-resize;
                    user-select: none;
                    border: 1px solid #666;
                    min-width: 60px;
                    text-align: center;
                    font-weight: bold;
                " data-min="${min}" data-max="${max}" data-value="${value.toFixed(2)}" data-type="${type}">
                    ${value.toFixed(2)}
                </div>
                <input type="text" id="${id}" value="${value.toFixed(2)}" 
                    style="width: 60px; margin-left: 5px; background: #333; color: white; border: 1px solid #666; padding: 2px; font-size: 11px;">
            </div>
        `;
    }
    
    private attachSliderListeners(): void {
        setTimeout(() => {
            ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'timestamp'].forEach(id => {
                const input = document.getElementById(id) as HTMLInputElement;
                if (input) {
                    input.addEventListener('mousedown', (e) => e.stopPropagation(), { capture: true });
                    input.addEventListener('mouseup', (e) => e.stopPropagation(), { capture: true });
                    input.addEventListener('mousemove', (e) => e.stopPropagation(), { capture: true });
                    input.addEventListener('click', (e) => e.stopPropagation(), { capture: true });
                    
                    input.addEventListener('change', () => {
                        const value = parseFloat(input.value);
                        if (isNaN(value)) return;
                        
                        const parts = id.split('-');
                        const type = parts[0];
                        const axis = parts[1];
                        
                        if (type === 'pos') {
                            this.updateSelectedMarkerPosition(axis as 'x' | 'y' | 'z', value);
                        } else if (type === 'rot') {
                            this.updateSelectedMarkerRotation(axis as 'x' | 'y' | 'z', value);
                        } else if (id === 'timestamp') {
                            this.updateSelectedMarkerTimestamp(value);
                        }
                        
                        this.updateDragValueDisplay(id);
                    });
                }
                
                const dragDiv = document.getElementById(`${id}-drag`) as HTMLDivElement;
                if (!dragDiv) return;
                
                let isDraggingValue = false;
                let dragStartX = 0;
                let dragStartValue = 0;
                
                dragDiv.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    
                    isDraggingValue = true;
                    dragStartX = e.clientX;
                    dragStartValue = parseFloat(dragDiv.dataset.value || '0');
                    dragDiv.style.background = '#666';
                    
                    const onMouseMove = (moveEvent: MouseEvent) => {
                        if (!isDraggingValue) return;
                        
                        moveEvent.stopPropagation();
                        moveEvent.stopImmediatePropagation();
                        
                        const deltaX = moveEvent.clientX - dragStartX;
                        const deltaValue = deltaX * 0.01;
                        const newValue = dragStartValue + deltaValue;
                        
                        const min = parseFloat(dragDiv.dataset.min || '0');
                        const max = parseFloat(dragDiv.dataset.max || '100');
                        const clampedValue = Math.max(min, Math.min(max, newValue));
                        
                        const dataType = dragDiv.dataset.type;
                        const snappedValue = dataType === 'position' 
                            ? Math.round(clampedValue * 20) / 20
                            : clampedValue;
                        
                        const parts = id.split('-');
                        const type = parts[0];
                        const axis = parts[1];
                        
                        if (type === 'pos') {
                            this.updateSelectedMarkerPosition(axis as 'x' | 'y' | 'z', snappedValue);
                        } else if (type === 'rot') {
                            this.updateSelectedMarkerRotation(axis as 'x' | 'y' | 'z', snappedValue);
                        } else if (id === 'timestamp') {
                            this.updateSelectedMarkerTimestamp(snappedValue);
                        }
                        
                        dragDiv.textContent = snappedValue.toFixed(2);
                        dragDiv.dataset.value = snappedValue.toFixed(2);
                        if (input) input.value = snappedValue.toFixed(2);
                    };
                    
                    const onMouseUp = (upEvent: MouseEvent) => {
                        upEvent.stopPropagation();
                        upEvent.stopImmediatePropagation();
                        
                        isDraggingValue = false;
                        dragDiv.style.background = '#444';
                        document.removeEventListener('mousemove', onMouseMove, { capture: true } as any);
                        document.removeEventListener('mouseup', onMouseUp, { capture: true } as any);
                    };
                    
                    document.addEventListener('mousemove', onMouseMove, { capture: true });
                    document.addEventListener('mouseup', onMouseUp, { capture: true });
                }, { capture: true });
            });
        }, 10);
    }
    
    private updateDragValueDisplay(id: string): void {
        const input = document.getElementById(id) as HTMLInputElement;
        const dragDiv = document.getElementById(`${id}-drag`) as HTMLDivElement;
        
        if (input && dragDiv) {
            const value = parseFloat(input.value);
            if (!isNaN(value)) {
                dragDiv.textContent = value.toFixed(2);
                dragDiv.dataset.value = value.toFixed(2);
            }
        }
    }
    
    dispose(): void {
        this.setEnabled(false);
        
        // Dispose debug camera controller
        if (this.debugCameraController) {
            this.debugCameraController.dispose();
            this.debugCameraController = null;
        }
        
        this.markers.forEach(marker => {
            this.scene.remove(marker.helper);
            marker.helper.traverse(obj => {
                if (obj instanceof THREE.Mesh) {
                    obj.geometry.dispose();
                    if (obj.material instanceof THREE.Material) {
                        obj.material.dispose();
                    }
                }
            });
        });
        
        this.markers = [];
        
        if (this.ground) {
            this.scene.remove(this.ground);
            this.ground.geometry.dispose();
            (this.ground.material as THREE.Material).dispose();
            this.ground = null;
        }
    }
}

