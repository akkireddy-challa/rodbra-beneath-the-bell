# Character & Animation System

> **Coordinate convention:** Humanoid characters use the **+Z gameplay forward** convention — at `rotation.y = 0` the character's visible front (local +Z column) points along world +Z, matching `Object3D.getWorldDirection()` and glTF authoring. `WalkingAndJumpingMovement` rotates the character via `atan2(moveDir.x, moveDir.z)` so the local +Z column lines up with motion. See `@docs coordinate-system.md` §2. Under **pose v2** (the default for new games) `BlockCharacterRenderer` orients the torso group +Z-forward to match the head, so block factories place every detail at +Z naturally (see "Axis convention" below); pose v1 left the torso backward and is kept only for existing games.

## Animation System
- **Root Motion Handling**: Automatic root motion normalization to prevent floating or unwanted displacement
- **Physics Integration**: Root motion displacement applied to physics body after animation completion
- **Animation Types**: Uppercut/special moves with single-play, clamped finishing

## Character Features
- **Default Character: BitmagicPlayerCharacter** — a clean BoxGeometry "mascot": a white rounded body of simple Three.js boxes, plus a pink antenna, blinking eyes, and sparkles
- **On-demand highres**: an Asset-Forger voxelized GLB rendered as a skinned mesh, used only when the user asks (see "Highres characters" below)
- **Bitmagic Modifications**: Special character customizations (eye blinking, etc.)
- **Character Switching**: Dynamic model changes with preserved physics state
- **Physics Sync**: Accurate feet-to-capsule alignment with offset compensation

## Character Styles

There are exactly **two** looks, for both player and NPCs:

1. **Clean block (DEFAULT — strongly preferred)** — simple BoxGeometry meshes, drawn by `BlockCharacterRenderer`: a hidden animated skeleton drives the bone transforms and a **character factory** (an `IBlockCharacterFactory`) decides the visual look. The player factory is set in Game.ts via `this.engine.blockCharacterFactory = factory;`; NPC factories are passed per-NPC as `characterFactory` (see `@docs npc-appearance.md`). Block characters are highly customizable in code — colours, outfits, body-part sizes/proportions, antennae and accessories — so **small/simple looks (recolours, themed outfits, a blocky knight/robot/wizard) stay block.** A factory can also be swapped in at runtime to change a character's clothes mid-game — see `@docs character-outfits.md`.
2. **Highres (ON DEMAND, for large asks only)** — an Asset-Forger voxelized GLB rendered as a real skinned mesh, used only for a **large** look the block style genuinely cannot represent (a detailed/realistic/organic or recognizable specific character). When in doubt, choose block.

> **ALL-OR-NOTHING — never mix the two looks in one game.** The moment ANY character (the player OR any one NPC type) becomes highres, EVERY character must be highres too — the whole cast is generated at once. A game is either entirely block characters or entirely highres characters, never a mix.

### The default player — a clean BoxGeometry "mascot" ⭐

`BitmagicPlayerCharacter.ts` (`bitmagicCharacterFactory`) builds a **white rounded block character** out of plain Three.js `BoxGeometry` meshes, plus mascot flair (pink antenna, blinking eyes, sparkles).

```typescript
import { bitmagicCharacterFactory } from './BitmagicPlayerCharacter.js';
this.engine.blockCharacterFactory = bitmagicCharacterFactory;
```

**Editing the player** — everything is in the self-contained `game/src/genres/voxel/BitmagicPlayerCharacter.ts`, inside `createBitmagicBlockCharacter(characterGroup)`:

| To change… | Edit |
|---|---|
| A body part's size/shape | the `new THREE.BoxGeometry(w, h, d)` for that part (e.g. `headMesh`, `torsoBodyMesh`, `leftThighMesh`). |
| Feet | the `leftFootMesh` / `rightFootMesh` boxes. ⚠️ Feet MUST use a **negative Y** position so they extend forward from the ankle. |
| Colours / outfit | the `color` of each part's `MeshStandardMaterial` (the mascot is all `0xFFFFFF`; give parts different colours for an outfit). |
| Face, antenna, sparkles | the antenna/eye/sparkle meshes added to `headMesh` — pink antenna + white/black **blinking** eyes (animated by `updateBitmagicEyeBlink`) + sparkles. |
| Height | `BITMAGIC_CONFIG.targetHeight`. |

### Building a custom block character (player or NPC)

