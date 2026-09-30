import { splitWeaponStyleId } from 'engine/WeaponVisualStyle.js';
/**
 * @fileoverview Ranged Weapon Types & Interfaces
 *
 * Type definitions, interfaces, and the weapon type system for the ranged weapon registry.
 * Extracted from RangedWeaponRegistry.ts to keep file sizes manageable.
 */

import * as THREE from 'three';

// ════════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ════════════════════════════════════════════════════════════════════════════════

export interface RangedWeaponPreset {
	name: string;
	damage: number;
	fireRate: number;          // Shots per second
	projectileSpeed: number;
	magazineSize: number;
	reloadDuration?: number;   // Reload time in milliseconds (default: 1500)
	autoReload?: boolean;      // Auto-reload when empty (default: true)
	reloadEnabled?: boolean;   // Whether reload is allowed at all (default: true)
	hands: 1 | 2;              // 1-handed or 2-handed
	muzzleOffset: THREE.Vector3; // Where bullets spawn (relative to gun)
	gripOffset: THREE.Vector3;   // Where right hand holds (relative to gun)
	foregrip?: THREE.Vector3;    // Where left hand holds (for 2-handed weapons)
	recoilStrength?: number;     // Visual recoil amount

	/**
	 * Projectiles per trigger pull. Above 1 the weapon fires a VOLLEY — one
	 * round of ammunition, several pellets scattered across `pelletSpreadRad`.
	 * Default: 1.
	 */
	pelletCount?: number;
	/** Half-angle of the pellet cone, radians. Default: DEFAULT_PELLET_SPREAD_RAD. */
	pelletSpreadRad?: number;
	/**
	 * Multiplier on first-person movement bob for this weapon. A heavy weapon
	 * carried two-handed bobs less than a pistol. Default: 1.
	 */
	viewBobScale?: number;

	/** Whether spent casings are thrown in first person. Default: true.
	 *  Set false for bows, crossbows and energy weapons, which have none. */
	ejectsShells?: boolean;
	/** Where casings leave the weapon, weapon-local. Defaults beside the muzzle. */
	ejectPort?: THREE.Vector3;

	// Dual weapon config - same weapon mirrored on both sides
	dual?: boolean;              // If true, creates two weapons (left and right)
	dualSpacing?: number;        // Horizontal spacing from center (default: 0.35)

	// Positioning config
	heightOffset?: number;       // How high above shoulder (default: 0.2)
	xOffset?: number;            // Additional horizontal offset (default: 0)
	forwardOffset?: number;      // How far forward from player (default: 0.55)
	weaponScale?: THREE.Vector3; // Scale of weapon mesh (default: 3, 3, 1.5)

	// Projectile visual config
	projectileRadius?: number;   // Size of projectile (default: 0.03)
	projectileColor?: number;    // Hex color (default: 0xffaa00)
	trailLength?: number;        // Trail length (default: 4)
	createProjectileMesh?: (radius: number, color: number) => THREE.Object3D; // Custom mesh factory

	// Ballistic physics
	gravityScale?: number;       // 0 = bullet (straight line), 1 = realistic arc (grenade/mortar)

	// Explosion config (optional)
	explosion?: {
		enabled: boolean;
		radius: number;          // Explosion visual radius
		duration: number;        // How long explosion lasts (seconds)
		color?: number;          // Explosion color (default: orange)
		damage?: number;         // Damage at center (for future NPC damage)
		damageRadius?: number;   // Radius for damage falloff (for future NPC damage)
	};
}

export interface RangedWeaponMeshResult {
	/** Authored rear grip center in unscaled mesh coordinates; defaults to preset.gripOffset. */
	grip?: THREE.Vector3;
	foregrip: THREE.Vector3 | null; // Position for left hand (2-handed weapons)
}

export type RangedWeaponMeshCreator = (group: THREE.Group, preset: RangedWeaponPreset) => RangedWeaponMeshResult;

export interface CustomRangedWeaponDefinition {
	preset: RangedWeaponPreset;
	createMesh: RangedWeaponMeshCreator;
}

export interface RangedWeaponCreationResult {
	/** Authored rear grip center, when supplied by the mesh creator. */
	grip?: THREE.Vector3;
	mesh: THREE.Group;
	preset: RangedWeaponPreset;
	foregrip: THREE.Vector3 | null;  // Unscaled mesh-local position for left hand attachment
	// Dual weapon specific
	isDual?: boolean;                 // True if this is a dual weapon setup
	rightWeaponMesh?: THREE.Group;    // Reference to right weapon (for individual animations)
	leftWeaponMesh?: THREE.Group;     // Reference to left weapon (for individual animations)
	rightGrip?: THREE.Vector3;        // Right hand grip position (on right weapon)
	leftGrip?: THREE.Vector3;         // Left hand grip position (on left weapon)
}

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON TYPE SYSTEM
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Built-in ranged weapon types as a const object.
 * Use these for autocomplete when specifying weapon types.
 */
export const RangedWeaponType = {
	PISTOL: 'pistol',
	ASSAULT_RIFLE: 'assault_rifle',
	SHOTGUN: 'shotgun',
	BAZOOKA: 'bazooka',
	BOW: 'bow',
	CROSSBOW: 'crossbow',
	LASER_BLASTER: 'laser_blaster',
	LASER_PISTOL: 'laser_pistol',
	// Dual weapons - same weapon mirrored on both sides, each hand on pistol grip
	DUAL_PISTOLS: 'dual_pistols',
	DUAL_ASSAULT_RIFLES: 'dual_assault_rifles',
	DUAL_BAZOOKAS: 'dual_bazookas'
} as const;

export type BaseRangedWeaponType = typeof RangedWeaponType[keyof typeof RangedWeaponType];
export type BuiltInRangedWeaponType = BaseRangedWeaponType | `${BaseRangedWeaponType}_lowpoly`;

/**
 * Type for any ranged weapon ID - built-in or custom registered.
 */
export type RangedWeaponTypeId = BuiltInRangedWeaponType | (string & {});

export function isBuiltInRangedWeapon(typeId: string): typeId is BuiltInRangedWeaponType {
	return Object.values(RangedWeaponType).includes(splitWeaponStyleId(typeId).baseId as BaseRangedWeaponType);
}
