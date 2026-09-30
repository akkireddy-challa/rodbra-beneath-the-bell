/**
 * Procedural ski / snowboard equipment, placed in the world and driven every
 * frame by SkiMovement.updateVisuals. World-space placement (not bone
 * attachment) keeps orientation under our control — skis and the board point
 * along the heading the caller passes and tilt with the carve — independent of
 * the Mixamo foot bone whose local axes are not toe-forward (that mismatch
 * stood a hand-attached board on end). It also dodges the hidden animation
 * skeleton: the visible character is rendered as separate block parts, so
 * anything parented under `PlayerController.player` (that skeleton) never shows.
 * This group lives in the scene beside the body, at the feet.
 */

import * as THREE from 'three';
import type { SkiMovementHost } from 'engine/ski/SkiMovementHost.js';
import type { SkiConfig } from 'engine/ski/SkiConfig.js';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';

/** A shadow-casting box — every ski, board and tip slab is one of these. */
function slab(width: number, height: number, depth: number, material: THREE.Material): THREE.Mesh {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
	mesh.castShadow = true;
	return mesh;
}

export class SkiEquipment {
	private config: SkiConfig;
	private group: THREE.Group | null = null;
	private placed = false;

	constructor(config: SkiConfig) {
		this.config = config;
	}

	/** Re-arm placement (the group re-inserts into the scene on the next update). */
	attach(_host: SkiMovementHost): void {
		this.placed = false;
	}

	/**
	 * Drive the equipment for this frame. `feet` is the world feet position;
	 * `orientation` already encodes heading + carve/slope tilt (the board nose,
	 * local +Z, points down the hill). Builds + inserts into the scene on the
	 * first call once the player root has a parent.
	 */
	syncTransform(host: SkiMovementHost, feet: THREE.Vector3, orientation: THREE.Quaternion): void {
		if (!this.config.showEquipment) return;
		if (!this.group) this.group = this.build();
		if (!this.placed) {
			const parent = host.player?.parent;
			if (!parent) return;
			parent.add(this.group);
			this.placed = true;
		}
		// `feet` already includes the snow lift; the board mesh sits a touch below
		// the group origin so it rides just under the boots.
		this.group.position.copy(feet);
		this.group.quaternion.copy(orientation);
	}

	/** Remove and dispose all meshes. */
	detach(_host: SkiMovementHost): void {
		if (this.group) {
			this.group.parent?.remove(this.group);
			this.disposeObject(this.group);
			this.group = null;
		}
		this.placed = false;
	}

	private build(): THREE.Group {
		const root = new THREE.Group();
		root.name = 'ski-equipment';
		if (this.config.equipmentStyle === 'snowboard') {
			const board = this.buildSnowboard();
			board.position.set(0, -0.04, 0);
			root.add(board);
		} else {
			const half = 0.11;
			for (const side of [-1, 1]) {
				const ski = this.buildSki();
				ski.position.set(side * half, -0.04, 0);
				root.add(ski);
			}
			if (this.config.showPoles) {
				for (const side of [-1, 1]) {
					const pole = this.buildPole();
					pole.position.set(side * 0.34, 1.0, -0.05);
					pole.rotation.set(0.2, 0, side * 0.08);
					root.add(pole);
				}
			}
		}
		return root;
	}

	private disposeObject(obj: THREE.Object3D): void {
		// One material is shared by every mesh of a ski/board/pole, so dedupe
		// before disposing.
		const seenMaterials = new Set<THREE.Material>();
		obj.traverse((child) => {
			if (!(child instanceof THREE.Mesh)) return;
			child.geometry.dispose();
			const material = child.material;
			if (material instanceof THREE.Material && !seenMaterials.has(material)) {
				seenMaterials.add(material);
				material.dispose();
			}
		});
	}

	private buildSki(): THREE.Object3D {
		const group = new THREE.Group();
		group.name = 'ski';
		// 'plastic' — the glossy ski topsheet the old .4/.1 hand-tune meant.
		const mat = createClassedPartMaterial('plastic', { color: this.config.skiColor });
		const len = this.config.skiLength;
		const wid = this.config.skiWidth;
		// Body: thin slab along +Z (flat, long axis forward).
		group.add(slab(wid, 0.035, len * 0.88, mat));
		// Tip: short angled slab rising at the nose.
		const tip = slab(wid, 0.03, len * 0.16, mat);
		tip.position.set(0, 0.035, len * 0.5);
		tip.rotation.x = -0.45;
		group.add(tip);
		return group;
	}

	private buildSnowboard(): THREE.Object3D {
		const group = new THREE.Group();
		group.name = 'snowboard';
		const mat = createClassedPartMaterial('plastic', { color: this.config.skiColor });
		const length = 1.5; // nose-to-tail, along +Z (down the hill)
		const width = 0.30;
		group.add(slab(width, 0.04, length * 0.82, mat));
		// Upturned nose and tail.
		for (const sign of [-1, 1]) {
			const tip = slab(width, 0.035, length * 0.12, mat);
			tip.position.set(0, 0.03, sign * length * 0.47);
			tip.rotation.x = sign * -0.5;
			group.add(tip);
		}
		return group;
	}

	private buildPole(): THREE.Object3D {
		const group = new THREE.Group();
		group.name = 'ski-pole';
		// 'metal' — aluminium poles, what the old .35 metalness was reaching for.
		const mat = createClassedPartMaterial('metal', { color: this.config.poleColor });
		const len = this.config.poleLength;
		const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, len, 6), mat);
		shaft.position.y = -len / 2;
		shaft.castShadow = true;
		group.add(shaft);
		const basket = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 12), mat);
		basket.rotation.x = Math.PI / 2;
		basket.position.y = -len + 0.08;
		group.add(basket);
		return group;
	}
}
