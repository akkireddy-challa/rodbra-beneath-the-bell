import * as THREE from 'three';
import type { GameData, ForgedLevelFeature } from 'types/game.js';
import { findForgedFeature, findForgedMarker, type ForgedMarker } from 'engine/ForgedLevelData.js';

/**
 * Where a ship stands in the world, and which way its geometry points.
 *
 * Everything in `engine/sailing/` is measured from this: the wake is laid along
 * the keel line, the voyage turns the world about the centre, and the render
 * region is drawn round the hull. A forged vessel carries all of it (the
 * `vesselDeck` feature plus the `Bow` / `Stern` / `DeckCentre` markers); a ship
 * built any other way gives its bow and stern by hand.
 */
export interface VesselFrame {
    /** Midway along the keel line in world XZ, at deck height. */
    centre: THREE.Vector3;
    /** World position of the stem. */
    bow: THREE.Vector3;
    /** World position of the stern. */
    stern: THREE.Vector3;
    /**
     * The course the GEOMETRY points along, in radians, in the gameplay
     * convention: forward is (sin h, 0, cos h). See `agent-docs/coordinate-system.md`.
     */
    heading: number;
    /** Stem to stern, horizontal, in metres. */
    length: number;
    /** Widest breadth of the hull, in metres. */
    beam: number;
    /** World Y of the walkable deck. */
    deckY: number;
}

/**
 * A frame from a bow and a stern given by hand — a ship built from placed
 * props, say, rather than forged. `deckY` is where people stand.
 */
export function vesselFrameFromBowStern(
    bow: THREE.Vector3,
    stern: THREE.Vector3,
    beam: number,
    deckY: number,
): VesselFrame {
    const dx = bow.x - stern.x;
    const dz = bow.z - stern.z;
    return {
        centre: new THREE.Vector3((bow.x + stern.x) / 2, deckY, (bow.z + stern.z) / 2),
        bow: bow.clone(),
        stern: stern.clone(),
        heading: Math.atan2(dx, dz),
        length: Math.hypot(dx, dz),
        beam,
        deckY,
    };
}

/**
 * The frame of a forged vessel level, or `null` when the level is not one (or
 * this forge left out what the frame needs). Never throws — a level without a
 * ship is a normal outcome to degrade through, not a load failure.
 *
 * The world-space `Bow` / `Stern` markers are preferred. Without them the
 * `vesselDeck` params still carry the bow and stern as offsets from the deck
 * centre, which is the `DeckCentre` marker or, failing that, the middle of the
 * deck outline.
 */
export function forgedVesselFrame(gameData: GameData | null | undefined): VesselFrame | null {
    const deck = findForgedFeature(gameData, { kind: 'vesselDeck' });
    if (!deck) return null;

    const params = deck.params ?? {};
    const centreMarker = findForgedMarker(gameData, 'DeckCentre');
    const deckY = deck.points?.[0]?.y ?? centreMarker?.y ?? null;
    if (deckY === null) return null;

    let bow = toVector(findForgedMarker(gameData, 'Bow'));
    let stern = toVector(findForgedMarker(gameData, 'Stern'));
    if (!bow || !stern) {
        const centre = toVector(centreMarker) ?? deckCentroid(deck);
        const bowOffset = toVector(pointParam(params.bow));
        const sternOffset = toVector(pointParam(params.stern));
        if (!centre || !bowOffset || !sternOffset) return null;
        bow = centre.clone().add(bowOffset);
        stern = centre.clone().add(sternOffset);
    }

    const beam = numberParam(params.beam) ?? deckWidth(deck, bow, stern);
    return vesselFrameFromBowStern(bow, stern, beam, deckY);
}

function toVector(point: { x: number; y: number; z: number } | null): THREE.Vector3 | null {
    return point ? new THREE.Vector3(point.x, point.y, point.z) : null;
}

function numberParam(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pointParam(value: unknown): ForgedMarker | null {
    if (typeof value !== 'object' || value === null) return null;
    const { x, y, z } = value as Record<string, unknown>;
    const nx = numberParam(x);
    const ny = numberParam(y);
    const nz = numberParam(z);
    return nx !== null && ny !== null && nz !== null ? { x: nx, y: ny, z: nz } : null;
}

/** Middle of the deck outline's bounding box — the deck centre when no marker says so. */
function deckCentroid(deck: ForgedLevelFeature): THREE.Vector3 | null {
    const points = deck.points ?? [];
    if (points.length === 0) return null;
    const box = new THREE.Box3();
    for (const p of points) box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
    return box.getCenter(new THREE.Vector3());
}

/**
 * Breadth of the deck outline across the keel line, for a forge that did not
 * write `beam`. The deck is a little narrower than the hull, which is the safe
 * side for anything that must clear it.
 */
function deckWidth(deck: ForgedLevelFeature, bow: THREE.Vector3, stern: THREE.Vector3): number {
    const axis = new THREE.Vector2(bow.x - stern.x, bow.z - stern.z).normalize();
    let min = 0;
    let max = 0;
    for (const p of deck.points ?? []) {
        // Signed distance across the keel line (positive to starboard).
        const across = (p.x - stern.x) * axis.y - (p.z - stern.z) * axis.x;
        min = Math.min(min, across);
        max = Math.max(max, across);
    }
    return max - min;
}
