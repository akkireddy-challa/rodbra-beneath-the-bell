/**
 * @fileoverview Ranged Weapon Mesh Creators
 *
 * All projectile mesh factories and weapon mesh creation functions for the ranged weapon system.
 * Extracted from RangedWeaponRegistry.ts to keep file sizes manageable.
 */

import * as THREE from 'three';
import type { RangedWeaponPreset, RangedWeaponMeshResult, RangedWeaponMeshCreator } from 'engine/RangedWeaponTypes.js';
import { createWeaponPartMaterial } from 'engine/WeaponPartMaterial.js';
import { createRangedWeaponModel } from 'engine/weapons/RangedWeaponModels.js';

// ════════════════════════════════════════════════════════════════════════════════
// PROJECTILE MESH FACTORIES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * One flat flame sliver, in the XY plane and tapering to a point at -Y, ready to
 * be spun about Z into a blaze. Both the rocket's outer blaze and its brighter
 * inner core are this shape at different widths and lengths.
 */
function createFlameGeometry(halfWidth: number, length: number): THREE.ShapeGeometry {
	const shape = new THREE.Shape();
	shape.moveTo(0, 0);
	shape.lineTo(-halfWidth, 0);
	shape.lineTo(0, -length);
	shape.lineTo(halfWidth, 0);
	shape.lineTo(0, 0);
	return new THREE.ShapeGeometry(shape);
}

/**
 * Add `count` flat vanes around a shaft, evenly spaced about the +Z axis.
 *
 * Shared by every fletched projectile and by the arrows/bolts modelled as part
 * of the bow and crossbow meshes — 3 feathers for an arrow, 2 crossbow-style
 * vanes for a bolt, which is only ever the `count` argument.
 */
function addFletching(
	parent: THREE.Object3D,
	count: number,
	width: number,
	length: number,
	material: THREE.Material,
	y: number,
	z: number
): void {
	for (let i = 0; i < count; i++) {
		const vane = new THREE.Mesh(new THREE.PlaneGeometry(width, length), material);
		vane.rotation.z = (i * Math.PI * 2) / count;
		vane.rotation.y = Math.PI / 2;
		vane.position.set(0, y, z);
		parent.add(vane);
	}
}

/**
 * A single emissive cylinder along +Z — the whole body of the energy
 * projectiles. Emissive intensity well above 1 is what makes bloom pick them up.
 */
function createEnergyBolt(
	color: number,
	radius: number,
	length: number,
	radialSegments: number,
	emissiveIntensity: number
): THREE.Group {
	const group = new THREE.Group();
	// Glow is in units of the voxel full-glow (3.0), so glow = intensity / 3
	// reproduces the pre-class emissiveIntensity exactly — neon's emissive is
	// tinted by the part's own colour, which is what these always were.
	const cylinder = new THREE.Mesh(
		new THREE.CylinderGeometry(radius, radius, length, radialSegments),
		createWeaponPartMaterial('neon', { color, glow: emissiveIntensity / 3 })
	);
	cylinder.rotation.x = Math.PI / 2; // Point along Z
	group.add(cylinder);
	return group;
}

/**
 * Create a rocket mesh with body, nose cone, fins, and fire blaze
 * Rocket points along +Z axis (forward)
 */
