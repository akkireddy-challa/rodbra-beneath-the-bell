/** @jest-environment jsdom */
/**
 * A dynamic prop must still be DYNAMIC after it leaves the render batch.
 *
 * `promote()` copies the template's geometry onto the instance with
 * `cloneDataTo`, and `cloneDataTo` ends by building a physics body for the
 * geometry it just copied — a STATIC one, which is right for its original
 * caller (re-cloning a prefab after an edit) and fatal here: the prop's dynamic
 * body was replaced by a fixed one the first time anything woke it. The ball
 * then hung wherever that push left it, unkickable and unpushable for the rest
 * of the session, which is exactly what a "the ball just floats and I can't
 * kick it" report looks like.
 *
 * `keepPhysicsBody` is how the promotion path keeps its body; the exact
 * colliders are swapped onto it afterwards by attachPromotedDynamicColliders.
 */
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
(globalThis as unknown as { TextDecoder: unknown }).TextDecoder ??= NodeTextDecoder;
(globalThis as unknown as { TextEncoder: unknown }).TextEncoder ??= NodeTextEncoder;

import { VoxelObject } from 'engine/VoxelObject.js';
import { PristineDynamicVoxelObject } from 'engine/PristineDynamic.js';
import { BlockType } from 'engine/VoxelTextureAtlas.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/** A small chunk-backed prop — enough geometry for cloneDataTo to have work to do. */
function buildProp(): VoxelObject {
    const o = new VoxelObject({ voxelSize: 0.25, useAtlas: false, shadows: false });
    for (let x = 0; x < 2; x++) {
        for (let y = 0; y < 2; y++) o.setVoxel(x, y, 0, BlockType.COLOR, { r: 1, g: 0, b: 0 });
    }
    return o;
}

/** Give `vox` a physics world so cloneDataTo's body-building branch is reachable. */
function withPhysicsWorld(vox: VoxelObject): void {
    (vox as unknown as { physicsWorld: PhysicsWorld }).physicsWorld = {} as PhysicsWorld;
}

describe('cloneDataTo and the target physics body', () => {
    test('rebuilds the body by default — the prefab re-clone contract', () => {
        const template = buildProp();
        const target = buildProp();
        withPhysicsWorld(target);
        const rebuild = jest.spyOn(target, 'createPhysicsBody').mockImplementation(() => undefined);

        template.cloneDataTo(target);

        expect(rebuild).toHaveBeenCalledTimes(1);
    });

    test('leaves the body alone when the caller asks to keep it', () => {
        const template = buildProp();
        const target = buildProp();
        withPhysicsWorld(target);
        const rebuild = jest.spyOn(target, 'createPhysicsBody').mockImplementation(() => undefined);

        template.cloneDataTo(target, { keepPhysicsBody: true });

        expect(rebuild).not.toHaveBeenCalled();
    });
});

describe('PristineDynamicVoxelObject.promote', () => {
    test('keeps the dynamic body instead of letting the clone rebuild a static one', () => {
        const template = buildProp();
        const clone = jest.spyOn(template, 'cloneDataTo').mockImplementation(() => undefined);

        // promote() reads only these members; building the whole proxy would
        // pull in the batch, the navmesh obstacle and a real physics world.
        const proxy = Object.create(PristineDynamicVoxelObject.prototype) as PristineDynamicVoxelObject;
        Object.assign(proxy as unknown as Record<string, unknown>, {
            promoted: false,
            template,
            physicsWorldRef: null,          // skips attachPromotedDynamicColliders
            hooks: { hideBatchInstance: () => undefined, onPromoted: () => undefined },
            setCarveable: () => undefined,
        });

        proxy.promote();

        expect(clone).toHaveBeenCalledWith(proxy, { keepPhysicsBody: true });
    });
});
