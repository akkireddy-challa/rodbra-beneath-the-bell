// Shared utilities for networking components
import * as THREE from 'three';

/**
 * Create a floating name label sprite for networked players/vehicles.
 * Uses a canvas-texture with a rounded pill background and centered text.
 */
export function createNameLabelSprite(name: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    // Rounded pill background
    const pad = 8;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.roundRect(pad, pad, canvas.width - pad * 2, canvas.height - pad * 2, 16);
    ctx.fill();

    // Name text
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(2, 0.5, 1);
    sprite.userData['playerName'] = name;
    return sprite;
}
