/**
 * WorldSpaceHealthBar - A health bar that floats above any world object
 * 
 * Generic health bar component that can be attached to NPCs, animals, players,
 * or static world objects like destructible towers.
 * 
 * Polls health every frame and automatically detects changes. Use `onHealthChanged`
 * to react to damage/healing without manual tracking.
 * 
 */

import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import { GameEngine } from 'engine/GameEngine.js';

/**
 * Configuration for WorldSpaceHealthBar
 */
export interface WorldSpaceHealthBarConfig {
    /** The 3D object to follow */
    target: THREE.Object3D;
    
    /** Callback to get current health value */
    getHealth: () => number;
    
    /** Callback to get maximum health value */
    getMaxHealth: () => number;
    
    /** Offset from target position (default: (0, 2.0, 0)) */
    offset?: THREE.Vector3;
    
    /** Bar width in pixels (default: 60) */
    width?: number;
    
    /** Bar height in pixels (default: 8) */
    height?: number;
    
    /** Background color (default: 'rgba(0, 0, 0, 0.7)') */
    backgroundColor?: string;
    
    /** Border color (default: 'rgba(255, 255, 255, 0.3)') */
    borderColor?: string;
    
    /** Color when health > warningThreshold (default: '#00ff00') */
    healthyColor?: string;
    
    /** Color when health between warningThreshold and criticalThreshold (default: '#ffff00') */
    warningColor?: string;
    
    /** Color when health < criticalThreshold (default: '#ff0000') */
    criticalColor?: string;
    
    /** Threshold for warning color (default: 0.6 = 60%) */
    warningThreshold?: number;
    
    /** Threshold for critical color (default: 0.3 = 30%) */
    criticalThreshold?: number;
    
    /** Hide when health is full (default: false) */
    hideWhenFull?: boolean;
    
    /** Always show health bar, skip line-of-sight check (default: false) */
    alwaysVisible?: boolean;
    
    /** Called automatically when health changes (detected via polling) */
    onHealthChanged?: (currentHealth: number, maxHealth: number, previousHealth: number) => void;
}

/**
 * Default configuration values. Empty-string color defaults are a sentinel
 * meaning "use the HUD theme" — the bar's CSS (.hud-world-health-bar plus
 * data-tier modifiers) picks the surface/border/fill from --hud-color-*
 * tokens. Genres that need a specific palette (e.g. red enemies regardless of
 * theme) still pass concrete strings via setStyle(...) or the constructor
 * config; those win by inline-style specificity.
 */
const DEFAULT_CONFIG = {
    offset: new THREE.Vector3(0, 2.0, 0),
    width: 60,
    height: 8,
    backgroundColor: '',  // empty = theme via CSS
    borderColor: '',      // empty = theme via CSS
    healthyColor: '',     // empty = theme primary via [data-tier="healthy"]
    warningColor: '',     // empty = theme warning via [data-tier="warning"]
    criticalColor: '',    // empty = theme danger via [data-tier="critical"]
    warningThreshold: 0.6,
    criticalThreshold: 0.3,
    hideWhenFull: false,
    alwaysVisible: false
};


export class WorldSpaceHealthBar {
    private engine: EngineLike;
    private config: Required<Omit<WorldSpaceHealthBarConfig, 'onHealthChanged'>> & Pick<WorldSpaceHealthBarConfig, 'onHealthChanged'>;
    
    private containerElement: HTMLDivElement | null = null;
    private fillElement: HTMLDivElement | null = null;
    
    private isDisposed: boolean = false;
    private isVisible: boolean = true;
    private previousHealth: number;
    private animationFrameId: number | null = null;
    
    // Line of sight tracking - each instance checks on a random frame (0-59)
    private losCheckFrame: number;
    private hasLineOfSight: boolean = true;
    
