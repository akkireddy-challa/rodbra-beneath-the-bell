/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                  RANGED WEAPON CREATION GUIDE FOR AI AGENTS                  ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * SEARCH KEYWORDS: revolver, six-shooter, pistol, handgun, custom weapon, create weapon,
 * shotgun, rifle, carbine, laser gun, ray gun, blaster, SMG, akimbo, dual weapons,
 * bazooka, rocket launcher, RPG, grenade, hand grenade, flamethrower, flame thrower,
 * AOE, area of effect, explosion, explosive, arc trajectory, gravityScale, thrown weapon
 *
 * SEE ALSO (for specific weapon archetypes with multiplayer):
 * - EXAMPLE_BazookaGame.ts — Bazooka/rocket launcher with AOE + multiplayer
 * - EXAMPLE_HandGrenadeWeapon.ts — Grenade with arc trajectory + AOE + multiplayer
 * - EXAMPLE_FlamethrowerWeapon.ts — Flamethrower rapid-fire + multiplayer
 *
 * BUILT-IN WEAPONS (use these directly, no registration needed):
 * Two authored styles: base ID = BLOCK; append `_lowpoly` = LOWPOLY.
 * Examples: 'pistol_lowpoly', 'shotgun_lowpoly', 'dual_pistols_lowpoly'.
 * Both keep identical stats, muzzle/hand anchors, projectiles and hold poses.
 * See @docs weapon-visuals.md and the compiled registerTrailCarbines() below.
 * ┌─────────────────────┬───────┬──────────────────────────────────────┐
 * │ ID                  │ Hands │ Description                          │
 * ├─────────────────────┼───────┼──────────────────────────────────────┤
 * │ pistol              │ 1     │ Basic handgun                        │
 * │ assault_rifle       │ 2     │ Standard rifle with foregrip         │
 * │ shotgun             │ 2     │ Pump shotgun, eight-pellet volley    │
 * │ bazooka             │ 2     │ Shoulder-mounted rocket launcher     │
 * │ bow                 │ 2     │ Traditional bow with arrows          │
 * │ crossbow            │ 2     │ Rifle-style crossbow                 │
 * │ laser_blaster       │ 2     │ Sci-fi energy rifle                  │
 * │ laser_pistol        │ 1     │ Sci-fi energy pistol                 │
 * │ dual_pistols        │ dual  │ Two pistols, akimbo style            │
 * │ dual_assault_rifles │ dual  │ Two rifles, akimbo style             │
 * │ dual_bazookas       │ dual  │ Two bazookas, akimbo style           │
 * └─────────────────────┴───────┴──────────────────────────────────────┘
 *
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ TO GIVE THE PLAYER A GUN — ONE CALL, NOTHING ELSE TO WIRE                    │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 *     import { installRangedWeapon } from 'engine/RangedWeaponSystem.js';
 *
 *     // Top-down arena: pistol that fires at the visible mouse cursor + ammo HUD
 *     installRangedWeapon(this.playerController, 'pistol', {
 *         aim: 'cursor',
 *         showAmmoCounter: true,
 *     });
 *
 * That single call constructs the RangedWeaponSystem, registers it as the
 * controller's attack system (listeners, mobile controls, per-frame tick,
 * disposal), equips the weapon READINESS-SAFELY (before or after the character
 * has loaded — either way the gun, the hold-to-fire shoot action and the ammo
 * counter appear), and applies the ammo options.
 *
 * ⚠️ Do NOT hand-roll the three-step sequence below unless you need to
 * interleave your own steps — getting `setAttackSystem` / `onCharacterReady` /
 * `equipWeapon` in the wrong order is the classic "type-clean code, no visible
 * weapon and nothing happens when I shoot" bug:
 *
 *     const s = new RangedWeaponSystem(engine, physicsWorld, options);  // low level
 *     playerController.setAttackSystem(s);
 *     playerController.onCharacterReady(() => s.equipWeapon('pistol', player, playerLoader));
 *
 * OPTIONS (all optional, spread over DEFAULT_RANGED_WEAPON_INSTALL_OPTIONS):
 *   aim: 'auto' | 'camera' | 'cursor'          — 'auto' = cursor under a top-down camera
 *   cursorFacing: 'while-firing' | 'always'    — 'always' = classic twin-stick
 *   projectileColor: number | null             — null keeps the preset's color
 *   magazineSize: number | null                — null keeps the preset's magazine
 *   reloadDurationMs: number | null            — null keeps the preset's reload time
 *   showAmmoCounter: 'auto' | true | false     — 'auto' = show with finite ammo
 *
 * The returned handle switches or removes the weapon later:
 *   const weapon = installRangedWeapon(controller, 'pistol');
 *   weapon.switchWeapon('assault_rifle');
 *   weapon.remove();
 *   weapon.system.onProjectileCreated = (p) => { ... };   // low-level escape hatch
 *
 * TO CREATE A CUSTOM WEAPON:
 * 1. Choose archetype: PISTOL (1-hand), ASSAULT_RIFLE (2-hand), BAZOOKA (shoulder), or DUAL
 * 2. Copy the matching PRESET_TEMPLATE below
 * 3. Create a createMesh function using THREE.js geometry
 * 4. Register with RangedWeaponRegistry.register('your_weapon_id', { preset, createMesh })
 * 5. Install it exactly like a built-in: installRangedWeapon(controller, 'your_weapon_id')
 */

