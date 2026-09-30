---
name: importing-metahumans
description: Bring an Epic MetaHuman (a UE 5.7 glTF export) into this game as the playable, animated, talking high-fidelity character without voxelizing it — prepare the GLB (Draco, one skeleton, body mesh first, garment weights), load it as the engine's high-res player, fix the A-pose retarget and the pose-driven helper joints, keep the hair on the head, upgrade skin / hair / eye materials, add life and lip-sync, and verify with numbers. Use it when a creator asks for a MetaHuman, an Unreal character, a "photoreal" or "highest fidelity" character — or when such a character shows floating hair, crossed arms, split legs, a torn shirt, tinted skin, black eyes, slumped shoulders or sliding feet.
---

# Importing a MetaHuman

A MetaHuman export is a 40–80 MB skinned GLB with 51 ARKit blendshapes, hair as textured cards and a
UE5 skeleton with hundreds of pose-driven helper joints. The engine can load it as the player's
**high-res character** and drive it with its own Mixamo locomotion — but the raw export loads as
nothing (Draco), animates in pieces (three skeleton copies), stands with its arms crossed into its
chest (A-pose bind), tears its shirt at the armpits (helper joints), leaves its hair behind when it
turns its head (unskinned cards), and renders with tinted skin and black eyes (rig masks, eye shell).
Every one of those was met and fixed on Epic's "Bo" preset in a lab game (September 2026); this
skill is that path, in order, with the tools that do it. Everything it names ships with the CLI:

```
bitmagic tools install metahuman
```

lands, at the project root:

| Path | Does |
|---|---|
| `src/work/metahuman/MetaHumanActor.ts` | adopts the engine-loaded player model, re-parents the hair cards, fixes the arm retarget, applies the helper-joint policy, blinks / saccades / breathing / head look-at, morph access |
| `src/work/metahuman/MetaHumanMaterials.ts` | upgrades every material by name: skin SSS, hair/brow card atlas, lashes, eyes; hides the export's helper meshes |
| `src/work/metahuman/MetaHumanSpeech.ts` | plays a line and drives the ARKit mouth shapes from mouth cues (+ amplitude fallback); clock-driven mode for the frame recorder |
| `src/work/metahuman/StudioEnvironment.ts` | HDRI image-based lighting that survives the engine's ambient-lighting re-applies; optional separate sky map |
| `src/work/metahuman/MetaHumanLabHooks.ts` | installs `window.__lab`, the handle the rigs below drive |
| `tools/metahuman/prepare.sh` + five `.mjs` scripts | the GLB preparation, one command (needs Node ≥ 18; `npm install` runs on first use) |
| `tools/metahuman/e2e/` | `shot.mjs`, `eval.mjs`, `walk-probe.mjs` and `probes/` — headless Chrome stills and measurements |
| `tools/lipsync/make_line.py` | TTS audio → forced alignment → mouth cues (`assets/speech/<id>.{m4a,json}`) |

Nothing in them is character-specific: the scripts find meshes by the export's naming
(`SKM_<name>_FaceMesh`, `SKM_<name>_BodyMesh`, `<name>_Outfits`) and the actor classifies materials
by name. `tools/metahuman/README.md` is the index.

## 0. Before you start

- **WebGPU.** The skin, hair and eye upgrades are TSL node materials on three's WebGPU build (the
  engine default). The WebGL fallback keeps plain glTF PBR with scalar tweaks — acceptable, not
  photoreal. `bitmagic verify` prints which backend booted.
- **Licence.** Since June 2025 Epic allows MetaHumans in non-Unreal products; the export pipeline
  below is MIT. Record both in an `assets/LICENSES.md` and check the current MetaHuman terms before
  a commercial release.
- **Budget.** One character is ~45 MB of GLB plus two 4K atlases. Publish uploads it (step 8). The
  whole cast goes highres with it — highres and block characters never coexist.
- **Nothing else changes.** `artStyle` in `game.json` stays whatever the game is; a MetaHuman is a
  loaded file, not a generated asset, and costs no sparks.

## 1. Get an export

The exports come from **smorchj/metahuman-to-glb** (UE 5.7 MetaHuman → Blender → Draco GLB with the
51 ARKit blendshapes). Ready-made characters sit in that repo under `docs/5.7/characters/<name>/`
(bo 41 MB, bruce 79 MB; `docs/characters/` holds ada and taro from the older 5.6 pipeline). Fetch
through `raw.githubusercontent.com` — they are plain files, not LFS. An export folder holds:

