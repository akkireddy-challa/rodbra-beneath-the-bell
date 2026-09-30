import * as THREE from 'three';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';

export interface MarkerData {
    id: string;
    name: string;
    color: string; // Named color: "red", "blue", "cyan", etc.
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
}

// Named color definitions
const NAMED_COLORS: Record<string, string> = {
    'red': '#ff0000',
    'blue': '#0000ff',
    'cyan': '#00ffff',
    'green': '#00ff00',
    'yellow': '#ffff00',
    'orange': '#ff8800',
    'purple': '#8800ff',
    'pink': '#ff00ff',
    'white': '#ffffff',
    'black': '#000000',
    'gray': '#888888',
    'magenta': '#ff00ff',
    'lime': '#00ff00',
    'navy': '#000080',
    'teal': '#008080'
};

const COLOR_NAMES = Object.keys(NAMED_COLORS);

/**
 * Marker System for Scene Editor
 * Markers are invisible in-game but visible to AI agents
 * They can be placed anywhere and have editable properties (name, color, position, rotation)
 */
export class MarkerSystem {
    private scene: THREE.Scene;
    private markersParent: THREE.Group;
    private markers: Map<string, { data: MarkerData; object: THREE.Group }> = new Map();
    private markerCounter: number = 0;

    constructor(scene: THREE.Scene) {
        this.scene = scene;
        
        // Create parent object for all markers
        this.markersParent = new THREE.Group();
        this.markersParent.name = 'Markers';
        this.markersParent.layers.set(0); // Ensure it's on layer 0
        this.scene.add(this.markersParent);
        // Markers are hidden by default (only visible in debug mode)
        this.markersParent.visible = false;
    }

    /**
     * Create a marker at the specified position
     */
    public createMarker(position: THREE.Vector3, rotation: THREE.Euler = new THREE.Euler(0, 0, 0)): MarkerData {
        // Use ObjectIdService for globally unique ID
        const idService = getObjectIdService();
        const id = idService.generateId('marker');
        this.markerCounter++;
        
        const markerData: MarkerData = {
            id,
            name: `Marker ${this.markerCounter}`,
            color: 'red', // Default to named color
            position: { x: position.x, y: position.y, z: position.z },
            rotation: { x: rotation.x, y: rotation.y, z: rotation.z }
        };

        const markerObject = this.createMarkerVisual(markerData);
        markerObject.position.copy(position);
        markerObject.rotation.copy(rotation);
        
        this.markersParent.add(markerObject);
        this.markers.set(id, { data: markerData, object: markerObject });
        
        // Register with ObjectIdService
        idService.register(id, 'marker', markerObject, markerData);

        return markerData;
    }