import * as THREE from 'three';
import type { RangedWeaponPreset, RangedWeaponMeshResult } from 'engine/RangedWeaponRegistry.js';
import { createWeaponPartMaterial } from 'engine/WeaponPartMaterial.js';
import { RangedWeaponRegistry } from 'engine/RangedWeaponRegistry.js';
import { createRangedWeaponModel } from 'engine/weapons/RangedWeaponModels.js';
import { weaponStyleId } from 'engine/WeaponVisualStyle.js';

/**
 * Register a tuned built-in design in both styles. Call from template setup,
 * then installRangedWeapon(controller, 'trail_carbine_lowpoly'). For a new
 * silhouette, copy/adapt RangedWeaponModels.ts or use WeaponMeshBuilder; do not
 * merely swap materials and call the result a lowpoly model.
 */
export function registerTrailCarbines(): void {
    const preset: RangedWeaponPreset = {
        ...RIFLE_PRESET_TEMPLATE,
        name: 'Trail Carbine', damage: 14, fireRate: 5, magazineSize: 20,
    };
    for (const style of ['block', 'lowpoly'] as const) {
        RangedWeaponRegistry.register(weaponStyleId('trail_carbine', style), {
            preset,
            createMesh: (group, p) => createRangedWeaponModel(group, p, 'assault_rifle', style),
        });
    }
}


// ════════════════════════════════════════════════════════════════════════════════
// COORDINATE SYSTEM
// ════════════════════════════════════════════════════════════════════════════════
//
//       +Y (Up)
//         │
//         │
//         ┼────────── +X (Right)
//        ╱
//       +Z (Forward - where weapon fires)
//
// WEAPON ORIENTATION:
// - Weapon points FORWARD along +Z axis
// - Grip at origin (0, 0, 0), barrel extends toward +Z
// - Stock extends toward -Z, sights on top (+Y), magazine below (-Y)
//
// CRITICAL: Cylinders are vertical by default. Rotate barrels with:
//     barrel.rotation.x = Math.PI / 2;  // Points along +Z

export const BARREL_ROTATION = Math.PI / 2;


// ════════════════════════════════════════════════════════════════════════════════
// PRESET TEMPLATES - Copy and customize these
// ════════════════════════════════════════════════════════════════════════════════

/** 1-HANDED PISTOL - for handguns, revolvers, laser pistols */
export const PISTOL_PRESET_TEMPLATE: RangedWeaponPreset = {
	name: 'Your Pistol Name',        // ← Change
	damage: 15,                       // ← Customize
	fireRate: 3,                      // ← Customize (shots/sec)
	projectileSpeed: 40,              // ← Customize
	magazineSize: 12,                 // ← Customize
	// ═══ DO NOT CHANGE BELOW ═══
	hands: 1,
	muzzleOffset: new THREE.Vector3(0, 0.02, 0.15),
	gripOffset: new THREE.Vector3(0, 0, 0),
	recoilStrength: 0.1,
	heightOffset: 0.04,
	xOffset: 0,
	forwardOffset: 0.25,
	weaponScale: new THREE.Vector3(1.95, 1.95, 0.975),
	projectileRadius: 0.03,
	projectileColor: 0xffaa00,        // ← Customize color
	trailLength: 4
};

