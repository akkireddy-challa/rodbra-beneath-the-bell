import * as THREE from 'three';
import { CHUNK_SIZE } from 'engine/VoxelGeometry.js';

/**
 * Interface for objects that can be managed by the chunk physics system.
 * Dynamic objects (animals, NPCs, vehicles, etc.) implement this to support
 * hibernation when their containing chunks become inactive.
 */
export interface ChunkManagedObject {
    getPosition(): THREE.Vector3;
    hibernate(): void;
    wake(): void;
    isHibernating(): boolean;
    
    /**
     * Optional: Hold physics (disable gravity) until terrain colliders are ready.
     * Called by DynamicObjectManager when object registers before colliders are active.
     * Objects with physics bodies should implement this to prevent falling through ground.
     */
    holdPhysicsUntilReady?(): void;
    
    /**
     * Optional: Release physics (re-enable gravity) when terrain colliders are ready.
     * Called by DynamicObjectManager when colliders become queryable after physics step.
     */
    releasePhysics?(): void;
    
    /**
     * Optional: Return true if this object must always remain active.
     * Always-active objects never hibernate, and their terrain chunks stay loaded
     * (physics colliders enabled) even when outside the camera frustum.
     * Set via setAlwaysActive(true) on vehicles, NPCs, animals, or dynamic VoxelObjects.
     */
    isAlwaysActive?(): boolean;

    /**
     * Optional: Return false to veto hibernation right now. Used by objects with
     * a physics body that is awake and moving — hibernating such an object
     * mid-motion makes it visibly vanish (e.g. while it is being pushed across
     * a chunk boundary whose neighbour chunk is inactive), and waking it later
     * re-inserts its body wherever other bodies may have drifted, which the
     * solver resolves violently. The object hibernates normally once it has
     * come to rest.
     */
    canHibernate?(): boolean;
}

/**
 * ChunkPhysicsManager - Manages physics collider activation based on distance
 * and coordinates hibernation of dynamic objects when chunks are disabled.
 * 
 * Key behaviors:
 * - Chunks beyond physicsDistance have their colliders disabled
 * - Dynamic objects register with overlapping chunks (1/2/4 chunks)
 * - If ANY connected chunk is disabled → object hibernates
 * - If ALL connected chunks are enabled → object wakes
 * 
 * This prevents objects from falling through terrain when colliders are disabled
 * while optimizing physics performance for large worlds.
 */
export class ChunkPhysicsManager {
    private voxelSize: number;
    private chunkWorldSize: number;
    
    // Distance within which chunks have active physics colliders
    private physicsDistance: number = 150;
    
    // Currently active chunks (visible OR anchored)
    private activeChunks: Set<string> = new Set();
    
    // Track frustum visibility separately from active state.
    // A chunk is active if it's visible in the frustum OR has a terrain anchor.
    private visibleChunks: Set<string> = new Set();

    // The 3×3 chunks around each live character (player, NPCs, animals) — ALWAYS physics-active
    // regardless of frustum. The frustum test uses the chunk's whole 16×16 box, so a character
    // standing near a chunk CORNER whose box is off-screen has that chunk culled while standing on
    // visually solid ground (the visible ground belongs to neighbour chunks) — the collider under
    // their feet gets disabled and they fall through. Anchoring every character makes that impossible.
    // (Originally only the player was anchored, so off-camera NPCs/animals sank waist-deep into the
    // terrain where the voxel-floor safety net bobs them — see keepActiveAround.)
    private characterAnchorChunks: Set<string> = new Set();
    
    // All chunks ever evaluated by the visibility system. Chunks NOT in this set
    // are newly created and haven't been through a visibility pass yet — they
    // are treated as active until the visibility system evaluates them.
    private knownChunks: Set<string> = new Set();
    
    // Maps chunk keys to the dynamic objects overlapping that chunk
    private chunkToObjects: Map<string, Set<ChunkManagedObject>> = new Map();
    
    // Maps objects to the chunk keys they're registered with
    private objectToChunks: Map<ChunkManagedObject, Set<string>> = new Map();
    
    // Callback to enable/disable chunk colliders
    private onChunkStateChange: ((chunkKey: string, enabled: boolean) => void) | null = null;
    
    // World bounds for chunk coordinate calculation
    private boundsMinX: number = 0;
    private boundsMinZ: number = 0;
    
    constructor(voxelSize: number = 1.0) {
        this.voxelSize = voxelSize;
        this.chunkWorldSize = CHUNK_SIZE * voxelSize;
    }
    
