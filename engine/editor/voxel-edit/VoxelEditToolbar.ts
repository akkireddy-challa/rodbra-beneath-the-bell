/**
 * Compact toolbar shown while a `VoxelEditSession` is active. Selection
 * summary, colour picker, MATERIAL picker, the selection tools, and
 * Save / Cancel.
 *
 * Colour and material are separate axes on purpose: colour is per voxel,
 * while glow belongs to the material (see engine/VoxelMaterialSlots.ts). So
 * "make this glow" is "put it in an emissive material", not a per-voxel
 * slider — which is what lets one sign glow while an identically coloured
 * plank next to it stays dark.
 *
 * And WHICH emissive material is a question about what the surface is made of,
 * not a percentage: a material's class carries its own default glow, so the
 * create form asks for a name and a material and derives the rest. It used to
 * ask everybody for a glow level, including the leather grips.
 *
 * Game-side DOM, same conventions as the other editor panels
 * (inline styles, fixed positioning, z-index above the canvas).
 */

import {
    DEFAULT_VOXEL_MATERIAL_CLASS,
    VOXEL_MATERIAL_CLASS_NAMES,
    defaultGlowForVoxelMaterialClass,
    normalizeVoxelMaterialClassName,
} from 'engine/VoxelMaterialClass.js';
import { MAX_VOXEL_SLOTS, VOXEL_SLOT_NAME_MAX } from 'engine/VoxelMaterialSlots.js';
import {
    type EditVoxel,
    type IEditableVoxelVolume,
    type VoxelMaterial,
} from './VoxelEditTypes.js';

export interface VoxelEditToolbarCallbacks {
    onDeleteSelected: () => void;
    onDuplicateSelected: () => void;
    onFloodSelect: () => void;
    onUndo: () => void;
    onMaterialPicked: (material: VoxelMaterial) => void;
    /** Re-run color-similarity selection at 0-100 fuzziness. Returns the count, or -1 with no anchor. */
    onSelectSimilar: (fuzziness: number) => number;
    /** Move the selection into material `slot` (0 = base material). */
    onSlotPicked: (slot: number) => void;
    /**
     * Create a named material with a starting glow (0-255) and what it is MADE
     * OF, and move the selection into it. Returns the new slot index, or null
     * when it could not be created (budget reached).
     */
    onCreateMaterial: (name: string, emissive: number, materialClass: string) => number | null;
    /** Retune material `slot`'s glow (0-255) — affects every voxel in it. */
    onSlotEmissiveChanged: (slot: number, emissive: number) => void;
    /**
     * Set what material `slot` is MADE OF — a material-class name, or '' for the
     * default flat look. Rebuilds the mesh, unlike the glow above.
     */
    onSlotMaterialClassChanged: (slot: number, materialClass: string) => void;
    onSaveAndExit: () => void;
    onCancel: () => void;
}

/** Sentinel option value for "create a new material" in the picker. */
const NEW_MATERIAL_OPTION = 'new';
/** Sentinel shown while the selection spans several materials. */
const MIXED_OPTION = 'mixed';

/** The panel's one field recipe, shared by every select and text input in it. */
const FIELD_CSS = `
    background: #1e293b;
    color: #e2e8f0;
    border: 1px solid #475569;
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
    width: 100%;
    box-sizing: border-box;
`;

/** Slot glow is stored 0-255; every label in this panel says it as a percentage. */
function glowPercent(emissive: number): string {
    return `${Math.round((emissive / 255) * 100)}%`;
}

export class VoxelEditToolbar {
    private callbacks: VoxelEditToolbarCallbacks;
    private root: HTMLDivElement | null = null;
    private titleEl: HTMLSpanElement | null = null;
    private selectionEl: HTMLSpanElement | null = null;
    private changesEl: HTMLSpanElement | null = null;
    private paletteEl: HTMLDivElement | null = null;
    private noticeEl: HTMLDivElement | null = null;

    private volume: IEditableVoxelVolume | null = null;
    private fuzzinessRow: HTMLDivElement | null = null;
    private fuzzinessSlider: HTMLInputElement | null = null;
    private fuzzinessValueEl: HTMLSpanElement | null = null;
    private materialRow: HTMLDivElement | null = null;
    private materialSelect: HTMLSelectElement | null = null;
    private materialValueEl: HTMLSpanElement | null = null;
    private glowRow: HTMLDivElement | null = null;
    private glowSlider: HTMLInputElement | null = null;
    private glowValueEl: HTMLSpanElement | null = null;
    private madeOfRow: HTMLDivElement | null = null;
    private madeOfSelect: HTMLSelectElement | null = null;
    private madeOfHintEl: HTMLDivElement | null = null;
    private createForm: HTMLDivElement | null = null;
    private createNameInput: HTMLInputElement | null = null;
    private createClassSelect: HTMLSelectElement | null = null;
    private createHintEl: HTMLDivElement | null = null;
    private createErrorEl: HTMLDivElement | null = null;