/** 2-HANDED RIFLE - for rifles, SMGs, shotguns, crossbows */
export const RIFLE_PRESET_TEMPLATE: RangedWeaponPreset = {
	name: 'Your Rifle Name',         // ← Change
	damage: 10,                       // ← Customize
	fireRate: 8,                      // ← Customize
	projectileSpeed: 50,              // ← Customize
	magazineSize: 30,                 // ← Customize
	// ═══ DO NOT CHANGE BELOW ═══
	hands: 2,
	muzzleOffset: new THREE.Vector3(0, 0.03, 0.55),
	gripOffset: new THREE.Vector3(0, 0, -0.1),
	foregrip: new THREE.Vector3(0, -0.02, 0.07),  // LEFT HAND position
	recoilStrength: 0.15,
	heightOffset: 0.2,
	xOffset: 0,
	forwardOffset: 0.55,
	weaponScale: new THREE.Vector3(2.4, 2.4, 1.2),
	projectileRadius: 0.03,
	projectileColor: 0xffaa00,        // ← Customize color
	trailLength: 4
};

/** 2-HANDED LAUNCHER - for bazookas, rocket launchers, grenade launchers */
export const LAUNCHER_PRESET_TEMPLATE: RangedWeaponPreset = {
	name: 'Your Launcher Name',      // ← Change
	damage: 100,                      // ← Customize
	fireRate: 0.5,                    // ← Customize
	projectileSpeed: 7,               // ← Customize
	magazineSize: 1,                  // ← Customize
	// ═══ DO NOT CHANGE BELOW ═══
	hands: 2,
	muzzleOffset: new THREE.Vector3(0, 0, 0.8),
	gripOffset: new THREE.Vector3(0, -0.05, -0.2),
	foregrip: new THREE.Vector3(0, -0.05, 0.15),  // LEFT HAND position
	recoilStrength: 0.3,
	heightOffset: 0.45,               // Higher - sits ON shoulder
	xOffset: -0.1,                    // Offset for shoulder mount
	forwardOffset: 0.55,
	weaponScale: new THREE.Vector3(2.25, 2.25, 1.125),
	projectileRadius: 0.08,
	projectileColor: 0x556b2f,        // ← Customize color
	trailLength: 10,
	explosion: {
		enabled: true,
		radius: 25.0,
		duration: 1.0,
		color: 0xff4400,
		damage: 100,
		damageRadius: 37.5
	}
};

/** DUAL PISTOLS - akimbo style, one in each hand */
export const DUAL_PISTOL_PRESET_TEMPLATE: RangedWeaponPreset = {
	name: 'Your Dual Pistols',       // ← Change
	damage: 12,                       // ← Customize (per shot)
	fireRate: 5,                      // ← Customize (alternating)
	projectileSpeed: 40,              // ← Customize
	magazineSize: 24,                 // ← Customize (combined)
	// ═══ DO NOT CHANGE BELOW ═══
	hands: 2,
	dual: true,                        // REQUIRED for dual weapons
	dualSpacing: 0.308 / 1.82,         // Keep world spacing when choosing a smaller scale
	muzzleOffset: new THREE.Vector3(0, 0.02, 0.15),
	gripOffset: new THREE.Vector3(0, 0.01, -0.04),
	recoilStrength: 0.08,
	heightOffset: 0,
	xOffset: 0,                        // Always 0 for dual (centered)
	forwardOffset: 0.45,               // Reachable at the lower hold, including upward aim
	weaponScale: new THREE.Vector3(1.82, 1.82, 0.91),
	projectileRadius: 0.03,
	projectileColor: 0xffaa00,        // ← Customize color
	trailLength: 4
};


