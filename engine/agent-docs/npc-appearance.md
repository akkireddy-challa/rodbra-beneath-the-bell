# NPC Appearance

How an NPC LOOKS. For registering and spawning one, see `@docs npc-system.md`.

For changing a look **while the game runs** (armour, uniform, costume swap), see `@docs character-outfits.md`.

## NPC appearance — clean block by DEFAULT, highres GLB on DEMAND ⭐

**The default NPC look is a clean BoxGeometry block character — no asset generation needed, and it
is strongly preferred.** Block characters are highly customizable in code (colours, outfits,
body-part sizes/proportions, accessories), so **small/simple looks — recolours, themed outfits, a
blocky knight/robot/wizard — stay block.** A highres (Asset-Forger voxelized GLB) character is used
**only for a large look block cannot represent** (a detailed/realistic/organic or recognizable
specific character). When in doubt, choose block.

> **ALL-OR-NOTHING — never mix block and highres in one game.** The moment ANY character (the player
> OR any one NPC type) becomes highres, EVERY character must be highres too — the player and every NPC
> type are generated together. Either the whole cast is block, or the whole cast is highres.

**Default (no asset) — clean block.** Register the NPC with no appearance option and it renders the
engine's clean block character; pass a `characterFactory` to recolour/vary it:

```typescript
import { createBlockNpcCharacter, blockNpcVariant } from './BlockNpcCharacter.js';

// Default block look (recoloured):
engine.registerNpc('villager', new NpcVillagerBehavior({ greetingMessages: ['Hi!'] }), {
    characterFactory: createBlockNpcCharacter({ shirt: 0x8C4A3B, pants: 0x2E3440 }),
});
// A varied crowd of clean-block NPCs:
engine.registerNpc('crowd', new NpcIdleBehavior(), { characterFactory: blockNpcVariant(0) });
```

### `createBlockNpcCharacter` colours — the complete field list ⭐

`createBlockNpcCharacter(colors?)` takes `Partial<BlockNpcColors>`. There are **exactly five** fields
and **these are the only names that exist** — every one is an optional hex colour number, and anything
you omit falls back to `DEFAULT_BLOCK_NPC_COLORS`. Pass the fields **directly**; there is no `colors`
property, no `color`, and no nested object:

```typescript
// All five fields, with the DEFAULT_BLOCK_NPC_COLORS value each one falls back to
// (imported from './BlockNpcCharacter.js', as in the example above):
createBlockNpcCharacter({
    skin:  0xE0B68A,   // head, neck, hands
    shirt: 0x3A6EA5,   // torso, arms
    pants: 0x394150,   // thighs, shins
    shoes: 0x23262B,   // feet
    eye:   0x202428,   // eye pupils
});

// Name only what you change — the rest stay at their defaults:
createBlockNpcCharacter({ shirt: 0x4F7A52, skin: 0xE0B68A });
createBlockNpcCharacter();          // all five defaults
```

> ⚠️ **Do not invent field names.** `skinColor`, `shirtColor`, `pantsColor`, `bodyColor`, `clothing`,
> `hatColor`, `accentColor` and friends are **not** part of `BlockNpcColors` and are a compile error
> here. Some of those names are real — but they belong to the *different* `createCustomizedNpcFactory`
> API further down this doc ("Appearance — `createCustomizedNpcFactory`"), which takes an
> `NpcCustomizationConfig`, not `BlockNpcColors`. The two are not interchangeable.
>
> ❌ **WRONG** — none of these compile against `Partial<BlockNpcColors>`:
>
> ```typescript
> createBlockNpcCharacter({ skinColor: 0xE0B68A });           // no such field — it's `skin`
> createBlockNpcCharacter({ shirtColor: 0x4F7A52 });          // no such field — it's `shirt`
> createBlockNpcCharacter({ clothing: { shirt: 0x4F7A52 } }); // not nested; pass the fields flat
> createBlockNpcCharacter({ colors: { shirt: 0x4F7A52 } });   // the PARAMETER is named `colors`,
>                                                             // but it is not a property
> ```

