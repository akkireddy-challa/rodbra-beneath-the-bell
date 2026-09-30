/**
 * @fileoverview Weapon Registry - Extensible Weapon System
 *
 * Engine-level weapon system with support for custom weapons from templates.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 🏗️ ARCHITECTURE
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * **Engine Layer (this file):**
 * - Defines WeaponPreset interface and base types
 * - Provides 12 built-in weapons in block and lowpoly styles
 * - Exposes WeaponRegistry for custom weapon registration
 *
 * **Template Layer:**
 * - Can register custom weapons via WeaponRegistry.register()
 * - Custom weapons are defined entirely in template code
 * - No engine modification needed for new weapons
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 🗡️ BUILT-IN WEAPONS
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * | Type        | Description                      |
 * |-------------|----------------------------------|
 * | sword       | Balanced iron sword              |
 * | longsword   | Two-handed legendary sword       |
 * | dagger      | Short, fast attacks              |
 * | axe         | Heavy battle axe                 |
 * | spear       | Long reach, thrust attacks       |
 * | mace        | Blunt crushing weapon            |
 * | hammer      | Heavy war hammer                 |
 * | katana      | Elegant curved blade             |
 * | cleaver     | Wide chopping blade              |
 * | staff       | Long wooden staff                |
 * | club        | Simple wooden club               |
 * | lightsaber  | Bright green energy blade        |
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 🎮 USAGE - TEMPLATE DEVELOPERS
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Existing IDs select block art; append `_lowpoly` for faceted art (e.g.
 * `sword_lowpoly`, `axe_lowpoly`). Stats and move sets are identical.
 * See `examples/MeleeWeaponGuide.ts` and `@docs weapon-visuals.md`.
 *
 * **Register a custom weapon in your Game.ts:**
 *
 * Part materials: use `createWeaponPartMaterial('<class>', { color })` from
 * `engine/WeaponPartMaterial.js` — the material-class vocabulary (metal, wood,
 * leather, neon, …) — so a custom weapon shades like the built-ins and respects
 * the `?matq=` quality ladder. See `examples/RangedWeaponGuide.ts` for the
 * class table; raw metalness/roughness numbers pay full PBR cost on every device.
 *
 * Then set `weaponType: "carrot"` in world.json.
 */

import * as THREE from 'three';
import type { WeaponConfig } from 'engine/WeaponMeleeSystem.js';
import { splitWeaponStyleId } from 'engine/WeaponVisualStyle.js';
import { createMeleeWeaponModel } from 'engine/weapons/MeleeWeaponModels.js';

// ════════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ════════════════════════════════════════════════════════════════════════════════

export interface WeaponPreset {
	name: string;
	damage: number;
	impactForce: number;
	impulseStrength: number;
	attackRange: number;
	bladeRadius: number;
	gripOffset: number;
	forwardOffset: number;
	/**
	 * How the weapon is held — selects which attack-animation set
	 * `WeaponMeleeSystem` registers on equip. `'two'` gets the two-handed
	 * moves (heavy chop, cleave); `'one'` (and absent, for pre-existing
	 * custom weapons) gets the one-handed slash/thrust set.
	 *
	 * Optional for engine back-compat: published games register custom
	 * weapons through `WeaponRegistry.register()` with presets that predate
	 * this field.
	 */
	grip?: 'one' | 'two';
}

export type WeaponMeshCreator = (group: THREE.Group, preset: WeaponPreset) => number;

export interface CustomWeaponDefinition {
	preset: WeaponPreset;
	createMesh: WeaponMeshCreator;
}

export interface WeaponCreationResult {
	mesh: THREE.Group;
	config: Omit<WeaponConfig, 'weaponMesh'>;
	preset: WeaponPreset;
}

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON TYPE SYSTEM
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Built-in weapon types as a const object.
 * Use these for autocomplete when specifying weapon types.
 *
 * @example
 * const weaponType = WeaponType.SWORD;
 * const weaponType = WeaponType.LONGSWORD;
 */
export const WeaponType = {
	SWORD: 'sword',
	DAGGER: 'dagger',
	AXE: 'axe',
	SPEAR: 'spear',
	MACE: 'mace',
	HAMMER: 'hammer',
	KATANA: 'katana',
	CLEAVER: 'cleaver',
	STAFF: 'staff',
	CLUB: 'club',
	LONGSWORD: 'longsword',
	LIGHTSABER: 'lightsaber'
} as const;

/**
 * Type for built-in weapon IDs (values from WeaponType const object)
 */