// ════════════════════════════════════════════════════════════════════════════════
// MESH FUNCTION RETURN VALUES
// ════════════════════════════════════════════════════════════════════════════════
//
// Your createMesh function MUST return the correct foregrip:
//
// 1-handed (PISTOL):     return { foregrip: null };
// 2-handed (RIFLE):      return { foregrip: new THREE.Vector3(0, -0.02, 0.10) };
// 2-handed (LAUNCHER):   return { foregrip: new THREE.Vector3(0, -0.05, 0.15) };
// DUAL weapons:          return { foregrip: null };


// ════════════════════════════════════════════════════════════════════════════════
// TYPICAL PART DIMENSIONS (before weaponScale applied)
// ════════════════════════════════════════════════════════════════════════════════
//
// PISTOL (~0.15 length):
//   Barrel: radius=0.006, length=0.02-0.08
//   Grip: 0.024w × 0.07h × 0.03d
//   Frame: 0.022w × 0.025h × 0.10d
//
// RIFLE (~0.80 length):
//   Barrel: radius=0.014, length=0.30-0.40
//   Receiver: 0.040w × 0.055h × 0.25d
//   Stock: 0.035w × 0.040h × 0.18d
//   Handguard: radius=0.022, length=0.20
//   Magazine: 0.020w × 0.12h × 0.04d
//
// BAZOOKA (~1.20 length):
//   Main Tube: radius=0.08, length=1.0-1.4
//   Grips: 0.04w × 0.10h × 0.04d
//   Shoulder Rest: 0.15w × 0.03h × 0.20d


// ════════════════════════════════════════════════════════════════════════════════
// MATERIAL CLASSES — USE THESE FOR WEAPON PART MATERIALS
// ════════════════════════════════════════════════════════════════════════════════
//
// A weapon part names WHAT IT IS MADE OF and picks its colour; the engine picks
// the shading. This is the same 16-name vocabulary classed voxel assets use, so
// a custom weapon's steel matches a voxel sword's steel — and classes respect
// the `?matq=` material-quality ladder (engine/MaterialQuality.ts: full
// reflections on desktop, cheap Phong on mobile, Lambert on low-end). Raw
// metalness/roughness numbers do NOT — they pay full PBR cost on every device.
//
//     import { createWeaponPartMaterial } from 'engine/WeaponPartMaterial.js';
//     const steel = createWeaponPartMaterial('metal', { color: 0x333333 });
//
// Vocabulary: matte (default), cloth, fur, leather, wood, stone, plastic,
// paint, metal, gold, chrome, gem, glass, filament, neon, lava.
// The glowing classes (neon, filament, lava) glow by default, tinted by the
// part's own colour; tune with `glow:` (1 = the voxel full-glow, intensity 3.0)
// or silence with `glow: 0`. An unknown class name degrades to matte — never an
// error. Transparency stays a postscript: set `transparent`/`opacity` on the
// returned material.
//
// The legacy presets below, expressed as classes:
//   metalDark     → createWeaponPartMaterial('metal', { color: 0x1a1a1a })
//   metalMid      → createWeaponPartMaterial('metal', { color: 0x333333 })
//   polymer       → createWeaponPartMaterial('plastic', { color: 0x0f0f0f })
//   oliveDrab     → createWeaponPartMaterial('paint', { color: 0x4a5528 })
//   metalChrome   → createWeaponPartMaterial('chrome', { color: 0x888888 })
//   glowRed       → createWeaponPartMaterial('neon', { color: 0xff0000, glow: 2 / 3 })
//   glowCyan      → createWeaponPartMaterial('neon', { color: 0x00ffff, glow: 2 / 3 })
//   glowGreen     → createWeaponPartMaterial('neon', { color: 0x00ff00, glow: 2 / 3 })
//   woodDark      → createWeaponPartMaterial('wood', { color: 0x4a3728 })
//   woodLight     → createWeaponPartMaterial('wood', { color: 0x6b4423 })
//   metalBronze   → createWeaponPartMaterial('metal', { color: 0x8b7355 })
//   goldOrnate    → createWeaponPartMaterial('gold', { color: 0xffd700 })
//   crystalPurple → const gem = createWeaponPartMaterial('gem', { color: 0x9932cc });
//                   gem.transparent = true; gem.opacity = 0.7;