**Colouring something that isn't skin/shirt/pants/shoes/eyes** — a robot's chassis, a hat, a cape,
a chest emblem — is not a `BlockNpcColors` field. Either map it onto the five slots (a robot's plating
is its `skin`, its trim is its `shirt`) or write your own `IBlockCharacterFactory`, which can add any
mesh in any colour — see "Building a custom block character" in `@docs character-system.md`.

`blockNpcVariant(i)` picks palette `i` from the four in `BLOCK_NPC_PALETTES` (wrapping), so a crowd
varies without you naming any colours at all.

**On demand (user asked for a custom/highres look) — generate_character GLB via `characterAssetId`:**

```typescript
engine.registerNpc('ogre', new NpcEnemyBehavior(), {
    characterAssetId: 'asset_1781154221708_k8fcw7', // the character entry's id from the manifest
});
```

- Use the GLB path ONLY for a large look block cannot represent, and only as part of an all-or-nothing
  highres cast. Otherwise default to the clean block character (`characterFactory` or nothing) and
  customize it — do NOT generate a GLB for small/simple looks.
- The asset subagent calls `generate_character(name, prompt, { assetId, applyToPlayer: false })`, which
  stores the GLB in world.json `assets[]` under the manifest's minted id — pass that id as
  `characterAssetId`; the engine resolves the url at registration time. The result is a rigged voxel
  humanoid GLB that animates exactly like the player. Because the id is fixed up front, you can write
  this code while the asset is still generating.
- `characterUrl` (a literal GLB url) also works and takes precedence over `characterAssetId` — use it
  only when you have a url but no manifest id.
- **ONE `generate_character` call per NPC TYPE.** The GLB loads once and is shared across every instance
  of that type — 100 zombies = ONE generation, not 100.
- Omit all three → the engine's default clean block character.

## NPCs use the same character system as the player ⭐

NPCs use the **same two looks as the player**: a clean block character by default, or a highres
`generate_character` GLB on demand. Both ride the standard Mixamo skeleton, so NPCs animate identically
to the player either way. Default to the block look and customize it for small/simple asks; switch to a
GLB only for a large look block cannot represent — and when you do, the whole cast (player + every NPC
type) goes highres together, never mixed:

```typescript
import { NpcVillagerBehavior, NpcEnemyBehavior } from 'engine/npc/index.js';
import { createBlockNpcCharacter } from './BlockNpcCharacter.js';

// DEFAULT — clean block (recoloured), no asset generation:
const villager = engine.registerNpc('villager', new NpcVillagerBehavior({ greetingMessages: ['Hi!'] }), {
  characterFactory: createBlockNpcCharacter({ shirt: 0x4F7A52 }),
});
await villager.spawn(10, 5);

// ON DEMAND — user asked for a specific look → highres GLB, one generate_character per TYPE:
const goblin = engine.registerNpc('goblin', new NpcEnemyBehavior(), {
  characterAssetId: '<goblin-asset-id>',
});
await goblin.spawn(12, 5);
```

**Many NPCs, one type:** the GLB is loaded once and shared across all instances — register the type once
with its `characterAssetId` and spawn as many instances as you want; do NOT generate a character per instance.

```typescript
// 6 enemies of the SAME type → ONE generate_character, reused for every spawn:
const goblin = engine.registerNpc('goblin', new NpcEnemyBehavior(), {
  characterAssetId: '<goblin-asset-id>',
});
for (let i = 0; i < 6; i++) await goblin.spawn(10 + i, 5);
```

One name is one manager — registering the same name twice orphans the NPCs you already spawned. See
**"One `registerNpc` name = one manager"** in `@docs npc-system.md`.