A block character POPULATES the pre-created body-part groups with `THREE.Mesh` boxes — it must NOT
create a new group. Implement `IBlockCharacterFactory` (`createBlockCharacter(group)` + `getCharacterDimensions()`):

- **Player:** edit `BitmagicPlayerCharacter.ts` (above), or assign any `IBlockCharacterFactory` to `this.engine.blockCharacterFactory`.
- **NPCs:** pass an `IBlockCharacterFactory` (or a `(group) => dimensions` function) as the NPC `characterFactory`. The genre ships recolourable clean-block NPC factories in `BlockNpcCharacter.ts` (`createBlockNpcCharacter({ shirt: 0x4F7A52 })`, `blockNpcVariant(i)`) — full template in `@docs npc-appearance.md`. `createBlockNpcCharacter` accepts `Partial<BlockNpcColors>`, whose five optional hex-colour fields are passed flat, never nested; for the authoritative field list and their defaults see **"`createBlockNpcCharacter` colours — the complete field list"** in `@docs npc-appearance.md`, which is the single copy — read it rather than guessing a colour field name.

```typescript
import * as THREE from 'three';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';

const myFactory: IBlockCharacterFactory = {
  createBlockCharacter(group) {
    const head = group.getObjectByName('head') as THREE.Group;          // pre-created body-part group
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.4, 0.35),
      new THREE.MeshStandardMaterial({ color: 0xFFCC99 }),
    );
    mesh.position.set(0, 0.24, 0);
    head.add(mesh);                                                     // ADD to the provided group
    // …repeat for the other parts…
  },
  getCharacterDimensions: () => ({ width: 0.5, height: 1.75, depth: 0.35 }), // for physics capsule
};
this.engine.blockCharacterFactory = myFactory;
```

**Body part names** (groups provided by BlockCharacterRenderer — add your meshes to these):
`head`, `neck`, `torso`, `leftUpperArm`, `leftForearm`, `leftHand`, `rightUpperArm`, `rightForearm`, `rightHand`, `leftThigh`, `leftShin`, `leftFoot`, `rightThigh`, `rightShin`, `rightFoot`

**Axis convention (mesh-local):** X = left→right, Y = bottom→top, Z = back→**front**. This holds for
**every** body-part group — head, neck, **torso**, and limbs alike: put front details (face, eyes, a
chest emblem, a belly patch) at **+Z** and back details (a tail) at **−Z**. The engine orients all
groups consistently, so place meshes by their real anatomy and **never** add `rotation.y = Math.PI` to a
torso/body mesh — that flips the whole front to the back (it was an old work-around; new games don't
need it). Feet still use a negative Y offset to point forward.

> Legacy note: games created before the pose fix have `worldProfileData.characterPoseVersion` unset (=1),
> their torso group faces backward, and their factory pre-rotates the torso body mesh 180° to compensate.
> When editing one of those, keep its existing pattern (attach torso details to that flipped mesh) rather
> than re-orienting it. New games (templates set `characterPoseVersion: 2`) use the clean +Z=front rule above.

**Recolouring a body part at runtime:** `BlockCharacterRenderer.tintBodyPart(name, color)` clones the
part's materials and recolours them (same method on `NetworkCharacterController` for remote
players). For per-player multiplayer colour/team choices, use the opt-in `PlayerAppearanceSync`
helper rather than wiring the picker + broadcast yourself — see `@docs multiplayer-setup.md`
"Per-player appearance".

**Material classes:** characters ride the same 16-name material-class vocabulary as weapons,
vehicles and voxel assets (`engine/VoxelMaterialClass.ts`, quality-clamped — low renders
everything Lambert, exactly the pre-class look). Three routes, none needing game code:
NPC-customization parts carry deterministic classes (gold buckle/ring, glass lens, leather belt,
cloth clothing, fur tail…) applied at the block-character conversion; a character GLB whose
material is named `BM_slot_<class>` gets the engine's tuned classed material at load (the
`design-character` forger's optional `finish` spec field emits these, and `generate_character`
does behind the `CHARACTER_MATERIAL_CLASSES=on` lane); a rigged `.vxl` body with v11 material
classes renders them as geometry groups. Skin and untagged parts stay the deliberate matte
Lambert default. A block-character factory can opt a part in with
`classedPartStandardMaterial('gold', { color })` from `engine/npc/customization/blockPartCaches.js`.

