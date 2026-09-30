/**
 * Changing a block character's clothes at runtime (character-outfits.md): the
 * player picks up armour, an NPC changes uniform. One factory per look; the
 * engine swaps the meshes inside the same bone-bound body-part groups, so the
 * character keeps animating and keeps whatever it is holding.
 *
 * Referenced from agent docs (read-docs name: `samples/change-character-outfit`).
 * Compiled against the live engine by game's `pnpm run check`.
 */
import * as THREE from 'three';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { BaseNpcManagerBehavior, NpcIdleBehavior } from 'engine/npc/index.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';

/** One look. Same shape as the factory the character was first built with. */
function createOutfit(colors: { shirt: number; pants: number; skin: number }): IBlockCharacterFactory {
    const box = (w: number, h: number, d: number, color: number): THREE.Mesh =>
        new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));

    return {
        createBlockCharacter(characterGroup: THREE.Group): void {
            // POPULATE the provided group — never build and return your own.
            const part = (name: string): THREE.Group => characterGroup.getObjectByName(name) as THREE.Group;

            part('head').add(box(0.24, 0.24, 0.24, colors.skin));
            part('torso').add(box(0.34, 0.44, 0.2, colors.shirt));
            for (const arm of ['leftUpperArm', 'rightUpperArm', 'leftForearm', 'rightForearm']) {
                part(arm).add(box(0.12, 0.22, 0.12, colors.shirt));
            }
            for (const hand of ['leftHand', 'rightHand']) {
                part(hand).add(box(0.11, 0.11, 0.11, colors.skin));
            }
            for (const leg of ['leftThigh', 'rightThigh', 'leftShin', 'rightShin']) {
                part(leg).add(box(0.14, 0.24, 0.14, colors.pants));
            }
            for (const foot of ['leftFoot', 'rightFoot']) {
                // Feet extend FORWARD from the ankle — negative Y.
                const mesh = box(0.14, 0.1, 0.22, colors.pants);
                mesh.position.set(0, -0.1, 0);
                part(foot).add(mesh);
            }
        },
        getCharacterDimensions: () => ({ width: 0.4, height: 1.7, depth: 0.3 }),
    };
}

const PEASANT = createOutfit({ shirt: 0x8c4a3b, pants: 0x2e3440, skin: 0xe0ac69 });
const KNIGHT = createOutfit({ shirt: 0xb0b6bd, pants: 0x4a4f57, skin: 0xe0ac69 });

/**
 * One-shot change of clothes. Build the factory once (at load), call this
 * whenever the look should change — the player keeps walking mid-stride, and a
 * weapon already in the hand stays in the hand.
 */
export function wearArmour(engine: EngineLike): boolean {
    const playerLoader = engine.getPlayerLoader?.();
    if (!playerLoader) return false;
    return playerLoader.redressBlockCharacter(KNIGHT);
}

/**
 * Swapping back and forth between a few known looks: pre-build them once by
 * index, then activate. Index 0 is always the character the game started with,
 * so you never have to keep a factory around to undress back to it.
 */
export function setupOutfitWardrobe(engine: EngineLike): void {
    const playerLoader = engine.getPlayerLoader?.();
    if (!playerLoader) return;

    playerLoader.loadBlockCharacterVariant(1, PEASANT);
    playerLoader.loadBlockCharacterVariant(2, KNIGHT);
}

/** Activate a pre-built look (from a shop, a pickup, a menu selection). */
export function equipOutfit(engine: EngineLike, variantIndex: number): boolean {
    const playerLoader = engine.getPlayerLoader?.();
    if (!playerLoader) return false;
    if (!playerLoader.hasBlockCharacterVariant(variantIndex)) return false;
    return playerLoader.setActiveBlockCharacterVariant(variantIndex);
}

/**
 * The same call on an NPC. Controllers come from your manager — `onNpcCreated`
 * (fires for the initial spawn AND every respawn) or `getAllNpcs()`.
 */
export class GuardManagerBehavior extends BaseNpcManagerBehavior {
    constructor(private readonly onDuty: boolean) {
        super('Guard', false, 0, new NpcIdleBehavior());
    }

    onNpcCreated(npc: NpcController, _engine: EngineLike): void {
        npc.redressBlockCharacter(this.onDuty ? KNIGHT : PEASANT);
    }
}

/** Change the whole population's uniform at once (shift change, alarm raised). */
export function setPopulationUniform(guards: NpcController[], onDuty: boolean): void {
    for (const guard of guards) {
        guard.redressBlockCharacter(onDuty ? KNIGHT : PEASANT);
    }
}
