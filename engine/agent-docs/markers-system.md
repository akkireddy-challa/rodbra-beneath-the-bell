# Markers System

**Markers** are editor-only guide objects that are invisible in play mode but visible to the AI agent. They are stored in `world.json` as a `markers` array.

## Key Properties
- **Location**: `world.json` contains a `markers` array inside `worldProfileData.markers`
- **Always Present**: The `markers` array is always saved in `world.json`, even if empty (`[]`)
- **Visibility**: Markers are hidden in play mode and only visible in debug/edit mode
- **Purpose**: Used to mark positions for AI agent reference (e.g., spawn points, important locations, waypoints)
- **Properties**: Each marker has `id`, `name`, `color` (named color like "red", "blue", "cyan"), `position` (x, y, z), and `rotation` (x, y, z)

**When users mention "markers"**, they are referring to the array of marker objects defined in `world.json` at `worldProfileData.markers`. The AI agent can read, create, modify, or delete markers by editing the `markers` array in `worldProfileData`.

## Reserved Naming Conventions

### Multiplayer Spawn Points
- Markers named `"Multiplayer Spawn Point 1"`, `"Multiplayer Spawn Point 2"`, etc. are reserved for multiplayer spawn points
- Must use color `"green"`
- **When adding multiplayer to a game, ALWAYS create at least 2 spawn point markers**
- These markers show in the editor inspector as regular scene objects and can be moved by the user
- At runtime, use `NetworkManager.getMultiplayerSpawnPoints(gameData)` to retrieve them
- See `@docs networking-system.md` for full multiplayer spawn point usage

See `MarkerSystem.ts` for implementation details.