    constructor(engine: EngineLike, config: WorldSpaceHealthBarConfig) {
        this.engine = engine;
        
        // Random frame 0-59 for staggered LOS checks
        this.losCheckFrame = Math.floor(Math.random() * 60);
        
        // Merge with defaults
        this.config = {
            ...DEFAULT_CONFIG,
            offset: config.offset?.clone() ?? DEFAULT_CONFIG.offset.clone(),
            ...config
        };
        
        // Store initial health for change detection
        this.previousHealth = this.config.getHealth();
        
        this.createElements();
        this.startUpdateLoop();
    }
    
    /**
     * Create the HTML elements for the health bar.
     * Sizing + position stay inline (per-instance config). Theme tokens drive
     * surface/border/fill via .hud-world-health-bar in hud-base.css; genre
     * overrides (non-empty backgroundColor/borderColor/healthyColor in config)
     * apply as inline styles on top.
     */
    private createElements(): void {
        const { width, height, backgroundColor, borderColor } = this.config;

        // Container
        this.containerElement = document.createElement('div');
        this.containerElement.className = 'hud-world-health-bar';
        this.containerElement.style.width = `${width}px`;
        this.containerElement.style.height = `${height}px`;
        this.containerElement.style.borderRadius = `${Math.floor(height / 2)}px`;
        if (backgroundColor) this.containerElement.style.background = backgroundColor;
        if (borderColor) this.containerElement.style.borderColor = borderColor;

        // Fill bar — data-tier is set per-frame in update(), driving the
        // CSS .hud-world-health-bar[data-tier="healthy|warning|critical"] rules.
        this.fillElement = document.createElement('div');
        this.fillElement.className = 'hud-world-health-bar__fill';
        this.fillElement.style.borderRadius = `${Math.floor(height / 2) - 1}px`;

        this.containerElement.appendChild(this.fillElement);
        document.body.appendChild(this.containerElement);
    }
    
    /**
     * Compute the health tier (drives CSS [data-tier="..."] coloring) and the
     * optional explicit color override from config. Empty `override` means
     * "let CSS pick the themed color"; a non-empty string is a genre opt-out.
     */
    private getHealthVisual(percentage: number): { tier: 'healthy' | 'warning' | 'critical'; override: string } {
        const { healthyColor, warningColor, criticalColor, warningThreshold, criticalThreshold } = this.config;
        if (percentage > warningThreshold) return { tier: 'healthy', override: healthyColor };
        if (percentage > criticalThreshold) return { tier: 'warning', override: warningColor };
        return { tier: 'critical', override: criticalColor };
    }
    
    /**
     * Check line of sight from camera to target object (staggered, once per second)
     */
    private updateLineOfSight(): void {
        if (this.config.alwaysVisible) {
            this.hasLineOfSight = true;
            return;
        }
        
        // Stagger LOS checks: only check when frame % 60 equals our random frame
        if (GameEngine.getFrameCount() % 60 !== this.losCheckFrame) {
            return; // Not our turn to check
        }
        
        // Raycast from camera to target OBJECT (not health bar position)
        const physicsWorld = this.engine.physicsWorld;
        if (!physicsWorld || !this.engine.camera) {
            this.hasLineOfSight = true; // Assume visible if no physics
            return;
        }
        
        // Get target object position at ~head level (3/4 of the way up using offset as height reference)
        const targetPos = new THREE.Vector3();
        this.config.target.getWorldPosition(targetPos);
        targetPos.y += this.config.offset.y * 0.75;
        
        const cameraPos = this.engine.camera.position;
        const direction = new THREE.Vector3().subVectors(targetPos, cameraPos).normalize();
        const distance = cameraPos.distanceTo(targetPos);
        
        // Cast ray against environment only - if we hit terrain/walls, LOS is blocked
        const rayResult = physicsWorld.raycast(cameraPos, direction, distance - 0.5, CollisionGroup.ENVIRONMENT);
        
        this.hasLineOfSight = !rayResult?.hasHit;
    }
    
