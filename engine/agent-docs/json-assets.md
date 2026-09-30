# JSON Assets

JSON assets are user-uploaded `.json` files stored in the asset library. Use them for game configuration data (e.g., level settings, item stats, spawn tables).

## Loading a JSON Asset in Game Code

Use `loadJsonAsset<T>(gameData, assetName)` from `types/game.js`. It resolves the asset URL by name, fetches, and parses the JSON in one call. Returns `null` if the asset is missing or the fetch fails.

```typescript
import { loadJsonAsset } from 'types/game.js';

// In an async method that has access to engine:
const config = await loadJsonAsset<{ totalGems: number }>(this.engine.getGameData?.() ?? null, 'game-config');
if (config) {
  this.totalGems = config.totalGems;
}
```

## Key Points

- Asset must exist in the asset library with type `json` — use `search-assets` tool to verify
- The function is generic: pass a type parameter `<T>` for typed access to the parsed data
- Returns `null` on any failure (asset not found, network error, invalid JSON) — always provide a default/fallback
- Call during initialization (e.g., in `init()` or constructor) — avoid calling every frame
- Import path: `import { loadJsonAsset } from 'types/game.js'`
