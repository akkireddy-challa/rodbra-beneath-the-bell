import * as fs from 'fs';
import * as path from 'path';

/**
 * The engine source is compiled in TWO layouts, and only one of them makes a relative path to the
 * creator's game correct:
 *
 *   monorepo            src/bundle/WorldDataLoader.ts   ../work/ -> src/work/            exists
 *   scaffolded project  engine/bundle/WorldDataLoader.ts ../work/ -> engine/work/        DOES NOT
 *
 * In a scaffolded project the game lives at src/work/ and the vendored engine at engine/, so a
 * relative import resolves into a directory nothing ever creates and Rollup fails with
 * "Could not resolve ../work/world.json". The `work/` alias points at the right place in both
 * layouts; an alias cannot rewrite a RELATIVE specifier, which is why the alias form is required
 * rather than merely preferred.
 *
 * This is a source-shape test because no behavioural test can catch it: `types/global.d.ts`
 * declares `module '*.json'`, so tsc types an unresolvable JSON import without complaint and exits
 * 0. The real failure happens only when a bundler tries to read the file — a path that no unit
 * test exercises, which is how the bug reached a released CLI (issue #837).
 */
const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'WorldDataLoader.ts'),
  'utf-8',
);

/** Every `from '...'` specifier in the file, in source order. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
}

describe("WorldDataLoader's imports resolve in both layouts", () => {
  it('imports the game JSON through the work/ alias', () => {
    const specifiers = importSpecifiers(SOURCE);
    expect(specifiers).toContain('work/world.json');
    expect(specifiers).toContain('work/game.json');
  });

  it('never reaches the game through a relative path', () => {
    // The specific regression: '../work/world.json'. Any relative hop into work/ has the same
    // defect, so the assertion covers the shape rather than the one string that caused #837.
    const relativeIntoWork = importSpecifiers(SOURCE).filter((s) => /^\.\.?\//.test(s) && s.includes('work/'));
    expect(relativeIntoWork).toEqual([]);
  });

  it('still resolves its sibling modules relatively', () => {
    // A guard against "fixing" this by aliasing everything: imports that live NEXT to this file
    // are correct as relative paths in both layouts, because the file moves together with them.
    expect(importSpecifiers(SOURCE)).toContain('./BundledAssetData.js');
  });
});