- `<name>.glb` — Draco-compressed; meshes `SKM_<name>_FaceMesh` (face skin, teeth, eyes, eye shell,
  lacrimal fluid, lashes, an `M_Hide` helper), `<name>_Outfits` (garments), `SKM_<name>_BodyMesh`
  (body skin — **no torso or upper thighs under the clothing**, the export culls them), plus the
  hair / eyebrow / beard `*_CardsMesh_*` card meshes;
- `textures/<Hair|Eyebrows>_*_CardsAtlas_Attribute.png` — 4K card atlases, R = coverage, G = root→tip,
  B = per-strand seed; `T_Eyelashes_*_Coverage.png` — the lash mask;
- `mh_materials.json` — the pipeline's material sheet (base colours, alpha channels, roughness).
  Reference only.

What is inside, and why every step below exists: **three copies of the skeleton** (the face skin's
875 joints incl. `FACIAL_*`, the outfit's 342, the body's 342 — same names, same rest pose), the
face skin **stops at the upper arms**, the cards are **unskinned meshes posed at the head's rest
pose**, `COLOR_0` on every mesh is a **rig mask** (not albedo), the bind pose is an **A-pose**, and
the corrective joints (`*_correctiveRoot_*`, `*_twistCor_*`, bicep/tricep, clavicle scap/out/pec,
latissimus, wrist, ankle, finger helpers) are **pose-driven** in Unreal by RBF drivers the export
cannot carry.

## 2. Prepare the GLB — one command

```
tools/metahuman/prepare.sh <export>/<name>.glb assets/metahuman/<name>/<name>.glb
mkdir -p assets/metahuman/<name>/textures
cp <export>/textures/*CardsAtlas_Attribute.png <export>/textures/T_Eyelashes_*Coverage.png assets/metahuman/<name>/textures/
```

| Step | Script | Why | Without it |
|---|---|---|---|
| 1 | `tools/metahuman/strip-draco.mjs` | `engine.loader` is a plain GLTFLoader — no Draco, no KTX2 | the model never appears |
| 2 | `tools/metahuman/merge-skeletons.mjs` | grafts the limb subtrees from the body hierarchy onto the face hierarchy (asserts identical rest transforms) and re-points every skin at the one skeleton | each mesh follows its own copy: the face and body animate apart |
| 3 | `tools/metahuman/reorder-body-first.mjs` | the engine's `CharacterLoader` captures a rig's bind pose from the **first** skinned mesh it traverses, and the face skin has no forearms or legs | split legs, twisted forearms and hands (10 bones corrected instead of 52) |
| 4 | `tools/metahuman/smooth-outfit-weights.mjs` (shorts 6 × λ 0.5, shirt 12 × λ 0.6) | Laplacian-smooths the garment weights so hard seams (torso latissimus helper beside arm twist correctives) become gradients | 26 cm shards at the armpits under every arm swing |
| 5 | `tools/metahuman/transfer-skin-weights.mjs` (full ≤ 2 cm, blend to 4.5 cm) | gives garment vertices the skin's weights wherever skin lies under them (adds the face's neck joints to the outfit skin) | skin pokes through the shirt |

`SHORT_RE` / `SHIRT_RE` override the garment material regexes (the export names them
`MID_..._Short_NN` / `MID_..._Shirt_NN`); `KEEP_STEPS=1` keeps the intermediates. The tuned numbers
came from a torn-edge metric on the CPU-skinned outfit at the Mixamo idle (8038 torn edges raw →
≈300 after steps 3–5 plus the helper policy). Check the result: the scripts print the scene order
(`SKM_<name>_BodyMesh → <name>_Outfits → SKM_<name>_FaceMesh`), the skins and their joint counts, and
throw if a joint is unreachable or a duplicate does not match its twin.

## 3. Load it as the player

`src/work/world.json`, in `worldProfileData`:

```json
"characterUrl": "/assets/metahuman/bo/bo.glb",
"useHighResCharacter": true,
"characterConfig": { "height": 1.83, "walkSpeed": 1.4, "runSpeed": 2.4, "fastRunSpeed": 4 }
```

