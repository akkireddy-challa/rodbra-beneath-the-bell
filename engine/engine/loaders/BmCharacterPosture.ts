import * as THREE from 'three';

/**
 * bmCharacter posture — forged characters (character-forger GLBs) carry a
 * signature posture in their scene extras: additive per-part rotation
 * offsets (a miser's hunch, a goblin's head-jut) applied on top of every
 * clip via the animation controller's manual bone offsets. The bind pose is
 * never touched, so this composes with all animation.
 *
 * Absent/malformed extras are a silent no-op — every non-forged character
 * GLB simply has none.
 */

interface PosturePart {
    part: string;
    pitchDeg?: number;
    rollDeg?: number;
}

const MAX_OFFSET_DEG = 45;

/** Read scene extras posture and apply it. Returns true when applied. */
export function applyBmCharacterPosture(
    sceneRoot: THREE.Object3D,
    controller: { setManualBoneOffsets?(offsets: Map<string, THREE.Quaternion> | null): void },
): boolean {
    if (!controller.setManualBoneOffsets) return false;
    const bm = (sceneRoot.userData as Record<string, unknown>).bmCharacter;
    if (!bm || typeof bm !== 'object') return false;
    const posture = (bm as Record<string, unknown>).posture;
    if (!Array.isArray(posture) || posture.length === 0) return false;

    const clampDeg = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v)
            ? THREE.MathUtils.clamp(v, -MAX_OFFSET_DEG, MAX_OFFSET_DEG)
            : 0;

    const offsets = new Map<string, THREE.Quaternion>();
    for (const raw of posture as PosturePart[]) {
        if (!raw || typeof raw.part !== 'string') continue;
        const pitch = THREE.MathUtils.degToRad(clampDeg(raw.pitchDeg));
        const roll = THREE.MathUtils.degToRad(clampDeg(raw.rollDeg));
        if (pitch === 0 && roll === 0) continue;
        offsets.set(raw.part, new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, 0, roll, 'XYZ')));
    }
    if (offsets.size === 0) return false;
    controller.setManualBoneOffsets(offsets);
    return true;
}
