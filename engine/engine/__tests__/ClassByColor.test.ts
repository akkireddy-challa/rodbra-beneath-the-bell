import { applyClassByColor, MAX_LEVEL_MATERIAL_CLASSES } from 'engine/vxlscene/classByColor.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';

/**
 * The matcher is what turns the forger's "this colour is stone" into per-palette-cell
 * class assignments — with the tolerance that survives build-time jitter, deterministic
 * collision rules, and the budget collapse that keeps the renderer's batch split bounded.
 */

/** The cell an authored hex quantizes to, via the same path the matcher uses. */
function cellOf(hex: string): number {
    const v = parseInt(hex.slice(1), 16);
    return rgb888ToAtlasCell((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
}

/** A cell shifted by whole RGB444 steps per channel (caller keeps channels in range). */
function shift(cell: number, dr: number, dg: number, db: number): number {
    return (((cell >> 8) & 0xf) + dr) * 256 + (((cell >> 4) & 0xf) + dg) * 16 + ((cell & 0xf) + db);
}

const ROCK = '#7a7a72';
const WOOD = '#8a5a30';

describe('applyClassByColor matching', () => {
    it('assigns an exact-cell match and reports the class list by coverage', () => {
        const cells = [cellOf(ROCK), cellOf(WOOD), 0x0f0];
        const res = applyClassByColor(cells, [100, 40, 7], { [ROCK]: 'stone', [WOOD]: 'wood' });
        expect(res.classNames).toEqual(['stone', 'wood']); // coverage 100 > 40
        expect(Array.from(res.classIdxByPaletteEntry)).toEqual([1, 2, 0]);
        expect(res.unmatched).toEqual([]);
        expect(res.notes).toEqual([]);
    });

    it('claims cells within ±1 RGB444 step per channel (build-time jitter)', () => {
        const base = cellOf(ROCK);
        const jittered = shift(base, 1, 0, -1);
        const res = applyClassByColor([base, jittered], [1, 1], { [ROCK]: 'stone' });
        expect(Array.from(res.classIdxByPaletteEntry)).toEqual([1, 1]);
        expect(res.unmatched).toEqual([]);
    });

    it('leaves a cell more than one step away matte, and reports a never-matching key', () => {
        const base = cellOf(ROCK);
        const farCell = shift(base, 2, 0, 0);
        const res = applyClassByColor([farCell], [1], { [ROCK]: 'stone' });
        expect(Array.from(res.classIdxByPaletteEntry)).toEqual([0]);
        expect(res.unmatched).toEqual([ROCK]);
    });

    it('exact beats tolerance; nearest wins among tolerance claims; ties go to the smaller key', () => {
        const a = cellOf('#446688');
        // `between` is 1 step from `a` and 1 step from `b` — a genuine tie by distance.
        const between = shift(a, 1, 0, 0);
        const b = shift(a, 2, 0, 0);
        const bHex = `#${(((b >> 8) & 0xf) * 17).toString(16).padStart(2, '0')}${(((b >> 4) & 0xf) * 17).toString(16).padStart(2, '0')}${((b & 0xf) * 17).toString(16).padStart(2, '0')}`;
        // Exact beats tolerance: `a` is exactly claimed by its own key even though the
        // other entry is within tolerance of it too.
        const res = applyClassByColor([a, between, b], [1, 1, 1], { '#446688': 'stone', [bHex]: 'wood' });
        expect(res.classIdxByPaletteEntry[0]).toBe(res.classNames.indexOf('stone') + 1);
        expect(res.classIdxByPaletteEntry[2]).toBe(res.classNames.indexOf('wood') + 1);
        // The tie on `between`: '#446688' < bHex lexicographically, so stone wins.
        expect(res.classIdxByPaletteEntry[1]).toBe(res.classNames.indexOf('stone') + 1);
    });

    it('a matte entry matches (pinning its cell) but produces no class', () => {
        const snow = cellOf('#f0f0f5');
        const res = applyClassByColor([snow], [1], { '#f0f0f5': 'matte', '#f0f0e0': 'stone' });
        expect(Array.from(res.classIdxByPaletteEntry)).toEqual([0]);
        // The matte entry matched; the stone entry could not take the pinned cell.
        expect(res.unmatched).toEqual(['#f0f0e0']);
    });

    it('drops an unknown class name with a note instead of silently rendering matte', () => {
        const res = applyClassByColor([cellOf(ROCK)], [1], { [ROCK]: 'adamantium' });
        expect(res.classNames).toEqual([]);
        expect(res.notes.some((n) => n.includes('adamantium'))).toBe(true);
    });

    it('reports a malformed hex key as unmatched', () => {
        const res = applyClassByColor([cellOf(ROCK)], [1], { 'not-a-color': 'stone' });
        expect(res.unmatched).toEqual(['not-a-color']);
    });

    it('normalises class-name case and whitespace', () => {
        const res = applyClassByColor([cellOf(ROCK)], [1], { [ROCK]: ' Stone ' });
        expect(res.classNames).toEqual(['stone']);
    });
});

describe('applyClassByColor budget collapse', () => {
    const CELLS = ['#7a7a72', '#8a5a30', '#c0c0c8', '#d4af37'] as const; // stone, wood, metal, gold

    it('collapses the smallest-coverage class along its chain (gold → metal)', () => {
        const cells = CELLS.map(cellOf);
        const res = applyClassByColor(cells, [100, 80, 60, 5], {
            [CELLS[0]]: 'stone', [CELLS[1]]: 'wood', [CELLS[2]]: 'metal', [CELLS[3]]: 'gold',
        });
        expect(MAX_LEVEL_MATERIAL_CLASSES).toBe(3);
        expect(res.classNames).toEqual(['stone', 'wood', 'metal']);
        // The gold cell now renders as metal, not matte.
        expect(res.classIdxByPaletteEntry[3]).toBe(res.classNames.indexOf('metal') + 1);
        expect(res.notes.some((n) => n.includes('gold collapsed into metal'))).toBe(true);
    });

    it('a chain that ends at matte drops with a note', () => {
        const cells = CELLS.map(cellOf);
        // wood collapses to matte, so with wood as the smallest class it is dropped.
        const res = applyClassByColor(cells, [100, 2, 60, 50], {
            [CELLS[0]]: 'stone', [CELLS[1]]: 'wood', [CELLS[2]]: 'metal', [CELLS[3]]: 'gold',
        });
        expect(res.classNames.sort()).toEqual(['gold', 'metal', 'stone']);
        expect(res.classIdxByPaletteEntry[1]).toBe(0);
        expect(res.notes.some((n) => n.includes('wood dropped to matte'))).toBe(true);
    });

    it('respects a caller-set cap', () => {
        const cells = [cellOf(ROCK), cellOf(WOOD)];
        const res = applyClassByColor(cells, [10, 5], { [ROCK]: 'stone', [WOOD]: 'wood' }, 1);
        expect(res.classNames).toEqual(['stone']);
        // wood → matte (its chain ends there).
        expect(Array.from(res.classIdxByPaletteEntry)).toEqual([1, 0]);
    });
});