// ════════════════════════════════════════════════════════════════════════════════
// MATERIAL PRESETS (LEGACY — new code uses the material classes above)
// ════════════════════════════════════════════════════════════════════════════════

export const MATERIAL_PRESETS = {
	// MILITARY
	metalDark: { color: 0x1a1a1a, metalness: 0.85, roughness: 0.4 },
	metalMid: { color: 0x333333, metalness: 0.8, roughness: 0.35 },
	polymer: { color: 0x0f0f0f, metalness: 0, roughness: 0.7 },
	oliveDrab: { color: 0x4a5528, metalness: 0.3, roughness: 0.7 },

	// SCI-FI
	metalChrome: { color: 0x888888, metalness: 1.0, roughness: 0.1 },
	glowRed: { color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 2.0 },
	glowCyan: { color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 2.0 },
	glowGreen: { color: 0x00ff00, emissive: 0x00ff00, emissiveIntensity: 2.0 },

	// WOOD/CLASSIC
	woodDark: { color: 0x4a3728, metalness: 0.1, roughness: 0.8 },
	woodLight: { color: 0x6b4423, metalness: 0.1, roughness: 0.75 },
	metalBronze: { color: 0x8b7355, metalness: 0.6, roughness: 0.4 },

	// FANTASY
	goldOrnate: { color: 0xffd700, metalness: 0.9, roughness: 0.2 },
	crystalPurple: { color: 0x9932cc, emissive: 0x9932cc, emissiveIntensity: 1.0, transparent: true, opacity: 0.7 }
};


// ════════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════════

/** Create a barrel (cylinder rotated to point forward along +Z) */
export function createBarrel(
	group: THREE.Group,
	radius: number,
	length: number,
	position: THREE.Vector3,
	material: THREE.Material,
	tapered = false,
	taperRatio = 0.85
): THREE.Mesh {
	const radiusFront = tapered ? radius * taperRatio : radius;
	const barrel = new THREE.Mesh(
		new THREE.CylinderGeometry(radiusFront, radius, length, 12),
		material
	);
	barrel.rotation.x = BARREL_ROTATION;
	barrel.position.copy(position);
	barrel.castShadow = true;
	group.add(barrel);
	return barrel;
}

/**
 * One shadow-casting box part, optionally tilted about X — the shared body of
 * every box-shaped helper below (receiver, grip, stock, magazine).
 */
function addBoxPart(
	group: THREE.Group,
	width: number,
	height: number,
	depth: number,
	position: THREE.Vector3,
	material: THREE.Material,
	tiltAngle = 0
): THREE.Mesh {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
	mesh.position.copy(position);
	mesh.rotation.x = tiltAngle;
	mesh.castShadow = true;
	group.add(mesh);
	return mesh;
}

/** Create a box-shaped receiver/body */
export function createReceiver(
	group: THREE.Group,
	width: number,
	height: number,
	depth: number,
	position: THREE.Vector3,
	material: THREE.Material
): THREE.Mesh {
	return addBoxPart(group, width, height, depth, position, material);
}

/** Create a pistol grip (tilted backward) */
export function createPistolGrip(
	group: THREE.Group,
	width: number,
	height: number,
	depth: number,
	position: THREE.Vector3,
	material: THREE.Material,
	tiltAngle = -0.2
): THREE.Mesh {
	return addBoxPart(group, width, height, depth, position, material, tiltAngle);
}

/** Create a stock with optional butt pad */
export function createStock(
	group: THREE.Group,
	width: number,
	height: number,
	depth: number,
	position: THREE.Vector3,
	material: THREE.Material,
	addButtPad = true
): THREE.Mesh {
	const stock = addBoxPart(group, width, height, depth, position, material);

	if (addButtPad) {
		// A classed part material, like every other part — see MATERIAL CLASSES
		// above; the built-in assault rifle's butt pad is this exact call.
		addBoxPart(
			group,
			width * 1.2,
			height * 1.5,
			0.015,
			new THREE.Vector3(
				position.x,
				position.y - height * 0.1,
				position.z - depth / 2 - 0.0075
			),
			createWeaponPartMaterial('plastic', { color: 0x333333 })
		);
	}
	return stock;
}

