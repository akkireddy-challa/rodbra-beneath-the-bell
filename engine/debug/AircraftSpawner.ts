import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { AircraftManager } from 'debug/AircraftManager.js';
import { Aircraft } from 'debug/Aircraft.js';

export interface AircraftSpawnerData {
  id: string;
  position: { x: number; y: number; z: number };
  aircraftType: 'airplane' | 'helicopter' | 'balloon';
  aircraftSize?: 'small' | 'medium' | 'large';
  color?: number;
  respawnTime?: number; // seconds, 0 = no respawn
  maxAircraft?: number; // max aircraft this spawner can have active
  spawnRadius?: number; // radius around spawner position to try spawning
}

export class AircraftSpawner {
    private data: AircraftSpawnerData;
    private aircraftManager: AircraftManager;
    private engine: EngineLike;
    private spawnedAircraft: Aircraft[] = [];
    private respawnTimer: number = 0;
    private isActive: boolean = true;
    
    constructor(data: AircraftSpawnerData, aircraftManager: AircraftManager, engine: EngineLike) {
        this.data = { ...data };
        this.aircraftManager = aircraftManager;
        this.engine = engine;
        
        // Set defaults
        this.data.respawnTime = this.data.respawnTime ?? 60; // 60 seconds default respawn
        this.data.maxAircraft = this.data.maxAircraft ?? 1;
        this.data.spawnRadius = this.data.spawnRadius ?? 10;
        this.data.aircraftSize = this.data.aircraftSize ?? 'medium';
        this.data.color = this.data.color ?? this.getDefaultColor();
    }
    
    private getDefaultColor(): number {
        switch (this.data.aircraftType) {
            case 'airplane': return 0x0066cc;
            case 'helicopter': return 0x00cc66;
            case 'balloon': return 0xff6b6b;
            default: return 0x888888;
        }
    }
    
    public async initialize(): Promise<void> {
        for (let i = 0; i < this.data.maxAircraft!; i++) {
            await this.trySpawnAircraft();
        }
        
        console.log(`AircraftSpawner ${this.data.id}: Initialized with ${this.spawnedAircraft.length} aircraft`);
    }
    
    public update(deltaTime: number): void {
        if (!this.isActive) return;
        
        this.cleanupDestroyedAircraft();
        
        if (this.shouldRespawn()) {
            this.respawnTimer += deltaTime;
            
            if (this.respawnTimer >= this.data.respawnTime!) {
                this.trySpawnAircraft();
                this.respawnTimer = 0;
            }
        }
    }
    
    private shouldRespawn(): boolean {
        return this.data.respawnTime! > 0 && 
               this.spawnedAircraft.length < this.data.maxAircraft!;
    }
    
    private cleanupDestroyedAircraft(): void {
        this.spawnedAircraft = this.spawnedAircraft.filter(aircraft => {
            const allAircraft = this.aircraftManager.getAllAircraft();
            return allAircraft.includes(aircraft);
        });
    }
    
    private async trySpawnAircraft(): Promise<boolean> {
        if (this.spawnedAircraft.length >= this.data.maxAircraft!) {
            return false;
        }
        
        const spawnPosition = this.findValidSpawnPosition();
        if (!spawnPosition) {
            console.warn(`AircraftSpawner ${this.data.id}: Could not find valid spawn position`);
            return false;
        }
        
        // Create aircraft based on type
        let aircraft: Aircraft;
        
        switch (this.data.aircraftType) {
            case 'airplane':
                aircraft = this.aircraftManager.createAirplane(spawnPosition, {
                    color: this.data.color!,
                    size: this.data.aircraftSize!
                });
                break;
            case 'helicopter':
                aircraft = this.aircraftManager.createHelicopter(spawnPosition, {
                    color: this.data.color!,
                    size: this.data.aircraftSize!
                });
                break;
            case 'balloon':
                aircraft = this.aircraftManager.createHotAirBalloon(spawnPosition, {
                    color: this.data.color!,
                    size: this.data.aircraftSize!
                });
                break;
            default:
                console.error(`Unknown aircraft type: ${this.data.aircraftType}`);
                return false;
        }
        
        this.spawnedAircraft.push(aircraft);
        console.log(`AircraftSpawner ${this.data.id}: Spawned ${this.data.aircraftType} at`, spawnPosition);
        return true;
    }
    
    private findValidSpawnPosition(): THREE.Vector3 | null {
        const basePosition = new THREE.Vector3(
            this.data.position.x,
            this.data.position.y,
            this.data.position.z
        );
        
        // For aircraft, we can be more flexible with positioning
        // Try the spawner position first
        if (this.isValidAircraftSpawnPosition(basePosition)) {
            return basePosition;
        }
        
        // Try positions within spawn radius
        const maxAttempts = 5;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const distance = Math.random() * this.data.spawnRadius!;
            
            const testPosition = new THREE.Vector3(
                basePosition.x + Math.cos(angle) * distance,
                basePosition.y,
                basePosition.z + Math.sin(angle) * distance
            );
            
            if (this.isValidAircraftSpawnPosition(testPosition)) {
                return testPosition;
            }
        }
        