export function createRocketMesh(radius: number, color: number): THREE.Group {
	const rocket = new THREE.Group();

	// Materials. Glow values are in units of the voxel full-glow (3.0), so
	// glow = pre-class emissiveIntensity / 3; the flame emissives are authored
	// a different hue than their base colour, which stays a caller postscript
	// (the classes glow in their own colour by default).
	const bodyMaterial = createWeaponPartMaterial('neon', { color, glow: 1.5 / 3 });
	const finMaterial = createWeaponPartMaterial('metal', { color: 0x333333 });
	const fireMaterial = createWeaponPartMaterial('neon', { color: 0xffff00, glow: 5.0 / 3 });
	fireMaterial.emissive.setHex(0xffaa00);
	fireMaterial.transparent = true;
	fireMaterial.opacity = 0.9;

	// Main body (cylinder along Z axis)
	const bodyLength = radius * 4;
	const bodyGeometry = new THREE.CylinderGeometry(radius, radius, bodyLength, 8);
	const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
	body.rotation.x = Math.PI / 2; // Rotate to point along Z
	rocket.add(body);

	// Nose cone (pointing +Z)
	const coneGeometry = new THREE.ConeGeometry(radius, radius * 2, 8);
	const cone = new THREE.Mesh(coneGeometry, bodyMaterial);
	cone.rotation.x = -Math.PI / 2; // Point cone tip forward (+Z)
	cone.position.z = bodyLength / 2 + radius;
	rocket.add(cone);

	// Fins (4 triangular fins at the back, -Z side)
	const finSize = radius * 1.5;
	for (let i = 0; i < 4; i++) {
		const finShape = new THREE.Shape();
		finShape.moveTo(0, 0);
		finShape.lineTo(finSize, 0);
		finShape.lineTo(0, -finSize * 1.5);
		finShape.lineTo(0, 0);

		const finGeometry = new THREE.ShapeGeometry(finShape);
		const fin = new THREE.Mesh(finGeometry, finMaterial);

		// Position at back of rocket
		fin.position.z = -bodyLength / 2;

		// Rotate around Z to place 4 fins evenly
		const angle = (i * Math.PI / 2);
		fin.position.x = Math.cos(angle) * radius * 0.5;
		fin.position.y = Math.sin(angle) * radius * 0.5;
		fin.rotation.z = angle;

		rocket.add(fin);
	}

	// Fire blaze behind (at -Z, pointing backward)
	const blazeLength = radius * 2.5;
	for (let i = 0; i < 6; i++) {
		const blaze = new THREE.Mesh(
			createFlameGeometry(radius * 0.4, blazeLength * (0.8 + Math.random() * 0.4)),
			fireMaterial
		);

		// Position behind rocket
		blaze.position.z = -bodyLength / 2 - radius * 0.2;
		blaze.rotation.z = (i * Math.PI / 3);

		rocket.add(blaze);
	}

	// Inner bright fire core
	const innerFireMaterial = createWeaponPartMaterial('neon', { color: 0xffffff, glow: 8.0 / 3 });
	innerFireMaterial.emissive.setHex(0xffff00);
	innerFireMaterial.transparent = true;
	innerFireMaterial.opacity = 0.8;

	for (let i = 0; i < 3; i++) {
		const innerBlaze = new THREE.Mesh(
			createFlameGeometry(radius * 0.25, blazeLength * 0.5),
			innerFireMaterial
		);

		innerBlaze.position.z = -bodyLength / 2 - radius * 0.1;
		innerBlaze.rotation.z = (i * Math.PI / 1.5);

		rocket.add(innerBlaze);
	}

	return rocket;
}

/**
 * Create an arrow mesh with shaft, arrowhead, and fletching
 * Arrow points along +Z axis (forward)
 */
export function createArrowMesh(radius: number, color: number): THREE.Group {
	const arrow = new THREE.Group();

	// Materials — the same wood/metal/cloth vocabulary the weapon meshes use.
	const shaftMaterial = createWeaponPartMaterial('wood', { color: 0x8b4513 });   // Saddle brown
	const headMaterial = createWeaponPartMaterial('metal', { color });
	const fletchingMaterial = createWeaponPartMaterial('cloth', { color: 0xffffff }); // White feathers

	// Shaft (thin cylinder along Z axis)
	const shaftLength = radius * 12; // Long thin shaft
	const shaftRadius = radius * 0.15; // Much thinner than rocket
	const shaftGeometry = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 8);
	const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
	shaft.rotation.x = Math.PI / 2; // Rotate to point along Z
	arrow.add(shaft);

	// Arrowhead (cone at front)
	const headLength = radius * 2;
	const headRadius = radius * 0.4;
	const headGeometry = new THREE.ConeGeometry(headRadius, headLength, 4);
	const head = new THREE.Mesh(headGeometry, headMaterial);
	head.rotation.x = -Math.PI / 2; // Point forward
	head.position.z = shaftLength / 2 + headLength / 2 - 0.02;
	arrow.add(head);

	// Fletching (3 feather fins at the back)
	const fletchingLength = radius * 2;
	addFletching(arrow, 3, radius * 0.5, fletchingLength, fletchingMaterial,
		0, -shaftLength / 2 + fletchingLength / 2);

	// Nock (back end of arrow)
	const nockGeometry = new THREE.CylinderGeometry(shaftRadius * 1.2, shaftRadius, radius * 0.3, 8);
	const nock = new THREE.Mesh(nockGeometry, shaftMaterial);
	nock.rotation.x = Math.PI / 2;
	nock.position.z = -shaftLength / 2 - radius * 0.15;
	arrow.add(nock);

	return arrow;
}

/**
 * Create a crossbow bolt mesh - shorter and thicker than an arrow
 * Bolt points along +Z axis (forward) - same as arrow mesh
 */
