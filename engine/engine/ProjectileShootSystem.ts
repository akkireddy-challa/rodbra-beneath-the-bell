import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { CameraController, PlayerController } from 'engine/PlayerController.js';
import type { IPlayerAttack } from 'engine/IPlayerAttack.js';
import { Projectile, ProjectileType } from 'engine/Projectile.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * Handles projectile shooting system including:
 * - Projectile firing with cooldown
 * - Projectile lifecycle management
 * - Input handling (mouse and mobile)
 * - Collision tracking
 */
export class ProjectileShootSystem implements IPlayerAttack {
	private projectiles: Projectile[] = [];
	private projectileSpeed: number = 20;
	private projectileLifetime: number = 3; // seconds
	private lastShotTime: number = 0;
	private shootCooldown: number = 0.2; // seconds between shots
	private attackPressed: boolean = false;
	private mouseDownTime: number = 0;
	private readonly TAP_MAX_DURATION = 200; // milliseconds - maximum duration for a tap
	private boundOnMouseDown: ((event: MouseEvent) => void) | null = null;
	private boundOnMouseUp: ((event: MouseEvent) => void) | null = null;
	private boundOnMouseMove: ((event: MouseEvent) => void) | null = null;
	private mobileControls: any = null;
	private physicsWorld: PhysicsWorld;
	private engine: EngineLike | null;
	private controller: PlayerController | null = null;
	private lastMousePosition: THREE.Vector2 = new THREE.Vector2();
	private raycaster: THREE.Raycaster = new THREE.Raycaster();
	private currentProjectileType: ProjectileType = ProjectileType.WAVE_REVEAL;
	private currentEditorTab: string | null = null; // Current editor tab ('prompt', 'splats', 'scene', etc.)

	constructor(engine: EngineLike | null, physicsWorld: PhysicsWorld) {
		this.engine = engine;
		this.physicsWorld = physicsWorld;
	}

	setEditorTab(tab: string | null): void {
		this.currentEditorTab = tab;
	}

	/**
	 * Check if shooting is allowed (only allowed when in 'prompt' tab or no editor tab)
	 */
	private isShootingAllowed(): boolean {
		// Allow shooting if no editor tab is set (standalone mode) or if in 'prompt' tab
		return this.currentEditorTab === null || this.currentEditorTab === 'prompt';
	}

	/**
	 * Set the controller reference.
	 * Called by PlayerController.setAttackSystem() when this system is attached.
	 */
	setController(controller: PlayerController): void {
		this.controller = controller;
	}

	/**
	 * Setup event listeners for mouse input
	 */
	setupEventListeners(): void {
		// Bind mouse event handlers
		this.boundOnMouseDown = this.onMouseDown.bind(this);
		this.boundOnMouseUp = this.onMouseUp.bind(this);
		this.boundOnMouseMove = this.onMouseMove.bind(this);

		// Add mouse event listeners for left mouse button attack
		document.addEventListener('mousedown', this.boundOnMouseDown);
		document.addEventListener('mouseup', this.boundOnMouseUp);
		document.addEventListener('mousemove', this.boundOnMouseMove);
	}

	/**
	 * Remove event listeners
	 */
	removeEventListeners(): void {
		if (this.boundOnMouseDown && this.boundOnMouseUp) {
			document.removeEventListener('mousedown', this.boundOnMouseDown);
			document.removeEventListener('mouseup', this.boundOnMouseUp);
		}
		if (this.boundOnMouseMove) {
			document.removeEventListener('mousemove', this.boundOnMouseMove);
		}
	}

	/**
	 * Set mobile controls instance
	 */
	setMobileControls(mobileControls: any): void {
		this.mobileControls = mobileControls;
	}

	/**
	 * Track mouse position continuously for aiming
	 */
	private onMouseMove(event: MouseEvent): void {
		this.lastMousePosition.x = (event.clientX / window.innerWidth) * 2 - 1;
		this.lastMousePosition.y = -(event.clientY / window.innerHeight) * 2 + 1;
	}

	/**
	 * Handle mouse down for attack input
	 */
	private onMouseDown(event: MouseEvent): void {
		// Only handle left mouse button
		if (event.button === 0) {
			this.mouseDownTime = Date.now();
		}
	}

	/**
	 * Handle mouse up for attack input
	 */
	private onMouseUp(event: MouseEvent): void {
		// Only handle left mouse button
		if (event.button === 0) {
			// Check if shooting is allowed (only in prompt tab)
			if (!this.isShootingAllowed()) {
				this.mouseDownTime = 0;
				return;
			}

			const duration = Date.now() - this.mouseDownTime;

			// If it was a quick tap/click (not a drag), trigger attack
			if (duration <= this.TAP_MAX_DURATION) {
				this.attackPressed = true;
			}

			this.mouseDownTime = 0;
		}
	}