    /**
     * True while the create form is open, which the selection handler has to
     * know about: it would otherwise yank the picker off the "+ New material…"
     * sentinel and unhide the tuning rows under the open form the moment the
     * user clicked another voxel. Unreachable in the `window.prompt` version —
     * a platform modal blocks the event loop — and live the moment the form
     * became ordinary DOM.
     */
    private createFormOpen = false;

    /**
     * Cleared once the user types their own name, so the auto-fill from the
     * class pick stops fighting them mid-word.
     */
    private createNameAuto = true;

    /**
     * True while a fuzziness drag is driving the selection, so the resulting
     * `setSelection` doesn't yank the slider the user is holding back to 0.
     */
    private applyingFuzziness = false;

    /** Slot the picker should fall back to when a create prompt is cancelled. */
    private lastAppliedSlot = 0;

    constructor(callbacks: VoxelEditToolbarCallbacks) {
        this.callbacks = callbacks;
    }

    show(volume: IEditableVoxelVolume, title: string): void {
        this.hide();
        this.volume = volume;

        // Docked to the left edge as a narrow column: a horizontal bar across
        // the top ate the height the object needs, and picking one voxel out of
        // a model is a vertical-space problem.
        const root = document.createElement('div');
        root.id = 'voxel-edit-toolbar';
        root.style.cssText = `
            position: fixed;
            top: 12px;
            left: 12px;
            width: 250px;
            max-height: calc(100vh - 24px);
            overflow-y: auto;
            background: rgba(15, 23, 42, 0.95);
            border: 1px solid #334155;
            border-radius: 10px;
            padding: 12px;
            z-index: 9999;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #e2e8f0;
            font-size: 13px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        `;

        // Header: title, then the selection summary on its own line.
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';

        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; align-items: baseline; gap: 8px;';

        this.titleEl = document.createElement('span');
        this.titleEl.style.cssText = 'font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        this.titleEl.textContent = title;
        titleRow.appendChild(this.titleEl);

        this.changesEl = document.createElement('span');
        this.changesEl.style.cssText = 'color: #fbbf24; display: none; margin-left: auto; font-size: 11px; white-space: nowrap;';
        this.changesEl.textContent = '● unsaved';
        titleRow.appendChild(this.changesEl);
        header.appendChild(titleRow);

        this.selectionEl = document.createElement('span');
        this.selectionEl.style.cssText = 'color: #94a3b8; font-size: 12px; line-height: 1.35;';
        this.selectionEl.textContent = 'Click a voxel to select';
        header.appendChild(this.selectionEl);

        root.appendChild(header);

        // Optional provenance notice (set via setNotice)
        this.noticeEl = document.createElement('div');
        this.noticeEl.style.cssText = `
            display: none;
            background: rgba(251, 191, 36, 0.12);
            border: 1px solid rgba(251, 191, 36, 0.5);
            border-radius: 6px;
            padding: 6px 10px;
            color: #fbbf24;
            font-size: 12px;
        `;
        root.appendChild(this.noticeEl);

        // Palette row
        const caps = volume.capabilities();
        this.paletteEl = document.createElement('div');
        this.paletteEl.style.cssText = 'display: flex; flex-direction: column; align-items: stretch; gap: 6px;';
        this.buildPalette(volume);
        root.appendChild(this.paletteEl);

        // Per-voxel tool rows, only for volumes that can back them.
        if (caps.similaritySelect) {
            this.fuzzinessRow = this.buildFuzzinessRow();
            root.appendChild(this.fuzzinessRow);
        }
        if (caps.materials) {
            this.materialRow = this.buildMaterialRow(volume);
            root.appendChild(this.materialRow);
            // Directly under the picker that opens it, and above the tuning
            // rows: the vertical order is create, then tune.
            this.createForm = this.buildCreateForm(volume);
            root.appendChild(this.createForm);
            this.glowRow = this.buildGlowRow(volume);
            root.appendChild(this.glowRow);
            this.madeOfRow = this.buildMadeOfRow();
            root.appendChild(this.madeOfRow);
        }

        // Tools, two per row
        const actions = document.createElement('div');
        actions.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 6px;';
        actions.appendChild(this.makeButton('Delete', '#334155', () => this.callbacks.onDeleteSelected(),
            'Delete selected voxels (Del)'));
        actions.appendChild(this.makeButton('Duplicate', '#334155', () => this.callbacks.onDuplicateSelected(),
            'Copy the selected voxel into an adjacent cell'));
        actions.appendChild(this.makeButton('Connected', '#334155', () => this.callbacks.onFloodSelect(),
            'Select touching voxels of the same material (use the Select similar slider for the whole object)'));
        actions.appendChild(this.makeButton('Undo', '#334155', () => this.callbacks.onUndo(), 'Undo (Ctrl+Z)'));
        root.appendChild(actions);

        const footer = document.createElement('div');
        footer.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 6px;';
        footer.appendChild(this.makeButton('Cancel', '#7f1d1d', () => this.callbacks.onCancel(),
            'Revert all changes and exit (Esc)'));
        footer.appendChild(this.makeButton('Save & Exit', '#1e40af', () => this.callbacks.onSaveAndExit(),
            'Save changes and exit voxel editing'));
        root.appendChild(footer);

        // Hint row. Camera first: the session's orbit controls replace the
        // editor's WASD fly camera for as long as it is open.
        const hint = document.createElement('div');
        hint.style.cssText = 'color: #64748b; font-size: 11px; line-height: 1.5;';
        hint.textContent = 'Drag to orbit · wheel to zoom · right-drag to pan'
            + ' · Ctrl+click multi-select · right-click adds'
            + ' · Shift+WASD/QE moves selection · Esc exits';
        root.appendChild(hint);

        document.body.appendChild(root);
        this.root = root;
    }

