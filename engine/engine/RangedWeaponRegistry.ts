/**
 * @fileoverview Ranged Weapon Registry - Gun System
 *
 * Engine-level ranged weapon system with support for custom guns from templates.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 🏗️ ARCHITECTURE
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * **Engine Layer (this file):**
 * - Defines RangedWeaponPreset interface and base types
 * - Provides block and lowpoly weapons; append `_lowpoly` to any built-in ID
 * - Exposes RangedWeaponRegistry for custom weapon registration
 *
 * **Template Layer:**
 * - Can register custom ranged weapons via RangedWeaponRegistry.register()
 * - Custom weapons are defined entirely in template code
 * - No engine modification needed for new weapons
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 🔫 BUILT-IN WEAPONS
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * | Type               | Hands | Description                              |
 * |--------------------|-------|------------------------------------------|
 * | pistol             | 1     | Semi-automatic handgun                   |
 * | assault_rifle      | 2     | Full-auto rifle with foregrip            |
 * | bazooka            | 2     | Rocket launcher, slow thick rockets      |
 * | bow                | 2     | Bow with arrows, slower projectiles      |
 * | crossbow           | 2     | Rifle-style crossbow with bolts (faster) |
 * | laser_blaster      | 2     | Star Wars-style blaster, red laser beams |
 * | laser_pistol       | 1     | Futuristic laser pistol, red laser beams |
 * | dual_pistols       | dual  | Two pistols, one in each hand            |
 * | dual_assault_rifles| dual  | Two assault rifles, one in each hand     |
 * | dual_bazookas      | dual  | Two bazookas, one on each shoulder       |
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 📖 CUSTOM WEAPON CREATION GUIDE
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * For a comprehensive step-by-step guide with diagrams, see:
 * game/src/engine/examples/RangedWeaponGuide.ts
 *
 * SEARCH KEYWORDS for AI agents:
 * revolver, six-shooter, pistol, handgun, custom weapon, create weapon,
 * shotgun, rifle, carbine, laser gun, ray gun, blaster
 */

import * as THREE from 'three';

// Re-export all types for backward compatibility
export * from 'engine/RangedWeaponTypes.js';

import type {
	RangedWeaponPreset,
	RangedWeaponMeshResult,
	RangedWeaponMeshCreator,
	CustomRangedWeaponDefinition,
	RangedWeaponCreationResult,
	BaseRangedWeaponType,
	RangedWeaponTypeId,
} from 'engine/RangedWeaponTypes.js';

import { RangedWeaponType, isBuiltInRangedWeapon } from 'engine/RangedWeaponTypes.js';
import { splitWeaponStyleId } from 'engine/WeaponVisualStyle.js';

import {
	createRocketMesh,
	createArrowMesh,
	createCrossbowBoltMesh,
	createLaserBeamMesh,
	createPistol,
	createAssaultRifle,
	createShotgun,
	createBazooka,
	createBow,
	createCrossbow,
	createLaserBlaster,
	createLaserPistol,
	createDualWeapon,
	createDualPistols,
	createDualAssaultRifles,
	createDualBazookas,
} from 'engine/RangedWeaponMeshes.js';

// Re-export createDualWeapon for external consumers
export { createDualWeapon, createTracerMesh } from 'engine/RangedWeaponMeshes.js';

// ════════════════════════════════════════════════════════════════════════════════
// BUILT-IN WEAPON PRESETS
// ════════════════════════════════════════════════════════════════════════════════