and three animation assets in `assets[]` — the Mixamo viewer set — because the engine's `generated`
animation library plays the authored Idle but swaps Walk and Run for motion-captured clips whose
neutral shoulders sit ~20° lower (a visible slump on ANY character, only while walking):

```json
{ "id": "mMixamoIdleViewer", "type": "animation", "locomotionState": "idle", "url": "https://mini.bitmagic.ai/worlds/v3/animations_brotli/NewIdle.glb" },
{ "id": "mMixamoWalkViewer", "type": "animation", "locomotionState": "walk", "url": "https://mini.bitmagic.ai/worlds/v3/animations_brotli/NewWalk.glb" },
{ "id": "mMixamoRunViewer",  "type": "animation", "locomotionState": "run",  "url": "https://mini.bitmagic.ai/worlds/v3/animations_brotli/NewRun.glb" }
```

`src/work/Game.ts`: after `setupPlayerController()` and `playerLoader.enablePlayerGravity()`, adopt
the model the engine loaded (do NOT await slow downloads first — see fix 10), install the hooks, and
update the actor every frame:

```ts
import { MetaHumanActor } from './metahuman/MetaHumanActor.js';
import { DEFAULT_HAIR, DEFAULT_BROWS } from './metahuman/MetaHumanMaterials.js';
import { installMetaHumanLabHooks } from './metahuman/MetaHumanLabHooks.js';

const bloomOn = this.worldProfileData.bloomConfig?.enabled ?? false;
const actor = new MetaHumanActor(this.engine, {
    url: '/assets/metahuman/bo/bo.glb',
    yawOffset: 0,                                   // the export faces +Z = engine gameplay-forward
    materials: {
        hairAtlasUrl: '/assets/metahuman/bo/textures/Hair_S_SideSweptFringe_CardsAtlas_Attribute.png',
        browAtlasUrl: '/assets/metahuman/bo/textures/Eyebrows_M_Wide_CardsAtlas_Attribute.png',
        lashCoverageUrl: '/assets/metahuman/bo/textures/T_Eyelashes_S_Sparse_Coverage.png',
        hair: { ...DEFAULT_HAIR }, brows: { ...DEFAULT_BROWS },
        msaa: !bloomOn,                             // alpha-to-coverage only on the direct MSAA canvas
    },
    life: { blink: true, saccades: true, breathing: true, lookAtCamera: true, maxHeadTurn: 0.55 },
});
const root = this.playerLoader.getSkinnedSkeletonRoot();
if (root) actor.adopt(root, root, this.playerLoader);   // engine-driven locomotion
else { this.engine.getPlayerVisibility().hide(); await actor.load(); actor.attachToPlayer(this.player, this.playerLoader.getFeetOffsetY()); }
this.metaHuman = actor;
installMetaHumanLabHooks({ engine: this.engine, actor, playerLoader: this.playerLoader, player: this.player, cameraController: this.cameraController, playerController: this.playerController });
// in update(deltaTime):
this.metaHuman?.update(deltaTime, this.engine.getDefaultCamera().position);
```

Facts the wiring leans on: the engine faces the player toward −Z (camera behind) — use
`actor.getFacing()` for face cameras and turn `ThirdPersonCamera.setAutoFollow(false)` off while one
is on; the export faces +Z so `yawOffset` is 0; the engine picks walk or run by speed
(`walkToRunThreshold`) and never rescales a clip, so anything that drives the character by script
(cinematics, NPC copies) must move at the clip's stride speed — `characterConfig.runSpeed` 2.4 m/s
here — or the feet slide.

## 4. The fixes, by symptom

Each is a method of `MetaHumanActor` or a preparation step; know which one you are looking at.

1. **Hair, brows or beard stay behind when the head turns** → the cards are unskinned →
   `attachCardsToHead` re-parents every non-skinned mesh onto the `head` bone with `Object3D.attach`
   at load, while the skeleton is at rest. Any new load path must keep it.
2. **Split legs, twisted forearms and hands** → bind captured from the face skin → preparation step 3.
3. **Arms 45° too low, crossed into the torso** → the engine's per-bone correction `inv(B_src)·B_rig`
   assumes the rig binds in the clip's rest pose; MetaHumans bind in an A-pose, Mixamo rests in a
   T-pose → `patchArmRetarget` rewrites the loader's cached `skinnedRetargetDeltas` with a virtual
   T-pose per arm segment (thumbs forward). Check: upper-arm and forearm world directions equal the
   Mixamo rig's, hands at x ≈ ±0.30 m beside the thighs (`tools/metahuman/e2e/probes/arm-pose-check.js`).