export type BaseWeaponType = typeof WeaponType[keyof typeof WeaponType];
export type BuiltInWeaponType = BaseWeaponType | `${BaseWeaponType}_lowpoly`;

/**
 * Type for any weapon ID - built-in or custom registered.
 *
 * This union type provides:
 * - Autocomplete for built-in weapons (sword, axe, etc.)
 * - Accepts any string for custom weapons
 *
 * The `(string & {})` trick allows arbitrary strings while preserving
 * autocomplete for the known literal types.
 *
 * @example
 * function equipWeapon(type: WeaponTypeId) { ... }
 *
 * equipWeapon(WeaponType.SWORD);  // ✅ Autocomplete works
 * equipWeapon('sword');           // ✅ String literal works
 * equipWeapon('carrot');          // ✅ Custom weapon works
 */
export type WeaponTypeId = BuiltInWeaponType | (string & {});

const BUILT_IN_IDS: ReadonlySet<string> = new Set(Object.values(WeaponType));

/**
 * Check if a weapon type is a built-in type
 */
export function isBuiltInWeapon(typeId: string): typeId is BuiltInWeaponType {
	return BUILT_IN_IDS.has(splitWeaponStyleId(typeId).baseId);
}

/** Weapon ids are matched case- and whitespace-insensitively, everywhere. */
function normalizeId(typeId: string): string {
	return typeId.toLowerCase().trim();
}

// ════════════════════════════════════════════════════════════════════════════════
// BUILT-IN WEAPON PRESETS
// ════════════════════════════════════════════════════════════════════════════════

const BUILT_IN_PRESETS: Record<BaseWeaponType, WeaponPreset> = {
	[WeaponType.SWORD]: {
		name: 'Iron Sword',
		damage: 10,
		impactForce: 400,
		impulseStrength: 15,
		attackRange: 3.0,
		bladeRadius: 0.15,
		gripOffset: 0.12,
		forwardOffset: 0.08
	},
	[WeaponType.DAGGER]: {
		name: 'Steel Dagger',
		damage: 6,
		impactForce: 200,
		impulseStrength: 8,
		attackRange: 2.0,
		bladeRadius: 0.1,
		gripOffset: 0.08,
		forwardOffset: 0.06
	},
	[WeaponType.AXE]: {
		name: 'Battle Axe',
		grip: 'two',
		damage: 15,
		impactForce: 600,
		impulseStrength: 20,
		attackRange: 2.5,
		bladeRadius: 0.25,
		gripOffset: 0.15,
		forwardOffset: 0.08
	},
	[WeaponType.SPEAR]: {
		name: 'Iron Spear',
		grip: 'two',
		damage: 12,
		impactForce: 350,
		impulseStrength: 12,
		attackRange: 4.0,
		bladeRadius: 0.1,
		gripOffset: 0.3,
		forwardOffset: 0.1
	},
	[WeaponType.MACE]: {
		name: 'Flanged Mace',
		damage: 12,
		impactForce: 500,
		impulseStrength: 18,
		attackRange: 2.5,
		bladeRadius: 0.2,
		gripOffset: 0.1,
		forwardOffset: 0.08
	},
	[WeaponType.HAMMER]: {
		name: 'War Hammer',
		grip: 'two',
		damage: 18,
		impactForce: 700,
		impulseStrength: 25,
		attackRange: 2.5,
		bladeRadius: 0.25,
		gripOffset: 0.2,
		forwardOffset: 0.08
	},
	[WeaponType.KATANA]: {
		name: 'Katana',
		damage: 11,
		impactForce: 380,
		impulseStrength: 14,
		attackRange: 3.2,
		bladeRadius: 0.12,
		gripOffset: 0.15,
		forwardOffset: 0.08
	},
	[WeaponType.CLEAVER]: {
		name: 'Meat Cleaver',
		damage: 14,
		impactForce: 550,
		impulseStrength: 16,
		attackRange: 2.2,
		bladeRadius: 0.22,
		gripOffset: 0.1,
		forwardOffset: 0.06
	},
	[WeaponType.STAFF]: {
		name: 'Wooden Staff',
		grip: 'two',
		damage: 5,
		impactForce: 250,
		impulseStrength: 10,
		attackRange: 3.5,
		bladeRadius: 0.15,
		gripOffset: 0.4,
		forwardOffset: 0.1
	},
	[WeaponType.CLUB]: {
		name: 'Wooden Club',
		damage: 8,
		impactForce: 400,
		impulseStrength: 15,
		attackRange: 2.0,
		bladeRadius: 0.18,
		gripOffset: 0.1,
		forwardOffset: 0.06
	},
	[WeaponType.LONGSWORD]: {
		name: 'Legendary Longsword',
		grip: 'two',
		damage: 16,
		impactForce: 550,
		impulseStrength: 22,
		attackRange: 4.0,
		bladeRadius: 0.18,
		gripOffset: 0.25,
		forwardOffset: 0.1
	},
	[WeaponType.LIGHTSABER]: {
		name: 'Lightsaber',
		damage: 20,
		impactForce: 300,
		impulseStrength: 18,
		attackRange: 3.5,
		bladeRadius: 0.12,
		gripOffset: 0.15,
		forwardOffset: 0.06
	}
};

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON REGISTRY - Singleton for custom weapon registration
// ════════════════════════════════════════════════════════════════════════════════