const BUILT_IN_PRESETS: Record<BaseRangedWeaponType, RangedWeaponPreset> = {
	[RangedWeaponType.PISTOL]: {
		name: 'Combat Pistol',
		weaponScale: new THREE.Vector3(1.95, 1.95, 0.975),
		damage: 15,
		fireRate: 3,           // 3 shots per second
		projectileSpeed: 40,
		magazineSize: 12,
		hands: 1,
		muzzleOffset: new THREE.Vector3(0, 0.02, 0.15),
		gripOffset: new THREE.Vector3(0, 0, 0),
		recoilStrength: 0.1,
		// Positioning
		heightOffset: 0.04,
		forwardOffset: 0.25,   // Keep the wrist reachable at this lower hold, including upward aim
		// Projectile
		projectileRadius: 0.03,
		projectileColor: 0xffaa00,
		trailLength: 4
	},
	[RangedWeaponType.ASSAULT_RIFLE]: {
		name: 'Assault Rifle',
		weaponScale: new THREE.Vector3(2.4, 2.4, 1.2),
		damage: 10,
		fireRate: 8,           // 8 shots per second (full auto)
		projectileSpeed: 50,
		magazineSize: 30,
		hands: 2,
		muzzleOffset: new THREE.Vector3(0, 0.03, 0.55),
		gripOffset: new THREE.Vector3(0, 0, -0.1),
		foregrip: new THREE.Vector3(0, -0.02, 0.07), // Compact support hold; mesh uses this point too
		recoilStrength: 0.15,
		// Positioning
		heightOffset: 0.2,
		// Projectile
		projectileRadius: 0.03,
		projectileColor: 0xffaa00,
		trailLength: 4
	},
	[RangedWeaponType.SHOTGUN]: {
		name: 'Pump Shotgun',
		weaponScale: new THREE.Vector3(2.4, 2.4, 1.2),
		damage: 8,             // per pellet; eight pellets per shell
		fireRate: 1.2,
		projectileSpeed: 50,
		magazineSize: 6,
		reloadDuration: 2500,
		hands: 2,
		muzzleOffset: new THREE.Vector3(0, 0.025, 0.50),
		gripOffset: new THREE.Vector3(0, 0, 0),
		foregrip: new THREE.Vector3(0, 0.008, 0.15),
		recoilStrength: 0.25,  // lands in the 'heavy' recoil class
		// Positioning
		heightOffset: 0.2,
		// Volley
		pelletCount: 8,
		pelletSpreadRad: 0.08,
		viewBobScale: 0.6,
		// Projectile
		projectileRadius: 0.02,
		projectileColor: 0xff8800,
		trailLength: 2
	},
	[RangedWeaponType.BAZOOKA]: {
		name: 'Bazooka',
		damage: 100,           // High damage rockets
		fireRate: 0.5,         // 1 shot per 2 seconds (slow)
		projectileSpeed: 7,    // Very slow rockets (50% slower)
		// Rockets ARC. Without this they inherit the projectile default of
		// gravityScale 0 and fly dead flat at muzzle height (~2m) for the full
		// 10s lifetime — so a shot that misses a target never meets the ground,
		// never contacts anything, and never explodes. Top-down aiming makes
		// this worse: `calculateTargetPoint` deliberately flattens the shot to
		// muzzle height, so a rocket sails just over the heads it was aimed at.
		// 0.05 (a ≈ 0.49 m/s²) drops the ~2m muzzle height over roughly 20m of
		// travel at 7 m/s — a lazy, readable arc that still reaches across a
		// fight, and guarantees ground contact on a miss.
		gravityScale: 0.05,
		magazineSize: 1,
		hands: 2,
		muzzleOffset: new THREE.Vector3(0, 0, 0.8),
		gripOffset: new THREE.Vector3(0, -0.05, -0.2),
		foregrip: new THREE.Vector3(0, -0.05, 0.15),
		recoilStrength: 0.3,
		// Positioning - lower the large tube without changing the rifle hold
		heightOffset: 0.25,
		xOffset: -0.1,       // Additional right offset (negative X = right in player space)
		forwardOffset: 0.4,  // Keep the lower support grip reachable while aiming upward
		weaponScale: new THREE.Vector3(2.25, 2.25, 1.125), // 75% of default
		// Projectile - rocket with fins and fire blaze
		projectileRadius: 0.08,
		projectileColor: 0x556b2f, // Olive drab rocket body
		createProjectileMesh: createRocketMesh, // Custom rocket mesh factory
		trailLength: 10,
		// Explosion on impact
		explosion: {
			enabled: true,
			radius: 4.0,           // Visual explosion radius (meters)
			duration: 1.0,         // Duration
			color: 0xff4400,       // Orange-red
			damage: 100,           // AOE base damage at center
			damageRadius: 6.0      // Damage falloff radius (meters) — linear falloff to edge
		}
	},
	[RangedWeaponType.BOW]: {
		name: 'Bow',
		damage: 25,            // Moderate arrow damage
		fireRate: 1.5,         // 1.5 shots per second (draw time)
		projectileSpeed: 12,   // Slower than bullets, but faster than rockets
		magazineSize: 1,       // One arrow at a time
		hands: 2,              // Two-handed weapon
		muzzleOffset: new THREE.Vector3(0, 0.01, 0.5),  // Arrow spawns at arrowhead position
		gripOffset: new THREE.Vector3(0, 0.01, 0.07),   // Right hand at bowstring (arrow nock)
		foregrip: new THREE.Vector3(0, 0, 0.2),         // Left hand on bow grip
		recoilStrength: 0.05,  // Minimal recoil
		// Positioning - held closer to player
		heightOffset: 0.15,
		xOffset: -0.15,        // Offset right to align with right arm
		forwardOffset: 0.35,   // Closer to player than guns
		weaponScale: new THREE.Vector3(2.5, 2.5, 2.5),
		// Projectile - thin arrow
		projectileRadius: 0.04,
		projectileColor: 0x666666, // Gray metal arrowhead
		createProjectileMesh: createArrowMesh,
		trailLength: 2         // Short trail
	},
	[RangedWeaponType.CROSSBOW]: {
		name: 'Crossbow',
		damage: 35,            // Higher damage than bow (mechanical advantage)
		fireRate: 0.8,         // Slower than bow (reload time)
		projectileSpeed: 18,   // Faster than bow (higher tension)
		magazineSize: 1,       // One bolt at a time
		hands: 2,              // Two-handed weapon (held like rifle)
		muzzleOffset: new THREE.Vector3(0, 0.03, 0.6),   // Bolt spawns at front of rail
		gripOffset: new THREE.Vector3(0, -0.02, -0.15),  // Right hand on stock grip
		foregrip: new THREE.Vector3(0, -0.02, 0.15),     // Left hand on foregrip
		recoilStrength: 0.12,  // Moderate recoil
		// Positioning - held like a rifle
		heightOffset: 0.22,
		xOffset: -0.12,        // Slight right offset
		forwardOffset: 0.4,
		weaponScale: new THREE.Vector3(2.2, 2.2, 2.2),
		// Projectile - shorter, thicker bolt
		projectileRadius: 0.05,
		projectileColor: 0x555555, // Dark gray metal head
		createProjectileMesh: createCrossbowBoltMesh,
		trailLength: 3         // Medium trail
	},
	[RangedWeaponType.LASER_BLASTER]: {
		name: 'Laser Blaster',
		damage: 12,            // Moderate damage per shot
		fireRate: 5,           // Moderate firing rate
		projectileSpeed: 22,   // Slower, more visible laser bolts
		magazineSize: 50,      // Large energy cell
		hands: 2,              // Two-handed weapon
		muzzleOffset: new THREE.Vector3(0, 0.03, 0.5),   // Beam spawns at barrel tip
		gripOffset: new THREE.Vector3(0, -0.02, -0.12),  // Right hand on grip
		foregrip: new THREE.Vector3(0, -0.02, 0.09),     // Compact support hold, ahead of the magazine
		recoilStrength: 0.08,  // Low recoil (energy weapon)
		// Positioning - held like assault rifle
		heightOffset: 0.22,
		xOffset: -0.1,
		forwardOffset: 0.35,
		weaponScale: new THREE.Vector3(1.6, 1.6, 1.2),
		// Projectile - plain solid red beam
		projectileRadius: 0.06,  // Thick beam
		projectileColor: 0xdd1133, // Lipstick red
		createProjectileMesh: createLaserBeamMesh,
		trailLength: 0         // No trail - plain cylinder
	},
	[RangedWeaponType.LASER_PISTOL]: {
		name: 'Laser Pistol',
		damage: 10,            // Slightly less than blaster
		fireRate: 4,           // Moderate firing rate
		projectileSpeed: 25,   // Slightly faster than blaster
		magazineSize: 30,      // Smaller energy cell
		hands: 1,              // One-handed weapon
		muzzleOffset: new THREE.Vector3(0, 0.02, 0.18),  // Beam spawns at barrel tip
		gripOffset: new THREE.Vector3(0, 0, 0),          // Right hand on grip
		recoilStrength: 0.1,   // Low recoil
		// Positioning - held like pistol
		heightOffset: 0.05,
		xOffset: -0.08,
		forwardOffset: 0.25,
		weaponScale: new THREE.Vector3(1.17, 1.17, 1.17),
		// Projectile - plain solid red beam (same as blaster)
		projectileRadius: 0.05,  // Slightly thinner than blaster
		projectileColor: 0xdd1133, // Lipstick red
		createProjectileMesh: createLaserBeamMesh,
		trailLength: 0         // No trail - plain cylinder
	},
	// ═══════════════════════════════════════════════════════════════
	// DUAL WEAPONS - Same weapon mirrored on both sides
	// ═══════════════════════════════════════════════════════════════
	[RangedWeaponType.DUAL_PISTOLS]: {
		name: 'Dual Pistols',
		damage: 12,            // Slightly less per gun than single pistol
		fireRate: 5,           // Higher combined rate (alternating fire)
		projectileSpeed: 40,
		magazineSize: 24,      // Combined mag size
		hands: 2,              // Uses both hands (one per weapon)
		dual: true,            // Flag for dual weapon handling
		dualSpacing: 0.308 / 1.82, // Preserve the fitted hand spacing as each gun shrinks
		muzzleOffset: new THREE.Vector3(0, 0.02, 0.15),
		gripOffset: new THREE.Vector3(0, 0.01, -0.04),  // At pistol grip (center-back of gun)
		recoilStrength: 0.08,
		// Positioning - forward, in front of player
		heightOffset: 0,
		xOffset: 0,            // Centered, spacing handled by dualSpacing
		forwardOffset: 0.45,   // Start within arm reach at the lower hold, including upward aim
		weaponScale: new THREE.Vector3(1.82, 1.82, 0.91),
		// Projectile
		projectileRadius: 0.03,
		projectileColor: 0xffaa00,
		trailLength: 4
	},
	[RangedWeaponType.DUAL_ASSAULT_RIFLES]: {
		name: 'Dual Assault Rifles',
		damage: 8,             // Slightly less per gun
		fireRate: 12,          // Very high combined rate
		projectileSpeed: 50,
		magazineSize: 60,      // Combined mag size
		hands: 2,
		dual: true,
		dualSpacing: 0.15,     // Same world spacing with the smaller rifles
		muzzleOffset: new THREE.Vector3(0, 0.03, 0.55),
		gripOffset: new THREE.Vector3(0, 0.0, -0.15),  // At pistol grip (mid-back of rifle)
		recoilStrength: 0.12,
		// Positioning - forward, in front of player
		heightOffset: 0.03,
		xOffset: 0,
		forwardOffset: 0.45,   // Avoid a long backward/downward reach correction when aiming up
		weaponScale: new THREE.Vector3(2.0, 2.0, 1.0),
		// Projectile
		projectileRadius: 0.03,
		projectileColor: 0xffaa00,
		trailLength: 4
	},
	[RangedWeaponType.DUAL_BAZOOKAS]: {
		name: 'Dual Bazookas',
		damage: 80,            // Slightly less per rocket
		fireRate: 0.8,         // Faster combined (alternating)
		projectileSpeed: 7,
		gravityScale: 0.05,    // Rockets arc — see the bazooka preset for why
		magazineSize: 2,
		hands: 2,
		dual: true,
		dualSpacing: 0.16,     // Spacing from center (local space, auto-scaled)
		muzzleOffset: new THREE.Vector3(0, 0, 0.8),
		gripOffset: new THREE.Vector3(0, -0.02, -0.2),  // At grip handle (underside of tube)
		recoilStrength: 0.25,
		// Positioning - forward, in front of player
		heightOffset: 0.13,
		xOffset: 0,
		forwardOffset: 0.45,   // Keep both trigger grips reachable at the lower hold
		weaponScale: new THREE.Vector3(2.0, 2.0, 1.0),
		// Projectile - rockets
		projectileRadius: 0.08,
		projectileColor: 0x556b2f,
		createProjectileMesh: createRocketMesh,
		trailLength: 10,
		// Explosion
		explosion: {
			enabled: true,
			radius: 4.0,           // Visual explosion radius (meters)
			duration: 1.0,
			color: 0xff4400,
			damage: 80,            // AOE base damage at center
			damageRadius: 6.0      // Damage falloff radius (meters) — linear falloff to edge
		}
	}
};

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON REGISTRY - Singleton for custom weapon registration
// ════════════════════════════════════════════════════════════════════════════════

