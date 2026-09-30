/**
 * @jest-environment jsdom
 *
 * The "new material" form — the flow that stopped asking everybody how brightly
 * they glow.
 *
 * Creating a material used to fire two `window.prompt`s, the second of which
 * asked "how strongly should this glow? 0-100%" of a metal blade, a leather grip
 * and a stone plinth alike. The question was asked because nothing else could
 * answer it; now the material CLASS does, so the form asks what a surface is
 * made of and derives the glow from `defaultGlowForVoxelMaterialClass`.
 *
 * The toolbar is plain DOM with no `three` import, so it runs here for real
 * rather than through the source-reading the sibling suites resort to.
 */
import { VoxelEditToolbar, type VoxelEditToolbarCallbacks } from 'editor/voxel-edit/VoxelEditToolbar.js';
import { VOXEL_MATERIAL_CLASSES } from 'engine/VoxelMaterialClass.js';
import { MAX_VOXEL_SLOTS, type VoxelSlot } from 'engine/VoxelMaterialSlots.js';
import type { EditVoxel, IEditableVoxelVolume, VoxelMaterial } from 'editor/voxel-edit/VoxelEditTypes.js';

/** A volume with just the material surface the toolbar actually touches. */
function fakeVolume(slots: VoxelSlot[] = []): IEditableVoxelVolume {
    return {
        kind: 'object',
        capabilities: () => ({ materials: true, similaritySelect: true, paintColor: true }),
        getMaterialSlots: () => slots,
        getMaterialPalette: () => [{ material: { kind: 'rgb', color: 0xff0000 }, name: 'red' }],
        materialName: () => 'red',
    } as unknown as IEditableVoxelVolume;
}

function voxel(slot = 0): EditVoxel {
    const material: VoxelMaterial = { kind: 'rgb', color: 0xff0000 };
    return { x: 0, y: 0, z: 0, size: 1, material, slot } as unknown as EditVoxel;
}

function callbacks(over: Partial<VoxelEditToolbarCallbacks> = {}): VoxelEditToolbarCallbacks {
    return {
        onDeleteSelected: () => {}, onDuplicateSelected: () => {}, onFloodSelect: () => {},
        onUndo: () => {}, onMaterialPicked: () => {}, onSelectSimilar: () => 0,
        onSlotPicked: () => {}, onCreateMaterial: () => 1, onSlotEmissiveChanged: () => {},
        onSlotMaterialClassChanged: () => {}, onSaveAndExit: () => {}, onCancel: () => {},
        ...over,
    };
}

/** The toolbar builds into `document.body`; find its controls by their labels. */
const q = <T extends HTMLElement>(sel: string): T => {
    const el = document.querySelector<T>(`#voxel-edit-toolbar ${sel}`);
    if (!el) throw new Error(`no ${sel} in the toolbar`);
    return el;
};

/** Every select in the panel, in document order: material picker, create-form class, made-of. */
const selects = (): HTMLSelectElement[] =>
    Array.from(document.querySelectorAll<HTMLSelectElement>('#voxel-edit-toolbar select'));

function openForm(toolbar: VoxelEditToolbar, volume: IEditableVoxelVolume): {
    name: HTMLInputElement; klass: HTMLSelectElement;
} {
    toolbar.setSelection([voxel()], volume);
    const picker = selects()[0]!;
    picker.value = 'new';
    picker.onchange?.(new Event('change'));
    return { name: q<HTMLInputElement>('input[type="text"]'), klass: selects()[1]! };
}