class WeaponRegistryClass {
	private customWeapons: Map<string, CustomWeaponDefinition> = new Map();

	/**
	 * Register a custom weapon type
	 *
	 * @param typeId - Unique identifier for this weapon (e.g., 'carrot', 'lightsaber')
	 * @param definition - Weapon preset and mesh creation function
	 *
	 * @example
	 * WeaponRegistry.register('carrot', {
	 *   preset: { name: 'Carrot', damage: 4, ... },
	 *   createMesh: (group, preset) => {
	 *     // Build mesh
	 *     return tipY;
	 *   }
	 * });
	 */
	register(typeId: string, definition: CustomWeaponDefinition): void {
		const normalizedId = normalizeId(typeId);

		// Warn if overwriting a built-in
		if (isBuiltInWeapon(normalizedId)) {
			console.warn(`WeaponRegistry: Overriding built-in weapon type "${normalizedId}"`);
		}

		this.customWeapons.set(normalizedId, definition);
		console.log(`⚔️ WeaponRegistry: Registered custom weapon "${normalizedId}"`);
	}

	/**
	 * Check if a weapon type is registered (built-in or custom)
	 */
	has(typeId: string): boolean {
		const normalizedId = normalizeId(typeId);
		return this.customWeapons.has(normalizedId) || isBuiltInWeapon(normalizedId);
	}

	/**
	 * Get a custom weapon definition (returns null for built-in weapons)
	 */
	getCustom(typeId: string): CustomWeaponDefinition | null {
		return this.customWeapons.get(normalizeId(typeId)) ?? null;
	}

	/**
	 * List all registered custom weapon IDs
	 */
	listCustom(): string[] {
		return Array.from(this.customWeapons.keys());
	}

	/**
	 * Clear all custom weapons (useful for testing)
	 */
	clearCustom(): void {
		this.customWeapons.clear();
	}
}

export const WeaponRegistry = new WeaponRegistryClass();

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON TYPE PARSING
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Parse a weapon type string.
 * Checks custom weapons first, then built-in types.
 * Returns 'sword' as default if not found.
 */
export function parseWeaponType(weaponTypeStr: string | undefined | null): WeaponTypeId {
	if (!weaponTypeStr) return WeaponType.SWORD;

	const normalized = normalizeId(weaponTypeStr);

	// has() covers both registered custom weapons and built-in types
	if (WeaponRegistry.has(normalized)) {
		return normalized;
	}

	console.warn(`Unknown weapon type "${weaponTypeStr}", defaulting to sword`);
	return WeaponType.SWORD;
}

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON CREATION
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Create a weapon mesh and config for the specified weapon type.
 * Supports both built-in and custom registered weapons.
 */
export function createWeaponMesh(weaponType: WeaponTypeId): WeaponCreationResult {
	const normalizedType = normalizeId(weaponType);

	// Check for custom weapon first
	const customDef = WeaponRegistry.getCustom(normalizedType);
	if (customDef) {
		return createFromDefinition(customDef);
	}

	// Fall back to a built-in weapon, and to the sword for anything unknown.
	const { baseId, style } = splitWeaponStyleId(normalizedType);
	const builtInType = (BUILT_IN_IDS.has(baseId) ? baseId : WeaponType.SWORD) as BaseWeaponType;
	return createFromDefinition({
		preset: BUILT_IN_PRESETS[builtInType],
		createMesh: (group, preset) => createMeleeWeaponModel(group, preset, builtInType, style),
	}, true);
}

