# Hero characters (experimental, opt-in)

`engine/hero/HeroCharacter.ts` is a new adapter for reconstructed game characters. It does not
modify the voxel/low-poly paths, infer skin from material names, or import MetaHuman DNA.
It currently provides explicitly assigned PBR materials, approximate skin backscatter on both
renderer paths, semantic morph controls, temporal smoothing and multiplicative correctives.
Three real source characters now exercise the adapter in the sibling hero lab. This remains an
experimental feature, not a claim of MetaHuman feature or visual parity.

Use the existing skinned `characterUrl` path to load the package's `character.glb`. Keep the
existing player/controller setup and body animation. Once loaded, adopt its actual root:

```ts
import { HeroCharacter } from 'engine/hero/HeroCharacter.js';
import type { HeroCharacterDefinition } from 'engine/hero/HeroCharacterDefinition.js';

// definition is the package's hero.json, decoded/validated by the caller.
// Receive definition: HeroCharacterDefinition as a parameter to the setup method.
const root = this.playerLoader.getSkinnedSkeletonRoot();
if (!root) throw new Error('Hero character requires the loaded skinned model');
const hero = new HeroCharacter(root, definition);

// Supply a complete expression frame, then apply after body/mixer animation each frame.
hero.face.setFrame({ jawOpen: 0.4, mouthSmileLeft: 0.2, mouthSmileRight: 0.2 });
hero.face.advance(deltaTime, 0.06);

// At character teardown, before disposing the engine-loaded model:
hero.dispose();
```

The definition has `type: 'hero-character'`, `version: 1`, a stable `id`, `surfaces`, `controls`
and `correctives`. This is a package discriminator, **not a new accepted world.json character
type**. Explicit adoption is required; no default loader recognizes the sidecar automatically.
If loading a standalone GLB, use `createGltfLoader()` as for every other engine asset.

Surface entries name each unique material, assign its kind (`skin`, `cloth`, `hair`, `eye`,
`teeth`, `leather`, `fur`, `metal`, `other`), roughness, specular intensity and scatter `{color, strength}`.
Color is `#rrggbb`; scalar values are finite [0,1]. Only skin has nonzero scatter. Texture maps,
alpha behavior, normals, UV transforms and vertex colors are preserved from the loaded source.
Roughness is the usual glTF multiplier of its authored roughness map. Eyes receive a clearcoat;
cloth/fur receive sheen; hair receives anisotropy. These are physical surface approximations,
not a dedicated strand-scattering model.

Controls map semantic names to arrays of `{mesh, target, gain}`. Exact, unambiguous mesh and
target names are required. A control may drive several meshes; multiple controls may sum into
one slot. Correctives contain `drivers` and one `binding`, with weight equal to the product of
their normalized driver values. Bound outputs are clamped to 1 and added to the captured neutral
weights. Bind in the neutral pose. This is a compact morph evaluator, not a general rig graph.

`setFrame` replaces the complete expression frame and resets omitted controls to zero. Invalid
names/NaNs/out-of-range values reject the frame before changing state. Merge speech, blink and
expression upstream; there is no audio/viseme generation or automatic blink scheduler yet.
`advance(dt, responseSeconds)` is deterministic and takes engine time; zero response applies
the target exactly. It does not alter body bones or unbound morph slots.

The adapter validates all bindings/material assignments before mutating the scene. It prevents
adopting the same root twice and creates separate material instances. `dispose()` is idempotent,
restores original materials and neutral bound morph values, and disposes only materials it owns.
Textures, geometry and skeletons remain caller-owned. Do not call the face controller after
teardown. Separate characters need separate cloned skinned roots and morph influence arrays.

## Current limits and quality gate

The sibling `character-forger/hero` pipeline now converts three reviewed pilots (elf b0114,
orc knight b1851 and wolf b0050) directly from dense originals and repaired low-poly cages.
Each has 39 facial controls, eye/lid geometry, a mouth cavity/teeth/tongue, independent material
surfaces and short hair/fur fibers. The existing 22-bone rigs and three baked body clips survive
export. Use the local lab at `http://127.0.0.1:8106/` for actual asset comparison and expressions.

The pilot classifier/landmarks require per-anatomy review. There is no general automatic face
retopology, production groom, dynamic wrinkle system, LOD chain or audio lip-sync system.
Source stylization and some faceting remain; extreme combined morphs need artist correction.

The SSS term is a low-cost backscatter approximation, not a diffusion profile. It currently
uses uniform strength per skin material; no per-texel thickness or dynamic wrinkles. The WebGPU
node implementation and WebGL shader adapter use the same tint and exponent. The WebGL adapter
asserts its Three.js light-chunk hook so dependency changes fail visibly.

Run `pnpm run check`, the hero Jest tests and `node scripts/hero-material-smoke.mjs` from `game/`.
The smoke test compiles/renders a synthetic skinned/morphed sphere on actual browser backends and
records which backend ran; fallback is not counted as WebGPU coverage. It is not character QA.
Before production use, reimport the actual exported GLB, test facial combinations/body clips on
both backends and record image evidence and performance against the exact package hash.

Actual package coverage is recorded in `character-forger/hero/reports/package-audit.json` and
`runtime-results.json`. The lab tests neutral/jaw/blink/smile plus idle/walk/run with the face
active on each backend; its screenshots and Blender review views complement those checks.

## Registered skin renderer (2026-09-12)

The high-quality lab additionally uses `CharacterSurfaceMaterials`, `SkinAtlasDetail`,
`SkinDiffusionKernel`, `SkinDiffusionPass`, `SkinTransmissionPass` and
`SkinAppearanceState`. This opt-in path is separate from the older `HeroSurface`
profile adapter described above.

Load the GLTF material's `skinAtlasTexture` and `skinExpressionTexture` extras through
its parser, then call `createCharacterSurfaceMaterial(source, atlas, transmissionPass,
expressionAtlas, appearanceState)`. The geometry must supply `_face_uv` and
`_face_weight` (GLTF custom attributes `_FACE_UV`, `_FACE_WEIGHT`). Atlas data are
linear, not sRGB. Set an explicit material environment map/intensity for the second
IBL lobe. The viewer demonstrates binding and teardown. Keep shared environment
textures alive when disposing a character; dispose its owned detail textures separately.

Render `transmissionPass.render(renderer, scene, character, keyDirectionalLight)`
before beauty/SSS. Coordinates are metres. `SkinDiffusionPass.radiusMm` is the support
radius in millimetres, default 3. The pass has a single RGB profile per instance.
Specular stays outside the diffusion filter. Expression material state can be driven
with the same named control frame as a facial rig, but does not itself move geometry.

Release cached extraction materials when source material properties change, and
dispose both passes at teardown. The high-quality viewer and
`character-forger/highquality/research/skin-implementation.md` document the full
reference/asset workflow, limitations and required redistribution notices. This is
not yet a frame-budgeted multi-character production renderer or MetaHuman parity.