/** Create a cylindrical handguard (for left hand on rifles) */
export function createHandguard(
	group: THREE.Group,
	radius: number,
	length: number,
	position: THREE.Vector3,
	material: THREE.Material
): THREE.Mesh {
	const handguard = new THREE.Mesh(
		new THREE.CylinderGeometry(radius, radius * 1.1, length, 8),
		material
	);
	handguard.rotation.x = BARREL_ROTATION;
	handguard.position.copy(position);
	handguard.castShadow = true;
	group.add(handguard);
	return handguard;
}

/** Create a box magazine */
export function createMagazine(
	group: THREE.Group,
	width: number,
	height: number,
	depth: number,
	position: THREE.Vector3,
	material: THREE.Material,
	tiltAngle = -0.1
): THREE.Mesh {
	return addBoxPart(group, width, height, depth, position, material, tiltAngle);
}

/** Create iron sights (front post + rear notch) */
export function createIronSights(
	group: THREE.Group,
	frontPosition: THREE.Vector3,
	rearPosition: THREE.Vector3,
	material: THREE.Material
): void {
	const front = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.015, 0.004), material);
	front.position.copy(frontPosition);
	group.add(front);

	const rear = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.010, 0.008), material);
	rear.position.copy(rearPosition);
	group.add(rear);
}


// ════════════════════════════════════════════════════════════════════════════════
// REGISTRATION EXAMPLE
// ════════════════════════════════════════════════════════════════════════════════
//
// In your Game.ts:
//
// import { RangedWeaponRegistry } from 'engine/RangedWeaponRegistry.js';
// import { createWeaponPartMaterial } from 'engine/WeaponPartMaterial.js';
//
// // Define preset (copy from template above)
// const MY_REVOLVER_PRESET: RangedWeaponPreset = {
//     ...PISTOL_PRESET_TEMPLATE,
//     name: 'Western Revolver',
//     damage: 25,
//     fireRate: 1.5,
//     magazineSize: 6,
//     projectileColor: 0xffdd00
// };
//
// // Define mesh creator
// function createRevolver(group: THREE.Group, _preset: RangedWeaponPreset): RangedWeaponMeshResult {
//     const metal = createWeaponPartMaterial('metal', { color: 0x333333 });
//     const wood = createWeaponPartMaterial('wood', { color: 0x5c3d2e });
//
//     // Frame
//     const frame = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.035, 0.08), metal);
//     frame.position.set(0, 0.015, 0.02);
//     group.add(frame);
//
//     // Barrel
//     const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.12, 8), metal);
//     barrel.rotation.x = Math.PI / 2;
//     barrel.position.set(0, 0.025, 0.12);
//     group.add(barrel);
//
//     // Cylinder (revolving chamber)
//     const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.035, 6), metal);
//     cylinder.rotation.x = Math.PI / 2;
//     cylinder.position.set(0, 0.02, 0.03);
//     group.add(cylinder);
//
//     // Grip
//     const grip = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.06, 0.028), wood);
//     grip.position.set(0, -0.025, -0.01);
//     grip.rotation.x = -0.2;
//     group.add(grip);
//
//     return { foregrip: null };  // 1-handed = null
// }
//
// // Register
// RangedWeaponRegistry.register('western_revolver', {
//     preset: MY_REVOLVER_PRESET,
//     createMesh: createRevolver
// });
//
// // Give it to the player (or set world.json "player": { "weaponType": "western_revolver" })
// installRangedWeapon(this.playerController, 'western_revolver');


