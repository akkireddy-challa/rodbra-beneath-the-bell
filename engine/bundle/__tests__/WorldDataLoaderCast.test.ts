import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ts from 'typescript';

/**
 * world.json is a STATIC import in WorldDataLoader.ts, so its contents are part of the engine's
 * TypeScript program: tsc infers a literal type from whatever the creator's game happens to hold
 * and checks it against GameData. That makes the cast on line ~33 a compile-time gate on runtime
 * data — and a checked `as Partial<GameData>` there is a loaded gun, because the file is engine
 * code that neither the creator nor the coding agent may edit.
 *
 * It fired: `Asset.vehicleFitment.bodyBounds` is `{ min: [number, number, number] }` (see
 * types/vehicleFitment.ts). tsc infers `number[]` from a JSON array, and `number[]` is not
 * COMPARABLE to a 3-tuple, so the first vehicle asset VehicleDesignTool wrote into world.json
 * made every later type check fail with TS2352 in a file nobody could fix. The session outcome
 * gate then rolled back every turn that touched code, and the game was permanently unedittable.
 *
 * The ajv schema generated from GameData cannot catch this class: it validates VALUES, and
 * `[-0.9, 0.3, -2.1]` is a perfectly valid 3-element array. Only the compiler sees the widened
 * `number[]`. Hence the fix is to cast through `unknown` and leave validation to ajv.
 */
const GAME_DIR = path.join(__dirname, '..', '..', '..');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'WorldDataLoader.ts'), 'utf-8');

/** A world.json carrying exactly what VehicleDesignTool writes for a drivable vehicle. */
const VEHICLE_WORLD_JSON = {
  worldProfileData: {
    playerSpawnPosition: { x: 0, y: 0.5, z: 4 },
    spawnPoints: [
      {
        id: 'vehicle_player_car',
        type: 'vehicle',
        name: 'player_car',
        position: { x: 5, y: 1, z: 4 },
        rotationY: 0,
        params: { vehicleType: 'player_car', assetId: 'asset_1', drivable: true },
      },
    ],
  },
  assets: [
    {
      id: 'asset_1',
      name: 'player_car',
      url: 'https://example.invalid/player_car.vxl',
      type: 'vxl',
      // The field that widens to number[] and broke the checked cast.
      vehicleFitment: {
        version: 1,
        platform: { width: 1.8, length: 4.2 },
        axles: [{ z: 1.4, y: 0.32, radius: 0.32, width: 0.22, track: 1.5, steering: true, driven: false, dual: false, wheelStyle: 'alloy5' }],
        bodyBounds: { min: [-0.9, 0.3, -2.1], max: [0.9, 1.4, 2.1] },
        hasWheelNodes: false,
        collisionBoxes: [{ position: { x: 0, y: 0.8, z: 0 }, size: { x: 1.8, y: 1.0, z: 4.2 } }],
        mass: 1200,
      },
    },
  ],
  environmentObjects: [],
};

/** game.json alongside it — every required GameMetadata field, so only world.json is under test. */
const GAME_JSON = {
  gameId: 'TESTGAME',
  gameGenre: 'Voxel',
  gameName: 'Test Game',
  gameDescription: '',
  characterUrl: '',
  thumbnailUrl: '',
};

const tsPath = (p: string): string => p.replace(/\\/g, '/');

/**
 * Type-checks the REAL WorldDataLoader.ts against a world.json holding a vehicle asset, by
 * pointing the `work/` alias at a fixture directory instead of the creator's live src/work.
 *
 * A `checked.ts` probe compiles in the same program: it imports the same fixture and casts it the
 * way the fix replaced. That is the control — it must fail, or the fixture is not actually being
 * typed and the real assertion proves nothing. Sharing one program keeps this to a single walk of
 * the (multi-second) engine type graph.
 */
function compileAgainstVehicleWorld(): { loader: ts.Diagnostic[]; checked: ts.Diagnostic[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-data-loader-cast-'));
  const loaderPath = path.join(__dirname, '..', 'WorldDataLoader.ts');
  const checkedProbe = path.join(dir, 'checked.ts');
  try {
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(VEHICLE_WORLD_JSON));
    fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify(GAME_JSON));
    fs.writeFileSync(
      checkedProbe,
      "import worldData from './world.json';\n"
        + "import type { GameData } from 'types/game.js';\n"
        + 'export const data = worldData as Partial<GameData>;\n',
    );

    // Read the engine's real tsconfig rather than restating its options, so this test cannot drift
    // from the compiler settings the pod and CI actually use. Only `work/*` is redirected.
    const { config } = ts.readConfigFile(path.join(GAME_DIR, 'tsconfig.json'), ts.sys.readFile.bind(ts.sys));
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, GAME_DIR);
    const program = ts.createProgram([loaderPath, checkedProbe], {
      ...parsed.options,
      paths: { ...parsed.options.paths, 'work/*': [path.join(dir, '*')] },
      noEmit: true,
      incremental: false,
      tsBuildInfoFile: undefined,
    });

    // Only TS2352 ("neither type sufficiently overlaps"). The wider engine graph reports unrelated
    // ambient noise in this program (navigator.gpu, import.meta.env) because these files are
    // compiled outside the vite/@webgpu global setup.
    const casts = ts.getPreEmitDiagnostics(program).filter((d) => d.code === 2352);
    return {
      loader: casts.filter((d) => d.file?.fileName === tsPath(loaderPath)),
      checked: casts.filter((d) => d.file?.fileName === tsPath(checkedProbe)),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('world.json content cannot break the engine bundle compile', () => {
  it('casts world.json through unknown', () => {
    // The source-shape half of the guard: cheap, and it names the exact regression. A checked
    // cast reintroduces the failure for whatever the NEXT tuple-typed field turns out to be.
    expect(SOURCE).toContain('worldData as unknown as Partial<GameData>');
    expect(SOURCE).not.toMatch(/worldData as Partial<GameData>/);
  });

  it('compiles against a world.json holding a vehicle asset', () => {
    const { loader, checked } = compileAgainstVehicleWorld();

    // The regression itself, on the shipped file.
    expect(loader.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))).toEqual([]);

    // Control. Without it this passes vacuously the moment the fixture stops being typed — an
    // unresolved JSON import falls back to `declare module '*.json'` (types/global.d.ts), which
    // is `any`, and then no cast form of any kind can fail.
    expect(checked).toHaveLength(1);
    expect(ts.flattenDiagnosticMessageText(checked[0]?.messageText, ' ')).toContain(
      "Type 'number[]' is not comparable to type '[number, number, number]'",
    );
  }, 120_000);
});