export function createCrossbowBoltMesh(radius: number, color: number): THREE.Group {
	const bolt = new THREE.Group();

	// Materials — the same wood/metal/cloth vocabulary the weapon meshes use.
	const shaftMaterial = createWeaponPartMaterial('wood', { color: 0x5c4033 });   // Dark brown
	const headMaterial = createWeaponPartMaterial('metal', { color });
	const fletchingMaterial = createWeaponPartMaterial('cloth', { color: 0x8b0000 }); // Dark red

	// Shaft (shorter and thicker than arrow)
	const shaftLength = radius * 8; // Shorter than arrow
	const shaftRadius = radius * 0.2; // Thicker than arrow
	const shaftGeometry = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 8);
	const shaft = new THREE.Mesh(shaftGeometry, shaftMaterial);
	shaft.rotation.x = Math.PI / 2; // Rotate to point along Z
	bolt.add(shaft);

	// Bolt head (broader, more angular) - at +Z (front)
	const headLength = radius * 1.5;
	const headRadius = radius * 0.5;
	const headGeometry = new THREE.ConeGeometry(headRadius, headLength, 4);
	const head = new THREE.Mesh(headGeometry, headMaterial);
	head.rotation.x = -Math.PI / 2; // Point forward (+Z)
	head.position.z = shaftLength / 2 + headLength / 2 - 0.02;
	bolt.add(head);

	// Fletching (2 vanes instead of 3 feathers - crossbow style) - at -Z (back)
	const fletchingLength = radius * 1.5;
	addFletching(bolt, 2, radius * 0.4, fletchingLength, fletchingMaterial,
		0, -shaftLength / 2 + fletchingLength / 2);

	// Nock (flat back for crossbow string) - at -Z (back)
	const nockGeometry = new THREE.BoxGeometry(shaftRadius * 3, shaftRadius * 3, radius * 0.2);
	const nock = new THREE.Mesh(nockGeometry, shaftMaterial);
	nock.position.z = -shaftLength / 2 - radius * 0.1;
	bolt.add(nock);

	return bolt;
}

/**
 * Create a laser beam mesh - plain solid red cylinder
 * Beam points along +Z axis (forward) - same as arrow mesh
 */
export function createLaserBeamMesh(radius: number, color: number): THREE.Group {
	return createEnergyBolt(color, radius * 0.6, radius * 14, 12, 5.0);
}

/**
 * Default visual for BALLISTIC bullets: a slim tracer bolt along +Z, the same
 * family as the laser beam but shorter and thinner — bullets read as fast
 * streaks, not orbs. (The default used to be a sphere; the projectile
 * minimum-apparent-size pass then inflated that sphere into a "giant puffy
 * ball" at third-person camera distances. Tracers carry their legibility in
 * LENGTH, which the size floor barely needs to touch.)
 */
export function createTracerMesh(radius: number, color: number): THREE.Group {
	// Shorter and narrower than the laser beam (14r × 0.6r): a bullet is a
	// streak of light, a laser is a bar of it.
	return createEnergyBolt(color, radius * 0.45, radius * 9, 8, 4.0);
}

// ════════════════════════════════════════════════════════════════════════════════
// BUILT-IN WEAPON MESH CREATORS
// ════════════════════════════════════════════════════════════════════════════════

/** Built-in pistol; defaults to block, also used by custom/dual registrations. */
export function createPistol(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createRangedWeaponModel(group, preset, 'pistol', group.userData.weaponVisualStyle === 'lowpoly' ? 'lowpoly' : 'block');
}

/** Built-in shotgun; defaults to block, also used by custom/dual registrations. */
export function createShotgun(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createRangedWeaponModel(group, preset, 'shotgun', group.userData.weaponVisualStyle === 'lowpoly' ? 'lowpoly' : 'block');
}

/** Built-in assault_rifle; defaults to block, also used by custom/dual registrations. */
export function createAssaultRifle(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createRangedWeaponModel(group, preset, 'assault_rifle', group.userData.weaponVisualStyle === 'lowpoly' ? 'lowpoly' : 'block');
}

/** Built-in bazooka; defaults to block, also used by custom/dual registrations. */
export function createBazooka(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createRangedWeaponModel(group, preset, 'bazooka', group.userData.weaponVisualStyle === 'lowpoly' ? 'lowpoly' : 'block');
}

/** Built-in bow; defaults to block, also used by custom/dual registrations. */
export function createBow(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createRangedWeaponModel(group, preset, 'bow', group.userData.weaponVisualStyle === 'lowpoly' ? 'lowpoly' : 'block');
}

