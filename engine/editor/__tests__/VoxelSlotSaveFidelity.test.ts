/**
 * A material change must reach the file.
 *
 * Glow is a property of a MATERIAL, not of a voxel, so the two ways a creator changes one —
 * retuning a slot's level, or re-adding a material by a name that already exists — move no
 * leaf at all. Both used to be lost, and lost SILENTLY, which is the worst shape this can
 * take: the toolbar reports a successful save and the asset comes back unlit.
 *
 *   1. `createMaterialSlot` resolved a name clash to the existing slot and threw away the
 *      percentage the creator had just been asked for, so re-adding "glow" at a new level
 *      changed nothing.
 *   2. `VoxelObject.toVXL` branches on `_octreeLeafEdited`, which only a LEAF edit sets. A
 *      material-only session therefore took the round-trip branch, whose slot table is the
 *      one the file held at load — undoing the change the save was reporting.
 *
 * Read off the source rather than exercised, for the reason `VoxelSaveCommit.test.ts` gives:
 * this suite's `testEnvironment` is `node` and the import graph of both files reaches `window`.
 * `__dirname` because ts-jest transpiles this project to CJS.
 */
import * as fs from 'fs';
import * as path from 'path';

const volumeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'voxel-edit', 'VoxelObjectVolume.ts'), 'utf-8');
const objectSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'engine', 'VoxelObject.ts'), 'utf-8');

/** The body of one method, from its signature to the next same-indent closing brace. */
function methodBody(source: string, signature: string): string {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n    }', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('adding a material that already exists', () => {
    const body = methodBody(
        volumeSrc, 'createMaterialSlot(name: string, emissive: number, materialClass?: string)');

    it('still resolves the clash to the one existing slot', () => {
        // Two materials of one name are two the runtime cannot tell apart by name, which is
        // the single thing `setSlotEmissive` needs to work. This must not become an append.
        expect(body).toContain('const existing = this.slots.findIndex');
        expect(body).toMatch(/if \(existing >= 0\) \{/);
        expect(body).toContain('return existing + 1;');
    });

    it('applies the glow level and class the creator just chose', () => {
        // The bug: the `emissive` argument was dropped on this path entirely.
        // The class is the same argument and the same reasoning — the creator
        // picked what this material is made of, and resolving to an existing
        // slot must honour the answer rather than silently keep the old one.
        const clash = body.slice(body.indexOf('if (existing >= 0)'));
        expect(clash).toContain('setSlotEmissive(existing + 1, emissive)');
        expect(clash).toContain('setSlotMaterialClass(existing + 1, stored)');
    });
});

describe('saving a session that changed only a material', () => {
    it('carries the live slot table, not the one the file loaded with', () => {
        const body = methodBody(objectSrc, 'async toVXL()');
        const roundTrip = body.slice(body.indexOf('decodedToEncodable('));
        // The branch a material-only session takes must override the decode's stale table.
        expect(roundTrip).toContain('slots: this._slots');
        expect(roundTrip).toContain('this._slots.length > 0');
    });

    it('still passes the live table on the leaf-edited branch too', () => {
        // The other branch always did this; a regression there is the same loss.
        const body = methodBody(objectSrc, 'async toVXL()');
        expect(body).toContain('}, this._slots)');
    });
});

/**
 * Changing what a material is MADE OF is the same shape of change as retuning its
 * glow — asset-level, moving no voxel — so it can be lost in all the same places,
 * and needs one thing the glow does not.
 */
describe('changing a material\'s class', () => {
    const body = methodBody(volumeSrc, 'setSlotMaterialClass(slot: number, materialClass: string)');
    const checksumSrc = fs.readFileSync(
        path.join(__dirname, '..', 'VoxelChecksum.ts'), 'utf-8');

    it('REBUILDS the mesh, which the glow path deliberately does not', () => {
        // A glow is a uniform on a material that already exists. A class decides
        // WHICH material to build — Lambert, Phong or Physical — and whether that
        // slot's vertices get smoothed shading normals, both settled at
        // mesh-assembly time. Writing the table alone would leave the old material
        // on screen and the change invisible until a reload.
        expect(body).toContain('this.object.setSlotsForEdit(this.slots)');
        expect(body).toContain('this.refresh()');
    });

    it('clears the field rather than storing the default', () => {
        // A slot with no class must be shaped exactly like one that never had one,
        // or the encoder's write gate raises the file's version to record the
        // absence of a decision.
        expect(body).toContain('delete entry.materialClass');
    });

    it('is hashed by the checksum, or Save & Exit throws it away', () => {
        // The exact trap docs/voxel-editor-design.md records for the glow: an
        // asset-level change moves no leaf, so `hasChanges()` is false without this.
        expect(checksumSrc).toContain('slot.materialClass');
    });

    it('reads the outgoing default BEFORE overwriting the class', () => {
        // The glow follows a class change only when nobody has tuned it, and
        // "untouched" means "still equal to the OLD class's default". Testing it
        // after the write compares the new class against itself, which is always
        // false — so a plain material picked as a light would never light up.
        const write = body.indexOf('entry.materialClass = stored');
        const test = body.indexOf('const untouched =');
        expect(test).toBeGreaterThan(-1);
        expect(test).toBeLessThan(write);
        expect(body).toContain('defaultGlowForVoxelMaterialClass(entry.materialClass)');
    });

    it('pushes the moved glow to the live material as well as the table', () => {
        // Same two writes the glow slider needs: the table so it survives the
        // save, the live material so the change is on screen. `refresh()` alone
        // rebuilds from the table, but the emissive uniform is set by name.
        expect(body).toContain('this.object.setSlotEmissive(entry.name, entry.emissive / 255)');
    });
});