describe('creating a material', () => {
    let toolbar: VoxelEditToolbar;

    afterEach(() => { toolbar?.hide(); });

    it('never asks for a glow level', () => {
        // The regression that matters: a prompt is invisible to every other
        // assertion here, and its return value would be `null` under jsdom —
        // silently turning every create into a cancel.
        const prompt = jest.spyOn(window, 'prompt').mockReturnValue('x');
        const alert = jest.spyOn(window, 'alert').mockImplementation(() => {});
        toolbar = new VoxelEditToolbar(callbacks());
        const volume = fakeVolume();
        toolbar.show(volume, 'sword');

        const { name, klass } = openForm(toolbar, volume);
        klass.value = 'neon';
        klass.onchange?.(new Event('change'));
        expect(name.value).toBe('neon');

        expect(prompt).not.toHaveBeenCalled();
        expect(alert).not.toHaveBeenCalled();
        prompt.mockRestore();
        alert.mockRestore();
    });

    it('derives the glow from what the material is made of', () => {
        const created: Array<[string, number, string]> = [];
        toolbar = new VoxelEditToolbar(callbacks({
            onCreateMaterial: (n, e, c) => { created.push([n, e, c]); return 1; },
        }));
        const volume = fakeVolume();
        toolbar.show(volume, 'sign');

        const { klass } = openForm(toolbar, volume);
        klass.value = 'neon';
        klass.onchange?.(new Event('change'));
        q<HTMLButtonElement>('button[title^="Create the material"]').click();

        expect(created).toEqual([['neon', VOXEL_MATERIAL_CLASSES.neon.defaultGlow, 'neon']]);
    });

    it('creates a surface material dark, without mentioning glow', () => {
        const created: Array<[string, number, string]> = [];
        toolbar = new VoxelEditToolbar(callbacks({
            onCreateMaterial: (n, e, c) => { created.push([n, e, c]); return 1; },
        }));
        const volume = fakeVolume();
        toolbar.show(volume, 'sword');

        const { name, klass } = openForm(toolbar, volume);
        name.value = 'grip';
        name.oninput?.(new Event('input'));
        klass.value = 'leather';
        klass.onchange?.(new Event('change'));
        // Their name survives the class pick — the auto-fill stops once they type.
        q<HTMLButtonElement>('button[title^="Create the material"]').click();

        expect(created).toEqual([['grip', 0, 'leather']]);
    });

    it('reports the material budget in the form instead of an alert', () => {
        const alert = jest.spyOn(window, 'alert').mockImplementation(() => {});
        toolbar = new VoxelEditToolbar(callbacks({ onCreateMaterial: () => null }));
        const volume = fakeVolume();
        toolbar.show(volume, 'sword');

        const { name } = openForm(toolbar, volume);
        name.value = 'blade';
        name.oninput?.(new Event('input'));
        q<HTMLButtonElement>('button[title^="Create the material"]').click();

        // The form stays open with what they typed, so the budget is something
        // they can act on rather than an alert that throws the work away.
        expect(alert).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain(`all ${MAX_VOXEL_SLOTS} materials`);
        expect(name.value).toBe('blade');
        alert.mockRestore();
    });

    it('refuses an unnamed material — a slot with no name is unaddressable', () => {
        const created: string[] = [];
        toolbar = new VoxelEditToolbar(callbacks({
            onCreateMaterial: (n) => { created.push(n); return 1; },
        }));
        const volume = fakeVolume();
        toolbar.show(volume, 'sword');

        openForm(toolbar, volume);
        q<HTMLButtonElement>('button[title^="Create the material"]').click();

        expect(created).toEqual([]);
        expect(document.body.textContent).toContain('Give the material a name.');
    });

    it('keeps the picker on the sentinel when the selection changes underneath', () => {
        // Live only because the form is ordinary DOM: a `window.prompt` blocked
        // the event loop, so a selection change could not arrive mid-create.
        toolbar = new VoxelEditToolbar(callbacks());
        const volume = fakeVolume([{ name: 'blade', emissive: 0, materialClass: 'metal' }]);
        toolbar.show(volume, 'sword');

        openForm(toolbar, volume);
        toolbar.setSelection([voxel(1)], volume);

        expect(selects()[0]!.value).toBe('new');
        expect(q<HTMLDivElement>('input[type="text"]').closest('div')!.style.display).not.toBe('none');
    });
});