**Varied crowd:** for a varied clean-block crowd, recolour the block factory per type with
`createBlockNpcCharacter({ ... })` or `blockNpcVariant(i)` — no asset generation. Only a large look
block cannot represent should push to highres — and then the whole cast goes highres (each type its
own `generate_character` GLB, one generation per type, plus the player), never a block/highres mix.

## Appearance — `createCustomizedNpcFactory`

Builds a HUMANOID. Colours and hat types are free choices, not a fixed palette.

```typescript
import { createCustomizedNpcFactory } from 'engine/npc/index.js';

const factory = createCustomizedNpcFactory({
    skinColor: 0xFFDBB3,
    clothing: { shirtColor: 0xFF0000, hatColor: 0x0000FF, hatType: 'cap' },
});
```

> **This is a DIFFERENT type from `createBlockNpcCharacter`.** It takes an
> `NpcCustomizationConfig` (verbose, `*Color`-suffixed, nested) — *not* `BlockNpcColors` (five flat
> fields: `skin`/`shirt`/`pants`/`shoes`/`eye`). Never mix the two vocabularies.

`NpcCustomizationConfig` top level — `skinColor` is the only **required** field:

```typescript
createCustomizedNpcFactory({
    skinColor: 0xFFDBB3,     // required — hex number, or an NpcColorConfig object (see below)
    accentColor: 0xFFD700,   // decoration colour (defaults to the clothing colour)
    clothing: {},            // shirt/pants/hat/boots/belt/shoes/accessories
    bodyShape: {},           // height, width, depth, headSize, torsoSize, limbSize
    features: {},            // ears, horns, tail, beard, eyeColor, visorEyes, sparkles
});
```

`clothing` (`NpcClothingConfig`) — every field optional; an omitted colour means that garment is
simply not added:

```typescript
createCustomizedNpcFactory({
    skinColor: 0xFFDBB3,
    clothing: {
        shirtColor: 0xFF0000,
        pantsColor: 0x2E3440,
        hatColor:   0x0000FF,
        hatType:    'cap',   // 'cap'|'tophat'|'crown'|'helmet'|'beanie'|'hood'|'bandana-hat'|'cowboy'|'beret'|'visor'
        bootsColor: 0x23262B,  // NOTE: boots are `bootsColor`; there is no `shoesColor`
        belt:        {},       // NpcBeltConfig
        shoes:       {},       // NpcShoesConfig — shape/detail, distinct from `bootsColor`
        accessories: {},       // NpcAccessoriesConfig — glasses, cape, elbowPads, mask, badge, …
    },
});
```

A colour field also accepts an `NpcColorConfig` (`{ color, roughness?, metalness?, emissive?,
emissiveIntensity? }`) instead of a bare number, for glowing or metallic parts. The nested
`belt`/`shoes`/`accessories`/`features` sub-configs have many more fields than are worth listing
here — read `game/src/engine/npc/customization/NpcCustomization.ts` before using them rather than
guessing a name.

Do NOT use it for animals — it always produces a humanoid body plan. Use the animal
system (`@docs animal-instructions.md`) instead.

## Animations for humanoid NPCs

An empty animation array means "auto-load the core pack", which is what you want.
Load extra packs later, when the NPC picks up a weapon:

```typescript
const humanoidSystem = new HumanoidVisualSystem(engine, playerGLTF, []);   // [] = auto-load

import { MELEE_WEAPON_ANIMATIONS } from 'engine/AnimationPacks.js';
const animController = npc.getAnimationController();
await animController.loadAnimationPack(MELEE_WEAPON_ANIMATIONS, { addToAttackCollection: true });
```

`NpcEnemyBehavior` / `NpcHostileBehavior` load the punch/kick strike clips themselves the
first time they aggro — don't load them by hand. If you *do* register your own attack
moves on an NPC, the built-in behaviors leave them alone and use yours.

## Costume presets

`game/src/engine/npc/customization/CostumePresets.ts` ships Jedi, Sith, Stormtrooper, Knight and
Soldier presets.
