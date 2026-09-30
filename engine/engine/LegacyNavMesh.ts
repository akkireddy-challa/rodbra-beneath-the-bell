import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';

interface NavNode {
    x: number;
    z: number;
    walkable: boolean;
}

export class LegacyNavMesh {
    private grid: NavNode[][] = [];
    private gridSize: number = 40; // 40x40 grid for 20x20 world
    private cellSize: number = 0.5; // Each cell is 0.5 units
    private engine: EngineLike;
    
    constructor(engine: EngineLike) {
        this.engine = engine;
        this.buildGrid();
    }
    
    private buildGrid(): void {
        for (let x = 0; x < this.gridSize; x++) {
            this.grid[x] = [];
            for (let z = 0; z < this.gridSize; z++) {
                const worldX = (x - this.gridSize / 2) * this.cellSize;
                const worldZ = (z - this.gridSize / 2) * this.cellSize;
                
                // Check if this cell is walkable (raycast)
                const walkable = this.isWalkable(worldX, worldZ);
                
                this.grid[x]![z] = { x: worldX, z: worldZ, walkable };
            }
        }
    }
    
    private isWalkable(x: number, z: number): boolean {
        if (!this.engine.physicsWorld) return true;
        
        // Cast ray downward to check for ground
        const origin = new THREE.Vector3(x, 5, z);
        const direction = new THREE.Vector3(0, -1, 0);
        const maxDistance = 6; // From y=5 to y=-1
        
        const result = this.engine.physicsWorld.raycast(origin, direction, maxDistance, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);

        if (!result.hasHit) return false;
        
        const groundY = this.engine.getWorldHeightAt?.(x, z) ?? 0;
        const checkHeight = groundY + 0.875;
        
        const horizontalChecks = [
            { dx: 0.2, dz: 0 },
            { dx: -0.2, dz: 0 },
            { dx: 0, dz: 0.2 },
            { dx: 0, dz: -0.2 }
        ];
        
        for (const check of horizontalChecks) {
            const fromPos = new THREE.Vector3(x + check.dx, checkHeight, z + check.dz);
            const toPos = new THREE.Vector3(x - check.dx, checkHeight, z - check.dz);
            
            // Calculate direction from fromPos to toPos
            const horizDir = new THREE.Vector3().subVectors(toPos, fromPos).normalize();
            const horizDistance = fromPos.distanceTo(toPos);
            
            const horizResult = this.engine.physicsWorld.raycast(fromPos, horizDir, horizDistance, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);
            
            if (horizResult.hasHit) {
                return false;
            }
        }
        
        return true;
    }
    
    findPath(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3[] {
        const startCell = this.worldToGrid(start.x, start.z);
        const endCell = this.worldToGrid(end.x, end.z);
        
        if (!this.isValidCell(startCell.x, startCell.z) || !this.isValidCell(endCell.x, endCell.z)) {
            return [end]; // Return direct path if invalid
        }
        
        // Simple A* pathfinding
        const openSet: Array<{x: number, z: number, g: number, h: number, parent: {x: number, z: number} | null}> = [];
        const closedSet = new Set<string>();
        
        openSet.push({
            x: startCell.x,
            z: startCell.z,
            g: 0,
            h: this.heuristic(startCell, endCell),
            parent: null
        });
        
        while (openSet.length > 0) {
            // Find node with lowest f score
            openSet.sort((a, b) => (a.g + a.h) - (b.g + b.h));
            const current = openSet.shift()!;
            
            if (current.x === endCell.x && current.z === endCell.z) {
                // Found path, reconstruct it
                return this.reconstructPath(current, start, end);
            }
            
            closedSet.add(`${current.x},${current.z}`);
            
            // Check neighbors
            const neighbors = [
                {x: current.x + 1, z: current.z},
                {x: current.x - 1, z: current.z},
                {x: current.x, z: current.z + 1},
                {x: current.x, z: current.z - 1}
            ];
            
            for (const neighbor of neighbors) {
                if (!this.isValidCell(neighbor.x, neighbor.z)) continue;
                const neighborCell = this.grid[neighbor.x]?.[neighbor.z];
                if (!neighborCell || !neighborCell.walkable) continue;
                if (closedSet.has(`${neighbor.x},${neighbor.z}`)) continue;
                
                const g = current.g + 1;
                const h = this.heuristic(neighbor, endCell);
                
                const existing = openSet.find(n => n.x === neighbor.x && n.z === neighbor.z);
                if (!existing || g < existing.g) {
                    if (existing) {
                        existing.g = g;
                        existing.parent = {x: current.x, z: current.z};
                    } else {
                        openSet.push({
                            x: neighbor.x,
                            z: neighbor.z,
                            g,
                            h,
                            parent: {x: current.x, z: current.z}
                        });
                    }
                }
            }
            
            // Limit iterations to prevent infinite loops
            if (closedSet.size > 1000) break;
        }
        
        // No path found, return direct
        return [end];
    }
    
    private worldToGrid(x: number, z: number): {x: number, z: number} {
        return {
            x: Math.floor((x / this.cellSize) + this.gridSize / 2),
            z: Math.floor((z / this.cellSize) + this.gridSize / 2)
        };
    }
    
    private gridToWorld(x: number, z: number): {x: number, z: number} {
        return {
            x: (x - this.gridSize / 2) * this.cellSize,
            z: (z - this.gridSize / 2) * this.cellSize
        };
    }
    
    private isValidCell(x: number, z: number): boolean {
        return x >= 0 && x < this.gridSize && z >= 0 && z < this.gridSize;
    }
    
    private heuristic(a: {x: number, z: number}, b: {x: number, z: number}): number {
        return Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
    }
    
    private reconstructPath(endNode: any, start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3[] {
        const path: THREE.Vector3[] = [];
        let current: any = endNode;
        
        while (current.parent) {
            const worldPos = this.gridToWorld(current.x, current.z);
            const y = this.engine.getWorldHeightAt?.(worldPos.x, worldPos.z) ?? 0;
            path.unshift(new THREE.Vector3(worldPos.x, y, worldPos.z));
            current = current.parent;
        }
        
        // Add final destination
        path.push(end);
        
        return path;
    }
}
