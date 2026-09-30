/**
 * The inspector's "Edit Source…" and "Re-import…" buttons must not be drawn for a host that
 * cannot service them.
 *
 * Both actions reach the host through `EditorHost.navigate({ assetAction })`, and `navigate()`
 * returns without posting when the announced capabilities say `hostNavigation: false` — which is
 * what `bitmagic dev` announces and what `NullEditorHost` (published games) hardcodes. The wiring
 * in `EditorManager.setVoxelEditCallbacks` passes `onOpenAssetAction` unconditionally, so before
 * this gate the buttons rendered under both hosts and clicking them did nothing at all: the exact
 * silent-dead-button shape `game/docs/editor-host-contract.md` exists to rule out ("no editor
 * surface ever draws a button nothing can service").
 *
 * A source guard rather than an exercised DOM, for the same reason as `VoxelSaveCommit.test.ts`:
 * this project's Jest runs under `testEnvironment: node`, and importing the inspector reaches
 * modules that touch `window` at module scope. `__dirname` rather than `import.meta.url` because
 * ts-jest transpiles this suite to CJS.
 */
import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', 'ObjectInspector.ts'), 'utf-8');

/** The drawing condition guarding one button, found by the exact label it draws. */
function conditionAbove(label: string): string {
    const button = source.indexOf(label);
    expect(button).toBeGreaterThan(-1);
    // The emoji-prefixed textContent literals appear exactly once each; a comment or a title
    // string sharing the words would silently re-anchor this at the wrong condition.
    expect(source.indexOf(label, button + 1)).toBe(-1);
    // The nearest `if (` above the label is the condition that decides whether it renders.
    const start = source.lastIndexOf('if (', button);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, button);
}

describe('the voxel section offers Edit Source and Re-import only where a host can open them', () => {
    it('gates Edit Source on the hostNavigation capability', () => {
        const condition = conditionAbove("'🔧 Edit Source…'");
        // Still the callback wiring, so the gate was added rather than swapped for it…
        expect(condition).toContain('onOpenAssetAction');
        // …and the capability the navigate() call actually checks before posting.
        expect(condition).toContain('canNavigate');
        expect(source).toContain('getEditorHost().capabilities.hostNavigation');
    });

    it('leaves Re-import ungated while no CLI command can re-run an import', () => {
        // The asymmetry is deliberate. Hiding a dead button is right only when the action
        // survives elsewhere: Edit Source does (`bitmagic assets revoxelize` re-bakes from
        // sourceGlbUrl), Re-import does not — `chooseSource` reads only sourceVxlMasterUrl
        // and sourceGlbUrl. Gating it would leave an imported asset with no route to its
        // import settings from anywhere, which is worse than a button that reports it
        // cannot act. Flip this the day `bitmagic assets reimport` exists.
        const condition = conditionAbove("'📥 Re-import…'");
        expect(condition).toContain('onOpenAssetAction');
        expect(condition).not.toContain('canNavigate');
    });

    it('leaves Edit Voxels itself ungated — the session runs under every host', () => {
        const condition = conditionAbove("'✏️ Edit Voxels'");
        expect(condition).not.toContain('canNavigate');
        expect(condition).not.toContain('hostNavigation');
    });
});
