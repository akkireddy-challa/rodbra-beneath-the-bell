# Voxel Mining System

`VoxelMiningSystem` is an engine primitive (`engine/VoxelMiningSystem.ts`) that applies damage to voxel blocks (terrain cells or `VoxelObject` scenery) when a weapon system swings into them. It does **not** raycast from the camera — it reacts to hits reported by a separate tool/weapon system (typically `PlayerToolSystem`). This mirrors how `WeaponMeleeSystem` does combat: hit detection is driven by the swing motion, not a crosshair.

The system is **auto-wired by the engine — on PROCEDURAL voxel terrain only**. The moment any Voxel game calls `engine.getDynamicObjectManager().setTerrainSystem(voxelTerrain)`, the engine automatically creates a `VoxelMiningSystem`, hooks it into the game loop, and shows a default `+1 <blockName>` HUD notification when a block is destroyed. You only need to touch the system to customise `onBlockDestroyed` or change HP / whitelist options.

> **Forged/baked levels (`.vwld`): mining does NOT auto-wire.** A baked level has no `VoxelWorld` — `getVoxelTerrainSystem()` is null, `setTerrainSystem()` never runs, and `PlayerToolSystem` swings silently hit nothing. `PlayerToolSystem` itself (in-hand tool + swing animation) still works; implement the harvest resolution yourself against `gameData.environmentObjects` — recipe in `@docs environment-objects.md`.

## Autowiring

```
VoxelGame.init()
  └─ engine.getDynamicObjectManager().setTerrainSystem(voxelTerrain)
       └─ auto-creates VoxelMiningSystem
            └─ GameEngine update loop calls updateMining(dt) each frame
                 (overlay wobble + auto-release target after inactivity)

PlayerToolSystem.performBladeSweep()   (every swing, while mining key held)
  └─ sample the tool mesh's world position at several points across the swing
       └─ nearest scenery mesh within hitRadius, in the player's forward half-space
            └─ mining.hitVoxelObject(vo, pos, nameHint, handle) | mining.hitSceneryAt(pos, nameHint)
                 └─ resolve target → apply damagePerSwing → destroy at HP 0
```

## What is mineable by default

**Only environment objects (rocks, trees, placed `VoxelObject`s) are mineable by default.** Terrain is NOT mineable unless you pass `mineTerrain: true`. This matches the usual "harvest natural resources" feel and stops the player from accidentally digging holes in the world while swinging.

- If the user's prompt describes Minecraft-style terrain digging, pass `mineTerrain: true`.
- If the prompt names specific resources only (e.g. "mine stone with an axe"), pass a whitelist: `mineableBlocks: ['stone']` — anything else the sweep hits is ignored. A whitelisted terrain block is allowed even when `mineTerrain: false`, so `['stone']` lets the player mine stone terrain without opening dirt/grass to destruction.

### How block names are derived

The name used for whitelist matching and the `+1 <name>` notification is parsed from the asset / InstancedMesh name:

1. Split on `_`, `-`, whitespace, and camelCase boundaries.
2. Drop generic container tokens (`voxel`, `rock`, `stone`, `ore`, `block`, `instanced`, `mesh`, `tree`, `trunk`, `leaf`, `log`, `wood`, etc.).
3. The first remaining token is the block name.

Examples:
- `gold_stone_instanced` → `['gold', 'stone', 'instanced']` → `gold`
- `iron_ore_instanced` → `['iron', 'ore', 'instanced']` → `iron`
- `voxelRock_instanced` → `['voxel', 'rock', 'instanced']` → no specific token left → falls back to `stone`
- `mithril_ore_instanced` → `mithril` (engine has no hardcoded list — any new resource name works)

Whitelist with new resources just lists them alongside existing ones:

```ts
setTerrainSystem(voxelTerrain, {
    mineableBlocks: ['stone', 'gold', 'iron', 'mithril'],
});
```

Default `+1 <name>` HUD notification reads correctly for every whitelisted block — no custom `onBlockDestroyed` override required.

## Customising options

Pass a second argument to `setTerrainSystem`. Pass only the fields you want
to override — the rest are filled from `DEFAULT_MINING_OPTIONS`:

```ts
engine.getDynamicObjectManager().setTerrainSystem(voxelTerrain, {
    mineableBlocks: ['stone'],    // whitelist mineable block names
    mineTerrain: true,            // opt in to terrain digging
    damagePerSwing: 2,            // faster mining
});
```

Full `VoxelMiningOptions` shape (all required in the type — defaults live in
`DEFAULT_MINING_OPTIONS`):
- `blockHp: Map<number, number>` — per-block-id HP overrides.
- `defaultHp: number` — HP for blocks with no explicit entry.
- `damagePerSwing: number` — HP removed per successful swing hit.
- `mineTerrain: boolean` — allow terrain voxels to be mined.
- `mineableBlocks: string[] | null` — whitelist of mineable names; `null` = all allowed (gated by `mineTerrain`).
- `targetHoldSec: number` — seconds of no hits before the locked target resets.

## Customising the destroy callback

```ts
const mining = engine.getDynamicObjectManager().getVoxelMiningSystem();
if (mining) {
    mining.onBlockDestroyed = (pos, blockId, blockName, color) => {
        droppedItemSystem.spawn(pos, blockName, color);
    };
}
```

## What it does on each swing hit

1. `tryHitAt(hitBody, hitPoint, hitNormal)` resolves the hit into a target:
   - If `hitBody` has `userData.voxelObject` → that `VoxelObject` is the target; block name comes from the object's name (`Rock` → stone, `Tree` → trunk/leaves).
   - Else → look up the voxel cell at the hit point in `VoxelWorld` (with a 3×3×3 fallback for boundary hits).