    hide(): void {
        this.root?.remove();
        this.root = null;
        this.volume = null;
        this.titleEl = null;
        this.selectionEl = null;
        this.changesEl = null;
        this.paletteEl = null;
        this.noticeEl = null;
        this.fuzzinessRow = null;
        this.fuzzinessSlider = null;
        this.fuzzinessValueEl = null;
        this.materialRow = null;
        this.materialSelect = null;
        this.materialValueEl = null;
        this.glowRow = null;
        this.glowSlider = null;
        this.glowValueEl = null;
        this.madeOfRow = null;
        this.madeOfSelect = null;
        this.madeOfHintEl = null;
        this.createForm = null;
        this.createNameInput = null;
        this.createClassSelect = null;
        this.createHintEl = null;
        this.createErrorEl = null;
        this.createFormOpen = false;
        this.createNameAuto = true;
        this.applyingFuzziness = false;
    }

    isVisible(): boolean {
        return this.root !== null;
    }

    setSelection(selected: EditVoxel[], volume: IEditableVoxelVolume): void {
        this.volume = volume;

        if (this.selectionEl) {
            if (selected.length === 0) {
                this.selectionEl.textContent = 'Click a voxel to select';
            } else if (selected.length === 1) {
                const v = selected[0]!;
                this.selectionEl.textContent = `${volume.materialName(v.material)} · size ${v.size}`;
            } else {
                this.selectionEl.textContent = `${selected.length} voxels selected`;
            }
        }

        // A fresh hand-pick starts a new similarity search — but not when the
        // fuzziness drag itself produced this selection.
        if (!this.applyingFuzziness && this.fuzzinessSlider) {
            this.fuzzinessSlider.value = '0';
            this.updateFuzzinessLabel(selected.length);
        }

        this.updateMaterialRow(selected, volume);
    }

    /**
     * Show which material the selection is in — or "Mixed" when it spans
     * several, which is the honest answer and the cue that assigning one will
     * flatten them.
     */
    private updateMaterialRow(selected: EditVoxel[], volume: IEditableVoxelVolume): void {
        if (!this.materialRow || !this.materialSelect || !this.materialValueEl) return;

        const enabled = selected.length > 0;
        this.materialRow.style.opacity = enabled ? '1' : '0.45';
        this.materialSelect.disabled = !enabled;

        if (!enabled) {
            this.materialValueEl.textContent = '';
            // A material is created FOR a selection, so an empty one closes the
            // form rather than leaving it hovering over nothing to apply to.
            this.closeCreateForm();
            if (this.glowRow) this.glowRow.style.display = 'none';
            if (this.madeOfRow) this.madeOfRow.style.display = 'none';
            return;
        }

        // Re-sync the options whenever the slot table changed underneath us —
        // a material can appear by routes other than this picker.
        const expected = volume.getMaterialSlots().length + 2; // base + slots + "new"
        const actual = this.materialSelect.querySelectorAll(`option:not([value="${MIXED_OPTION}"])`).length;
        if (actual !== expected) this.rebuildMaterialOptions(volume);

        const first = selected[0]!.slot;
        const mixed = selected.some((v) => v.slot !== first);
        // Name the material in the label as well as the picker: that is the
        // "which material is this?" answer, and it stays readable when the
        // picker is showing the Mixed placeholder.
        this.materialValueEl.textContent = mixed ? 'Mixed' : this.slotLabel(volume, first);

        // Selecting other voxels with the create form open is legitimate — it is
        // how you decide what the new material is for — so the selection is
        // taken but the picker is NOT: it has to stay on the sentinel the open
        // form belongs to, and the tuning rows underneath describe a different
        // material and must stay hidden. `lastAppliedSlot` still moves, so
        // Cancel returns to what is selected now rather than to what was
        // selected when the form opened.
        if (this.createFormOpen) {
            if (!mixed) this.lastAppliedSlot = first;
            this.updateCreateSelectionHint(selected.length);
            return;
        }

        // A mixed selection has no single value to show, and leaving the picker
        // blank reads as broken — park it on an explicit placeholder that also
        // says picking one will flatten them.
        this.setMixedPlaceholder(mixed);
        if (mixed) {
            this.materialSelect.value = MIXED_OPTION;
            if (this.glowRow) this.glowRow.style.display = 'none';
            if (this.madeOfRow) this.madeOfRow.style.display = 'none';
            return;
        }

        this.materialSelect.value = String(first);
        this.lastAppliedSlot = first;
        this.updateGlowRow(volume, first);
        this.updateMadeOfRow(volume, first);
    }