    /**
     * Initialize all provided chunk keys as active.
     * Call this after setup to ensure all chunks start with physics enabled.
     * Visibility culling will then deactivate chunks as they go out of view.
     * 
     * This prevents race conditions where objects spawn before visibility is updated.
     */
    initializeAllChunksActive(chunkKeys: Set<string>): void {
        // Record state without firing the per-chunk callback: trimesh colliders are
        // enabled by default at creation, and env-object physics haven't been loaded
        // yet (that happens after this init). The callback's job is to react to
        // state TRANSITIONS, so for the initial all-active state it's pure overhead —
        // and at 1920×1920 (14,400 chunks) the previous O(N²) callback chain cost ~41s.
        for (const chunkKey of chunkKeys) {
            this.knownChunks.add(chunkKey);
            this.activeChunks.add(chunkKey);
        }
    }
    
    /**
     * Set the physics activation distance.
     * Chunks beyond this distance from camera will have colliders disabled.
     */
    setPhysicsDistance(distance: number): void {
        this.physicsDistance = distance;
    }
    
    getPhysicsDistance(): number {
        return this.physicsDistance;
    }
    
    /**
     * Set world bounds offset for chunk coordinate calculation.
     */
    setBoundsOffset(minX: number, minZ: number): void {
        this.boundsMinX = minX;
        this.boundsMinZ = minZ;
    }
    
    /**
     * Set callback for when chunk physics state changes.
     * Called with (chunkKey, enabled) when a chunk should enable/disable its colliders.
     */
    setChunkStateChangeCallback(callback: (chunkKey: string, enabled: boolean) => void): void {
        this.onChunkStateChange = callback;
    }
    
    /**
     * Convert world position to chunk key(s) that the position overlaps.
     * Returns 1 chunk if in center, 2 if near edge, 4 if near corner.
     * 
     * @param position World position
     * @param objectRadius Radius of the object for overlap detection
     */
    getOverlappingChunkKeys(position: THREE.Vector3, objectRadius: number = 0.5): Set<string> {
        const chunks = new Set<string>();
        
        // Convert to chunk-local coordinates
        const localX = position.x - this.boundsMinX;
        const localZ = position.z - this.boundsMinZ;
        
        // Primary chunk
        const cx = Math.floor(localX / this.chunkWorldSize);
        const cz = Math.floor(localZ / this.chunkWorldSize);
        
        // Position within chunk (0 to chunkWorldSize)
        const inChunkX = localX - cx * this.chunkWorldSize;
        const inChunkZ = localZ - cz * this.chunkWorldSize;
        
        // Check if near edges (within objectRadius of chunk boundary)
        const nearMinX = inChunkX < objectRadius;
        const nearMaxX = inChunkX > this.chunkWorldSize - objectRadius;
        const nearMinZ = inChunkZ < objectRadius;
        const nearMaxZ = inChunkZ > this.chunkWorldSize - objectRadius;
        
        // Add primary chunk (use cy=0 for 2D chunk tracking, Y handled by column)
        chunks.add(this.makeChunkKey(cx, cz));
        
        // Add adjacent chunks if near edges
        if (nearMinX) chunks.add(this.makeChunkKey(cx - 1, cz));
        if (nearMaxX) chunks.add(this.makeChunkKey(cx + 1, cz));
        if (nearMinZ) chunks.add(this.makeChunkKey(cx, cz - 1));
        if (nearMaxZ) chunks.add(this.makeChunkKey(cx, cz + 1));
        
        // Add corner chunks if near corners
        if (nearMinX && nearMinZ) chunks.add(this.makeChunkKey(cx - 1, cz - 1));
        if (nearMinX && nearMaxZ) chunks.add(this.makeChunkKey(cx - 1, cz + 1));
        if (nearMaxX && nearMinZ) chunks.add(this.makeChunkKey(cx + 1, cz - 1));
        if (nearMaxX && nearMaxZ) chunks.add(this.makeChunkKey(cx + 1, cz + 1));
        
        return chunks;
    }
    
    private makeChunkKey(cx: number, cz: number): string {
        return `${cx},${cz}`;
    }
    
    /**
     * Register a dynamic object with the physics manager.
     * The object will be tracked and hibernated when its chunks become inactive.
     */
    registerObject(obj: ChunkManagedObject, objectRadius: number = 0.5): void {
        if (this.objectToChunks.has(obj)) return; // Already registered

        const chunks = this.getOverlappingChunkKeys(obj.getPosition(), objectRadius);
        this.objectToChunks.set(obj, chunks);

        for (const chunkKey of chunks) this.addObjectToChunk(chunkKey, obj);

        // Check if object should hibernate immediately (if any chunk is inactive)
        this.updateObjectHibernation(obj, chunks);
    }

