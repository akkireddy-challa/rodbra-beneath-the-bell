# Texture Text — write names, numbers, decals onto a texture

Engine module: `engine/TextureTextWriter.js`. Writes runtime text into a
defined quad of a texture image (e.g. a jersey name/number). Regions are
parallelogram quads with corners in normalized image coordinates (0–1,
origin top-left, y down), listed in TEXT order: `topLeft` is where the top-left
of the readable text lands. Rotated/mirrored UV islands are expressed purely
by corner order — callers always pass normal upright text. Quads work at any
texture resolution.

## API

- `createTextEditedTexture(baseTexture, edits)` — copies a loaded
  `THREE.Texture`, applies the edits, returns a `THREE.CanvasTexture` that
  inherits `flipY`/`colorSpace`. Assign it to `material.map` and set
  `material.needsUpdate = true`. Each edit is `{ quad, text, style? }`.
  Call once after the model loads, never per frame.
- `writeTextInTextureQuad(canvas, quad, text, style?)` — lower-level: draw
  text into a quad on a canvas you manage. Text renders at quad height and
  condenses horizontally when too wide (jersey style); it never wraps.
- `fillTextureQuad(canvas, quad, color)` — flat fill of a quad. Use color
  `'#8080ff'` to neutralize a region of a normal map.

`style` fields (all optional): `fontColor` (default `'#151515'`),
`backgroundColor` (default `null` = transparent, keep texture),
`fontFamily`, `fontWeight`, `paddingFraction`.

## Region quads are game data

The engine module is generic — print-region quads are measured from a
specific model's UV atlas. They are not stored in the engine or in docs:
define them in game code as `TextureTextQuad` constants (import the type
from the same module), using coordinates supplied by the user's request.
