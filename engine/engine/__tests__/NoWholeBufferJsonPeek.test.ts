/**
 * No engine code may JSON-parse a whole asset buffer.
 *
 * Four sites used to open an asset like this:
 *
 *   const json = JSON.parse(new TextDecoder().decode(buffer));
 *
 * It was correct once — `.vxl` was JSON, and `useAtlas` / `voxelSize` had to be known
 * before the `VoxelObject` was constructed. When the JSON format was retired the call
 * could no longer succeed on any input: every buffer reaching it is binary VXL3, so it
 * decoded the entire multi-megabyte asset into a string, threw, and fell into a catch
 * that used defaults. Per asset, on the scenery build, to learn nothing — and the values
 * were then overwritten by `loadFromFile` from the binary header regardless.
 *
 * This is a guard rather than a comment because the pattern SPREAD: it was copied to
 * three further sites, one of them annotated "mirror the AssetSpawner metadata peek".
 * A reviewer reading any single site would see something that looks deliberate.
 *
 * Reading a BOUNDED slice is untouched and still legal — a GLB's JSON chunk is a real
 * embedded document, and `VoxelMessageHandlers` parses it correctly with a windowed
 * `Uint8Array`. What this forbids is decoding a whole buffer of unknown format.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/** `JSON.parse(new TextDecoder().decode(x))` where `x` is a bare buffer, not a slice. */
const WHOLE_BUFFER_PARSE = /JSON\.parse\(\s*new TextDecoder\(\)\.decode\(\s*[A-Za-z_$][\w$]*\s*\)/;

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== '__tests__') sourceFiles(full, out);
        } else if (entry.name.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

describe('asset buffers are never JSON-parsed whole', () => {
    it('finds no whole-buffer TextDecoder+JSON.parse in src/engine', () => {
        const offenders = sourceFiles(join(__dirname, '..'))
            .filter((f) => WHOLE_BUFFER_PARSE.test(readFileSync(f, 'utf8')))
            .map((f) => f.slice(f.indexOf('src/engine')));
        expect(offenders).toEqual([]);
    });

    it('still matches the shape it is meant to catch', () => {
        // Guards that quietly stop matching are worse than no guard, so the pattern is
        // exercised directly — including the bounded-slice form it must NOT flag.
        expect(WHOLE_BUFFER_PARSE.test('const j = JSON.parse(new TextDecoder().decode(buffer));')).toBe(true);
        expect(WHOLE_BUFFER_PARSE.test(
            'const j = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, off + 8, len)));',
        )).toBe(false);
    });
});
