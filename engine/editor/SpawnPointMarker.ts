import * as THREE from 'three';
import type { SpawnPoint } from 'types/game.js';

/** Color mapping for known spawn point types */
const TYPE_COLORS: Record<string, number> = {
    player: 0x00cc88,  // Green
    npc: 0x4488ff,     // Blue
    animal: 0xddaa00,  // Yellow
};
const DEFAULT_COLOR = 0x888888; // Gray for unknown types

/**
 * SpawnPointMarker - Visual editor marker showing where an entity spawns.
 *
 * Renders a translucent downward-pointing arrow (cone + shaft) with a text label.
 * Color-coded by type. Visible in editor mode only, hidden during gameplay.
 * Y-rotation encodes the entity's initial facing direction.
 */
export class SpawnPointMarker {
    readonly mesh: THREE.Group;
    readonly id: string;
    readonly type: string;

    constructor(id: string, type: string) {
        this.id = id;
        this.type = type;

        this.mesh = new THREE.Group();
        this.mesh.name = `SpawnPointMarker_${id}`;
        this.mesh.userData.isSpawnPointMarker = true;
        this.mesh.userData.spawnPointId = id;

        const color = TYPE_COLORS[type] ?? DEFAULT_COLOR;
        this.buildArrow(color);
        this.buildLabel(id);
    }

    /**
     * Build the downward-pointing arrow geometry (cone tip + cylinder shaft).
     * A small horizontal cone at the base indicates facing direction.
     */
    private buildArrow(color: number): void {
        const material = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            side: THREE.DoubleSide,
        });

        // Cone (arrow head) — points downward
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 8), material);
        cone.rotation.x = Math.PI;
        cone.position.y = 0.6;
        this.mesh.add(cone);

        // Shaft (thin cylinder)
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.5, 6), material);
        shaft.position.y = 1.95;
        this.mesh.add(shaft);

        // Direction indicator — small cone showing facing direction (+Z local)
        const dirMaterial = new THREE.MeshBasicMaterial({
            color: 0xffcc00,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
        });
        const dirCone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 6), dirMaterial);
        dirCone.rotation.x = -Math.PI / 2;
        dirCone.position.set(0, 0.3, 0.6);
        this.mesh.add(dirCone);
    }

    /**
     * Build a text label sprite above the arrow showing the spawn point id.
     */
    private buildLabel(text: string): void {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = 256;
        canvas.height = 64;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.roundRect(0, 0, canvas.width, canvas.height, 8);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 28px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.scale.set(2, 0.5, 1);
        sprite.position.y = 3.2;
        this.mesh.add(sprite);
    }

    setPosition(x: number, y: number, z: number): void {
        this.mesh.position.set(x, y, z);
    }

    getPosition(): THREE.Vector3 {
        return this.mesh.position.clone();
    }

    setRotationY(radians: number): void {
        this.mesh.rotation.y = radians;
    }

    getRotationY(): number {
        return this.mesh.rotation.y;
    }

    /** Serialize to SpawnPoint data for saving. */
    toSpawnPoint(): SpawnPoint {
        const pos = this.mesh.position;
        return {
            id: this.id,
            type: this.type,
            position: { x: pos.x, y: pos.y, z: pos.z },
            rotationY: this.mesh.rotation.y,
        };
    }

    show(): void {
        this.mesh.visible = true;
    }

    hide(): void {
        this.mesh.visible = false;
    }

    dispose(): void {
        this.mesh.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                if (child.material instanceof THREE.Material) {
                    child.material.dispose();
                }
            }
            if (child instanceof THREE.Sprite) {
                child.material.map?.dispose();
                child.material.dispose();
            }
        });
    }
}
