# Custom Block Types

Games extend the voxel palette with their own block types (gold, ice, lava, glass…). Registration is data-driven; placement and queries then work like any built-in block.

## Declaring blocks (world.json — asset agent)

Add entries to `worldProfileData.customBlockTypes[]`. Fields per block: `name` (unique, matched case-insensitively), `textureUrl` (PNG or a solid-color data URL), optional `sideTextureUrl` (defaults to top texture), `textureSize` (default 64), `isFluid` (water/lava-like: non-solid for collision and culling), `opacity` 0..1 (`0` = invisible but still solid — useful for trigger geometry).

They load before terrain generation; a failed texture fetch is logged and skipped, never thrown, so one bad URL can't sink the world. Block id `0` is reserved for air.

## Using blocks (code — coding agent)

- Resolve a name to its runtime id with `engine.blocks.resolve(name)` — returns `{ id }` or `{ id: undefined, reason }` where reason distinguishes `not-in-world-json` (never declared) from `load-failed` (declared, texture failed). `engine.blocks.resolveOrFallback(name, fallbackId, ctx?)` logs a structured warning and keeps going.
- Never hard-code custom block ids — ids are assigned at load order. Always resolve by name.
- Place/query via the voxel world (`setBlock(x, y, z, id)` / `getBlock(x, y, z)`) — see `voxel-mining` (Terrain queries).
- Runtime registration also exists — `engine.blocks.registerCustom(spec)` (async, returns `{ id }` or `{ error }`) — but prefer declaring in world.json so blocks survive reloads and publishes.

Mining interplay: mineability is whitelisted by block NAME — see `voxel-mining` (What is mineable by default).
