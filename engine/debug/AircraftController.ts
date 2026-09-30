import type { EngineLike } from 'types/game.js';
import { AircraftManager } from 'debug/AircraftManager.js';

export interface AircraftKeys {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    land: boolean;
}

export class AircraftController {
    private engine: EngineLike;
    private aircraftManager: AircraftManager;
    private keys: AircraftKeys;
    private isActive: boolean = false;
    
    private boundOnKeyDown: (event: KeyboardEvent) => void;
    private boundOnKeyUp: (event: KeyboardEvent) => void;
    
    constructor(engine: EngineLike, aircraftManager: AircraftManager) {
        this.engine = engine;
        this.aircraftManager = aircraftManager;
        this.keys = {
            forward: false,
            backward: false,
            left: false,
            right: false,
            up: false,
            down: false,
            land: false
        };
        
        this.boundOnKeyDown = this.onKeyDown.bind(this);
        this.boundOnKeyUp = this.onKeyUp.bind(this);
    }
    
    public activate(): void {
        if (this.isActive) return;
        
        this.isActive = true;
        document.addEventListener('keydown', this.boundOnKeyDown);
        document.addEventListener('keyup', this.boundOnKeyUp);
        this.resetKeys();
        
        console.log('AircraftController: Controls activated');
    }
    
    public deactivate(): void {
        if (!this.isActive) return;
        
        this.isActive = false;
        document.removeEventListener('keydown', this.boundOnKeyDown);
        document.removeEventListener('keyup', this.boundOnKeyUp);
        this.resetKeys();
        
        console.log('AircraftController: Controls deactivated');
    }
    
    private shouldProcessInput(): boolean {
        if (!this.isActive) return false;
        if (this.engine && !this.engine.isWindowFocused) return false;
        if (this.engine && this.engine.editorManager && this.engine.editorManager.isEditorMode) return false;
        return true;
    }
    
    private onKeyDown(event: KeyboardEvent): void {
        if (!this.shouldProcessInput()) return;
        
        switch (event.code) {
            case 'KeyW':
            case 'ArrowUp':
                this.keys.forward = true;
                event.preventDefault();
                break;
            case 'KeyS':
            case 'ArrowDown':
                this.keys.backward = true;
                event.preventDefault();
                break;
            case 'KeyA':
            case 'ArrowLeft':
                this.keys.left = true;
                event.preventDefault();
                break;
            case 'KeyD':
            case 'ArrowRight':
                this.keys.right = true;
                event.preventDefault();
                break;
            case 'Space':
                this.keys.up = true;
                event.preventDefault();
                break;
            case 'KeyC':
                this.keys.down = true;
                event.preventDefault();
                break;
            case 'KeyE':
                this.keys.land = true;
                event.preventDefault();
                break;
        }
    }
    
    private onKeyUp(event: KeyboardEvent): void {
        if (!this.shouldProcessInput()) return;
        
        switch (event.code) {
            case 'KeyW':
            case 'ArrowUp':
                this.keys.forward = false;
                event.preventDefault();
                break;
            case 'KeyS':
            case 'ArrowDown':
                this.keys.backward = false;
                event.preventDefault();
                break;
            case 'KeyA':
            case 'ArrowLeft':
                this.keys.left = false;
                event.preventDefault();
                break;
            case 'KeyD':
            case 'ArrowRight':
                this.keys.right = false;
                event.preventDefault();
                break;
            case 'Space':
                this.keys.up = false;
                event.preventDefault();
                break;
            case 'KeyC':
                this.keys.down = false;
                event.preventDefault();
                break;
            case 'KeyE':
                this.keys.land = false;
                event.preventDefault();
                break;
        }
    }
    
    private resetKeys(): void {
        this.keys.forward = false;
        this.keys.backward = false;
        this.keys.left = false;
        this.keys.right = false;
        this.keys.up = false;
        this.keys.down = false;
        this.keys.land = false;
    }
    
    public update(): void {
        if (!this.isActive) return;
        
        this.aircraftManager.updateAircraftControls({
            forward: this.keys.forward,
            backward: this.keys.backward,
            left: this.keys.left,
            right: this.keys.right,
            up: this.keys.up,
            down: this.keys.down,
            land: this.keys.land
        });
    }
    
    public shouldLandAircraft(): boolean {
        return this.keys.land;
    }
    
    public getKeys(): Readonly<AircraftKeys> {
        return { ...this.keys };
    }
    
    public isControllerActive(): boolean {
        return this.isActive;
    }
    
    public dispose(): void {
        this.deactivate();
    }
}