/**
 * How much wider one cross-blade axis must be than the other before we believe
 * it identifies the blade's plane. Below this the weapon is effectively round
 * (a club, a staff, a mace) and has no meaningful edge to align.
 */
const EDGE_ASYMMETRY_THRESHOLD = 1.25;

/**
 * How much thinner one half of the blade must be before we call it the edge.
 * A relative difference, so it means the same on a dagger and a greatsword.
 */
const SPINE_BIAS_THRESHOLD = 0.08;

/**
 * Which side of the blade is SHARP, measured as where it is thinnest.
 *
 * A first attempt compared the mesh's vertex centroid against the bounding-box
 * centre, on the theory that a tapered blade leaves more geometry at the spine.
 * It does not: tessellation is usually uniform, so both halves carry the same
 * vertex count and the centroid sits dead centre no matter which side is sharp.
 * Measured against a synthetic sabre it detected nothing at all.
 *
 * So measure the property that actually defines an edge — thickness. Bucket
 * every vertex by which half of the wide axis it sits in, and average its
 * distance from the blade's mid-plane. The thinner half is the edge.
 *
 * @returns +1 when the edge faces the positive end of `wideAxis`, -1 when it
 *          faces the negative end, or 0 when the blade is symmetric (a
 *          double-edged sword, where either side is legitimately its edge).
 */
function detectEdgeSide(root: THREE.Object3D, wideAxis: 'x' | 'z', center: THREE.Vector3): number {
	const thinAxis: 'x' | 'z' = wideAxis === 'x' ? 'z' : 'x';
	let positiveSum = 0, positiveWeight = 0;
	let negativeSum = 0, negativeWeight = 0;

	const vertex = new THREE.Vector3();
	root.updateMatrixWorld(true);
	const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

	// Thickness means are WEIGHTED by how far out the wide axis each vertex
	// sits. Unweighted means let a weapon's HANDLE vote: on an axe, the bare
	// 3cm haft (hundreds of near-centre vertices, thinner than the 5cm head)
	// out-voted the actual blade, the "thinner side is the edge" rule
	// inverted, and the built-in axe both shipped swinging backwards AND got
	// re-flipped when its mesh was fixed. Weighting by offset makes the far
	// geometry — the head and its edge, the only parts that matter — decide,
	// while handle vertices near the centreline contribute almost nothing.
	root.traverse((node) => {
		const mesh = node as THREE.Mesh;
		const position = mesh.geometry?.attributes?.position as THREE.BufferAttribute | undefined;
		if (!position) return;
		for (let i = 0; i < position.count; i++) {
			vertex.fromBufferAttribute(position, i);
			mesh.localToWorld(vertex);
			vertex.applyMatrix4(rootInverse);
			const thickness = Math.abs(vertex[thinAxis] - center[thinAxis]);
			const offset = vertex[wideAxis] - center[wideAxis];
			const weight = Math.abs(offset);
			if (offset >= 0) {
				positiveSum += thickness * weight; positiveWeight += weight;
			} else {
				negativeSum += thickness * weight; negativeWeight += weight;
			}
		}
	});

	if (positiveWeight <= 1e-6 || negativeWeight <= 1e-6) return 0;

	const positiveMean = positiveSum / positiveWeight;
	const negativeMean = negativeSum / negativeWeight;
	const spread = Math.max(positiveMean, negativeMean);
	if (spread <= 1e-6) return 0;

	// Symmetric within tolerance → genuinely double-edged, leave it alone.
	const difference = (positiveMean - negativeMean) / spread;
	if (Math.abs(difference) < SPINE_BIAS_THRESHOLD) return 0;
	// Thinner side is the edge (both sides are blade material here).
	return positiveMean < negativeMean ? 1 : -1;
}