    /**
     * The glow control belongs to the MATERIAL, so it only appears once the
     * selection is in a named one — there is nothing to tune about the base
     * material, and a disabled slider hanging there would just raise the
     * question the material picker already answers.
     */
    private updateGlowRow(volume: IEditableVoxelVolume, slot: number): void {
        if (!this.glowRow || !this.glowSlider) return;
        const entry = slot > 0 ? volume.getMaterialSlots()[slot - 1] : undefined;
        if (!entry) {
            this.glowRow.style.display = 'none';
            return;
        }
        this.glowRow.style.display = 'flex';
        this.glowSlider.value = String(entry.emissive);
        this.setGlowLabel(entry.name, entry.emissive);
    }

    private setGlowLabel(name: string, emissive: number): void {
        if (this.glowValueEl) this.glowValueEl.textContent = glowPercent(emissive);
        if (this.glowRow) this.glowRow.title = `How strongly "${name}" glows`;
    }

    /**
     * What the selection's material is MADE OF.
     *
     * Beside Glow and gated the same way, because it is the same kind of thing: a
     * property of the MATERIAL, not of a voxel or a colour. Putting a sword's
     * blade in a material called "blade" and setting that to metal makes every
     * voxel in it catch the light, and leaves the grip alone.
     *
     * A light class also brings its default glow with it, but only onto a
     * material whose glow nobody has tuned — see
     * `VoxelObjectVolume.setSlotMaterialClass`.
     */
    private buildMadeOfRow(): HTMLDivElement {
        const { row } = this.buildSliderRow('Made of');
        row.style.display = 'none';

        const select = this.buildMaterialClassSelect('How this material responds to light');
        select.onchange = () => {
            const slot = parseInt(this.materialSelect?.value ?? '0', 10);
            if (!Number.isFinite(slot) || slot <= 0) return;
            this.callbacks.onSlotMaterialClassChanged(slot, select.value);
            const volume = this.volume;
            // The class may have taken the glow with it — see
            // `VoxelObjectVolume.setSlotMaterialClass`. Re-read rather than
            // assume: only an untouched glow follows.
            if (volume) this.updateGlowRow(volume, slot);
            this.updateMadeOfHint(select.value);
        };
        row.appendChild(select);
        this.madeOfSelect = select;

        const hint = document.createElement('div');
        hint.style.cssText = 'color: #64748b; font-size: 11px; line-height: 1.4;';
        row.appendChild(hint);
        this.madeOfHintEl = hint;
        return row;
    }

    /**
     * The "made of" dropdown, built once and used twice — here and in the create
     * form — so the two cannot drift apart.
     *
     * The vocabulary is closed (`VOXEL_MATERIAL_CLASS_NAMES`) rather than a free
     * text field: a class name is a lookup into the engine's tuned table, so a
     * typo would silently render as the default with nothing to say why. The
     * light-emitting classes are grouped separately because picking one has a
     * consequence the others do not — it turns the material on — and a `neon`
     * sitting in one flat list beside `wood` gives no warning of that.
     */
    private buildMaterialClassSelect(title: string): HTMLSelectElement {
        const select = document.createElement('select');
        select.title = title;
        select.style.cssText = FIELD_CSS;

        const surfaces = document.createElement('optgroup');
        surfaces.label = 'Surfaces';
        const lights = document.createElement('optgroup');
        lights.label = 'Lights';

        for (const name of VOXEL_MATERIAL_CLASS_NAMES) {
            const option = document.createElement('option');
            option.value = name;
            // `matte` is the default and reads better as what it means than as a
            // material nobody asked for.
            option.textContent = name === DEFAULT_VOXEL_MATERIAL_CLASS ? 'Nothing special' : name;
            if (defaultGlowForVoxelMaterialClass(name) > 0) lights.appendChild(option);
            else surfaces.appendChild(option);
        }
        select.appendChild(surfaces);
        if (lights.childElementCount > 0) select.appendChild(lights);
        return select;
    }