    /**
     * Create visual representation of a marker (arrow showing position and direction)
     * Multiplayer spawn point markers use the same visual style as SpawnPointMarker
     * (translucent downward arrow with label) so they look like player spawn points.
     */
    private createMarkerVisual(data: MarkerData): THREE.Group {
        const group = new THREE.Group();
        group.name = data.name;
        group.userData.markerId = data.id;
        group.userData.isMarker = true;

        // Parse color - convert named color to hex if needed
        const colorHex = NAMED_COLORS[data.color.toLowerCase()] || data.color;
        const color = new THREE.Color(colorHex);

        // Use spawn-point style visual for multiplayer spawn markers
        if (data.name.startsWith('Multiplayer Spawn Point')) {
            this.buildSpawnPointVisual(group, color, data.name);
        } else {
            this.buildDefaultMarkerVisual(group, color);
        }

        // Make marker visible (layer 0)
        // Sub-objects are on layer 0 for visibility, but will be filtered out during selection
        group.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.layers.set(0); // Layer 0 for visibility
                // Mark as marker sub-object so it can be filtered out during selection
                child.userData.isMarkerSubObject = true;
            }
        });

        // The group itself should be on layer 0 for selection
        group.layers.set(0);

        // Store marker data in userData for easy access
        group.userData.markerData = data;

        return group;
    }

    /**
     * Build the default thin arrow visual for regular markers.
     */
    private buildDefaultMarkerVisual(group: THREE.Group, color: THREE.Color): void {
        const arrowLength = 1.0;
        const arrowHeadLength = 0.3;
        const arrowHeadWidth = 0.2;
        const shaftRadius = 0.02;

        // Arrow shaft (cylinder)
        const shaftGeometry = new THREE.CylinderGeometry(shaftRadius, shaftRadius, arrowLength, 8);
        const shaftMaterial = new THREE.MeshBasicMaterial({ color });
        const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
        shaft.position.y = arrowLength / 2;
        shaft.rotation.z = Math.PI / 2;
        group.add(shaft);

        // Arrow head (cone)
        const headGeometry = new THREE.ConeGeometry(arrowHeadWidth, arrowHeadLength, 8);
        const headMaterial = new THREE.MeshBasicMaterial({ color });
        const head = new THREE.Mesh(headGeometry, headMaterial);
        head.position.y = arrowLength + arrowHeadLength / 2;
        group.add(head);

        // Base sphere at origin
        const sphereGeometry = new THREE.SphereGeometry(0.1, 8, 8);
        const sphereMaterial = new THREE.MeshBasicMaterial({ color });
        const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
        group.add(sphere);

        // Line connecting sphere to arrow
        const lineGeometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, arrowLength + arrowHeadLength, 0)
        ]);
        const lineMaterial = new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(lineGeometry, lineMaterial);
        group.add(line);
    }

    /**
     * Build a spawn-point style visual (translucent downward arrow + direction indicator + label).
     * Matches the look of SpawnPointMarker so multiplayer spawn points are visually
     * identical to the player spawn point.
     */
    private buildSpawnPointVisual(group: THREE.Group, color: THREE.Color, label: string): void {
        const material = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            side: THREE.DoubleSide,
        });

        // Cone (arrow head) — points downward
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 8), material);
        cone.rotation.x = Math.PI;
        cone.position.y = 0.6;
        group.add(cone);

        // Shaft (thin cylinder)
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.5, 6), material);
        shaft.position.y = 1.95;
        group.add(shaft);

        // Direction indicator — small cone showing facing direction (+Z local)
        const dirMaterial = new THREE.MeshBasicMaterial({
            color: 0xffcc00,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
        });
        const dirCone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 6), dirMaterial);
        dirCone.rotation.x = -Math.PI / 2;
        dirCone.position.set(0, 0.3, 0.6);
        group.add(dirCone);

        // Text label sprite above the arrow
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (ctx) {
            canvas.width = 512;
            canvas.height = 64;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.roundRect(0, 0, canvas.width, canvas.height, 8);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 28px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, canvas.width / 2, canvas.height / 2);

            const texture = new THREE.CanvasTexture(canvas);
            const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.scale.set(4, 0.5, 1);
            sprite.position.y = 3.2;
            group.add(sprite);
        }
    }

    /**
     * Update marker data and sync visual representation
     */
    public updateMarker(id: string, updates: Partial<MarkerData>, notifyParent: boolean = true): void {
        const marker = this.markers.get(id);
        if (!marker) return;

        // Update data
        Object.assign(marker.data, updates);

        // Update visual if name or color changed
        if (updates.name !== undefined) {
            marker.object.name = updates.name;
        }
        if (updates.color !== undefined) {
            // Convert named color to hex if needed
            const colorHex = NAMED_COLORS[updates.color.toLowerCase()] || updates.color;
            const color = new THREE.Color(colorHex);
            marker.object.traverse((child) => {
                if (child instanceof THREE.Mesh && child.material) {
                    (child.material as THREE.MeshBasicMaterial).color.copy(color);
                } else if (child instanceof THREE.Line && child.material) {
                    (child.material as THREE.LineBasicMaterial).color.copy(color);
                }
            });
        }
        if (updates.position !== undefined) {
            marker.object.position.set(
                updates.position.x,
                updates.position.y,
                updates.position.z
            );
        }
        if (updates.rotation !== undefined) {
            marker.object.rotation.set(
                updates.rotation.x,
                updates.rotation.y,
                updates.rotation.z
            );
        }

        // Update userData
        marker.object.userData.markerData = marker.data;
        
        // Notify parent window to save marker via backend endpoint
        if (notifyParent) {
            safePostMessageToCreator({
                type: 'UPDATE_MARKER',
                marker: marker.data
            });
        }
    }

    /**
     * Remove a marker
     */
    public removeMarker(id: string): void {
        const marker = this.markers.get(id);
        if (!marker) return;

        this.markersParent.remove(marker.object);
        marker.object.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.geometry.dispose();
                if (child.material instanceof THREE.Material) {
                    child.material.dispose();
                }
            }
        });
        this.markers.delete(id);
        
        // Unregister from ObjectIdService
        getObjectIdService().unregister(id);
    }

    /**
     * Get marker by ID
     */
    public getMarker(id: string): MarkerData | null {
        return this.markers.get(id)?.data || null;
    }

    /**
     * Get all markers
     */
    public getAllMarkers(): MarkerData[] {
        return Array.from(this.markers.values()).map(m => m.data);
    }

    /**
     * Get markers parent object (for Object Inspector detection)
     */
    public getMarkersParent(): THREE.Group {
        return this.markersParent;
    }

    /**
     * Serialize markers to JSON format for world.json
     */
    public serializeMarkers(): any[] {
        return this.getAllMarkers().map(marker => ({
            id: marker.id,
            name: marker.name,
            color: marker.color,
            position: marker.position,
            rotation: marker.rotation
        }));
    }

    /**
     * Load markers from JSON format
     */
    public loadMarkers(markersData: any[]): void {
        const idService = getObjectIdService();
        
        // Clear existing markers
        this.markers.forEach((marker, id) => {
            this.removeMarker(id);
        });

        // Reset marker counter
        this.markerCounter = 0;

        // Load markers from data
        for (const data of markersData) {
            // Only use existing ID if it has the correct new format (type_timestamp_random)
            // Old format IDs (marker_0, marker_1) are migrated to new format
            const isValidNewFormat = data.id && data.id.split('_').length >= 3 && idService.parseIdType(data.id) === 'marker';
            const id = isValidNewFormat ? data.id : idService.generateId('marker');
            this.markerCounter++;
            
            const markerData: MarkerData = {
                id,
                name: data.name || 'Marker',
                color: data.color || 'red', // Default to named color
                position: data.position || { x: 0, y: 0, z: 0 },
                rotation: data.rotation || { x: 0, y: 0, z: 0 }
            };

            const markerObject = this.createMarkerVisual(markerData);
            markerObject.position.set(
                markerData.position.x,
                markerData.position.y,
                markerData.position.z
            );
            markerObject.rotation.set(
                markerData.rotation.x,
                markerData.rotation.y,
                markerData.rotation.z
            );

            this.markersParent.add(markerObject);
            this.markers.set(markerData.id, { data: markerData, object: markerObject });
            
            // Register with ObjectIdService
            idService.register(id, 'marker', markerObject, markerData);
        }
    }

    /**
     * Get marker object by ID (for Object Inspector)
     */
    public getMarkerObject(id: string): THREE.Group | null {
        return this.markers.get(id)?.object || null;
    }

    /**
     * Get available color names
     */
    public getColorNames(): string[] {
        return COLOR_NAMES;
    }

    /**
     * Get hex color for a named color
     */
    public getColorHex(colorName: string): string {
        return NAMED_COLORS[colorName.toLowerCase()] || colorName;
    }

    /**
     * Set markers visibility (hidden in play mode, visible in debug mode)
     */
    public setVisible(visible: boolean): void {
        this.markersParent.visible = visible;
    }

    /**
     * Find marker by object reference
     */
    public findMarkerByObject(object: THREE.Object3D): MarkerData | null {
        for (const marker of this.markers.values()) {
            if (marker.object === object || marker.object.children.includes(object as THREE.Mesh)) {
                return marker.data;
            }
        }
        return null;
    }
}
