import * as THREE from 'three';

/**
 * Object types that can be registered with the ObjectIdService
 *
 * Simplified ID system - all IDs use format: {type}_{timestamp}_{random}
 * - asset: Items in the asset library (reusable templates)
 * - inst: Instances of assets placed in the world
 * - marker: Debug markers
 * - object: Legacy placed objects (for PlacedObjectSystem)
 * - env: Legacy procedural environment objects
 */
export type ObjectType = 'asset' | 'inst' | 'marker' | 'object' | 'env';

/**
 * Bounding box definition for objects
 */
export interface BoundingBox {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

/**
 * Object transform data for NPC relative spawning
 */
export interface ObjectTransform {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    boundingBox: BoundingBox | null;
}

/**
 * Registered object entry
 */
export interface RegisteredObject {
    id: string;
    type: ObjectType;
    object: THREE.Object3D;
    data?: any;
}

/**
 * ObjectIdService - Centralized service for generating and managing object IDs
 *
 * All IDs use a simple, consistent format: {type}_{timestamp}_{random}
 * Examples:
 * - asset_1765470221698_a1b2c3  (asset in library)
 * - inst_1765470221698_x7y8z9   (instance placed in world)
 * - marker_1765470221698_m1n2o3 (debug marker)
 */
export class ObjectIdService {
    private static instance: ObjectIdService | null = null;
    private registry: Map<string, RegisteredObject> = new Map();

    private constructor() {}

    /**
     * Get singleton instance
     */
    public static getInstance(): ObjectIdService {
        if (!ObjectIdService.instance) {
            ObjectIdService.instance = new ObjectIdService();
        }
        return ObjectIdService.instance;
    }

    /**
     * Reset the service (for testing or reloading)
     */
    public static reset(): void {
        if (ObjectIdService.instance) {
            ObjectIdService.instance.registry.clear();
        }
        ObjectIdService.instance = null;
    }

    /**
     * Generate a globally unique ID
     * Format: {type}_{timestamp}_{random}
     */
    public generateId(type: ObjectType): string {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        return `${type}_${timestamp}_${random}`;
    }

    /**
     * Check if an ID has valid format: {type}_{timestamp}_{random}
     * At least 3 parts separated by underscores
     */
    public isValidId(id: string): boolean {
        if (!id || typeof id !== 'string') return false;
        const parts = id.split('_');
        return parts.length >= 3;
    }

    /**
     * Parse an ID to extract its type (first part before underscore)
     * Returns null if the ID format is invalid
     */
    public parseIdType(id: string): string | null {
        if (!this.isValidId(id)) return null;
        const parts = id.split('_');
        return parts[0] ?? null;
    }

    /**
     * Register an object with its ID
     */
    public register(id: string, type: ObjectType, object: THREE.Object3D, data?: any): void {
        this.registry.set(id, { id, type, object, data });

        // Also store ID in object's userData for reverse lookup
        object.userData.objectId = id;
        object.userData.objectType = type;
    }

    /**
     * Unregister an object by ID
     */
    public unregister(id: string): void {
        const entry = this.registry.get(id);
        if (entry && entry.object) {
            delete entry.object.userData.objectId;
            delete entry.object.userData.objectType;
        }
        this.registry.delete(id);
    }

    /**
     * Get a registered object by ID
     */
    public getById(id: string): RegisteredObject | null {
        return this.registry.get(id) || null;
    }

    /**
     * Get object by ID (convenience method returning just the THREE.Object3D)
     */
    public getObjectById(id: string): THREE.Object3D | null {
        return this.registry.get(id)?.object || null;
    }

    /**
     * Get object type by ID (from registry or by parsing)
     */
    public getTypeById(id: string): string | null {
        return this.registry.get(id)?.type || this.parseIdType(id);
    }

    /**
     * Get object data by ID
     */
    public getDataById(id: string): any | null {
        return this.registry.get(id)?.data || null;
    }

    /**
     * Get object transform (position, rotation, bounding box) by ID
     * Used for NPC relative spawning (e.g., "spawn NPC on top of tower")
     */
    public getObjectTransform(id: string): ObjectTransform | null {
        const entry = this.registry.get(id);
        if (!entry || !entry.object) {
            return null;
        }

        // Read world-space position and rotation (handles nested objects).
        const position = new THREE.Vector3();
        entry.object.getWorldPosition(position);

        const worldQuat = new THREE.Quaternion();
        entry.object.getWorldQuaternion(worldQuat);
        const rotation = new THREE.Euler().setFromQuaternion(worldQuat);

        const boundingBox: BoundingBox | null = entry.data?.boundingBox ?? null;

        return { position, rotation, boundingBox };
    }

    /**
     * Check if an ID is registered
     */
    public isRegistered(id: string): boolean {
        return this.registry.has(id);
    }

    /**
     * Get all registered objects of a specific type
     */
    public getAllByType(type: ObjectType): RegisteredObject[] {
        const result: RegisteredObject[] = [];
        for (const entry of this.registry.values()) {
            if (entry.type === type) {
                result.push(entry);
            }
        }
        return result;
    }

    /**
     * Get all registered objects
     */
    public getAll(): RegisteredObject[] {
        return Array.from(this.registry.values());
    }

    /**
     * Update the data for a registered object
     */
    public updateData(id: string, data: any): void {
        const entry = this.registry.get(id);
        if (entry) {
            entry.data = data;
        }
    }

    /**
     * Find object by THREE.Object3D (reverse lookup)
     */
    public findByObject(object: THREE.Object3D): RegisteredObject | null {
        // First check userData for quick lookup
        if (object.userData.objectId) {
            return this.registry.get(object.userData.objectId) || null;
        }

        // Fallback to searching registry
        for (const entry of this.registry.values()) {
            if (entry.object === object) {
                return entry;
            }
        }

        return null;
    }

    /**
     * Find all registrations by THREE.Object3D (for InstancedMesh where multiple instances share one object)
     * Returns array of registrations with their IDs and data (including instanceIndex)
     */
    public findAllByObject(object: THREE.Object3D): RegisteredObject[] {
        const results: RegisteredObject[] = [];
        for (const entry of this.registry.values()) {
            if (entry.object === object) {
                results.push(entry);
            }
        }
        return results;
    }

    /**
     * Get count of registered objects
     */
    public getCount(): number {
        return this.registry.size;
    }

    /**
     * Get count of registered objects by type
     */
    public getCountByType(type: ObjectType): number {
        let count = 0;
        for (const entry of this.registry.values()) {
            if (entry.type === type) {
                count++;
            }
        }
        return count;
    }

    /**
     * Clear all registrations (use when reloading level)
     */
    public clear(): void {
        // Clear userData from all objects
        for (const entry of this.registry.values()) {
            if (entry.object) {
                delete entry.object.userData.objectId;
                delete entry.object.userData.objectType;
            }
        }
        this.registry.clear();
    }

    /**
     * Clear registrations of a specific type
     */
    public clearByType(type: ObjectType): void {
        const idsToRemove: string[] = [];
        for (const [id, entry] of this.registry) {
            if (entry.type === type) {
                if (entry.object) {
                    delete entry.object.userData.objectId;
                    delete entry.object.userData.objectType;
                }
                idsToRemove.push(id);
            }
        }
        for (const id of idsToRemove) {
            this.registry.delete(id);
        }
    }
}

// Export singleton getter for convenience
export function getObjectIdService(): ObjectIdService {
    return ObjectIdService.getInstance();
}
