import * as THREE from 'three';
import { classedPartStandardMaterial } from 'engine/npc/customization/blockPartCaches.js';

/**
 * Default block NPC character — a clean BoxGeometry humanoid (recoloured blue, with horns
 * and eyes). This is the engine-wide fallback used for any NPC registered without a
 * `characterFactory` / `characterAssetId`.
 *
 * Built from the SAME gap-free box spec as the player mascot (`BitmagicPlayerCharacter`):
 * slim, centred boxes whose proportions match the default `BaseCharacter.glb` skeleton's
 * bone lengths, so adjacent parts meet with no gaps. (The previous version used chunkier,
 * untuned boxes and a taller 1.84m height, which left visible gaps between blocks and made
 * NPCs look oversized next to the 1.3m player.) Because the engine scales the whole
 * character uniformly to the returned height, the box↔bone fit is preserved at any size.
 *
 * Usage:
 * ```typescript
 * import { BlockCharacterBuilder } from 'engine/BlockCharacterBuilder.js';
 * import { createExampleEnemyCharacter } from 'engine/ExampleEnemyCharacter.js';
 *
 * const builder = new BlockCharacterBuilder(characterModel);
 * const enemyInstance = builder.buildInstance(createExampleEnemyCharacter);
 * scene.add(enemyInstance.root);
 * ```
 *
 * @returns Character dimensions (width, height, depth)
 */

// Matches the bitmagic mascot's target height so default NPCs are the same scale as the player.
const ENEMY_HEIGHT = 1.3; // metres

const BLUE = 0x4169E1;     // royal blue — main body
const PURPLE = 0x9370DB;   // medium purple — horns / accents

function bodyMaterial(color: number): THREE.MeshStandardMaterial {
    // Tagged 'plastic': the block-character conversion turns this into the
    // glossy toy-monster material at the resolved quality (Lambert on low) —
    // the look the old hand-tuned roughness 0.3 was reaching for.
    return classedPartStandardMaterial('plastic', { color });
}

/** Add a box to a named body-part group at a local offset; returns the mesh (or null if the group is missing). */
function addPart(
    characterGroup: THREE.Group,
    partName: string,
    w: number, h: number, d: number,
    color: number,
    position: [number, number, number],
): THREE.Mesh | null {
    const group = characterGroup.getObjectByName(partName) as THREE.Group | null;
    if (!group) return null;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMaterial(color));
    mesh.position.set(position[0], position[1], position[2]);
    group.add(mesh);
    return mesh;
}

export function createExampleEnemyCharacter(characterGroup: THREE.Group): { width: number; height: number; depth: number } {
    // Head — same box + bone offset as the mascot (bone at 1/5 from the bottom of the head).
    const headHeight = 0.4;
    const head = addPart(characterGroup, 'head', 0.45, headHeight, 0.35, BLUE, [0, 3 * headHeight / 5, 0]);
    if (head) {
        // Two purple horns on top.
        [-0.13, 0.13].forEach((x) => {
            const horn = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.06), bodyMaterial(PURPLE));
            horn.position.set(x, 0.27, 0);
            head.add(horn);
        });
        // Two eyes on the front facet (high +Z), white with a black pupil.
        const eyeWhite = new THREE.Mesh(
            new THREE.BoxGeometry(0.12, 0.15, 0.03),
            classedPartStandardMaterial('plastic', { color: 0xFFFFFF }),
        );
        eyeWhite.position.set(-0.1, 0.04, 0.17);
        const pupil = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 0.08, 0.02),
            classedPartStandardMaterial('gem', { color: 0x000000 }),
        );
        pupil.position.set(0, 0, 0.01);
        eyeWhite.add(pupil);
        head.add(eyeWhite);
        const rightEye = eyeWhite.clone();
        rightEye.position.x = 0.1;
        head.add(rightEye);
    }

    // Neck.
    addPart(characterGroup, 'neck', 0.15, 0.08, 0.12, BLUE, [0, 0.04, 0]);

    // Torso (rotation.y = π so its front facet faces +Z, matching the mascot) + purple spots.
    const torso = addPart(characterGroup, 'torso', 0.4, 0.5, 0.25, BLUE, [0, -0.1, 0]);
    if (torso) {
        torso.rotation.y = Math.PI;
        [
            { x: -0.12, y: 0.15, z: 0.13 },
            { x: 0.12, y: 0.05, z: 0.13 },
            { x: 0, y: -0.08, z: 0.13 },
        ].forEach((p) => {
            const spot = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.02), bodyMaterial(PURPLE));
            spot.position.set(p.x, p.y, p.z);
            torso.add(spot);
        });
    }

    // Arms (blue) + hands (blue).
    addPart(characterGroup, 'leftUpperArm', 0.12, 0.22, 0.12, BLUE, [0, 0, 0]);
    addPart(characterGroup, 'leftForearm', 0.11, 0.18, 0.11, BLUE, [0, 0, 0]);
    addPart(characterGroup, 'leftHand', 0.15, 0.12, 0.1, BLUE, [0, 0.06, 0]);
    addPart(characterGroup, 'rightUpperArm', 0.12, 0.22, 0.12, BLUE, [0, 0, 0]);
    addPart(characterGroup, 'rightForearm', 0.11, 0.18, 0.11, BLUE, [0, 0, 0]);
    addPart(characterGroup, 'rightHand', 0.15, 0.12, 0.1, BLUE, [0, 0.06, 0]);

    // Legs.
    addPart(characterGroup, 'leftThigh', 0.18, 0.3, 0.16, BLUE, [0, 0, 0]);
    addPart(characterGroup, 'leftShin', 0.16, 0.35, 0.14, BLUE, [0, 0.02, 0]);
    addPart(characterGroup, 'rightThigh', 0.18, 0.3, 0.16, BLUE, [0, 0, 0]);
    addPart(characterGroup, 'rightShin', 0.16, 0.35, 0.14, BLUE, [0, 0.02, 0]);

    // Feet — NEGATIVE Y so the foot extends forward from the ankle (same as the mascot).
    const lf = addPart(characterGroup, 'leftFoot', 0.2, 0.12, 0.35, BLUE, [0, -0.08, 0]);
    if (lf) lf.rotation.x = -Math.PI / 2;
    const rf = addPart(characterGroup, 'rightFoot', 0.2, 0.12, 0.35, BLUE, [0, -0.08, 0]);
    if (rf) rf.rotation.x = -Math.PI / 2;

    // Shadows.
    characterGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });

    // Dimensions for the physics capsule + height scaling. ⚠️ HIGHRES-SENSITIVE:
    // for a SKINNED (Asset-Forger GLB) NPC with no custom factory, THIS factory is the
    // hidden block proxy, and NpcController re-derives the hit capsule as
    // `radius * targetHeight / dimensions.height` — i.e. it depends on the width:height
    // RATIO, not the absolute values. To keep that tuned highres melee/shot capsule
    // unchanged while still rendering block NPCs at the smaller, player-matched 1.3m, we
    // return the ORIGINAL tuned dims { 0.5, 1.84, 0.35 } scaled UNIFORMLY to ENEMY_HEIGHT
    // (every ratio preserved → proxy capsule height is exact and radius within ~3%).
    // Do NOT swap these for the mascot's wider 0.6×/0.3× ratios — that fattens the
    // highres hit capsule ~26%.
    const ORIGINAL_HEIGHT = 1.84; // the pre-1.3 tuned ExampleEnemy height
    const s = ENEMY_HEIGHT / ORIGINAL_HEIGHT;
    return {
        width: 0.5 * s,
        height: ENEMY_HEIGHT,
        depth: 0.35 * s,
    };
}
