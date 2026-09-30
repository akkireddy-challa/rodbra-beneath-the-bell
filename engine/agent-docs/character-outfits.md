# Changing a character's clothes at runtime

How to make a block character (player or NPC) **change its look while the game
runs** — pick up armour, put on a uniform, change skin between rounds. For
choosing a character's look in the first place, see `@docs npc-appearance.md`
(NPCs) and `@docs character-system.md` (player).

Only **block characters** can change clothes. A highres (Asset-Forger GLB)
character's look is baked into the asset.

## What a block character is made of

A block character is 15 named `THREE.Group`s — `head`, `neck`, `torso`,
`leftUpperArm` … `rightFoot` — each bound to a skeleton bone and re-posed every
frame from the animation. The factory you pass to the engine
(`IBlockCharacterFactory.createBlockCharacter`) only fills those groups with
meshes.

So an outfit **is just a different set of meshes in the same groups**. Changing
clothes swaps the meshes; the groups, the bone bindings and the current pose
never move. Three things follow, and you can rely on all of them:

- The character keeps animating — mid-stride, mid-swing, without a T-pose flash.
- Anything you attached to a body part yourself (a weapon in the hand, a hat on
  the head, via `getBodyPart('rightHand').add(...)`) **stays attached**.
- The physics capsule does **not** resize. A bulkier outfit changes how the
  character looks, never how it collides.

## One-shot change: `redressBlockCharacter(factory)`

The whole API for "put these clothes on now". Build the factory once, call it
whenever the look changes:

```typescript
const playerLoader = engine.getPlayerLoader?.();
playerLoader?.redressBlockCharacter(createKnightOutfit());   // player
npcController.redressBlockCharacter(createGuardUniform());   // any NPC
```

Returns `false` (and says why in the console) if there is no block character or
the factory added no meshes — the character keeps the look it has rather than
turning invisible.

NPC controllers come from your manager: `onNpcCreated(npc, engine)` — which
fires for the initial spawn **and every respawn** — or `getAllNpcs()`. See
`@docs npc-managers.md`.

## Swapping between a few known looks: variants

When the game switches back and forth between the same handful of outfits,
pre-build them by index and activate on demand. Building costs geometry;
activating is a mesh swap.

```typescript
playerLoader.loadBlockCharacterVariant(1, createPeasantOutfit());
playerLoader.loadBlockCharacterVariant(2, createKnightOutfit());
// later
playerLoader.setActiveBlockCharacterVariant(2);   // wears the knight
playerLoader.setActiveBlockCharacterVariant(0);   // back to the original
```

- **Index 0 is always the look the character was created with** and always
  exists — you never need to keep a factory around to change back.
- `hasBlockCharacterVariant(i)` / `getActiveBlockCharacterVariant()` report state.
- The same four methods exist on `NpcController`.
- `redressBlockCharacter()` resets the active index to 0: it replaces the look
  the character is wearing, it does not register a new variant.

Full runnable reference: `samples/change-character-outfit.ts` (outfit factory, one-shot redress, a pre-built wardrobe, and an NPC population changing uniform).

## Writing the outfit factory

An outfit factory is an ordinary `IBlockCharacterFactory` — the same interface
the character was first built with, so an existing character factory (including
`createBlockNpcCharacter({...})` from `@docs npc-appearance.md`) works
unchanged as an outfit.

Two rules that matter here:

- **Populate the group you are given**, never build and return your own.
- **Feet extend forward from the ankle with NEGATIVE Y** (`position.set(0, -0.1, 0)`).

Meshes get the engine's shared materials and layers automatically, so a changed
outfit lights exactly like the one it replaced.

## Limits

- **Skinned (highres GLB) characters.** On a character rendering its skinned
  GLB, the block character is only a hidden pose (and melee-raycast) source —
  changing its meshes has no visible effect. The engine warns once if you try.
- **Dead NPCs** refuse a variant switch.
- Old meshes are released when you redress. A look you registered with
  `loadBlockCharacterVariant()` is kept until the character is disposed, so it
  can be worn again.