4. **Shirt tears at the armpits and shoulders** → pose-driven helper joints swing rigidly with the
   limb → `applyHelperJointPolicy`: each helper family follows only a fraction of its parent's
   rotation delta from bind (`helperFollow`, families shoulder / thigh / elbow / knee / twistCor /
   muscle / clavicle / lat / wrist / ankle / finger; tuned by coordinate descent on the torn-edge
   metric, `tools/metahuman/e2e/probes/helper-follow-descent.js`) — plus preparation steps 4–5.
5. **Skin shows through the garment** → the outfit's weights differ from the skin's under it →
   preparation step 5 (smoothing alone made this WORSE; transfer fixed it).
6. **Skin is tinted / blotchy** → `COLOR_0`/`COLOR_1` are rig masks → every material gets
   `vertexColors = false` (`MetaHumanMaterials`).
7. **Eyes are black** → the export's eye shell has UVs that are not eye-centred, so any occlusion
   gradient blacks the eye out → the shell, lacrimal fluid and `M_Hide` are hidden
   (`eyeShellOcclusion: 0`).
8. **Far-side hair shows through the skin over the ear** → the hair depth bias was too strong →
   polygon offset factor −0.5 / units −1, not −4 / −16.
9. **Hair edges alias or halo** → alpha-to-coverage needs the direct MSAA canvas, which only exists
   while bloom / post-FX are off → `msaa: !bloomOn`; with post-FX on, the cards use the blended fringe.
10. **Hair or helpers detached, only on slow machines** → rest data was read from bones that were
    already animating → capture every rest quantity from the skins' inverse bind matrices and adopt
    BEFORE awaiting the HDRI or atlases.
11. **Shoulders slump only while walking** → the animation library, not the rig → section 3's
    Mixamo assets. Compare raw clip tracks across states (`tools/metahuman/e2e/probes/clip-shoulder.js`)
    before touching rig code.
12. **Feet slide** when moved by script → speed below the clip's stride → section 3.

## 5. What the materials do

`upgradeMetaHumanMaterials(root, options)` classifies each material by name (`classifyMaterial`)
and replaces it in place — geometry untouched:

- **skin** (`MI_Face_Skin_*`, `MI_Body_*`): roughness floor and a wrap-lighting subsurface term in a
  `PhysicalLightingModel` subclass (light through ears, nose, lips);
- **hair / brow cards**: the 4K atlas drives coverage (alpha-to-coverage or blended fringe clone),
  root darkening, per-strand tint and roughness variance, a normal-based self-occlusion;
  `DEFAULT_HAIR` / `DEFAULT_BROWS` are the dials (colour, anisotropy, blend mode);
- **lashes**: the 2K coverage mask, alpha-blended;
- **eyes**: wet cornea (near-mirror roughness + clearcoat);
- **hidden**: `M_Hide`, lacrimal, eye edge, saliva, the eye shell.

Typing note for edits: `@types/three` types TSL nodes as `Node<'vec3'>` etc. while the engine's
lighting-model inputs are bare `Node` — cast; and `three` resolves to the WebGPU build.

## 6. Life and speech

- `life` options blink, saccade, breathe and turn the head toward the camera as deltas on top of the
  animated pose (rest-frame world-axis rotations). `setSpeechEnergy` adds brow lift and nods.
- **Lip-sync**: `MetaHumanSpeech` maps Rhubarb-style mouth shapes (A closed, B teeth, C open, D wide,
  E rounded, F puckered, G F/V, H L, X rest) to ARKit weights with 60 ms co-articulation, jaw scaled
  by loudness, amplitude-driven jaw when a line has no cues. Lines live in `assets/speech/lines.json`
  (`MetaHumanSpeech.loadLines`), `speak(line)` plays one, `update(dt)` every frame,
  `actor.setSpeechEnergy(speech.getEnergy())` for the accents.