2. Whitelist check: if the resolved name isn't in `mineableBlocks`, the hit is discarded. Terrain hits also require `mineTerrain: true` unless the name is explicitly whitelisted.
3. If the resolved target matches the currently locked target, HP is reduced by `damagePerSwing`; otherwise a new target is locked and HP resets to that block's max.
4. When HP reaches 0, `VoxelObject.explodeAt()` (env) or `voxelWorld.setBlock(..., 0)` + `rebuildDirtyChunks()` (terrain) runs, and `onBlockDestroyed(pos, blockId, blockName, color)` fires.
5. The target is auto-cleared after `targetHoldSec` seconds of no swing hits (so releasing the mining key resets progress after a short grace period).

# Showing a tool in the player's hand — `PlayerToolSystem`

Mining is driven from the player's swing. To show a tool (axe, pickaxe, hammer, etc.) in the player's hand, play a swing animation while the mining key is held, AND report each swing's hit to the auto-wired `VoxelMiningSystem`, use **`PlayerToolSystem`** (`engine/PlayerToolSystem.ts`). The tool mesh is parented to the player's `rightHand` bone and the system plays the built-in `mMiningChop01` overhead-chop animation for every swing — same hand-attachment pattern that `WeaponMeleeSystem` uses for swords.

```ts
import { PlayerToolSystem } from 'engine/PlayerToolSystem.js';
import { WeaponType } from 'engine/WeaponRegistry.js';

// engine reference is required — the tool system casts rays through the
// engine's physics world and calls into the auto-wired mining system.
const toolSystem = new PlayerToolSystem(this.engine);
toolSystem.equipTool(WeaponType.AXE, controller);   // safe any time — defers until character ready

// in the template's update loop:
toolSystem.update(deltaTime);

// on teardown:
toolSystem.dispose();
```

`equipTool` internally defers to `onCharacterReady`, so you do NOT need to wrap it yourself.

On each swing (once per `swingIntervalSec`, default 0.6s, while the mining key is held), `PlayerToolSystem` does:
- Read the tool mesh's *current* world position at several points across the swing animation (the animation carries it through an arc) and look for the nearest scenery mesh within `hitRadius` of it. There is no raycast and no camera direction involved — the hit is bound to where the axe actually is.
- The candidate must also sit in the player's forward half-space (`facingDotThreshold`), so you have to swing toward the rock for it to count.
- On a hit, calls `mining.hitVoxelObject(...)` for an individual `VoxelObject`, otherwise `mining.hitSceneryAt(...)`. The first sample that lands wins; the rest of the swing is skipped.

Options (spread `DEFAULT_TOOL_OPTIONS` to override only some fields):
```ts
import { PlayerToolSystem, DEFAULT_TOOL_OPTIONS } from 'engine/PlayerToolSystem.js';

new PlayerToolSystem(engine, {
    ...DEFAULT_TOOL_OPTIONS,
    hitRadius: 1.5,            // widen the hit window
});
```

Fields:
- `swingIntervalSec: number` — seconds between repeated swings while held.
- `hitRadius: number` — max distance from tool to a scenery mesh's bounding box to count a hit.
- `facingDotThreshold: number` — `dot(playerForward, playerToTarget)` minimum for a hit. 1 = straight ahead, 0 = side, -1 = behind (~0.25 ≈ ±75°).

`PlayerToolSystem` is **cosmetic + sweep only**. It does not implement `IPlayerAttack`, does not call `setAttackSystem`, and does not register an action handler — so it coexists cleanly with `VoxelMiningSystem` and never hijacks the mining key.

> **Do NOT** wire `WeaponMeleeSystem` / `setAttackSystem` / `WeaponType.AXE` as a "mining axe". `WeaponMeleeSystem` does blade-sweep hit detection against `IDamageable` entities (enemies/NPCs); it does **not** break voxel blocks, and its action handler competes with the mining key. Always use `PlayerToolSystem` for the in-hand tool and let `VoxelMiningSystem` (auto-wired) do the block damage.

## Over-the-shoulder camera

For mining/aiming framing, use `ThirdPersonCamera.setShoulderOffset(right, up)` (e.g. `0.6, 0.3` ≈ 0.6 m right, 0.3 m up) rather than patching the camera math. The offset is applied in camera-relative basis vectors, so the crosshair still tracks the aim direction.

## Terrain queries (reading the voxel world)

Reach the live terrain via `engine.getDynamicObjectManager().getMainVoxelWorld()` — returns `VoxelWorld | null` (null until a terrain system is set, so always guard).

- `getBlock(x, y, z): BlockID` — world-space meters, not voxel indices; the world's `bounds` offset and `voxelSize` are applied internally. Positions outside any chunk return `0` (air), never throw. Resolve block NAMES to ids via `engine.blocks.resolve(name)` (see `custom-block-types`).
- `getColumnMaxWorldY(x, z): number | null` — highest solid-block top in that column (null: empty column).
- `getColumnUniformGroundY(x, z): number | null` — zero-alloc ground-surface Y for uniformly stamped columns; the hot-path choice inside per-frame loops.
- Fluids (water/lava/`isFluid` custom blocks) count as NON-solid for these queries.

Terrain queries see only voxel terrain. When "ground" must include placed structures and props, raycast instead — see `physics-best-practices` (Raycast Queries) and `samples/raycast-ground-check.ts`.