    /** Says why a light-class material arrived already glowing. */
    private updateMadeOfHint(materialClass: string): void {
        if (!this.madeOfHintEl) return;
        const glow = defaultGlowForVoxelMaterialClass(materialClass);
        this.madeOfHintEl.textContent = glow > 0 ? `${materialClass} glows ${glowPercent(glow)} by default` : '';
    }

    /** Shown only once the selection is in a named material — see `updateGlowRow`. */
    private updateMadeOfRow(volume: IEditableVoxelVolume, slot: number): void {
        if (!this.madeOfRow || !this.madeOfSelect) return;
        const entry = slot > 0 ? volume.getMaterialSlots()[slot - 1] : undefined;
        if (!entry) {
            this.madeOfRow.style.display = 'none';
            return;
        }
        this.madeOfRow.style.display = 'flex';
        // An unrecognised stored class — one a newer vocabulary introduced — shows
        // as the default here rather than as a blank select, matching how it
        // actually renders.
        const className = normalizeVoxelMaterialClassName(entry.materialClass);
        this.madeOfSelect.value = className;
        this.updateMadeOfHint(className);
        this.madeOfRow.title = `What "${entry.name}" is made of`;
    }

    /** Add or drop the transient "Mixed" entry at the top of the picker. */
    private setMixedPlaceholder(show: boolean): void {
        const select = this.materialSelect;
        if (!select) return;
        const existing = select.querySelector(`option[value="${MIXED_OPTION}"]`);
        if (show && !existing) {
            const option = document.createElement('option');
            option.value = MIXED_OPTION;
            option.textContent = 'Mixed — pick one to apply to all';
            select.insertBefore(option, select.firstChild);
        } else if (!show && existing) {
            existing.remove();
        }
    }

    /** Display name for a slot index: 0 is the base material, 1..N are named. */
    private slotLabel(volume: IEditableVoxelVolume, slot: number): string {
        if (slot === 0) return 'Base material';
        const entry = volume.getMaterialSlots()[slot - 1];
        if (!entry) return `Material ${slot}`;
        const glow = glowPercent(entry.emissive);
        return glow === '0%' ? entry.name : `${entry.name} (${glow} glow)`;
    }

    /** Section heading inside the narrow column. */
    private makeSectionLabel(text: string): HTMLDivElement {
        const label = document.createElement('div');
        label.style.cssText = 'color: #94a3b8; font-size: 12px;';
        label.textContent = text;
        return label;
    }

    setHasChanges(hasChanges: boolean): void {
        if (this.changesEl) this.changesEl.style.display = hasChanges ? 'inline' : 'none';
    }

    /** Show a persistent provenance warning (e.g. re-voxelize discards edits). */
    setNotice(text: string | null): void {
        if (!this.noticeEl) return;
        if (text) {
            this.noticeEl.textContent = `⚠ ${text}`;
            this.noticeEl.style.display = 'block';
        } else {
            this.noticeEl.style.display = 'none';
        }
    }

    /**
     * "Select similar" as a live slider rather than a button: the user needs to
     * SEE which voxels a given fuzziness catches, and the only way to judge
     * that is to watch the highlight grow while dragging.
     */
    /** Label + value on one line, full-width slider under it (narrow column). */
    private buildSliderRow(labelText: string): { row: HTMLDivElement; value: HTMLSpanElement } {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; flex-direction: column; gap: 3px;';

        const head = document.createElement('div');
        head.style.cssText = 'display: flex; align-items: baseline; gap: 8px;';

        const label = document.createElement('span');
        label.style.cssText = 'color: #94a3b8; font-size: 12px;';
        label.textContent = labelText;
        head.appendChild(label);

        const value = document.createElement('span');
        value.style.cssText = 'color: #94a3b8; font-size: 12px; margin-left: auto; white-space: nowrap;';
        head.appendChild(value);

        row.appendChild(head);
        return { row, value };
    }

    private buildFuzzinessRow(): HTMLDivElement {
        const { row, value } = this.buildSliderRow('Select similar');
        this.fuzzinessValueEl = value;
        this.fuzzinessValueEl.textContent = 'click a voxel first';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.step = '1';
        slider.value = '0';
        slider.title = 'Widen the selection to voxels of a similar color';
        slider.style.cssText = 'width: 100%; cursor: pointer; margin: 0;';

        const apply = (): void => {
            const fuzziness = parseInt(slider.value, 10);
            this.applyingFuzziness = true;
            const count = this.callbacks.onSelectSimilar(fuzziness);
            this.applyingFuzziness = false;
            this.updateFuzzinessLabel(count);
        };
        slider.oninput = apply;
        row.appendChild(slider);

        this.fuzzinessSlider = slider;
        return row;
    }

    private updateFuzzinessLabel(count: number): void {
        if (!this.fuzzinessValueEl || !this.fuzzinessSlider) return;
        const fuzziness = parseInt(this.fuzzinessSlider.value, 10);
        this.fuzzinessValueEl.textContent = count < 0
            ? 'click a voxel first'
            : `${fuzziness}% · ${count} voxel${count === 1 ? '' : 's'}`;
    }

