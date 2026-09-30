/**
 * The published bundle's Rapier flavor must match the physics world the engine
 * actually boots — for the SAME game.json.
 *
 * This pins a real black-screen regression. The publish lane reads the flavor
 * inputs straight off game.json; the ENGINE reads them off the MERGED GameData.
 * `mergeGameData` copies metadata field by field, so a field added to the types
 * but not to that copy is visible to publish and invisible at runtime. The
 * bundle then ships one flavor while the engine boots the other — and the
 * dropped package is stubbed to `export default null`, so the symptom is not a
 * degraded game but
 *   TypeError: Cannot read properties of null (reading 'init')
 * and a black screen on a published game.
 *
 * Any future field that steers the flavor has to be asserted here too.
 *
 * The file grew past that single field into the whole class of bug it belongs
 * to: ONE VALUE, READ FROM TWO PLACES THAT CAN DISAGREE. Four hand-written
 * copies of game.json exist (this merge, the Creator's own loader, the agent's
 * new-game template copy, the publish lanes' direct read), plus one stub that
 * turns "the engine touched the other flavor" from a slow path into a null
 * dereference. Each section below pins one of those seams.
 *
 * TWO TESTS HERE ARE CURRENTLY RED, AND THAT IS THE POINT — they name two live
 * omissions of the very field that caused the outage:
 *   - creator/src/editor/utils/gameDataLoader.ts merges game.json for the WEB
 *     CREATOR and assigns gameDimension + physicsMode but not physics2d, so the
 *     Creator boots 3D physics for a game the published bundle runs in 2D.
 *   - game-play-agent .../middleware/session-file-manager.ts builds a new
 *     game's game.json field by field and carries physicsMode but not
 *     physics2d, so a template that opts in cannot pass the opt-in on.
 * One assignment each. Both go green with no change to this file.
 */
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { mergeGameData, extractMetadataFromWorldData, type GameData, type GameMetadata } from 'types/game.js';
import { effectivePhysicsMode, rapierFlavorForPhysicsMode } from 'engine/physics/PhysicsModeRule.js';

/** Monorepo root: game/src/engine/__tests__ → ../../../.. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function metadata(over: Partial<GameMetadata> = {}): GameMetadata {
    return {
        gameId: 'G1', gameGenre: 'Voxel', gameName: 'n', gameDescription: '',
        characterUrl: '', thumbnailUrl: '',
        ...over,
    } as GameMetadata;
}

/** The flavor the ENGINE boots for data it has already merged. */
function bootedFlavor(data: Pick<GameData, 'gameGenre' | 'physicsMode' | 'physics2d'>): '2d' | '3d' {
    return rapierFlavorForPhysicsMode(
        effectivePhysicsMode(data.gameGenre, data.physicsMode, data.physics2d === true),
    );
}

/** The flavor the PUBLISH lanes ship, reading raw game.json — never the merge. */
function shippedFlavor(raw: Record<string, unknown>): '2d' | '3d' {
    const mode = raw.physicsMode === '2d' || raw.physicsMode === '3d' || raw.physicsMode === 'none'
        ? raw.physicsMode
        : undefined;
    return rapierFlavorForPhysicsMode(
        effectivePhysicsMode(typeof raw.gameGenre === 'string' ? raw.gameGenre : '', mode, raw.physics2d === true),
    );
}

