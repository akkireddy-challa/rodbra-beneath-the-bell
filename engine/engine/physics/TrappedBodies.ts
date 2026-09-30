/**
 * Which body already inside a character's capsule may be ignored by its
 * collide-and-slide this frame — and for which move.
 *
 * The motor treats other characters as solid, but they are not blocked by it,
 * so one can end up penetrating the capsule. Rapier's controller then refuses
 * any move that goes DEEPER into that body, and a body that came in from an
 * awkward angle can leave no allowed direction at all. The rule here (Jani,
 * 2026-09-05): ignore a penetrating body only for a move AWAY from it. Moving
 * into it stays blocked, so enemies stay solid — you can never walk through
 * one — but you can always step out of one that is inside you.
 *
 * Pure: takes positions, returns a verdict. The motor supplies the ray.
 */

/**
 * True when `move` (horizontal, world) does not carry the character toward the
 * body at `other`: away from it or tangent to it. A body exactly at the
 * capsule's centre has no direction to be "toward", and is ignored.
 */
export function movesAwayFrom(
    move: { x: number; z: number },
    self: { x: number; z: number },
    other: { x: number; z: number },
): boolean {
    const dx = other.x - self.x;
    const dz = other.z - self.z;
    if (dx * dx + dz * dz < 1e-8) return true;
    return move.x * dx + move.z * dz <= 0;
}
