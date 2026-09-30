# Top-down "fit whole world" camera

A fixed **orthographic** top-down view, sized so the **entire world is visible at
once with no scrolling** and the camera does **not** follow the player. It
re-fits automatically on window resize. Use it for board-game / strategy /
tower-defense / arena layouts where the player needs to see the whole map.

Only applies when `cameraMode: 'top-down'`. Two ways to enable it:

## 1. Declarative (asset subagent, `world.json`) — preferred for simple cases

```jsonc
"worldProfileData": {
  "cameraMode": "top-down",
  "topDownFitWorld": true,           // fixed ortho view, whole world visible
  "topDownFitWorldMargin": 1.0,      // optional; 1.0 = edges flush, >1 adds padding
  // optional: reserve viewport edges for an in-game HUD (see below)
  "topDownFitWorldRegion": { "right": { "px": 320 } },
  // optional margin color (see "Margins" below). Default "auto" = sky/fog color.
  "topDownFitWorldBackground": "#d8cfc0"
}
```

The fitted world is `groundWorldSizeX` × `groundWorldSizeZ`, centered at the
origin. Pair with `terrain: { shape: 'flat', … }` like any top-down map.

## 2. Programmatic (coding subagent) — for custom bounds / dynamic HUD

Use when the **playable area is smaller than the ground**, the center is offset,
or the reserved HUD width changes at runtime. From gameplay code:

```ts
const cam = this.cameraManager.getTopDownCamera();
cam.setFitWorld({
  sizeX: 92, sizeZ: 76,          // fit the PLAY rect, not the whole ground
  centerX: 0, centerZ: 0,
  margin: 1.04,
  region: { right: { px: 320 } },// reserve the right HUD panel
});
// cam.setFitWorld(null) restores the normal follow camera.
```

## Reserving space for in-game UI (`region`)

The 3D renders full-canvas; `region` offsets the view so the map fits and
**centers in the area left after the insets**, while a HUD overlays the reserved
edge. Each side (`left`/`right`/`top`/`bottom`) is optional, in CSS pixels
(`px`) or a viewport fraction (`fraction`, 0–1). Make the inset match the HUD
panel's actual width so they line up: a 320px right panel → `right: { px: 320 }`.

## Aspect reality — avoid surprise margins

It fits the WHOLE world (contain). If the world's aspect (sizeX:sizeZ) differs
from the **available** area's aspect (viewport minus `region`), the short axis
gets margins — the camera over-scans around the map. To minimize them: **size the
world/play-rect so its aspect roughly matches the usable area** (widescreen → make
the map wider than tall, or reserve a wide enough side panel). A square map cannot
fill a widescreen with no margins without cropping or distortion.

## Margins (`topDownFitWorldBackground`)

Because the view looks straight down, the skybox is only ever visible as those
over-scan margins — a scenic skybox there looks broken. So the margins are painted
a **solid color** instead (the skybox is hidden while fit-world is active):

- `"auto"` (default) — use the sky/fog color.
- a hex string — e.g. **match the ground color** (`"#d8cfc0"`) so the map sits on
  a seamless infinite-looking plane. This is the nicest look; prefer it.
- `"keep"` — leave the skybox (only if the over-scan stays on ground anyway,
  e.g. a play-rect smaller than a larger ground).

Programmatically the same value is the `background` field of `setFitWorld({...})`.

## Fog — disable it (this view only)

The fit-world camera hovers ~200m above the map, so ordinary distance fog (default
near 10 / far 500 — and mood fogs are much closer) covers the ENTIRE map in a
uniform haze that washes out every color. There is no fog setting that looks good
from this altitude; turn it off in the same `worldProfileData` edit that enables
fit-world:

```jsonc
"fogConfig": { "enabled": false }   // fog color still tints the sky fallback
```

(or `configure_game(configType="fog", enabled=false)` from a tool context). Keep
fog only for a deliberate can't-see-the-far-edge mechanic.

## Unit readability — zoom the fit, don't scale the units

Characters have fixed real-world sizes (block NPCs 1.3m, skinned NPCs 1.84m —
`registerNpc` has NO scale option), so on-screen unit size is controlled entirely
by **how much world you fit**. On a 200m+ ground a character is a few pixels tall.

- Size the ground close to the actual play area — don't forge a 220m world for a
  100m path.
- If the ground must be bigger than the action (scenery border, offset play rect),
  fit the PLAY rect programmatically (§2 `setFitWorld({ sizeX, sizeZ, centerX,
  centerZ })`) instead of the whole ground.
- Sanity check: units should be ≥ 1.5% of the fitted axis (a 1.84m skeleton needs
  the fitted span ≤ ~120m) to read as more than a dot.

## Caveats (this view only)

- Gaussian splats and depth-of-field don't render under the orthographic camera.
- The view is fixed: no player-follow, no scroll-zoom.
- Scene fog reads as full-screen haze from the fit altitude — see "Fog" above.
