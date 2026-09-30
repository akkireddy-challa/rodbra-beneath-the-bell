/**
 * A failed save must never commit the session.
 *
 * The bug this guards: `endVoxelSession` called `markCommitted()` and `exit({ committed: true })`
 * unconditionally, while `VoxelTerrainSystem.saveToS3` returns `null` on any upload failure and only
 * logs a warning. So a 500 from the agent, an expired token or no network threw a creator's terrain
 * sculpt away with nothing on screen to say so — in the web Creator as much as in `bitmagic dev`.
 * The voxels live only in the tab until the upload lands, so committing on failure is data loss.
 *
 * Read off the source rather than exercised, deliberately. `EditorManager` cannot be imported under
 * Jest: this project's `testEnvironment` is `node`, and the import graph reaches
 * `DebugGameInfoPanel`, which touches `window` at module scope — "ReferenceError: window is not
 * defined" before a single line runs. `jest-environment-jsdom` is not installed here, and pulling it
 * in for one test is a bigger change than this one. Until then a source guard on the exact invariant
 * beats no guard, and it is the same trick `cli/src/editor/__tests__/engine-voxel-contract.test.ts`
 * uses across the package boundary.
 *
 * `__dirname`, not `import.meta.url`: `game` runs plain `jest`, so ts-jest transpiles to CJS and
 * `import.meta` is a syntax error there. The CLI's suite sets `--experimental-vm-modules` and can
 * use it; this one cannot. Every other file-reading test here (`WorldDataLoaderCast`,
 * `RapierReentrancyGuard`) uses `__dirname` for the same reason.
 */
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', 'EditorManager.ts'), 'utf-8');

/** The body of one method, from its signature to the next same-indent closing brace. */
function methodBody(signature: string): string {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n    }', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('ending a voxel session that failed to save', () => {
    const body = methodBody('async endVoxelSession(save: boolean)');

    it('bails out before committing when the save reports failure', () => {
        const guard = body.indexOf('if (!saved.ok)');
        const commit = body.indexOf('markCommitted()');
        expect(guard).toBeGreaterThan(-1);
        expect(commit).toBeGreaterThan(guard);
        // The guard must actually leave the method — falling through to `exit({ committed: true })`
        // would drop the session and the edits with it.
        expect(body.slice(guard, commit)).toContain('return;');
    });

    it('tells the creator why, in the toolbar they are already looking at', () => {
        // A console warning is not a user interface. `setNotice` is the toolbar's own warning banner.
        expect(body).toContain('setNotice(');
    });
});

describe('what a terrain save reports', () => {
    it('distinguishes success from failure, rather than returning the same shape either way', () => {
        expect(source).toMatch(/private async saveTerrainChanges\(sessionId\?: string\): Promise<TerrainSaveResult>/);
        expect(source).toMatch(/export interface TerrainSaveResult extends VoxelSaveResult/);
        expect(source).toMatch(/ok: boolean;/);
    });

    it('only claims success once the upload produced a URL', () => {
        const body = methodBody('private async saveTerrainChanges(sessionId?: string)');
        const failure = body.indexOf('if (!voxelUrl)');
        const success = body.indexOf('return { ok: true');
        expect(failure).toBeGreaterThan(-1);
        expect(success).toBeGreaterThan(failure);
    });

    it('journals the failure, which no world.json diff could ever reveal', () => {
        // Nothing is written when an upload fails, so an agent watching the project's files would
        // otherwise never learn that its creator just lost work.
        expect(source).toContain("event: 'terrain.saveFailed'");
    });
});
