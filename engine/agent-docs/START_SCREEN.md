# Start Screen

<!-- doc-api-check: ignore hud.startScreen -- world.json config path, not a GameHUD member -->

The start screen is the first thing the player sees. The engine renders two layouts depending on whether the game ships a cover image:

- **With `imageUrl`** — a centered portrait card holding the cover image, with a circular Play button overlaid in the middle. The game canvas is visible around the card; the title is expected to be baked into the image art.
- **Without `imageUrl`** — a centered text card with the game's title and a pill-shaped Play button. Same family of themed surface that the Pause and End screens use.

The engine renders it automatically for every game. Customization is per-game and lives in `world.json` under `hud.startScreen`.

**Layering guarantee:** the engine mounts the start screen on a dedicated layer that stacks **above** the HUD (`.hud-root`), so the Play button is always visible and clickable — a game's custom HUD elements can never cover it or, on mobile, swallow its taps. Do **not** rely on covering the Play button, and do **not** mount gameplay HUD (boards, overlays) over the start screen before play — build those on the first `engine.startGame()` / play transition instead. See `HUD_ELEMENTS.md`.

## Schema

```jsonc
{
  "hud": {
    "theme": "bitmagic",            // unrelated — see HUD_THEMES.md
    "startScreen": {
      "imageUrl": "https://...",    // optional — cover image
      "imageSource": "generated",   // optional — cover provenance for the share-link gate; not required
      "title":    "ROBOT UPRISING", // optional — overrides gameData.gameName (both card layouts)
      "hideTitle": false,           // optional — hide the title but keep its space, for cover art that bakes the name in
      "playLabel": "Begin"          // optional — visible label (text card) / aria-label (image card)
    }
  }
}
```

Every field is optional. Omitted fields fall back to:

| Field        | Fallback                                              |
|--------------|-------------------------------------------------------|
| `imageUrl`   | no image — engine renders the text card               |
| `title`      | `gameData.gameName` from `game.json`                  |
| `hideTitle`  | `false` — the title is shown on both card layouts     |
| `playLabel`  | localized default (`"Play"` in English)               |

Image aspect: portrait (3:4) or square fit the card best — they're shown at natural aspect, max ~480px wide and 85vh tall. Landscape images render with letterboxing on the sides.

## How to edit

There is no dedicated tool — edit `world.json` directly with the standard file-edit tools. Read the current `hud.startScreen` block first (via `worldJsonInspectTool` or `fileReadTool`), then patch the field(s) you want. The iframe auto-reloads after any `world.json` write.

When patching, preserve other fields under `hud.startScreen` — a careless overwrite of the whole `startScreen` object will erase fields the user didn't ask to change.

To clear the background image, remove the `imageUrl` field (or set it to `null`).

## What the start screen does NOT control

- **Game title in the HUD** — there is none. The title only appears on the start screen.
- **Colors / fonts / button styling** — those come from the HUD theme. See `HUD_THEMES.md`.
- **Pause overlay or end overlay** — they share the theme but have separate visual content.
- **Opening cutscenes** — a video played after Play is a separate fullscreen overlay. See `video-cutscenes.md`.

## Where the image comes from

`imageUrl` is treated as an opaque URL. It can be:

- A full external URL (CDN, Imagekit, S3).
- A root-relative path served by the game iframe (`/assets/...`).

It is **not** routed through `world.json.assets[]`. Generated cover art will typically be an `imageAssetGenerationTool` result whose URL you pass through unchanged.

If the URL fails to load, the card renders without a background — never a broken-image icon.

## Share / link-preview thumbnail (separate from the cover)

The cover above is what the **player** sees on the start screen. The **share thumbnail** is a different thing: the Open Graph image shown when the published game's link is posted (Slack, social, the portal listing). By default publish captures a fresh screenshot for it each time. To pin a specific image instead — often the same cover art — set these **top-level `worldProfileData`** fields:

```jsonc
{
  "worldProfileData": {
    "thumbnailUrlOverride": "https://.../cover.webp",                  // og:image — overrides the auto screenshot
    "descriptionOverride":  "A one-line pitch for the link preview.",  // optional — overrides the auto description
    "faviconUrlOverride":   "https://.../icon.png"                     // optional — browser-tab icon
  }
}
```

- These live at the **top level of `worldProfileData`, NOT under `hud.startScreen`** — do not nest them there.
- `thumbnailUrlOverride` must be an `https://` URL (an uploaded asset URL is typical). It wins over the per-publish screenshot every time, so the preview stays stable across republishes.
- `thumbnailUrlOverride` / `descriptionOverride` / `faviconUrlOverride` (in `world.json`) are the **only** fields you ever set for this. The auto-captured thumbnail/description are system-managed and written solely by the publish flow — you do not touch them, and you never edit them anywhere.
- Setting the start-screen `imageUrl` does **not** set this automatically — if the user wants the cover to also be the share image, set both to the same URL.
- To revert to auto-capture, remove the override field.
- `faviconUrlOverride` is the **browser-tab icon**, not the link preview — publish crops it to a 64x64 PNG, so a wide banner loses everything outside its centre square. Leave it unset unless the user asks for a specific icon: publish already derives one from the cover art, and the Bitmagic mark only survives for a game with no art at all.