describe('physics flavor inputs survive the game-data merge', () => {
    it('carries physicsMode AND physics2d onto GameData', () => {
        const merged = mergeGameData(metadata({ physicsMode: '2d', physics2d: true }), {});
        expect(merged.physicsMode).toBe('2d');
        expect(merged.physics2d).toBe(true);
    });

    it('the engine boots the flavor the publish lane would ship, for every combination', () => {
        for (const physics2d of [undefined, true] as const) {
            for (const physicsMode of [undefined, '2d', '3d'] as const) {
                const meta = metadata({
                    ...(physicsMode ? { physicsMode } : {}),
                    ...(physics2d !== undefined ? { physics2d } : {}),
                });
                // What PUBLISH sees — game.json, read directly.
                const shipped = rapierFlavorForPhysicsMode(
                    effectivePhysicsMode(meta.gameGenre, meta.physicsMode, meta.physics2d === true),
                );
                // What the ENGINE sees — the merged data it actually loads from.
                const merged = mergeGameData(meta, {});
                const booted = rapierFlavorForPhysicsMode(
                    effectivePhysicsMode(merged.gameGenre, merged.physicsMode, merged.physics2d === true),
                );
                expect(booted).toBe(shipped);
            }
        }
    });

    it('a game whose template has NOT opted in boots 3D, whatever it declares', () => {
        // The protection for every sidescroller made since 2026-06-25: those
        // carry physicsMode '2d' with frozen 3D-typed template code.
        const merged = mergeGameData(metadata({ physicsMode: '2d' }), {});
        expect(effectivePhysicsMode(merged.gameGenre, merged.physicsMode, merged.physics2d === true)).toBe('3d');
    });
});

/**
 * The generalisation of the escaped bug: it was not "physics2d was forgotten",
 * it was "a hand-written field-by-field copy can forget ANY field".
 *
 * The probe map is typed `Required<GameMetadata>`, but that annotation is NOT
 * the guard: `tsc --noEmit` excludes the __tests__ trees, and ts-jest in this
 * project transpiles without type-checking, so a missing property here compiles
 * and runs silently (verified by deleting one). The guard is the interface's
 * field list, read out of `types/game.ts` with the TypeScript AST at run time
 * and compared against the probes — a new GameMetadata field fails the first
 * test until it is probed, and fails the second if the merge drops it.
 */
const METADATA_PROBES: Required<GameMetadata> = {
    gameId: 'PROBE-GAME-ID',
    gameGenre: 'Voxel',
    gameName: 'Probe Game',
    gameDescription: 'probe description',
    characterUrl: 'https://example.invalid/probe-character.glb',
    thumbnailUrl: 'https://example.invalid/probe-thumb.jpg',
    // Deliberately `false`, not `true`: the merge guards this one on
    // `!== undefined`, and a truthiness check would silently drop a legitimate
    // `false` — which is the value that means "the world is authored, do not
    // generate it procedurally", i.e. the one whose loss empties the world.
    environmentObjectsGeneratedProcedurally: false,
    gameDimension: '2d',
    physicsMode: '2d',
    physics2d: true,
    artStyle: 'low-poly',
};