	/**
	 * Update projectile system (called every frame)
	 * @param deltaTime - Time since last frame in seconds
	 * @returns false (projectile attacks don't block movement)
	 */
	update(deltaTime: number): boolean {
		if (!this.controller) return false;

		// Update all projectiles
		this.projectiles.forEach(projectile => projectile.update(deltaTime));

		// Remove expired projectiles
		this.projectiles = this.projectiles.filter(projectile => {
			if (projectile.isExpired()) {
				projectile.dispose();
				return false;
			}
			return true;
		});

		// Get references from controller
		const player = this.controller.player;
		const cameraController = this.controller.getCameraController();

		// Handle shooting input from mouse
		if (this.attackPressed) {
			this.tryShootProjectile(player, cameraController);
			this.attackPressed = false; // Consume the attack input
		}

		// Handle shooting input from mobile action button
		if (this.mobileControls && this.mobileControls.actionPressed) {
			this.tryShootProjectile(player, cameraController);
			this.mobileControls.resetActionPressed(); // Consume the attack input
		}

		// Projectile attacks don't block movement
		return false;
	}

	/**
	 * Try to shoot a projectile if cooldown allows
	 */
	private tryShootProjectile(player: THREE.Object3D, cameraController: CameraController | null): void {
		// Check if shooting is allowed (only in prompt tab)
		if (!this.isShootingAllowed()) {
			return;
		}

		const currentTime = Date.now() / 1000;
		if (currentTime - this.lastShotTime < this.shootCooldown) {
			return; // Still in cooldown
		}

		if (!player || !cameraController || !this.physicsWorld || !this.engine) {
			return;
		}

		// Calculate projectile spawn position and direction based on mouse aim
		const playerPosition = player.position.clone();
		const chestHeight = 1.1;
		const spawnPosition = playerPosition.clone();
		spawnPosition.y += chestHeight;
		
		// Get camera
		const camera = (cameraController as any).camera;
		if (!camera) return;
		
		// Raycast from camera through mouse position to find aim direction
		this.raycaster.setFromCamera(this.lastMousePosition, camera);
		
		// Calculate direction from spawn position to raycast far point
		const rayDirection = this.raycaster.ray.direction.clone();
		const aimDirection = rayDirection.normalize();
		
		// Offset spawn position slightly forward in aim direction
		spawnPosition.add(aimDirection.clone().multiplyScalar(0.5));

		// Create projectile aimed at mouse position
		const visualConfig = this.currentProjectileType === ProjectileType.DESTRUCTION ? {
			geometry: new THREE.SphereGeometry(0.15, 16, 16),
			material: new THREE.MeshStandardMaterial({
				color: 0xff0000,
				emissive: 0xff0000,
				emissiveIntensity: 3.0,
				roughness: 0.2,
				metalness: 0.0,
				toneMapped: false
			})
		} : undefined;

		const projectile = new Projectile(
			spawnPosition,
			aimDirection,
			this.projectileSpeed,
			this.physicsWorld,
			this.engine,
			undefined,
			visualConfig,
			this.currentProjectileType
		);

		this.projectiles.push(projectile);
		this.lastShotTime = currentTime;
	}

	/**
	 * Public method to shoot projectile (called from external sources like Enter key)
	 */
	public shoot(player: THREE.Object3D, cameraController: CameraController | null): void {
		this.tryShootProjectile(player, cameraController);
	}

	/**
	 * Set the projectile type for future shots
	 */
	public setProjectileType(type: ProjectileType): void {
		this.currentProjectileType = type;
	}

	/**
	 * Get the current projectile type
	 */
	public getProjectileType(): ProjectileType {
		return this.currentProjectileType;
	}

	/**
	 * Get all active projectiles (for collision detection)
	 */
	public getProjectiles(): Projectile[] {
		return this.projectiles;
	}

	/**
	 * Remove a projectile (called when it hits something)
	 */
	public removeProjectile(projectile: Projectile): void {
		const index = this.projectiles.indexOf(projectile);
		if (index > -1) {
			this.projectiles.splice(index, 1);
			projectile.dispose();
		}
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		// Remove event listeners
		this.removeEventListeners();

		// Dispose all projectiles
		this.projectiles.forEach(projectile => projectile.dispose());
		this.projectiles = [];
	}
}
