import * as fs from 'fs';
import * as path from 'path';

/**
 * `GameEngine.onWindowResize()` must not call `bloomNode.setSize()`.
 *
 * Three.js's BloomNode builds `_separableBlurMaterials` lazily in `setup()`, which runs on the
 * first frame that renders the post chain, and its `setSize()` indexes into that array with no
 * guard. Called before that first render it throws
 * "Cannot read properties of undefined (reading 'invSize')".
 *
 * The engine reaches exactly that state on its own: the size self-heal in the animate loop calls
 * `onWindowResize()` when the renderer's size diverges from the viewport, which is precisely what
 * happens on a cold start inside an iframe (viewport momentarily 0, renderer floored to 1x1) —
 * before anything has rendered. The throw also aborts the rest of `onWindowResize`, so
 * `outlinePass.setSize()` silently never runs.
 *
 * This is a source-shape test because the failure needs a real WebGPU/WebGL renderer, a real
 * BloomNode mid-setup, and an iframe cold start — none of which a unit test can stand up. It is
 * the same reason the bug reached a published game: `bitmagic dev` and `bitmagic verify` serve the
 * page directly with a real viewport, so the self-heal path never fires before the first frame and
 * the whole local pipeline is blind to it by construction.
 *
 * BloomNode.updateBefore() re-syncs its size from `renderer.getDrawingBufferSize()` on every frame
 * it renders, so nothing is lost by leaving it alone.
 */
const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'GameEngine.ts'),
  'utf-8',
);

/** Source with `//` line comments stripped, so the explanatory comment can name the banned call. */
const CODE_ONLY = SOURCE.split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

describe('onWindowResize does not resize the bloom node', () => {
  it('never calls bloomNode.setSize', () => {
    expect(CODE_ONLY).not.toContain('bloomNode.setSize');
  });

  it('still resizes the renderer and the outline pass', () => {
    // The guard above must not be satisfied by deleting the whole resize fan-out: the throw used
    // to abort before outlinePass.setSize, and restoring that call is half the point of the fix.
    expect(CODE_ONLY).toContain('this.renderer.setSize(width, height)');
    expect(CODE_ONLY).toContain('this.outlinePass.setSize(width, height)');
  });
});