    /**
     * Material picker. Glow is a property of the MATERIAL, not of a voxel or a
     * colour, so this — not a per-voxel slider — is how a selection is made to
     * light up: put it in an emissive material. Colour stays free within a
     * material, so a whole multi-coloured sign can share one light.
     */
    private buildMaterialRow(volume: IEditableVoxelVolume): HTMLDivElement {
        const { row, value } = this.buildSliderRow('Material');
        row.style.opacity = '0.45';
        this.materialValueEl = value;

        const select = document.createElement('select');
        select.disabled = true;
        select.title = 'Move the selected voxels into this material';
        select.style.cssText = FIELD_CSS;
        select.onchange = () => {
            if (select.value === MIXED_OPTION) return;
            if (select.value === NEW_MATERIAL_OPTION) {
                this.openCreateForm();
                return;
            }
            this.callbacks.onSlotPicked(parseInt(select.value, 10));
        };
        row.appendChild(select);
        this.materialSelect = select;
        this.rebuildMaterialOptions(volume);
        return row;
    }

    /**
     * Glow level of the selection's material. Editing it relights every voxel
     * in that material at once — which is the point of a material, and why the
     * voxel's own colour is left alone: the glow is that colour, turned up.
     */
    private buildGlowRow(volume: IEditableVoxelVolume): HTMLDivElement {
        const { row, value } = this.buildSliderRow('Glow');
        row.style.display = 'none';
        this.glowValueEl = value;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '255';
        slider.step = '1';
        slider.style.cssText = 'width: 100%; cursor: pointer; margin: 0;';
        const apply = (): void => {
            const slot = parseInt(this.materialSelect?.value ?? '0', 10);
            if (!Number.isFinite(slot) || slot <= 0) return;
            const level = parseInt(slider.value, 10);
            const entry = volume.getMaterialSlots()[slot - 1];
            if (entry) this.setGlowLabel(entry.name, level);
            this.callbacks.onSlotEmissiveChanged(slot, level);
        };
        // Live while dragging: this writes the material, not geometry, so there
        // is nothing to batch and the change is visible immediately.
        slider.oninput = apply;
        row.appendChild(slider);

        this.glowSlider = slider;
        return row;
    }

    /** Base + every named material + the create action, in slot-index order. */
    private rebuildMaterialOptions(volume: IEditableVoxelVolume): void {
        const select = this.materialSelect;
        if (!select) return;
        const previous = select.value;
        select.innerHTML = '';

        const add = (value: string, label: string): void => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.appendChild(option);
        };
        add('0', this.slotLabel(volume, 0));
        volume.getMaterialSlots().forEach((_, i) => add(String(i + 1), this.slotLabel(volume, i + 1)));
        add(NEW_MATERIAL_OPTION, '+ New material…');