class RangedWeaponRegistryClass {
	private customWeapons: Map<string, CustomRangedWeaponDefinition> = new Map();

	/**
	 * Register a custom ranged weapon type
	 *
	 * ⚠️ For DUAL weapons, use registerDual() instead - it's simpler!
	 */
	register(typeId: string, definition: CustomRangedWeaponDefinition): void {
		const normalizedId = typeId.toLowerCase().trim();

		if (isBuiltInRangedWeapon(normalizedId)) {
			console.warn(`RangedWeaponRegistry: Overriding built-in weapon type "${normalizedId}"`);
		}

		// Validate dual weapon setup
		if (definition.preset.dual) {
			// Test the mesh creator to see if it uses createDualWeapon properly
			const testGroup = new THREE.Group();
			definition.createMesh(testGroup, definition.preset);

			if (!testGroup.userData.isDual) {
				console.error(
					`⚠️ RangedWeaponRegistry: "${normalizedId}" has dual: true but createMesh doesn't use createDualWeapon()!\n` +
					`   This will cause the weapon to only show ONE gun instead of two.\n` +
					`   \n` +
					`   EASY FIX - Use registerDual() instead:\n` +
					`   \n` +
					`   RangedWeaponRegistry.registerDual('${normalizedId}', {\n` +
					`       preset: { ...your_preset, dual: true, dualSpacing: 0.12 },\n` +
					`       createSingleMesh: (group, preset) => {\n` +
					`           // Build ONE weapon mesh...\n` +
					`           return { foregrip: null };\n` +
					`       }\n` +
					`   });`
				);
			}
		}

		this.customWeapons.set(normalizedId, definition);
		console.log(`🔫 RangedWeaponRegistry: Registered custom weapon "${normalizedId}"${definition.preset.dual ? ' (dual)' : ''}`);
	}

