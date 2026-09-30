# Image Assets (CSS / DOM sprites)

When a custom or uploaded image (sprite, icon, portrait, tile texture, cover art) is shown via **CSS `background-image: url(...)`** or a DOM **`<img>` / element `.src`**, the URL MUST be resolved through `resolveAssetUrl` so published games use the inlined image instead of re-fetching it from the CDN.

```typescript
import { resolveAssetUrl } from 'types/game.js';

el.style.backgroundImage = `url(${resolveAssetUrl(spriteUrl) ?? spriteUrl})`;
// or
img.src = resolveAssetUrl(spriteUrl) ?? spriteUrl;
```

Prefer a single choke point — wrap it inside the function that returns the URL:

```typescript
function getSpriteURL(/* ... */): string {
  const url = getCustomSpriteURL(id, level); // external https URL
  if (url) return resolveAssetUrl(url) ?? url;
  return canvasDataUrl; // procedural — already a data: URL, leave as-is
}
```

## Why

Standalone builds populate `ASSET_MAP` with bundled URLs: Creator's single-file export uses base64,
while CLI Poki ZIPs use relative paths to packaged files. **Three.js loader** URLs are rewritten via
`DefaultLoadingManager.setURLModifier`. CSS `background-image` and DOM `<img>` bypass that hook,
so use `resolveAssetUrl` to keep dynamically constructed sprite URLs inside the package.

## Key points

- Only wrap **external `http(s)` URLs**. Do NOT wrap `data:` URLs (canvas-drawn / procedural sprites) — they're already self-contained.
- Three.js textures (`TextureLoader`, `GLTFLoader`, GLB / animation / character assets) are already handled by the loader hook — do NOT add `resolveAssetUrl` there.
- `resolveAssetUrl(url)` returns `ASSET_MAP.get(url) ?? url`. It's a **no-op in dev** (the map is empty outside standalone publishes), so it is always safe to use.
- Import path: `import { resolveAssetUrl } from 'types/game.js'`.