        return null;
    }
    
    private isValidAircraftSpawnPosition(position: THREE.Vector3): boolean {
        // Check distance from existing aircraft
        const minDistance = 8; // meters
        for (const aircraft of this.spawnedAircraft) {
            if (aircraft.getPosition().distanceTo(position) < minDistance) {
                return false;
            }
        }
        
        // Check distance from all other aircraft in the world
        const allAircraft = this.aircraftManager.getAllAircraft();
        for (const aircraft of allAircraft) {
            if (!this.spawnedAircraft.includes(aircraft)) {
                if (aircraft.getPosition().distanceTo(position) < minDistance) {
                    return false;
                }
            }
        }
        
        return true;
    }
    
    public getData(): AircraftSpawnerData {
        return { ...this.data };
    }
    
    public getId(): string {
        return this.data.id;
    }
    
    public getPosition(): THREE.Vector3 {
        return new THREE.Vector3(this.data.position.x, this.data.position.y, this.data.position.z);
    }
    
    public getSpawnedAircraft(): Aircraft[] {
        return [...this.spawnedAircraft];
    }
    
    public despawnAllAircraft(): void {
        for (const aircraft of this.spawnedAircraft) {
            this.aircraftManager.removeAircraft(aircraft);
        }
        this.spawnedAircraft = [];
    }
    
    public setActive(active: boolean): void {
        this.isActive = active;
        if (!active) {
            this.respawnTimer = 0;
        }
    }
    
    public dispose(): void {
        this.despawnAllAircraft();
        this.isActive = false;
    }
}

export class AircraftSpawnerManager {
    private spawners: Map<string, AircraftSpawner> = new Map();
    private aircraftManager: AircraftManager;
    private engine: EngineLike;
    
    constructor(aircraftManager: AircraftManager, engine: EngineLike) {
        this.aircraftManager = aircraftManager;
        this.engine = engine;
    }
    
    public createSpawner(data: AircraftSpawnerData): AircraftSpawner {
        if (this.spawners.has(data.id)) {
            console.warn(`AircraftSpawnerManager: Spawner with ID ${data.id} already exists`);
            return this.spawners.get(data.id)!;
        }
        
        const spawner = new AircraftSpawner(data, this.aircraftManager, this.engine);
        this.spawners.set(data.id, spawner);
        return spawner;
    }
    
    public async loadSpawners(spawnerDataList: AircraftSpawnerData[]): Promise<void> {
        console.log(`AircraftSpawnerManager: Loading ${spawnerDataList.length} aircraft spawners`);
        
        for (const spawnerData of spawnerDataList) {
            const spawner = this.createSpawner(spawnerData);
            await spawner.initialize();
        }
    }
    
    public getSaveData(): AircraftSpawnerData[] {
        return Array.from(this.spawners.values()).map(spawner => spawner.getData());
    }
    
    public update(deltaTime: number): void {
        for (const spawner of this.spawners.values()) {
            spawner.update(deltaTime);
        }
    }
    
    public static generateSpawnersForWorld(
        worldSeed: number,
        worldSize: number,
        spawnCount: number = 3
    ): AircraftSpawnerData[] {
        const spawners: AircraftSpawnerData[] = [];
        const rng = {
            state: worldSeed + 1000, // Different seed offset from vehicles
            next(): number {
                this.state = (this.state * 1664525 + 1013904223) % 4294967296;
                return this.state / 4294967296;
            }
        };
        
        const aircraftTypes: ('airplane' | 'helicopter' | 'balloon')[] = ['airplane', 'helicopter', 'balloon'];
        const aircraftSizes: ('small' | 'medium' | 'large')[] = ['small', 'medium', 'large'];
        const colors = [0x0066cc, 0x00cc66, 0xff6b6b, 0xffff00, 0xff00ff, 0x00ffff];
        
        for (let i = 0; i < spawnCount; i++) {
            // Generate position away from center and vehicles
            let x, z;
            do {
                x = (rng.next() - 0.5) * (worldSize * 0.6);
                z = (rng.next() - 0.5) * (worldSize * 0.6);
            } while (Math.sqrt(x * x + z * z) < 20); // Keep away from spawn and vehicles
            
            const aircraftType = aircraftTypes[Math.floor(rng.next() * aircraftTypes.length)] || 'airplane';
            const aircraftSize = aircraftSizes[Math.floor(rng.next() * aircraftSizes.length)] || 'medium';
            const color = colors[Math.floor(rng.next() * colors.length)] || 0x0066cc;
            
            const spawnerData: AircraftSpawnerData = {
                id: `aircraft_spawner_${i}`,
                position: { x, y: 5, z }, // Spawn aircraft higher up
                aircraftType,
                aircraftSize,
                color,
                respawnTime: 60 + Math.floor(rng.next() * 120), // 60-180 seconds
                maxAircraft: 1,
                spawnRadius: 5 + rng.next() * 10 // 5-15 meter radius
            };
            
            spawners.push(spawnerData);
        }
        
        return spawners;
    }
    
    public dispose(): void {
        for (const spawner of this.spawners.values()) {
            spawner.dispose();
        }
        this.spawners.clear();
    }
}