    /**
     * Update health bar position and value
     */
    update(): void {
        if (this.isDisposed || !this.containerElement || !this.fillElement) {
            return;
        }
        
        if (!this.engine.camera || !this.engine.renderer) {
            return;
        }
        
        const { target, getHealth, getMaxHealth, offset, hideWhenFull, onHealthChanged } = this.config;
        
        // Get current health values
        const currentHealth = getHealth();
        const maxHealth = getMaxHealth();
        const percentage = maxHealth > 0 ? Math.max(0, Math.min(1, currentHealth / maxHealth)) : 0;
        
        // Detect health changes
        if (currentHealth !== this.previousHealth) {
            if (onHealthChanged) {
                onHealthChanged(currentHealth, maxHealth, this.previousHealth);
            }
            this.previousHealth = currentHealth;
        }
        
        // Update visual: width is always inline (animated by CSS transition).
        // Tier drives the themed color via CSS; if the genre passed an explicit
        // healthy/warning/criticalColor, that string wins as an inline override.
        // An empty override clears any prior inline value, handing colour back to CSS.
        this.fillElement.style.width = `${percentage * 100}%`;
        const { tier, override } = this.getHealthVisual(percentage);
        this.containerElement.dataset.tier = tier;
        this.fillElement.style.background = override;
        
        // Hide if dead or (optionally) if full
        if (currentHealth <= 0 || (hideWhenFull && percentage >= 1)) {
            this.containerElement.style.display = 'none';
            return;
        }
        
        // Check line of sight (staggered update)
        this.updateLineOfSight();
        
        // Calculate world position for health bar display
        const worldPosition = new THREE.Vector3();
        target.getWorldPosition(worldPosition);
        worldPosition.add(offset);
        
        // Show if visible AND has line of sight
        const shouldShow = this.isVisible && this.hasLineOfSight;
        this.containerElement.style.display = shouldShow ? 'block' : 'none';
        if (!shouldShow) return;
        
        // Project to screen
        const screenPosition = worldPosition.clone().project(this.engine.camera);
        
        // Check if behind camera
        if (screenPosition.z > 1) {
            this.containerElement.style.display = 'none';
            return;
        }
        
        // Convert to screen pixels
        const widthHalf = this.engine.renderer.domElement.clientWidth / 2;
        const heightHalf = this.engine.renderer.domElement.clientHeight / 2;
        
        const screenX = (screenPosition.x * widthHalf) + widthHalf;
        const screenY = -(screenPosition.y * heightHalf) + heightHalf;
        
        // Check if on screen
        if (screenX < -50 || screenX > this.engine.renderer.domElement.clientWidth + 50 ||
            screenY < -50 || screenY > this.engine.renderer.domElement.clientHeight + 50) {
            this.containerElement.style.display = 'none';
            return;
        }
        
        // Apply position
        this.containerElement.style.left = `${screenX}px`;
        this.containerElement.style.top = `${screenY}px`;
    }
    
    /**
     * Start the update loop
     */
    private startUpdateLoop(): void {
        const loop = () => {
            if (!this.isDisposed) {
                this.update();
                this.animationFrameId = requestAnimationFrame(loop);
            }
        };
        this.animationFrameId = requestAnimationFrame(loop);
    }
    
    /**
     * Show or hide the health bar
     */
    setVisible(visible: boolean): void {
        this.isVisible = visible;
    }
    
    /**
     * Check if health bar is visible
     */
    getVisible(): boolean {
        return this.isVisible;
    }
    
    /**
     * Update visual configuration at runtime
     */
    setStyle(style: Partial<Pick<WorldSpaceHealthBarConfig, 
        'healthyColor' | 'warningColor' | 'criticalColor' | 
        'warningThreshold' | 'criticalThreshold' | 'hideWhenFull' | 'alwaysVisible'
    >>): void {
        Object.assign(this.config, style);
    }
    
    /**
     * Clean up resources
     */
    dispose(): void {
        this.isDisposed = true;
        
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        
        if (this.containerElement && this.containerElement.parentNode) {
            this.containerElement.parentNode.removeChild(this.containerElement);
        }
        
        this.containerElement = null;
        this.fillElement = null;
    }
}