### Highres characters (on demand, large asks only) ⭐

For a **large** look the block style cannot represent (detailed/realistic/organic or a recognizable
specific character), use a `generate_character` GLB instead of a block factory. This is the only path
that needs asset generation — small/simple looks stay block. **All-or-nothing:** if you generate one
character highres, generate the player and every NPC type highres too; never leave a block character
alongside a highres one.

- **Player:** `generate_character(name, prompt, { applyToPlayer: true })` — the asset subagent does this;
  it writes `worldProfileData.characterUrl` **and** `useHighResCharacter: true` to world.json, so
  PlayerLoader renders the generated GLB as a skinned highres mesh and the game reloads. To revert to
  the default block look, clear `characterUrl` / set `useHighResCharacter: false`. A `characterUrl`
  in `game.json` (the field every scaffold ships) is honoured as a fallback when the profile has none;
  a `.vxl` URL from either place renders skinned without any other flag.
- **The physics capsule is measured from the BODY, not the bounding box.** A character GLB is
  authored in a T-pose, so its box is mostly arm span — a 1.5 m generated character measures 1.63 m
  wide, and a radius taken from that is 0.8 m, which is wider than half the capsule's height. That is
  a ball, not a capsule: it rests on voxel corners (the character hovers beside an edge) and rolls up
  them diagonally instead of stepping. `measureSkinnedBodyWidthRatio` discounts every vertex bound to
  the arm chain, the same rule `measureVxlCharacter` applies to voxel bodies. Don't size a character
  capsule straight off `Box3.setFromObject`.
- **Eyes on a `.vxl` body** are metadata, never voxels: the file's v11 eye record (where, how big,
  classic/dark) and the runtime draws the engine's square voxel "googly" eye on the head bone —
  black rim, rectangular sclera, rectangular pupil (`engine/loaders/VxlCharacterEyes.ts`, the same
  stack block animals get). They blink on their own and the pupils track a gaze: an NPC's eyes
  follow the player within 5 m (`NpcController` ticks them); the player's eyes follow the aim
  (`PlayerController` ticks `tickVxlCharacterEyesAlong` with the camera's view direction). A
  round or static eye on a voxel character means an old engine build, not a broken asset.
  **Colours are overridable**: the record's type only picks a default look (`DEFAULT_VXL_EYE_LOOK`,
  `DARK_VXL_EYE_LOOK`). `registerNpc(name, behavior, { eyeLook: EVIL_VXL_EYE_LOOK })` gives every
  NPC of a type black eyes with glowing red pupils; `npc.setEyeLook(look)` does one NPC, and
  `setVxlCharacterEyeLook(root, look)` any character root (the player's loaded body included).
  A look is `{ sclera, pupil, pupilGlow }` — spread `DEFAULT_VXL_EYE_LOOK` and change what you need.
  **A glowing pupil needs bloom.** Bloom is on by default only for the `voxel` genre, and not when
  that game declares `"artStyle": "low-poly"` in game.json; every other
  game sets `worldProfileData.bloomConfig: { "enabled": true, "strength": 0.4, "radius": 0.4,
  "threshold": 0.98 }` in world.json. Keep the threshold high — lower it and the sky, pale ground and
  beacons bloom too — and raise `pupilGlow` instead (the evil preset sits at 3 for that reason; red
  has a fifth of white's luminance). Without bloom, drop `pupilGlow` to ~0.3 or the pupil overexposes.
- **NPCs:** `generate_character(name, prompt, { applyToPlayer: false, assetId })` stores the GLB in
  `assets[]`; reference it via `registerNpc(name, behavior, { characterAssetId })`. One generation per
  NPC type. See `@docs npc-appearance.md`.

**Custom character renders backward (faces away from travel)?** The GLB is authored facing the
wrong way. Set a yaw correction in radians (`Math.PI` = 180°): player →
`worldProfileData.characterModelRotationY`; NPC → `registerNpc(..., { characterModelRotationY })`.
Applied only to the skinned mesh; movement is unaffected.

## Character Manipulation - Safe Traversal & Attachment

**CRITICAL: Never use `player.traverse()` directly** - the player object may be a hidden skeleton used only for animations. The visible character (blocks) is rendered separately and added to the scene. Always use `PlayerController` methods.

See `PlayerController.ts` for methods like `traverseVisibleCharacter`, `attachToBodyPart`, and `detachFromBodyPart`.