    /**
     * Unregister a dynamic object from the physics manager.
     */
    unregisterObject(obj: ChunkManagedObject): void {
        const chunks = this.objectToChunks.get(obj);
        if (!chunks) return;

        for (const chunkKey of chunks) this.removeObjectFromChunk(chunkKey, obj);

        this.objectToChunks.delete(obj);
    }

    private addObjectToChunk(chunkKey: string, obj: ChunkManagedObject): void {
        let set = this.chunkToObjects.get(chunkKey);
        if (!set) {
            set = new Set();
            this.chunkToObjects.set(chunkKey, set);
        }
        set.add(obj);
    }

    private removeObjectFromChunk(chunkKey: string, obj: ChunkManagedObject): void {
        const set = this.chunkToObjects.get(chunkKey);
        if (!set) return;
        set.delete(obj);
        if (set.size === 0) this.chunkToObjects.delete(chunkKey);
    }
    
    /**
     * Update an object's chunk registration when it moves.
     * Call this when a dynamic object crosses a chunk boundary.
     * 
     * @param obj The object that moved
     * @param objectRadius Radius for overlap detection
     */
    updateObjectPosition(obj: ChunkManagedObject, objectRadius: number = 0.5): void {
        const oldChunks = this.objectToChunks.get(obj);
        if (!oldChunks) {
            // Not registered, register now
            this.registerObject(obj, objectRadius);
            return;
        }
        
        const newChunks = this.getOverlappingChunkKeys(obj.getPosition(), objectRadius);
        
        // Check if chunks changed
        if (this.setsEqual(oldChunks, newChunks)) return;
        
        // Remove from old chunks
        for (const chunkKey of oldChunks) {
            if (!newChunks.has(chunkKey)) this.removeObjectFromChunk(chunkKey, obj);
        }

        // Add to new chunks
        for (const chunkKey of newChunks) {
            if (!oldChunks.has(chunkKey)) this.addObjectToChunk(chunkKey, obj);
        }
        
        // Update mapping
        this.objectToChunks.set(obj, newChunks);
        
        // Check hibernation state (also activates new chunks for terrain anchors)
        this.updateObjectHibernation(obj, newChunks);
        
        // For always-active objects: re-evaluate old chunks that the object left.
        // They may need to deactivate if nothing else is keeping them active.
        if (obj.isAlwaysActive?.()) {
            for (const chunkKey of oldChunks) {
                if (!newChunks.has(chunkKey)) {
                    this.updateChunkActiveState(chunkKey);
                }
            }
        }
    }
    
    private setsEqual(a: Set<string>, b: Set<string>): boolean {
        if (a.size !== b.size) return false;
        for (const item of a) if (!b.has(item)) return false;
        return true;
    }
    
    /**
     * Update which chunks have active physics based on camera position.
     * Call this every frame (or when camera moves significantly).
     * 
     * @param cameraPosition Current camera/player position
     */
    updateActiveChunks(cameraPosition: THREE.Vector3): void {
        const maxDistSq = this.physicsDistance * this.physicsDistance;
        
        // Calculate camera chunk position
        const camLocalX = cameraPosition.x - this.boundsMinX;
        const camLocalZ = cameraPosition.z - this.boundsMinZ;
        const camCx = Math.floor(camLocalX / this.chunkWorldSize);
        const camCz = Math.floor(camLocalZ / this.chunkWorldSize);
        
        // Calculate chunk radius to check
        const chunkRadius = Math.ceil(this.physicsDistance / this.chunkWorldSize) + 1;
        
        // Track which chunks should be active
        const shouldBeActive = new Set<string>();
        
        for (let dx = -chunkRadius; dx <= chunkRadius; dx++) {
            for (let dz = -chunkRadius; dz <= chunkRadius; dz++) {
                const cx = camCx + dx;
                const cz = camCz + dz;
                
                // Calculate chunk center distance
                const chunkCenterX = this.boundsMinX + (cx + 0.5) * this.chunkWorldSize;
                const chunkCenterZ = this.boundsMinZ + (cz + 0.5) * this.chunkWorldSize;
                
                const ddx = chunkCenterX - cameraPosition.x;
                const ddz = chunkCenterZ - cameraPosition.z;
                const distSq = ddx * ddx + ddz * ddz;
                
                if (distSq <= maxDistSq) {
                    shouldBeActive.add(this.makeChunkKey(cx, cz));
                }
            }
        }
        
        // Find chunks that changed state
        const nowActive: string[] = [];
        const nowInactive: string[] = [];
        
        // Check for newly inactive chunks
        for (const chunkKey of this.activeChunks) {
            if (!shouldBeActive.has(chunkKey)) {
                nowInactive.push(chunkKey);
            }
        }
        
        // Check for newly active chunks
        for (const chunkKey of shouldBeActive) {
            if (!this.activeChunks.has(chunkKey)) {
                nowActive.push(chunkKey);
            }
        }
        
        // Apply state changes
        // Process inactive first (hibernate objects before enabling new chunks)
        for (const chunkKey of nowInactive) {
            this.activeChunks.delete(chunkKey);
            this.onChunkBecameInactive(chunkKey);
        }
        
        for (const chunkKey of nowActive) {
            this.activeChunks.add(chunkKey);
            this.onChunkBecameActive(chunkKey);
        }
    }
    