/** The property names declared on an interface in `game/src/types/game.ts`. */
function interfaceFields(interfaceName: string): string[] {
    const file = path.join(REPO_ROOT, 'game', 'src', 'types', 'game.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(
        (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === interfaceName,
    );
    if (!declaration) throw new Error(`interface ${interfaceName} not found in ${file}`);
    return declaration.members
        .filter(ts.isPropertySignature)
        .map(member => (ts.isIdentifier(member.name) ? member.name.text : ''))
        .filter(name => name !== '');
}

describe('every game.json field reaches the runtime GameData', () => {
    it('probes every field GameMetadata actually declares', () => {
        // Not decoration: this is what makes the next test exhaustive. Without
        // it, a new metadata field is simply never asked about.
        expect(interfaceFields('GameMetadata').sort()).toEqual(Object.keys(METADATA_PROBES).sort());
    });

    it('mergeGameData copies all of GameMetadata, not just the remembered fields', () => {
        const merged = mergeGameData({ ...METADATA_PROBES }, {}) as unknown as Record<string, unknown>;
        const dropped = (Object.keys(METADATA_PROBES) as Array<keyof GameMetadata>)
            .filter(key => merged[key] !== METADATA_PROBES[key]);
        expect(dropped).toEqual([]);
    });

    it('the same comparison DOES catch a lossy copy (positive control)', () => {
        // `extractMetadataFromWorldData` is the other hand-written copy in
        // types/game.ts, and it carries neither the flavor fields nor the art
        // style. Aiming the identical technique at it has to produce a
        // NON-empty list — otherwise the test above is proving nothing about
        // anything.
        const round = extractMetadataFromWorldData(
            { ...METADATA_PROBES } as unknown as GameData,
        ) as unknown as Record<string, unknown>;
        const dropped = (Object.keys(METADATA_PROBES) as Array<keyof GameMetadata>)
            .filter(key => round[key] !== METADATA_PROBES[key]);
        expect(dropped.sort()).toEqual(['artStyle', 'gameDimension', 'physics2d', 'physicsMode']);
    });

    it('survives a real world.json payload rather than an empty one', () => {
        // The merge starts from `{...worldData}` and writes metadata over it;
        // a spread order regression would show up here and not above.
        const merged = mergeGameData({ ...METADATA_PROBES }, {
            worldProfileData: { playerSpawnPosition: { x: 1, y: 2, z: 3 } },
            assets: [],
        }) as unknown as Record<string, unknown>;
        const dropped = (Object.keys(METADATA_PROBES) as Array<keyof GameMetadata>)
            .filter(key => merged[key] !== METADATA_PROBES[key]);
        expect(dropped).toEqual([]);
    });
});

/**
 * The reverse hazard. world.json is the AI-EDITABLE file; game.json is not.
 * The publish lanes resolve the Rapier flavor from game.json ALONE, so the
 * moment world.json can contribute a flavor input, an agent edit to world.json
 * moves the engine without moving the bundle — the same disagreement, arriving
 * from the other side. The merge must therefore let game.json overwrite these
 * fields unconditionally, absent value included.
 */
describe('game.json is the only source of the physics flavor', () => {
    it('a flavor declared in world.json is ignored, so publish and engine still agree', () => {
        const worldData = {
            physicsMode: '2d', physics2d: true, gameDimension: '2d',
        } as unknown as Partial<GameData>;
        const merged = mergeGameData(metadata(), worldData);
        expect(merged.physicsMode).toBeUndefined();
        expect(merged.physics2d).toBeUndefined();
        expect(bootedFlavor(merged)).toBe(shippedFlavor({ gameGenre: 'Voxel' }));
        expect(bootedFlavor(merged)).toBe('3d');
    });

    it('the legacy no-game.json path cannot declare 2D either', () => {
        // Dev/legacy games without a game.json synthesise metadata FROM
        // world.json. That synthesis deliberately carries no flavor fields, so
        // the merge blanks them and the engine falls back to the genre default.
        const worldData = {
            gameGenre: 'Voxel', characterUrl: '', physicsMode: '2d', physics2d: true,
        } as unknown as GameData;
        const meta = extractMetadataFromWorldData(worldData);
        expect(meta).not.toBeNull();
        const merged = mergeGameData(meta, worldData);
        expect(merged.physicsMode).toBeUndefined();
        expect(merged.physics2d).toBeUndefined();
        expect(bootedFlavor(merged)).toBe('3d');
    });
});

/**
 * The shipped templates, through both readers. Every game starts as one of
 * these files, so a template that disagrees with itself ships the disagreement
 * to every game made from it.
 */
describe('shipped templates boot the flavor their bundle would ship', () => {
    function templateGameJsons(): Array<{ label: string; raw: Record<string, unknown> }> {
        const out: Array<{ label: string; raw: Record<string, unknown> }> = [];
        const configDir = path.join(REPO_ROOT, 'game', 'config-templates');
        for (const file of fs.readdirSync(configDir)) {
            if (!file.endsWith('-game.json')) continue;
            out.push({ label: `config-templates/${file}`, raw: JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8')) });
        }
        const templatesDir = path.join(REPO_ROOT, 'templates');
        for (const name of fs.readdirSync(templatesDir)) {
            const p = path.join(templatesDir, name, 'source', 'game.json');
            if (!fs.existsSync(p)) continue;
            out.push({ label: `templates/${name}`, raw: JSON.parse(fs.readFileSync(p, 'utf8')) });
        }
        return out;
    }

    it('finds the templates at all (a silent empty sweep would prove nothing)', () => {
        expect(templateGameJsons().length).toBeGreaterThan(4);
    });

    it('engine-booted flavor === bundle-shipped flavor for every template', () => {
        const disagreements = templateGameJsons()
            .map(({ label, raw }) => {
                const merged = mergeGameData(raw as unknown as GameMetadata, {});
                return { label, booted: bootedFlavor(merged), shipped: shippedFlavor(raw) };
            })
            .filter(row => row.booted !== row.shipped);
        expect(disagreements).toEqual([]);
    });

    it('the sidescroller template is a 2D-DIMENSION game on the 2D physics world', () => {
        // `gameDimension: '2d'` routes the World-Forger's side-on lane;
        // `physicsMode: '2d'` + `physics2d: true` boot Rapier 2D, which the
        // template's code drives through the plane-locked facade
        // (engine/physics/PlaneLockedPhysics.ts). The text scans below are
        // what guarantee the Creator's loader and the agent's new-game copy
        // carry the opt-in — without it the engine downgrades to 3D and the
        // publish lane ships the 3D flavour.
        const raw = JSON.parse(
            fs.readFileSync(path.join(REPO_ROOT, 'templates', 'sidescroller', 'source', 'game.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(raw.gameDimension).toBe('2d');
        expect(raw.physicsMode).toBe('2d');
        expect(raw.physics2d).toBe(true);
        expect(shippedFlavor(raw)).toBe('2d');
        expect(bootedFlavor(mergeGameData(raw as unknown as GameMetadata, {}))).toBe('2d');
    });
});

/**
 * The OTHER hand-written copies of game.json. Neither can be imported from
 * here (separate TypeScript projects), so they are read as text — a weaker
 * check than the merge test above, but the only one that can see them at all,
 * and the omission it looks for is exactly the one that shipped.
 *
 * `creator/src/editor/utils/gameDataLoader.ts` is the merge the WEB CREATOR
 * uses: its result is posted to the engine iframe as LOAD_GAME `gameData` and
 * goes straight into `GameEngine.loadGame`. It is a third reader of the same
 * value, and it must not know less than `mergeGameData` does.
 */
describe('the other game.json copies carry the flavor inputs too', () => {
    /** The fields `effectivePhysicsMode` reads. Losing any one of them moves the engine. */
    const FLAVOR_INPUTS = ['gameGenre', 'physicsMode', 'physics2d'] as const;

    it("the Creator's own merge assigns every flavor input", () => {
        const file = path.join(REPO_ROOT, 'creator', 'src', 'editor', 'utils', 'gameDataLoader.ts');
        const src = fs.readFileSync(file, 'utf8');
        const missing = FLAVOR_INPUTS.filter(field => !new RegExp(`freshGameData\\.${field}\\s*=`).test(src));
        expect(missing).toEqual([]);
    });

    it("the agent's new-game template copy carries every flavor input", () => {
        // `prepareTemplateJsonFiles` builds a brand-new game.json field by
        // field from the genre config template. A field the template declares
        // but this copy does not know about never reaches the new game — and
        // the new game then disagrees with the template it was made from.
        const file = path.join(REPO_ROOT, 'game-play-agent', 'src', 'mastra', 'middleware', 'session-file-manager.ts');
        const src = fs.readFileSync(file, 'utf8');
        const missing = FLAVOR_INPUTS.filter(
            // Either `gameMetadata.<field> = …` or a `<field>,` / `<field>: …`
            // entry in the object literal that becomes game.json.
            field => !new RegExp(`gameMetadata\\.${field}\\s*=|^\\s*${field}\\s*[,:]`, 'm').test(src),
        );
        expect(missing).toEqual([]);
    });

    it("the agent's get-game-config merge carries every flavor input", () => {
        // `GET /api/get-game-config` is what every headless and lab load posts
        // as LOAD_GAME. It merged gameDimension and physicsMode field by field
        // and forgot physics2d — so those lanes booted the 3D solver for a game
        // the Creator (which re-reads game.json itself) booted on 2D. Same
        // omission class as the black-screened publish.
        const file = path.join(REPO_ROOT, 'game-play-agent', 'src', 'mastra', 'controllers', 'WorldController.ts');
        const src = fs.readFileSync(file, 'utf8');
        const missing = FLAVOR_INPUTS.filter(field => !new RegExp(`mergedConfig\\.${field}\\s*=`).test(src));
        expect(missing).toEqual([]);
    });

    it("the template picker's merge carries every flavor input", () => {
        // `GET /api/game-templates` spreads the template's game.json into the
        // picker's view field by field; a field it does not know about is one
        // the picked game silently boots without.
        const file = path.join(REPO_ROOT, 'game-play-agent', 'src', 'mastra', 'controllers', 'GameTemplateController.ts');
        const src = fs.readFileSync(file, 'utf8');
        const missing = FLAVOR_INPUTS.filter(field => !new RegExp(`\\b${field}\\s*:`).test(src));
        expect(missing).toEqual([]);
    });
});

/**
 * What makes a flavor disagreement fatal rather than merely wasteful: the
 * publish configs stub the dropped `-compat` package to `export default null`.
 * That is only safe while no module ever touches its Rapier import at MODULE
 * SCOPE — a single top-level `RAPIER.something` in any engine file turns every
 * single-flavor bundle of the other flavor into a black screen at load, with a
 * clean build, a green unit suite and nothing greppable in the output.
 *
 * The vite plugins (`game/vite.rapier-flavor.js` and the vendored copy the CLI
 * renders) both state this property as an audited fact. This is the audit.
 */
describe('the dropped Rapier package can safely be a null stub', () => {
    const RAPIER_PACKAGES = ['@dimforge/rapier3d-compat', '@dimforge/rapier2d-compat'];

    /** Every .ts under game/src, minus the test/mock trees the bundle never sees. */
    function sourceFiles(dir: string, out: string[] = []): string[] {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '__mocks__') continue;
                sourceFiles(path.join(dir, entry.name), out);
            } else if (entry.name.endsWith('.ts')) {
                out.push(path.join(dir, entry.name));
            }
        }
        return out;
    }

    /**
     * The names a file binds to a Rapier package as a VALUE (`import RAPIER
     * from …` / `import * as RAPIER from …`). `import type` bindings are erased
     * before the bundler sees them and cannot dereference anything.
     */
    function valueBindings(source: ts.SourceFile): string[] {
        const names: string[] = [];
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement)) continue;
            const specifier = statement.moduleSpecifier;
            if (!ts.isStringLiteral(specifier) || !RAPIER_PACKAGES.includes(specifier.text)) continue;
            const clause = statement.importClause;
            if (!clause || clause.isTypeOnly) continue;
            if (clause.name) names.push(clause.name.text);
            if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                names.push(clause.namedBindings.name.text);
            }
        }
        return names;
    }

    /**
     * Does this identifier DEREFERENCE the binding — read a property off it,
     * call it, or destructure it? A bare reference (`export { RAPIER }`,
     * `const R = RAPIER`, `if (RAPIER)`) just moves the null around and is
     * harmless; only a dereference throws.
     */
    function dereferences(node: ts.Node): boolean {
        const parent = node.parent;
        if (!parent) return false;
        if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
            return parent.expression === node;
        }
        if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
            return parent.expression === node;
        }
        // `const { ColliderDesc } = RAPIER` reads the null just as hard.
        if (ts.isVariableDeclaration(parent)) {
            return parent.initializer === node && !ts.isIdentifier(parent.name);
        }
        if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) return true;
        return false;
    }

    /**
     * Does this identifier run when the MODULE is evaluated?
     *
     * Anything inside a function body, or a non-static class field
     * initializer, is deferred to a call the game only makes in the flavor it
     * booted. Type positions are erased entirely. A static field initializer
     * or a static block is NOT deferred — those run at class evaluation, i.e.
     * at module load — so they deliberately fall through to `true`.
     */
    function runsAtModuleLoad(node: ts.Node): boolean {
        for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
            if (ts.isTypeNode(cursor)) return false;
            if (ts.isImportDeclaration(cursor) || ts.isExportDeclaration(cursor)) return false;
            if (ts.isFunctionLike(cursor)) return false;
            if (ts.isPropertyDeclaration(cursor)) {
                const isStatic = cursor.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword) === true;
                if (!isStatic) return false;
            }
        }
        return true;
    }

    /** The scanner itself, over text — so it can be aimed at fixtures as well as at the tree. */
    function moduleScopeUsesInSource(label: string, text: string): string[] {
        if (!text.includes('@dimforge/rapier')) return [];
        const source = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true);
        const bound = new Set(valueBindings(source));
        if (bound.size === 0) return [];
        const hits: string[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isIdentifier(node) && bound.has(node.text) && dereferences(node) && runsAtModuleLoad(node)) {
                const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
                hits.push(`${label}:${line + 1} ${node.text}`);
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(source, visit);
        return hits;
    }

    const IMPORT_LINE = "import RAPIER from '@dimforge/rapier3d-compat';\n";

    // A detector that has never been shown to detect anything is worth
    // nothing — these fixtures are the proof that the sweep below can fail.
    it.each([
        ['a module-scope property read', 'const D = RAPIER.ColliderDesc;'],
        ['a module-scope call', 'RAPIER.init();'],
        ['a module-scope destructure', 'const { ColliderDesc } = RAPIER;'],
        ['a static field initializer', 'class A { static D = RAPIER.ColliderDesc; }'],
        ['a top-level index read', "const D = RAPIER['ColliderDesc'];"],
    ])('flags %s', (_label, body) => {
        expect(moduleScopeUsesInSource('fixture.ts', IMPORT_LINE + body)).toHaveLength(1);
    });

    it.each([
        ['a function body', 'export function f() { return RAPIER.ColliderDesc; }'],
        ['a method body', 'class A { f() { return RAPIER.ColliderDesc.cuboid(1, 1, 1); } }'],
        ['an instance field initializer', 'class A { d = RAPIER.ColliderDesc; }'],
        ['a type annotation', 'export function f(b: RAPIER.RigidBody): RAPIER.Collider[] { return []; }'],
        ['a typeof query', 'let inst: typeof RAPIER | null = null;'],
        ['a bare re-export', 'export { RAPIER };'],
    ])('does not flag %s', (_label, body) => {
        expect(moduleScopeUsesInSource('fixture.ts', IMPORT_LINE + body)).toEqual([]);
    });

    it('ignores a type-only import entirely', () => {
        const text = "import type RAPIER from '@dimforge/rapier3d-compat';\nconst D = RAPIER.ColliderDesc;";
        expect(moduleScopeUsesInSource('fixture.ts', text)).toEqual([]);
    });

    it('scans the engine sources it claims to scan', () => {
        const scanned = sourceFiles(path.join(REPO_ROOT, 'game', 'src'))
            .filter(f => fs.readFileSync(f, 'utf8').includes('@dimforge/rapier'));
        expect(scanned.length).toBeGreaterThan(40);
    });

    it('no module touches a Rapier value at module scope', () => {
        const violations = sourceFiles(path.join(REPO_ROOT, 'game', 'src'))
            .flatMap(file => moduleScopeUsesInSource(path.relative(REPO_ROOT, file), fs.readFileSync(file, 'utf8')));
        expect(violations).toEqual([]);
    });
});
