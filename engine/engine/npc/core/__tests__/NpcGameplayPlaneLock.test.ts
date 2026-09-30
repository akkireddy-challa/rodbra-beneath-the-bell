import { NpcController } from 'engine/npc/core/NpcController.js';
import { resolveGameplayPlaneZ } from 'engine/GameplayPlane.js';
import type { GameData } from 'types/game.js';

/**
 * Side-on 2D games play on one locked X/Y plane; the engine's NPC stack
 * (behaviors, A*, crowd separation, avoidance) is 3D and drifts NPCs off it a
 * little every frame. The first real side-on game shipped with enemies visibly
 * beside the plane — unreachable by a player who cannot leave it — and its
 * coding pass had to hand-roll a dead-banded teleport that still let them hover
 * 0.6 m off. The engine now owns the constraint: `resolveGameplayPlaneZ` picks
 * the plane once per load, and `NpcController.update()` snaps position back
 * onto it before any of the frame's reads.
 */
describe('resolveGameplayPlaneZ — which games get a locked plane', () => {
    const game = (over: Partial<GameData>): GameData => over as GameData;

    it('locks side-on 2D games to z = 0', () => {
        expect(resolveGameplayPlaneZ(game({ gameDimension: '2d' }))).toBe(0);
        expect(resolveGameplayPlaneZ(game({
            gameDimension: '2d',
            worldProfileData: { cameraMode: 'third-person' } as GameData['worldProfileData'],
        }))).toBe(0);
    });

    it('never locks a top-down 2D game — there Z is a real gameplay axis', () => {
        expect(resolveGameplayPlaneZ(game({
            gameDimension: '2d',
            worldProfileData: { cameraMode: 'top-down' } as GameData['worldProfileData'],
        }))).toBeNull();
    });

    it('never locks 3D games, declared or by absence', () => {
        expect(resolveGameplayPlaneZ(game({ gameDimension: '3d' }))).toBeNull();
        expect(resolveGameplayPlaneZ(game({}))).toBeNull();
    });
});

describe('NpcController gameplay-plane lock', () => {
    interface Vec3Like { x: number; y: number; z: number }

    /**
     * Bare instance without the heavy constructor — the pattern the freed-body
     * guard test established. Stubs exactly what the lock touches.
     */
    function makeController(options: { planeZ: number | null; bodyValid?: boolean }): {
        controller: NpcController;
        position: Vec3Like;
        bodyWrites: Vec3Like[];
    } {
        const controller = Object.create(NpcController.prototype) as NpcController;
        const position: Vec3Like = { x: 4, y: 2, z: 0.55 };
        const bodyWrites: Vec3Like[] = [];
        const raw = controller as unknown as Record<string, unknown>;
        raw.planeLockEnabled = true;
        raw.engine = { getGameplayPlaneZ: () => options.planeZ };
        raw.character = { position };
        raw.characterBody = {
            isValid: () => options.bodyValid ?? true,
            translation: () => ({ x: position.x, y: position.y, z: position.z }),
            setTranslation: (t: Vec3Like) => { bodyWrites.push({ ...t }); },
        };
        return { controller, position, bodyWrites };
    }

    const applyLock = (controller: NpcController): void => {
        (controller as unknown as { applyGameplayPlaneLock: () => void }).applyGameplayPlaneLock();
    };

    it('snaps an off-plane NPC back onto the plane — visual and physics body together', () => {
        const { controller, position, bodyWrites } = makeController({ planeZ: 0 });

        applyLock(controller);

        expect(position.z).toBe(0);
        expect(bodyWrites).toEqual([{ x: 4, y: 2, z: 0 }]);
    });

    it('is a no-op when the game has no locked plane', () => {
        const { controller, position, bodyWrites } = makeController({ planeZ: null });

        applyLock(controller);

        expect(position.z).toBe(0.55);
        expect(bodyWrites).toEqual([]);
    });

    it('is a no-op when the NPC opted out as a backdrop actor', () => {
        const { controller, position, bodyWrites } = makeController({ planeZ: 0 });
        controller.setPlaneLockEnabled(false);

        applyLock(controller);

        expect(position.z).toBe(0.55);
        expect(bodyWrites).toEqual([]);
    });

    it('does not churn the physics body when already on the plane', () => {
        const { controller, position, bodyWrites } = makeController({ planeZ: 0 });
        position.z = 0;

        applyLock(controller);

        expect(bodyWrites).toEqual([]);
    });

    it('survives an engine without the plane API (older fakes, embedders)', () => {
        const { controller, position } = makeController({ planeZ: 0 });
        (controller as unknown as { engine: object }).engine = {};

        applyLock(controller);

        expect(position.z).toBe(0.55);
    });

    it('update() applies the lock before this frame\'s reads — behaviors see an on-plane position', () => {
        // The lock sits directly after the freed-body guard, ahead of everything
        // that reads position. Prove the ordering with a sentinel: the next
        // statement in update() reads engine.gameStateManager, so a throwing
        // getter marks the boundary — the snap must already have happened.
        const { controller, position } = makeController({ planeZ: 0 });
        const raw = controller as unknown as Record<string, unknown>;
        raw.explosionComp = { hasExplodedBlocks: () => false };
        raw.ragdollComp = { hasRagdoll: () => false };
        const sentinel = new Error('stop-after-lock');
        Object.defineProperty(raw.engine, 'gameStateManager', { get: () => { throw sentinel; } });

        expect(() => controller.update(0.016)).toThrow(sentinel);
        expect(position.z).toBe(0);
    });

    it('projects navigation targets onto the plane, so a wander goal is actually reachable', () => {
        const { controller } = makeController({ planeZ: 0 });
        const received: Array<{ z: number } | null> = [];
        (controller as unknown as Record<string, unknown>).navigationComp = {
            setTargetPosition: (t: { z: number } | null) => { received.push(t); },
        };

        controller.setTargetPosition({ x: 10, y: 1, z: 3.2 } as never);
        expect(received[0]!.z).toBe(0);
    });

    it('leaves navigation targets alone when no plane is locked', () => {
        const { controller } = makeController({ planeZ: null });
        const received: Array<{ z: number } | null> = [];
        (controller as unknown as Record<string, unknown>).navigationComp = {
            setTargetPosition: (t: { z: number } | null) => { received.push(t); },
        };

        controller.setTargetPosition({ x: 10, y: 1, z: 3.2 } as never);
        expect(received[0]!.z).toBe(3.2);
    });
});