    /**
     * Mark a chunk active and fire its activation side effects, but only if it
     * wasn't already active. Centralizes the "add + onChunkBecameActive" idiom
     * used by the respawn, player-anchor, and always-active code paths.
     */
    private activateChunk(chunkKey: string): void {
        if (this.activeChunks.has(chunkKey)) return;
        this.activeChunks.add(chunkKey);
        this.onChunkBecameActive(chunkKey);
    }

    private onChunkBecameActive(chunkKey: string): void {
        // Enable chunk colliders
        if (this.onChunkStateChange) {
            this.onChunkStateChange(chunkKey, true);
        }
        
        // Check if any objects in this chunk can wake up
        const objects = this.chunkToObjects.get(chunkKey);
        if (objects) {
            for (const obj of objects) {
                const objChunks = this.objectToChunks.get(obj);
                if (objChunks) {
                    this.updateObjectHibernation(obj, objChunks);
                }
            }
        }
    }
    
    private onChunkBecameInactive(chunkKey: string): void {
        // Disable chunk colliders
        if (this.onChunkStateChange) {
            this.onChunkStateChange(chunkKey, false);
        }
        
        // Hibernate all objects in this chunk
        const objects = this.chunkToObjects.get(chunkKey);
        if (objects) {
            for (const obj of objects) {
                if (!obj.isHibernating() && (obj.canHibernate?.() ?? true)) {
                    obj.hibernate();
                }
            }
        }
    }
    
    /**
     * Update an object's hibernation state based on its chunk membership.
     * Object hibernates if ANY chunk is inactive, wakes if ALL are active.
     * Always-active objects never hibernate and keep their chunks loaded.
     */
    private updateObjectHibernation(obj: ChunkManagedObject, chunks: Set<string>): void {
        // Always-active objects keep their chunks active and never hibernate.
        if (obj.isAlwaysActive?.()) {
            // Force all chunks this object occupies to be active
            for (const chunkKey of chunks) this.activateChunk(chunkKey);
            if (obj.isHibernating()) obj.wake();
            return;
        }
        
        let anyInactive = false;
        for (const chunkKey of chunks) {
            if (!this.activeChunks.has(chunkKey)) {
                // Only treat as inactive if the visibility system has explicitly
                // marked this chunk as not visible. Chunks that have never been
                // evaluated (e.g. newly created terrain) are assumed active until
                // the first visibility update runs.
                if (this.visibleChunks.has(chunkKey) || this.knownChunks.has(chunkKey)) {
                    anyInactive = true;
                    break;
                }
            }
        }

        if (anyInactive && !obj.isHibernating()) {
            if (obj.canHibernate?.() ?? true) obj.hibernate();
        } else if (!anyInactive && obj.isHibernating()) {
            obj.wake();
        }
    }
    
    /**
     * Set a chunk's active state based on visibility (for frustum-based activation).
     * Use this instead of updateActiveChunks() for top-down camera or frustum-based physics.
     * 
     * A chunk stays active if it's visible in the frustum OR has a terrain anchor.
     * 
     * @param chunkKey2D The 2D chunk key (format: "cx,cz")
     * @param visible Whether the chunk is visible in the camera frustum
     */
    setChunkActiveFromVisibility(chunkKey2D: string, visible: boolean): void {
        // Mark chunk as known to the visibility system
        this.knownChunks.add(chunkKey2D);
        
        // Track visibility state separately from active state
        if (visible) {
            this.visibleChunks.add(chunkKey2D);
        } else {
            this.visibleChunks.delete(chunkKey2D);
        }
        
        // Chunk should be active if visible OR anchored
        this.updateChunkActiveState(chunkKey2D);
    }
    
    /**
     * Check if a specific chunk is currently active.
     */
    isChunkActive(chunkKey: string): boolean {
        return this.activeChunks.has(chunkKey);
    }
    
