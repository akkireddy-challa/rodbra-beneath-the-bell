// Numbered pins on the creator's current view — the "set of marks" that lets the
// AI editor get from "the red one on the left" to an id in world.json.
//
// The Creator sends the scene objects it already knows (the @-mention list: id,
// name, position); the engine adds the player and NPCs, projects everything
// through the camera the creator is looking through, keeps the nearest ones in
// frame and draws a small numbered pin at each. The caller gets the legend back
// so the agent reads "3 = Knight (inst_…) at (4, 0, -2)" next to the image.
//
// Pins mark an anchor point (usually an object's base), not a bounding box, so
// they cover as little of what the creator is complaining about as possible.

import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';

export interface PinInput {
    id: string;
    label: string;
    position: { x: number; y: number; z: number };
}

export interface ViewPin {
    /** The number drawn on the image. */
    n: number;
    id: string;
    label: string;
    position: [number, number, number];
    /** Pixel position in the returned image. */
    screen: [number, number];
    /** Metres from the camera. */
    distance: number;
}

export const MAX_VIEW_PINS = 20;

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

/** Validate the pin list from an untrusted postMessage payload. */
export function parsePinInputs(raw: unknown): PinInput[] {
    if (!Array.isArray(raw)) return [];
    const out: PinInput[] = [];
    for (const item of raw.slice(0, 500)) {
        const p = item as Partial<PinInput> | null;
        const pos = p?.position;
        if (!p || typeof p.id !== 'string' || !p.id || !pos) continue;
        if (typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') continue;
        out.push({ id: p.id, label: typeof p.label === 'string' && p.label ? p.label.slice(0, 60) : p.id, position: { x: pos.x, y: pos.y, z: pos.z } });
    }
    return out;
}

/**
 * Project candidates through `camera` into a `width`×`height` image and keep the
 * nearest `max` that are in front of the camera and inside the frame. Pure —
 * exported for tests.
 */
export function projectPins(
    candidates: readonly PinInput[],
    camera: THREE.Camera,
    width: number,
    height: number,
    max: number = MAX_VIEW_PINS,
): ViewPin[] {
    camera.updateMatrixWorld(true);
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const inView: Omit<ViewPin, 'n'>[] = [];
    const v = new THREE.Vector3();
    for (const c of candidates) {
        v.set(c.position.x, c.position.y, c.position.z).project(camera);
        // project() maps points behind a perspective camera to z > 1.
        if (v.z < -1 || v.z > 1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue;
        const world = new THREE.Vector3(c.position.x, c.position.y, c.position.z);
        inView.push({
            id: c.id,
            label: c.label,
            position: [round2(world.x), round2(world.y), round2(world.z)],
            screen: [Math.round(((v.x + 1) / 2) * width), Math.round(((1 - v.y) / 2) * height)],
            distance: round2(world.distanceTo(camPos)),
        });
    }
    inView.sort((a, b) => a.distance - b.distance);
    return inView.slice(0, max).map((pin, i) => ({ n: i + 1, ...pin }));
}

/** The player and every NPC, as pin candidates — the Creator's mention list does not carry them. */
export function engineActorPins(engine: GameEngine): PinInput[] {
    const pins: PinInput[] = [];
    const player = engine.getPlayerController()?.getPlayerObject?.() ?? null;
    if (player) {
        const p = player.getWorldPosition(new THREE.Vector3());
        pins.push({ id: 'player', label: 'Player', position: { x: p.x, y: p.y, z: p.z } });
    }
    const npcs = engine.getNpcRegistry()?.getAllControllers() ?? [];
    npcs.forEach((npc, i) => {
        const p = npc.getPosition();
        const id = npc.getId();
        pins.push({ id: id ?? `npc#${i + 1}`, label: id ? `NPC ${id}` : `NPC #${i + 1} (no id)`, position: { x: p.x, y: p.y, z: p.z } });
    });
    return pins;
}

/** Draw the pins onto the (already composed) current-view canvas. */
export function drawPins(ctx: CanvasRenderingContext2D, pins: readonly ViewPin[]): void {
    ctx.save();
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const pin of pins) {
        const [x, y] = pin.screen;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffd400';
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(pin.n), x, y + 0.5);
    }
    ctx.restore();
}