/** Built-in crossbow; defaults to block, also used by custom/dual registrations. */
export function createCrossbow(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createRangedWeaponModel(group, preset, 'crossbow', group.userData.weaponVisualStyle === 'lowpoly' ? 'lowpoly' : 'block');
}

/** Built-in laser_blaster; defaults to block, also used by custom/dual registrations. */
export function createLaserBlaster(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createRangedWeaponModel(group, preset, 'laser_blaster', group.userData.weaponVisualStyle === 'lowpoly' ? 'lowpoly' : 'block');
}

/** Built-in laser_pistol; defaults to block, also used by custom/dual registrations. */
export function createLaserPistol(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createRangedWeaponModel(group, preset, 'laser_pistol', group.userData.weaponVisualStyle === 'lowpoly' ? 'lowpoly' : 'block');
}

// ════════════════════════════════════════════════════════════════════════════════
// DUAL WEAPON HELPER - EASY WAY TO CREATE DUAL VERSIONS OF ANY WEAPON
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Creates a dual (akimbo) version of any single weapon.
 * Takes any single weapon creator function and automatically mirrors it.
 *
 * @param group - The parent group to add both weapons to
 * @param preset - The weapon preset (must have dual: true and dualSpacing)
 * @param baseWeaponCreator - The function that creates a single weapon
 * @param weaponName - Optional name for the weapons (default: 'Weapon')
 * @returns RangedWeaponMeshResult with dual weapon setup
 */
export function createDualWeapon(
	group: THREE.Group,
	preset: RangedWeaponPreset,
	baseWeaponCreator: RangedWeaponMeshCreator,
	weaponName: string = 'Weapon'
): RangedWeaponMeshResult {
	const spacing = preset.dualSpacing ?? 0.3;

	// Create RIGHT weapon (positive X)
	const rightWeaponGroup = new THREE.Group();
	rightWeaponGroup.name = `Right${weaponName}`;
	rightWeaponGroup.userData.weaponVisualStyle = group.userData.weaponVisualStyle;
	const rightResult = baseWeaponCreator(rightWeaponGroup, preset);
	rightWeaponGroup.position.x = spacing;
	group.add(rightWeaponGroup);

	// Create LEFT weapon (negative X, MIRRORED)
	const leftWeaponGroup = new THREE.Group();
	leftWeaponGroup.name = `Left${weaponName}`;
	leftWeaponGroup.userData.weaponVisualStyle = group.userData.weaponVisualStyle;
	const leftResult = baseWeaponCreator(leftWeaponGroup, preset);
	leftWeaponGroup.position.x = -spacing;
	leftWeaponGroup.scale.x = -1; // Mirror on X axis
	group.add(leftWeaponGroup);

	// Store references for RangedWeaponSystem
	group.userData.rightWeaponMesh = rightWeaponGroup;
	group.userData.leftWeaponMesh = leftWeaponGroup;
	group.userData.isDual = true;

	// Keep each model's authored handle, including its mirror and translation.
	// Legacy/custom creators may still supply only the preset grip.
	rightWeaponGroup.updateMatrix();
	leftWeaponGroup.updateMatrix();
	const rightGrip = (rightResult.grip ?? preset.gripOffset).clone().applyMatrix4(rightWeaponGroup.matrix);
	const leftGrip = (leftResult.grip ?? preset.gripOffset).clone().applyMatrix4(leftWeaponGroup.matrix);
	group.userData.rightGrip = rightGrip;
	group.userData.leftGrip = leftGrip;

	// Return left grip as foregrip for left hand attachment
	return { foregrip: leftGrip.clone() };
}

// ════════════════════════════════════════════════════════════════════════════════
// BUILT-IN DUAL WEAPON MESH CREATORS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Create dual pistols - one in each hand
 * Uses createDualWeapon helper for simplicity
 */
export function createDualPistols(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createDualWeapon(group, preset, createPistol, 'Pistol');
}

/**
 * Create dual assault rifles - one in each hand
 * Uses createDualWeapon helper for simplicity
 */
export function createDualAssaultRifles(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createDualWeapon(group, preset, createAssaultRifle, 'AssaultRifle');
}

/**
 * Create dual bazookas - one on each shoulder
 * Uses createDualWeapon helper for simplicity
 */
export function createDualBazookas(group: THREE.Group, preset: RangedWeaponPreset): RangedWeaponMeshResult {
	return createDualWeapon(group, preset, createBazooka, 'Bazooka');
}
