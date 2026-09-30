import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';

let highlightGroup: THREE.Group | null = null;

export function findObjectAtPosition(
    gameEngine: GameEngine,
    position: { x: number; y: number; z: number },
    searchRadius: number = 2
): THREE.Object3D | null {
    if (!gameEngine.scene) return null;

    const targetPos = new THREE.Vector3(position.x, position.y, position.z);
    let closestObject: THREE.Object3D | null = null;
    let closestDistance = searchRadius;

    gameEngine.scene.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        if (child.name.startsWith('__highlight')) return;
        if (child.type === 'GridHelper' || child.type === 'AxesHelper') return;

        const dist = child.position.distanceTo(targetPos);
        if (dist < closestDistance) {
            closestDistance = dist;
            closestObject = child;
        }
    });

    return closestObject;
}

export function createHighlightBox(
    gameEngine: GameEngine,
    position: { x: number; y: number; z: number },
    objectType?: string
): void {
    clearObjectHighlight(gameEngine);

    if (!gameEngine.scene) return;

    let box: THREE.Box3;

    if (objectType === 'marker') {
        const size = 1.0;
        box = new THREE.Box3(
            new THREE.Vector3(position.x - size / 2, position.y - size / 2, position.z - size / 2),
            new THREE.Vector3(position.x + size / 2, position.y + size / 2, position.z + size / 2)
        );
    } else {
        const object = findObjectAtPosition(gameEngine, position);

        if (object) {
            box = new THREE.Box3().setFromObject(object);
        } else {
            box = new THREE.Box3(
                new THREE.Vector3(position.x - 1.5, position.y, position.z - 1.5),
                new THREE.Vector3(position.x + 1.5, position.y + 4, position.z + 1.5)
            );
        }
    }

    box.expandByScalar(0.15);

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    highlightGroup = new THREE.Group();
    highlightGroup.name = '__highlight_group__';

    // Semi-transparent glowing fill
    const fillGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const fillMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    const fillMesh = new THREE.Mesh(fillGeometry, fillMaterial);
    fillMesh.position.copy(center);
    fillMesh.name = '__highlight_fill__';
    highlightGroup.add(fillMesh);

    // Bright wireframe edges
    const edgesGeometry = new THREE.EdgesGeometry(fillGeometry);
    const edgesMaterial = new THREE.LineBasicMaterial({
        color: 0x00ffff,
        linewidth: 2
    });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    edges.position.copy(center);
    edges.name = '__highlight_edges__';
    highlightGroup.add(edges);

    // Outer glow box
    const glowGeometry = new THREE.BoxGeometry(size.x + 0.3, size.y + 0.3, size.z + 0.3);
    const glowMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: 0.08,
        side: THREE.BackSide,
        depthWrite: false
    });
    const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    glowMesh.position.copy(center);
    glowMesh.name = '__highlight_glow__';
    highlightGroup.add(glowMesh);

    gameEngine.scene.add(highlightGroup);
}

export function clearObjectHighlight(gameEngine: GameEngine): void {
    if (!highlightGroup) return;

    if (gameEngine.scene) {
        gameEngine.scene.remove(highlightGroup);
    }

    highlightGroup.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        if (mesh.material) {
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            materials.forEach(m => m.dispose());
        }
    });

    highlightGroup = null;
}