- **Making a line**: `tools/lipsync/make_line.py <id> "<transcript>" --audio <tts.mp3>` — PocketSphinx
  forced alignment in a venv (`python3 -m venv tools/lipsync/.venv && tools/lipsync/.venv/bin/pip
  install pocketsphinx`), unknown words via its `EXTRA_WORDS` table. Make the audio with
  `bitmagic generate speech --text "<the line>" --voice <voice> --out <line>.mp3 --no-world` —
  `--no-world` because a lip-sync line is an input to this tool, not a world.json asset the game
  plays on its own, and `--out` writes the MP3 `make_line.py --audio` expects. Any provider's file
  works too. macOS `say` is a placeholder the creator will hear immediately; never ship it. For an
  exact pause between sentences generate them separately and join with silence.
- **Under the frame recorder** (`bitmagic trailer record`) the game runs slower than real time:
  `speech.setClockDriven(true)` advances the cues on the engine delta, log a `speech-start` game
  event when the cue clock starts, and mux the audio afterwards at that frame.

## 7. Verify with numbers, not thumbnails

Thumbnails hid crossed arms, detached hair and a "fix" whose before/after frames were identical.
Crop and zoom the contact region, and cross-check one measured quantity. The rigs drive the GAME
page (the game port in `.bitmagic/dev.json`, one below the dev shell's) through the system Chrome;
`npm install` in `tools/metahuman/` once:

- `node tools/metahuman/e2e/shot.mjs <port>` — stills: wide, front, face, three-quarter, profile,
  hair, eye macro, life on, head-turn; asserts the hair↔head distance is unchanged across a turn and
  that holding W moves the player;
- `node tools/metahuman/e2e/eval.mjs tools/metahuman/e2e/probes/<probe>.js <port>` with
  `arm-pose-check.js`, `bone-displacement.js`, `shirt-edge-stretch.js`, `shirt-long-edges.js`,
  `outfit-bad-vertices.js`, `shirt-bone-ownership.js`, `helper-follow-sweep.js`,
  `helper-follow-descent.js`, `helper-joints-inspect.js`, `clip-shoulder.js`, `grafted-bones.js`,
  `outfit-own-skeleton.js`, `outfit-body-material.js`;
- `node tools/metahuman/e2e/walk-probe.mjs <port>` — walks for a few seconds and prints idle-vs-walk
  statistics (`walk-sampler.js`: bone heights, skin-under-shirt penetration, clip shoulders);
- in the page: `__lab.retargetInfo()` and `__lab.boneMap()` dump the engine's pose map, bind
  corrections and name resolution (52 bones should be corrected);
- `bitmagic verify` last — it boots the real browser and reports the backend and fps.

## 8. Ship it

Every `/assets/...` URL the game fetches works only under `bitmagic dev` and 404s in a published
bundle: register the GLB with `bitmagic assets add assets/metahuman/<name>/<name>.glb --keep-glb`
and point `characterUrl` at the returned URL; do the same for the atlases, the lash mask, the HDRI
and the speech files, or inline them. This is the one step written from the CLI's rules rather
than from having done it — the lab game was never published.

## 9. Engine internals this depends on (re-check after `bitmagic upgrade`)

Written against engine 3.1173: `PlayerLoader.getSkinnedSkeletonRoot()`, `CharacterLoader`'s alias
map (resolves UE / Manny bone names) and its private `skinnedRetargetDeltas` / `skinnedBind` that
`patchArmRetarget` rewrites, `engine.getPlayerVisibility()`, the `generated` animation library. After
an upgrade run the probes in section 7 before trusting a screenshot.

## Known gaps

Shoulder / armpit fidelity (the RBF pose drivers are not in the export — real emulation or a
re-skin of the garment to the primary bones would fix it), scalp visible under thin hair cards, no
eye-socket occlusion, fingers keep the A-pose curl under Mixamo hand poses, the WebGL path is plain
PBR.

## Checklist

- [ ] export fetched, licence recorded in `assets/LICENSES.md`
- [ ] `bitmagic tools install metahuman`; `tools/metahuman/prepare.sh` ran clean: body mesh first, one skeleton, garment weights done
- [ ] atlases + lash mask copied; `characterUrl` + `useHighResCharacter` + Mixamo animation assets in world.json
- [ ] actor adopted BEFORE slow loads; hooks installed; `actor.update` every frame
- [ ] `bitmagic check`; shots + probes: hair follows the head, arms level with the Mixamo rig, ≈300 torn edges, no skin through the shirt
- [ ] `bitmagic verify` on WebGPU; speech line from a real TTS voice
- [ ] before publish: every `/assets/...` URL registered with `bitmagic assets add`
