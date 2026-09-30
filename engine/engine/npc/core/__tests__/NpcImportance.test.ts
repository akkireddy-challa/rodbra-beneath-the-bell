import { NpcManager } from 'engine/npc/core/NpcManager.js';
import { NpcHandleImpl } from 'engine/npc/core/NpcHandle.js';

describe('NPC importance threading', () => {
    test('manager stores importance and defaults to CROWD', () => {
        // The default is deliberately the CHEAP tier. It used to be 'hero' —
        // full fidelity at any distance — so an author who never considered
        // scale got the most expensive simulation for every NPC, and reaching
        // the cheap tier meant predicting how many NPCs the game would end up
        // with. 'hero' is now an opt-in describing what the NPC is.
        const manager = Object.create(NpcManager.prototype) as NpcManager;
        (manager as unknown as { importance?: string }).importance = undefined;
        // Field initializers do not run for Object.create-built instances; seed the
        // controller map so setImportance can propagate over it.
        (manager as unknown as { npcControllers: Map<string, unknown> }).npcControllers = new Map();
        expect(manager.getImportance()).toBe('crowd');
        manager.setImportance('hero');
        expect(manager.getImportance()).toBe('hero');
    });

    test('handle exposes setImportance and forwards to manager', () => {
        const calls: string[] = [];
        const fakeManager = {
            setImportance: (t: string) => calls.push(t),
        } as unknown as NpcManager;
        const handle = new NpcHandleImpl('zombie', fakeManager);
        handle.setImportance('crowd');
        expect(calls).toEqual(['crowd']);
    });
});