	/**
	 * ════════════════════════════════════════════════════════════════════════════════
	 * EASY DUAL WEAPON REGISTRATION
	 * ════════════════════════════════════════════════════════════════════════════════
	 *
	 * Register a DUAL weapon by providing just the SINGLE weapon mesh creator.
	 * This automatically wraps it with createDualWeapon().
	 */
	registerDual(
		typeId: string,
		definition: {
			preset: RangedWeaponPreset;
			createSingleMesh: RangedWeaponMeshCreator;
			weaponName?: string;
		}
	): void {
		const { preset, createSingleMesh, weaponName = 'Weapon' } = definition;

		// Ensure dual is set
		if (!preset.dual) {
			console.warn(`RangedWeaponRegistry.registerDual: "${typeId}" preset.dual was not set, setting to true`);
			preset.dual = true;
		}

		// Ensure dualSpacing has a reasonable default
		if (preset.dualSpacing === undefined) {
			// Calculate a reasonable default based on weapon scale
			const scaleX = preset.weaponScale?.x ?? 2.5;
			preset.dualSpacing = 0.30 / scaleX; // ~0.30 world units
			console.log(`RangedWeaponRegistry.registerDual: "${typeId}" using default dualSpacing ${preset.dualSpacing.toFixed(3)}`);
		}

		// Ensure xOffset is 0 for dual weapons
		if (preset.xOffset !== 0) {
			console.warn(`RangedWeaponRegistry.registerDual: "${typeId}" xOffset should be 0 for dual weapons, overriding`);
			preset.xOffset = 0;
		}

		// Register with automatic dual wrapper
		this.register(typeId, {
			preset,
			createMesh: (group: THREE.Group, p: RangedWeaponPreset) => {
				return createDualWeapon(group, p, createSingleMesh, weaponName);
			}
		});
	}