/**
 * Turn a weapon so its cutting edge faces the engine's expected axis AND side.
 *
 * The engine treats a weapon's local +Z as the edge direction and local X as
 * the flat — the convention used by both styles in `MeleeWeaponModels.ts`,
 * with blade breadth and crossguards along Z. Everything downstream
 * depends on it: the idle carry orientation, `rollEdgeToLead`, and the authored
 * animations' edge roll.
 *
 * Weapons built by template or agent code routinely model the blade the other
 * way round, which puts the edge 90° out — the sword swings and carries with
 * its FLAT leading instead of its edge. Rather than make every consumer guess,
 * normalise here, once, at the single point every weapon mesh is created.
 *
 * Two independent things have to be right, and getting only the first is what
 * makes a sabre curve the wrong way:
 *
 *  1. THE AXIS. The blade runs along the longest local axis (Y by convention);
 *     of the two cross-axes, the WIDER one spans edge to edge, because a blade
 *     is wide across its cutting plane and thin through it.
 *  2. THE SIDE. Which end of that wider axis is sharp. A bounding box cannot
 *     say — both 90° rotations put the wide axis on Z — so this measures
 *     THICKNESS per side (see detectEdgeSide): a single-edged blade tapers to
 *     its edge and keeps its bulk at the spine, so the thinner half is the
 *     edge. A symmetric double-edged blade measures equal and is left as-is,
 *     correctly, because either side is its edge.
 *
 * Rotating about Y only is what makes this safe: `hiltOffset` and `tipOffset`
 * both lie along Y, so they are unchanged and no hit detection, slash arc or
 * grip maths has to know this happened.
 *
 * @returns a description of what was corrected, or null if nothing was needed
 */
function normalizeWeaponEdgeAxis(group: THREE.Group): string | null {
	if (group.children.length === 0) return null;

	const box = new THREE.Box3().setFromObject(group);
	if (box.isEmpty()) return null;
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());

	// Only meaningful for blade-like weapons, i.e. clearly longest along Y.
	if (size.y <= Math.max(size.x, size.z)) return null;

	const thin = Math.min(size.x, size.z);
	if (thin <= 1e-6) return null;
	const wide = Math.max(size.x, size.z);
	if (wide / thin < EDGE_ASYMMETRY_THRESHOLD) return null;

	const wideAxis: 'x' | 'z' = size.z >= size.x ? 'z' : 'x';

	// Which side of the wide axis is sharp — measured, see detectEdgeSide.
	// 0 means symmetric (double-edged): either side is its edge, so treat it as
	// already facing +Z and there is nothing to fix.
	const edgeSign = detectEdgeSide(group, wideAxis, center) || 1;

	// Rotation about Y that carries the edge onto +Z.
	//   wide axis Z, edge +Z → 0        wide axis Z, edge −Z → 180°
	//   wide axis X, edge +X → −90°     wide axis X, edge −X → +90°
	let turn: number;
	let why: string;
	if (wideAxis === 'z') {
		if (edgeSign > 0) return null;   // already correct
		turn = Math.PI;
		why = 'edge faced backwards';
	} else {
		turn = edgeSign > 0 ? -Math.PI / 2 : Math.PI / 2;
		why = 'edge axis was 90° out';
	}

	const inner = new THREE.Group();
	inner.name = 'EdgeAxisCorrection';
	for (const child of [...group.children]) inner.add(child);
	inner.rotation.y = turn;
	group.add(inner);
	return why;
}

function createFromDefinition(definition: CustomWeaponDefinition, authoredEdgeAxis = false): WeaponCreationResult {
	const { preset, createMesh } = definition;
	const group = new THREE.Group();
	group.name = `Weapon_${preset.name}`;

	const tipY = createMesh(group, preset);

	// Put the cutting edge on the axis the rest of the engine assumes, whatever
	// orientation the mesh was authored in. See normalizeWeaponEdgeAxis.
	const edgeFix = authoredEdgeAxis ? null : normalizeWeaponEdgeAxis(group);
	if (edgeFix) {
		console.log(`🗡️ ${preset.name}: ${edgeFix} — corrected`);
	}

	// Position for hand grip
	group.position.set(0, preset.forwardOffset, 0);

	const config: Omit<WeaponConfig, 'weaponMesh'> = {
		name: preset.name,
		damage: preset.damage,
		impactForce: preset.impactForce,
		impulseStrength: preset.impulseStrength,
		hiltOffset: new THREE.Vector3(0, preset.gripOffset, 0),
		tipOffset: new THREE.Vector3(0, tipY, 0),
		bladeRadius: preset.bladeRadius,
		attackRange: preset.attackRange,
		animationPrefix: 'Attack_'
	};

	return { mesh: group, config, preset };
}

/**
 * Make weapon mesh visual-only (no physics collisions)
 */
export function makeWeaponVisualOnly(weaponGroup: THREE.Object3D): void {
	weaponGroup.traverse((child) => {
		const mesh = child as THREE.Mesh;
		if (!mesh.isMesh) return;
		mesh.layers.disableAll();
		mesh.layers.enable(2); // Visual-only layer
		mesh.userData.isVisualOnly = true;
		mesh.userData.noPhysics = true;
		delete mesh.userData.physicsBody;
		delete mesh.userData.mass;
	});
}
