# Map Asset System

Use the `set-map-asset` tool to replace the procedural voxel terrain with a voxel asset as the game map.

## When to Use

When the user wants to use an uploaded asset as the game map/terrain. Common prompts:
- "Use X as the game map"
- "Make X the map"
- "Replace the terrain with X"
- "X should be the world/level"

## How It Works

- The asset's VXL data is loaded as the voxel terrain (via the existing `voxelUrl` mechanism)
- The player walks on the actual voxel surface with full physics collision
- Existing environment objects are cleared (the map replaces everything)
- Foliage generation is skipped (the map asset defines the full terrain)
- The player character and camera work normally

## Usage

### Set a voxel asset as the map

The asset must already be uploaded and be of type `voxels`.

```
set_map_asset(asset_name="castle_map", action="set")
```

### Revert to procedural terrain

```
set_map_asset(action="unset")
```

## Limitations

- A polygon-mesh (`--keep-glb`) asset cannot be a map asset. For an authored GLB as the whole
  walkable world, use `MeshLevel` — `mesh-level.md`.

- Only works with `voxels` type assets (not polygon-mesh)
- Clears all existing environment objects when setting a map
- The asset is loaded at origin — no position/rotation controls