	has(typeId: string): boolean {
		const normalizedId = typeId.toLowerCase().trim();
		return this.customWeapons.has(normalizedId) ||
			   isBuiltInRangedWeapon(normalizedId);
	}

	getCustom(typeId: string): CustomRangedWeaponDefinition | null {
		return this.customWeapons.get(typeId.toLowerCase().trim()) || null;
	}

	listCustom(): string[] {
		return Array.from(this.customWeapons.keys());
	}

	clearCustom(): void {
		this.customWeapons.clear();
	}
}

export const RangedWeaponRegistry = new RangedWeaponRegistryClass();

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON TYPE PARSING
// ════════════════════════════════════════════════════════════════════════════════

export function parseRangedWeaponType(weaponTypeStr: string | undefined | null): RangedWeaponTypeId {
	if (!weaponTypeStr) return RangedWeaponType.PISTOL;

	const normalized = weaponTypeStr.toLowerCase().trim();

	// has() covers both custom registrations and the built-in RangedWeaponType values
	if (RangedWeaponRegistry.has(normalized)) {
		return normalized;
	}

	console.warn(`Unknown ranged weapon type "${weaponTypeStr}", defaulting to pistol`);
	return RangedWeaponType.PISTOL;
}

// ════════════════════════════════════════════════════════════════════════════════
// BUILT-IN WEAPON MESH CREATORS
// ════════════════════════════════════════════════════════════════════════════════

