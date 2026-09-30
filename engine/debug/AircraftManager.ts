import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { Aircraft } from 'debug/Aircraft.js';
import { Airplane, type AirplaneConfig } from 'debug/Airplane.js';
import { Helicopter, type HelicopterConfig } from 'debug/Helicopter.js';
import { HotAirBalloon, type HotAirBalloonConfig } from 'debug/HotAirBalloon.js';

export class AircraftManager {
    private engine: EngineLike;
    private aircraft: Aircraft[] = [];
    private activeAircraft: Aircraft | null = null;
    
    constructor(engine: EngineLike) {
        this.engine = engine;
    }
    
    public createAirplane(position: THREE.Vector3, options: {
        color?: number;
        size?: 'small' | 'medium' | 'large';
    } = {}): Airplane {
        const { color = 0x0066cc, size = 'medium' } = options;
        
        const sizeConfigs = {
            small: { wingSpan: 6, minSpeed: 6, maxSpeed: 20, climbRate: 5, turnRate: 0.04 },
            medium: { wingSpan: 8, minSpeed: 8, maxSpeed: 25, climbRate: 8, turnRate: 0.03 },
            large: { wingSpan: 10, minSpeed: 10, maxSpeed: 30, climbRate: 10, turnRate: 0.02 }
        };
        
        const sizeConfig = sizeConfigs[size];
        
        const config: AirplaneConfig = {
            position: position.clone(),
            mass: 500 + (size === 'large' ? 300 : size === 'small' ? -200 : 0),
            size: { 
                width: sizeConfig.wingSpan * 0.1, 
                height: 1, 
                length: sizeConfig.wingSpan * 0.3 
            },
            maxAltitude: 100,
            bodyColor: color,
            type: 'airplane',
            wingSpan: sizeConfig.wingSpan,
            minSpeed: sizeConfig.minSpeed,
            maxSpeed: sizeConfig.maxSpeed,
            climbRate: sizeConfig.climbRate,
            turnRate: sizeConfig.turnRate
        };
        
        const airplane = new Airplane(this.engine, config);
        this.aircraft.push(airplane);
        return airplane;
    }
    
    public createHelicopter(position: THREE.Vector3, options: {
        color?: number;
        size?: 'small' | 'medium' | 'large';
    } = {}): Helicopter {
        const { color = 0x00cc66, size = 'medium' } = options;
        
        const sizeConfigs = {
            small: { rotorRadius: 2, maxVertical: 8, maxHorizontal: 12, stability: 50 },
            medium: { rotorRadius: 3, maxVertical: 12, maxHorizontal: 15, stability: 80 },
            large: { rotorRadius: 4, maxVertical: 15, maxHorizontal: 18, stability: 100 }
        };
        
        const sizeConfig = sizeConfigs[size];
        
        const config: HelicopterConfig = {
            position: position.clone(),
            mass: 400 + (size === 'large' ? 200 : size === 'small' ? -150 : 0),
            size: { 
                width: sizeConfig.rotorRadius * 0.3, 
                height: 1.5, 
                length: sizeConfig.rotorRadius * 0.4 
            },
            maxAltitude: 80,
            bodyColor: color,
            type: 'helicopter',
            rotorRadius: sizeConfig.rotorRadius,
            maxVerticalSpeed: sizeConfig.maxVertical,
            maxHorizontalSpeed: sizeConfig.maxHorizontal,
            hoverStability: sizeConfig.stability
        };
        
        const helicopter = new Helicopter(this.engine, config);
        this.aircraft.push(helicopter);
        return helicopter;
    }
    