    /**
     * Check if a chunk at the given world position is active.
     */
    isPositionInActiveChunk(position: THREE.Vector3): boolean {
        const localX = position.x - this.boundsMinX;
        const localZ = position.z - this.boundsMinZ;
        const cx = Math.floor(localX / this.chunkWorldSize);
        const cz = Math.floor(localZ / this.chunkWorldSize);
        return this.activeChunks.has(this.makeChunkKey(cx, cz));
    }
    
    /**
     * Force-activate the chunk at a world position and its neighbors.
     * Used during respawn to ensure terrain colliders exist before the player lands.
     */
    forceActivateAtPosition(worldX: number, worldZ: number): void {
        const localX = worldX - this.boundsMinX;
        const localZ = worldZ - this.boundsMinZ;
        const cx = Math.floor(localX / this.chunkWorldSize);
        const cz = Math.floor(localZ / this.chunkWorldSize);
        
        // Activate the chunk and its 8 neighbors (3x3 grid)
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                this.activateChunk(this.makeChunkKey(cx + dx, cz + dz));
            }
        }
    }

    /**
     * Keep the 3×3 chunks around each given world position (the player AND every live NPC/animal)
     * physics-active EVERY FRAME, regardless of frustum visibility. Call before the per-frame
     * visibility update so view culling can never disable the collider under a character (see
     * characterAnchorChunks for the corner-of-chunk case this prevents). The union of every
     * character's 3×3 neighbourhood is recomputed each call and diffed against last frame's set.
     */
    keepActiveAround(worldPositions: ReadonlyArray<THREE.Vector3>): void {
        const next = new Set<string>();
        for (const pos of worldPositions) {
            const cx = Math.floor((pos.x - this.boundsMinX) / this.chunkWorldSize);
            const cz = Math.floor((pos.z - this.boundsMinZ) / this.chunkWorldSize);
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) next.add(this.makeChunkKey(cx + dx, cz + dz));
            }
        }
        if (this.setsEqual(this.characterAnchorChunks, next)) return; // same anchor set as last frame

        const prev = this.characterAnchorChunks;
        this.characterAnchorChunks = next;
        // Newly anchored chunks: enable their colliders now.
        for (const key of next) this.activateChunk(key);
        // Chunks no longer anchored by any character: re-evaluate (deactivate unless still
        // frustum-visible / terrain-anchored).
        for (const key of prev) {
            if (!next.has(key)) this.updateChunkActiveState(key);
        }
    }

    /**
     * Check if a chunk has any terrain anchor objects keeping it active.
     * Always-active objects keep their chunks loaded even when outside the camera frustum.
     */
    private isChunkAnchored(chunkKey: string): boolean {
        const objects = this.chunkToObjects.get(chunkKey);
        if (objects) {
            for (const obj of objects) {
                if (obj.isAlwaysActive?.()) return true;
            }
        }
        return false;
    }
    
    /**
     * Re-evaluate whether a chunk should be active based on visibility and anchors.
     * A chunk is active if it's visible in the camera frustum OR has a terrain anchor.
     */
    private updateChunkActiveState(chunkKey: string): void {
        const shouldBeActive = this.visibleChunks.has(chunkKey) || this.isChunkAnchored(chunkKey)
            || this.characterAnchorChunks.has(chunkKey);

        if (shouldBeActive) {
            this.activateChunk(chunkKey);
        } else if (this.activeChunks.has(chunkKey)) {
            this.activeChunks.delete(chunkKey);
            this.onChunkBecameInactive(chunkKey);
        }
    }
    
    /**
     * Get the number of registered terrain anchors.
     */
    getAnchorCount(): number {
        let count = 0;
        for (const obj of this.objectToChunks.keys()) {
            if (obj.isAlwaysActive?.()) count++;
        }
        return count;
    }
    
    /**
     * Get statistics about the current state.
     */
    getStats(): { activeChunks: number; trackedObjects: number; registrations: number; terrainAnchors: number } {
        let registrations = 0;
        for (const chunks of this.objectToChunks.values()) {
            registrations += chunks.size;
        }
        
        return {
            activeChunks: this.activeChunks.size,
            trackedObjects: this.objectToChunks.size,
            registrations,
            terrainAnchors: this.getAnchorCount()
        };
    }
    
    /**
     * Clear all state.
     */
    clear(): void {
        this.activeChunks.clear();
        this.visibleChunks.clear();
        this.knownChunks.clear();
        this.chunkToObjects.clear();
        this.objectToChunks.clear();
    }
}