// ════════════════════════════════════════════════════════════════════════════════
// CUSTOM MAGAZINE / AMMUNITION
// ════════════════════════════════════════════════════════════════════════════════
//
// The RangedWeaponSystem uses a pluggable IWeaponMagazine interface for ammo
// management. You can either configure the default WeaponMagazineComponent or
// implement a fully custom one.
//
// ── OPTION 0 (preferred): let installRangedWeapon configure it ──
//
// installRangedWeapon(controller, 'pistol', {
//     magazineSize: 6,
//     reloadDurationMs: 2000,
//     showAmmoCounter: true,
// });
//
// ── OPTION 1: Default magazine with custom config ──
//
// import { WeaponMagazineComponent } from 'engine/WeaponMagazineComponent.js';
//
// const mag = new WeaponMagazineComponent({
//     magazineSize: 6,
//     reloadDuration: 2000,  // 2 second reload
//     startLoaded: true
// });
// rangedSystem.setMagazine(mag);
//
// ── OPTION 2: Custom IWeaponMagazine (e.g., infinite ammo) ──
//
// import type { IWeaponMagazine } from 'engine/IWeaponMagazine.js';
//
// class InfiniteAmmoMagazine implements IWeaponMagazine {
//     tryConsume(): boolean { return true; }  // Always has ammo
//     startReload(): void {}                  // No-op
//     update(): void {}                       // No-op
//     reset(_magazineSize: number): void {}
//     getCurrentAmmo(): number { return 999; }
//     getMagazineSize(): number { return 999; }
//     getIsReloading(): boolean { return false; }
//     getAmmoState() { return { current: 999, max: 999, isReloading: false }; }
//     setReloadDuration(_ms: number): void {}
//     getReloadDuration(): number { return 0; }
// }
//
// rangedSystem.setMagazine(new InfiniteAmmoMagazine());
//
// ── OPTION 3: Set reloadDuration in weapon preset ──
//
// const MY_SLOW_RIFLE: RangedWeaponPreset = {
//     ...RIFLE_PRESET_TEMPLATE,
//     name: 'Heavy Sniper',
//     magazineSize: 5,
//     reloadDuration: 3000,  // 3 second reload
// };


// ════════════════════════════════════════════════════════════════════════════════
// DUAL WEAPONS
// ════════════════════════════════════════════════════════════════════════════════
//
// For akimbo weapons, use RangedWeaponRegistry.registerDual() - it's simpler!
// Just provide a single weapon mesh creator, and it handles duplication.
//
// RangedWeaponRegistry.registerDual('dual_my_pistols', {
//     preset: { ...DUAL_PISTOL_PRESET_TEMPLATE, name: 'Dual Custom Pistols' },
//     createSingleMesh: (group, preset) => {
//         // Build ONE weapon here
//         // ...
//         return { foregrip: null };
//     },
//     weaponName: 'MyPistol'
// });
//
// The helper automatically:
// - Creates two weapons with correct spacing
// - Mirrors the left weapon (scale.x = -1)
// - Sets up alternating fire


// ════════════════════════════════════════════════════════════════════════════════
// QUICK REFERENCE
// ════════════════════════════════════════════════════════════════════════════════
//
// ┌─────────────┬────────────────┬────────────────┬────────────────┬─────────────┐
// │ Type        │ muzzleOffset   │ gripOffset     │ foregrip       │ heightOffset│
// ├─────────────┼────────────────┼────────────────┼────────────────┼─────────────┤
// │ Pistol      │ (0, 0.02, 0.15)│ (0, 0, 0)      │ null           │ 0.20        │
// │ Rifle       │ (0, 0.03, 0.55)│ (0, 0, -0.10)  │ (0,-0.02,0.10) │ 0.20        │
// │ Bazooka     │ (0, 0, 0.80)   │ (0,-0.05,-0.2) │ (0,-0.05,0.15) │ 0.45        │
// │ Dual Pistol │ (0, 0.02, 0.15)│ (0, 0.01,-0.04)│ null           │ 0.12        │
// └─────────────┴────────────────┴────────────────┴────────────────┴─────────────┘
//
// CHECKLIST:
// □ Chose archetype (PISTOL/RIFLE/LAUNCHER/DUAL)
// □ Copied preset template, customized name/damage/fireRate/color
// □ Created mesh with: receiver, barrel (rotation.x=π/2), grip, [foregrip], [stock]
// □ Return correct foregrip value
// □ Registered with RangedWeaponRegistry.register()
// □ Installed with installRangedWeapon(controller, id, options) — NOT a hand-rolled
//   setAttackSystem / onCharacterReady / equipWeapon sequence