        if (previous && Array.from(select.options).some((o) => o.value === previous)) select.value = previous;
    }

    /**
     * The "new material" form, inline in the toolbar column.
     *
     * It replaced two `window.prompt`s, the second of which asked "how strongly
     * should this glow? 0-100%" of every material anyone ever made — a metal
     * blade, a leather grip, a stone plinth. The question was there because
     * nothing else could answer it. Now something can: what a material is MADE
     * OF carries a default glow (`defaultGlowForVoxelMaterialClass`), so the
     * form asks the question that has an answer and derives the one that does
     * not. Picking `neon` is how you make a selection glow; picking `wood`
     * never raises the subject.
     *
     * Inline rather than a modal because this panel is game-side DOM inside the
     * canvas with no modal layer of its own — and inline rather than a platform
     * prompt because a prompt cannot show you that `neon` means 100% before you
     * commit to it, which is the entire point.
     */
    private buildCreateForm(volume: IEditableVoxelVolume): HTMLDivElement {
        const form = document.createElement('div');
        form.style.cssText = `
            display: none;
            flex-direction: column;
            gap: 6px;
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 6px;
            padding: 8px;
        `;
        form.appendChild(this.makeSectionLabel('New material'));

        const name = document.createElement('input');
        name.type = 'text';
        name.placeholder = 'e.g. sign, beacon, blade';
        name.maxLength = VOXEL_SLOT_NAME_MAX;
        name.title = 'What to call this material — runtime code looks it up by this name';
        name.style.cssText = FIELD_CSS;
        name.oninput = () => {
            // Their word beats the auto-fill from here on.
            this.createNameAuto = false;
            this.setCreateError(null);
        };
        form.appendChild(name);
        this.createNameInput = name;

        form.appendChild(this.makeSectionLabel('Made of'));
        const classSelect = this.buildMaterialClassSelect(
            'What this material is made of — and, for a light, how much it glows',
        );
        classSelect.onchange = () => {
            if (this.createNameAuto) name.value = this.suggestedName(volume, classSelect.value);
            this.updateCreateHint();
        };
        form.appendChild(classSelect);
        this.createClassSelect = classSelect;

        const hint = document.createElement('div');
        hint.style.cssText = 'color: #64748b; font-size: 11px; line-height: 1.4;';
        form.appendChild(hint);
        this.createHintEl = hint;

        const error = document.createElement('div');
        error.style.cssText = `
            display: none;
            background: rgba(251, 191, 36, 0.12);
            border: 1px solid rgba(251, 191, 36, 0.5);
            color: #fbbf24;
            border-radius: 4px;
            padding: 5px 8px;
            font-size: 11px;
            line-height: 1.4;
        `;
        form.appendChild(error);
        this.createErrorEl = error;

        const buttons = document.createElement('div');
        buttons.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 6px;';
        buttons.appendChild(this.makeButton('Cancel', '#334155', () => this.closeCreateForm(),
            'Leave the selection in the material it is in'));
        buttons.appendChild(this.makeButton('Create', '#1e40af', () => this.submitCreateForm(volume),
            'Create the material and move the selection into it'));
        form.appendChild(buttons);

        // The form owns its own keys. `VoxelEditSession` already ignores events
        // aimed at a field, so this is belt and braces plus the two shortcuts a
        // form is expected to have.
        form.onkeydown = (event: KeyboardEvent) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                this.submitCreateForm(volume);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.closeCreateForm();
            }
        };

        return form;
    }

    /** Open on the picker's "+ New material…", with the tuning rows stood down. */
    private openCreateForm(): void {
        if (!this.createForm || !this.createNameInput || !this.createClassSelect) return;
        this.createFormOpen = true;
        this.createNameAuto = true;
        this.createClassSelect.value = DEFAULT_VOXEL_MATERIAL_CLASS;
        this.createNameInput.value = '';
        this.setCreateError(null);
        this.updateCreateHint();
        this.updateCreateSelectionHint(null);
        this.createForm.style.display = 'flex';
        // Glow and Made-of describe the material the selection is ALREADY in.
        // Left visible beside the form they read as its settings.
        if (this.glowRow) this.glowRow.style.display = 'none';
        if (this.madeOfRow) this.madeOfRow.style.display = 'none';
        this.createNameInput.focus();
    }

    /**
     * Close and put the picker back on the material the selection is actually
     * in — the same restore the cancelled prompt did, now shared by Cancel, an
     * emptied selection, and a successful create.
     */
    private closeCreateForm(): void {
        if (!this.createFormOpen) return;
        this.createFormOpen = false;
        if (this.createForm) this.createForm.style.display = 'none';
        this.setCreateError(null);
        if (this.materialSelect) this.materialSelect.value = String(this.lastAppliedSlot);
        const volume = this.volume;
        if (volume) {
            this.updateGlowRow(volume, this.lastAppliedSlot);
            this.updateMadeOfRow(volume, this.lastAppliedSlot);
        }
    }

    /** Create the material, move the selection into it, and tune from there. */
    private submitCreateForm(volume: IEditableVoxelVolume): void {
        if (!this.createNameInput || !this.createClassSelect) return;
        const name = this.createNameInput.value.trim();
        if (name.length === 0) {
            this.setCreateError('Give the material a name.');
            this.createNameInput.focus();
            return;
        }

        const materialClass = this.createClassSelect.value;
        const slot = this.callbacks.onCreateMaterial(
            name, defaultGlowForVoxelMaterialClass(materialClass), materialClass,
        );
        if (slot === null) {
            // The only way to get here with a non-empty name: the asset is at
            // its material budget. Say so in the form and keep what they typed.
            this.setCreateError(
                `This asset already has all ${MAX_VOXEL_SLOTS} materials. Reuse one from the picker.`,
            );
            return;
        }

        this.lastAppliedSlot = slot;
        this.createFormOpen = false;
        if (this.createForm) this.createForm.style.display = 'none';
        this.setCreateError(null);
        this.rebuildMaterialOptions(volume);
        if (this.materialSelect) this.materialSelect.value = String(slot);
        this.updateGlowRow(volume, slot);
        this.updateMadeOfRow(volume, slot);
    }

    /** What the pick means, in the one sentence the deleted prompt never gave. */
    private updateCreateHint(): void {
        if (!this.createHintEl || !this.createClassSelect) return;
        const glow = defaultGlowForVoxelMaterialClass(this.createClassSelect.value);
        this.createHintEl.textContent = glow > 0
            ? `Glows ${glowPercent(glow)} — tune it with the Glow slider afterwards.`
            : 'Does not glow. Any material can be lit later with the Glow slider.';
    }

    /** How many voxels this create will land in, refreshed as the selection moves. */
    private updateCreateSelectionHint(count: number | null): void {
        if (!this.createFormOpen || !this.createNameInput) return;
        const n = count ?? 0;
        this.createNameInput.title = n > 0
            ? `Names the material the ${n} selected voxel${n === 1 ? '' : 's'} will move into`
            : 'What to call this material — runtime code looks it up by this name';
    }

    private setCreateError(text: string | null): void {
        if (!this.createErrorEl) return;
        this.createErrorEl.textContent = text ?? '';
        this.createErrorEl.style.display = text === null ? 'none' : 'block';
    }

    /**
     * A free name derived from the class, so the common case is pick-and-Create
     * with no typing. Deduped against the slots that exist because two materials
     * with one name are two the runtime cannot tell apart by name, which is the
     * one thing `setSlotEmissive` needs to work.
     */
    private suggestedName(volume: IEditableVoxelVolume, materialClass: string): string {
        if (materialClass === DEFAULT_VOXEL_MATERIAL_CLASS) return '';
        const taken = new Set(volume.getMaterialSlots().map((s) => s.name));
        if (!taken.has(materialClass)) return materialClass;
        for (let i = 2; i <= MAX_VOXEL_SLOTS + 1; i++) {
            const candidate = `${materialClass} ${i}`;
            if (!taken.has(candidate)) return candidate;
        }
        return materialClass;
    }


    private buildPalette(volume: IEditableVoxelVolume): void {
        if (!this.paletteEl) return;
        this.paletteEl.innerHTML = '';

        const entries = volume.getMaterialPalette();
        const isRgb = entries.length > 0 && entries[0]!.material.kind === 'rgb';

        if (volume.capabilities().paintColor) {
            this.paletteEl.appendChild(this.makeSectionLabel('Colour'));

            const swatches = document.createElement('div');
            swatches.style.cssText = 'display: flex; flex-wrap: wrap; align-items: center; gap: 5px;';
            for (const entry of entries) {
                if (entry.material.kind !== 'rgb') continue;
                const swatch = document.createElement('button');
                const hex = `#${entry.material.color.toString(16).padStart(6, '0')}`;
                swatch.title = `Paint the selection ${hex}`;
                swatch.style.cssText = `
                    width: 20px; height: 20px;
                    border-radius: 4px;
                    border: 1px solid #475569;
                    background: ${hex};
                    cursor: pointer;
                    padding: 0;
                `;
                swatch.onclick = () => this.callbacks.onMaterialPicked(entry.material);
                swatches.appendChild(swatch);
            }

            const picker = document.createElement('input');
            picker.type = 'color';
            picker.value = '#ff0000';
            picker.title = 'Pick any colour and paint the selection';
            picker.style.cssText = 'width: 34px; height: 22px; border: 1px solid #475569; border-radius: 4px; background: none; cursor: pointer; padding: 0;';
            picker.oninput = () => {
                const hex = parseInt(picker.value.slice(1), 16);
                this.callbacks.onMaterialPicked({ kind: 'rgb', color: hex });
            };
            swatches.appendChild(picker);
            this.paletteEl.appendChild(swatches);

            const caption = document.createElement('div');
            caption.style.cssText = 'color: #64748b; font-size: 11px;';
            caption.textContent = 'Click a colour to paint the selected voxels';
            this.paletteEl.appendChild(caption);
        }

        if (!isRgb) {
            // Block types still matter for terrain and legacy chunk objects —
            // a textured block is not expressible as a plain colour.
            this.paletteEl.appendChild(this.makeSectionLabel('Block type'));
            const select = document.createElement('select');
            select.style.cssText = `
                background: #1e293b;
                color: #e2e8f0;
                border: 1px solid #475569;
                border-radius: 4px;
                padding: 3px 6px;
                font-size: 12px;
                width: 100%;
            `;
            for (let i = 0; i < entries.length; i++) {
                const option = document.createElement('option');
                option.value = String(i);
                option.textContent = entries[i]!.name;
                select.appendChild(option);
            }
            const apply = this.makeButton('Apply to selection', '#334155', () => {
                const entry = entries[parseInt(select.value, 10)];
                if (entry) this.callbacks.onMaterialPicked(entry.material);
            }, 'Change the selected voxels to this block type');
            this.paletteEl.appendChild(select);
            this.paletteEl.appendChild(apply);
        }
    }

    private makeButton(text: string, bg: string, onClick: () => void, title: string): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.title = title;
        btn.style.cssText = `
            background: ${bg};
            color: #e2e8f0;
            border: 1px solid #475569;
            border-radius: 6px;
            padding: 5px 10px;
            font-size: 12px;
            cursor: pointer;
        `;
        btn.onmouseenter = () => { btn.style.filter = 'brightness(1.25)'; };
        btn.onmouseleave = () => { btn.style.filter = 'none'; };
        btn.onclick = onClick;
        return btn;
    }
}