const BUILT_IN_CREATORS: Record<BaseRangedWeaponType, RangedWeaponMeshCreator> = {
	[RangedWeaponType.PISTOL]: createPistol,
	[RangedWeaponType.ASSAULT_RIFLE]: createAssaultRifle,
	[RangedWeaponType.SHOTGUN]: createShotgun,
	[RangedWeaponType.BAZOOKA]: createBazooka,
	[RangedWeaponType.BOW]: createBow,
	[RangedWeaponType.CROSSBOW]: createCrossbow,
	[RangedWeaponType.LASER_BLASTER]: createLaserBlaster,
	[RangedWeaponType.LASER_PISTOL]: createLaserPistol,
	// Dual weapons - these use the base weapon creators but are handled specially
	[RangedWeaponType.DUAL_PISTOLS]: createDualPistols,
	[RangedWeaponType.DUAL_ASSAULT_RIFLES]: createDualAssaultRifles,
	[RangedWeaponType.DUAL_BAZOOKAS]: createDualBazookas
};

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON CREATION
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Create a ranged weapon mesh and config for the specified weapon type.
 */
export function createRangedWeaponMesh(weaponType: RangedWeaponTypeId): RangedWeaponCreationResult {
	const normalizedType = weaponType.toLowerCase().trim();

	// Check for custom weapon first
	const customDef = RangedWeaponRegistry.getCustom(normalizedType);
	if (customDef) {
		return createFromDefinition(customDef);
	}

	// Fall back to built-in weapon
	const { baseId, style } = splitWeaponStyleId(normalizedType);
	const builtInType = baseId as BaseRangedWeaponType;
	const preset = BUILT_IN_PRESETS[builtInType] || BUILT_IN_PRESETS[RangedWeaponType.PISTOL];
	const createFn = BUILT_IN_CREATORS[builtInType] || BUILT_IN_CREATORS[RangedWeaponType.PISTOL];

	return createFromDefinition({ preset, createMesh: (group, p) => {
		group.userData.weaponVisualStyle = style;
		return createFn(group, p);
	} });
}

function createFromDefinition(definition: CustomRangedWeaponDefinition): RangedWeaponCreationResult {
	const { preset, createMesh } = definition;
	const group = new THREE.Group();

	const meshResult = createMesh(group, preset);

	// Apply grip offset to position gun in hand (for non-dual weapons)
	// For dual weapons, positioning is handled differently
	if (!preset.dual) {
		group.position.copy(preset.gripOffset);
	}

	// Build result with dual weapon info if applicable
	const result: RangedWeaponCreationResult = {
		mesh: group,
		preset,
		grip: meshResult.grip,
		foregrip: meshResult.foregrip
	};

	// Add dual weapon specific data if present
	if (group.userData.isDual) {
		result.isDual = true;
		result.rightWeaponMesh = group.userData.rightWeaponMesh as THREE.Group;
		result.leftWeaponMesh = group.userData.leftWeaponMesh as THREE.Group;
		result.rightGrip = group.userData.rightGrip as THREE.Vector3;
		result.leftGrip = group.userData.leftGrip as THREE.Vector3;
	}

	return result;
}

/**
 * Make ranged weapon mesh visual-only (no physics collisions)
 */
export function makeRangedWeaponVisualOnly(weaponGroup: THREE.Object3D): void {
	weaponGroup.traverse((child) => {
		if ((child as THREE.Mesh).isMesh) {
			const mesh = child as THREE.Mesh;
			mesh.layers.disableAll();
			mesh.layers.enable(2); // Visual-only layer
			if (!mesh.userData) mesh.userData = {};
			mesh.userData.isVisualOnly = true;
			mesh.userData.noPhysics = true;
			delete mesh.userData.physicsBody;
			delete mesh.userData.mass;
		}
	});
}