    public createHotAirBalloon(position: THREE.Vector3, options: {
        color?: number;
        size?: 'small' | 'medium' | 'large';
    } = {}): HotAirBalloon {
        const { color = 0xff6b6b, size = 'medium' } = options;
        
        const sizeConfigs = {
            small: { balloonRadius: 3, maxBuoyancy: 8, windSensitivity: 5 },
            medium: { balloonRadius: 4, maxBuoyancy: 12, windSensitivity: 8 },
            large: { balloonRadius: 5, maxBuoyancy: 16, windSensitivity: 10 }
        };
        
        const sizeConfig = sizeConfigs[size];
        
        const config: HotAirBalloonConfig = {
            position: position.clone(),
            mass: 200 + (size === 'large' ? 100 : size === 'small' ? -50 : 0),
            size: { width: 1.5, height: 1, length: 1.5 }, // Basket size
            maxAltitude: 120,
            bodyColor: color,
            type: 'balloon',
            balloonRadius: sizeConfig.balloonRadius,
            basketSize: { width: 1.5, height: 1, length: 1.5 },
            maxBuoyancy: sizeConfig.maxBuoyancy,
            windSensitivity: sizeConfig.windSensitivity
        };
        
        const balloon = new HotAirBalloon(this.engine, config);
        this.aircraft.push(balloon);
        return balloon;
    }
    
    public update(): void {
        this.aircraft.forEach(aircraft => {
            aircraft.update();
        });
    }
    
    public findNearestAircraft(position: THREE.Vector3, maxDistance: number = 5.0): Aircraft | null {
        let nearestAircraft: Aircraft | null = null;
        let nearestDistance = maxDistance;
        
        for (const aircraft of this.aircraft) {
            const distance = aircraft.getPosition().distanceTo(position);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestAircraft = aircraft;
            }
        }
        
        return nearestAircraft;
    }
    
    public findInteractableAircraft(playerPosition: THREE.Vector3): Aircraft | null {
        return this.findNearestAircraft(playerPosition, 4.0);
    }
    
    public tryEnterAircraft(player: any, playerPosition: THREE.Vector3): boolean {
        const aircraft = this.findInteractableAircraft(playerPosition);
        
        if (aircraft && aircraft.canPlayerEnter()) {
            const success = aircraft.enterAircraft(player);
            if (success) {
                this.activeAircraft = aircraft;
                return true;
            }
        }
        
        return false;
    }
    
    public tryLandAircraft(): boolean {
        if (this.activeAircraft && this.activeAircraft.canPlayerLand()) {
            const pilot = this.activeAircraft.exitAircraft();
            if (pilot) {
                this.activeAircraft = null;
                return true;
            }
        }
        
        return false;
    }
    
    public exitCurrentAircraft(): any {
        if (this.activeAircraft) {
            const pilot = this.activeAircraft.exitAircraft();
            if (pilot) {
                this.activeAircraft = null;
                return pilot;
            }
        }
        return null;
    }
    
    public getActiveAircraft(): Aircraft | null {
        return this.activeAircraft;
    }
    
    public isPlayerFlying(): boolean {
        return this.activeAircraft !== null && this.activeAircraft.isPlayerInAircraft();
    }
    
    public updateAircraftControls(controls: {
        forward: boolean;
        backward: boolean;
        left: boolean;
        right: boolean;
        up: boolean;
        down: boolean;
        land: boolean;
    }): void {
        if (this.activeAircraft) {
            this.activeAircraft.updateControls(controls);
        }
    }
    
    public getAllAircraft(): Aircraft[] {
        return [...this.aircraft];
    }
    
    public removeAircraft(aircraft: Aircraft): boolean {
        const index = this.aircraft.indexOf(aircraft);
        if (index !== -1) {
            if (this.activeAircraft === aircraft) {
                this.exitCurrentAircraft();
            }
            
            this.aircraft.splice(index, 1);
            aircraft.dispose();
            return true;
        }
        return false;
    }
    
    public dispose(): void {
        if (this.activeAircraft) {
            this.exitCurrentAircraft();
        }
        
        this.aircraft.forEach(aircraft => {
            aircraft.dispose();
        });
        
        this.aircraft = [];
        this.activeAircraft = null;
    }
    
    public getAircraftCount(): number {
        return this.aircraft.length;
    }
}
