import { NpcController } from 'engine/npc/core/NpcController.js';

/**
 * Regression: an NPC's characterBody is set to null on death/dispose (see the casts
 * in NpcController around the removeRigidBody calls), but NpcRegistry.updateAll can
 * still invoke update() for that NPC on later frames. Before the guard, update()
 * passed the null body straight into movementSystem.update(), whose first line does
 * playerBody.numColliders() — throwing "Cannot read properties of null (reading
 * 'numColliders')" every frame. update() must bail out early instead of throwing.
 */
describe('NpcController.update — freed body guard', () => {
    // Build a bare instance without running the (heavy, dependency-laden) constructor.
    // The death-visual syncs run BEFORE the guard — deliberately, because a corpse is
    // exactly the state where characterBody is null and its limb meshes still need a
    // per-frame sync — so stub those two components as "nothing to sync". The guard is
    // the next statement, and returns before touching any other field.
    function makeController(): NpcController {
        const controller = Object.create(NpcController.prototype) as NpcController;
        const deathVisuals = controller as unknown as {
            explosionComp: { hasExplodedBlocks: () => boolean };
            ragdollComp: { hasRagdoll: () => boolean };
        };
        deathVisuals.explosionComp = { hasExplodedBlocks: () => false };
        deathVisuals.ragdollComp = { hasRagdoll: () => false };
        return controller;
    }

    it('does not throw when characterBody has been nulled (dead/disposed NPC)', () => {
        const controller = makeController();
        (controller as unknown as { characterBody: null }).characterBody = null;

        expect(() => controller.update(0.016)).not.toThrow();
    });

    it('does not throw when characterBody has been freed (isValid() === false)', () => {
        const controller = makeController();
        (controller as unknown as { characterBody: { isValid: () => boolean } }).characterBody = {
            isValid: () => false,
        };

        expect(() => controller.update(0.016)).not.toThrow();
    });
});
