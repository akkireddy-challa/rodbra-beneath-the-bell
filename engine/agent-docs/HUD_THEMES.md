# HUD theming

<!-- doc-api-check: ignore hud.startScreen -- world.json config path, not a GameHUD member -->
<!-- doc-api-check: ignore hud.theme -- world.json config path, not a GameHUD member -->

The in-game HUD's look is **data**, not code: colors, fonts, geometry (radii, glow, gloss),
decorations and icons all live in one `hud.theme` value — a preset name or an inline token object —
applied as CSS custom properties. Never restyle HUD elements in game code to satisfy a look request;
change the theme.

## How to apply a change — two lanes

**Hosted agent (Creator):** three tools.

1. **`get-hud-catalog`** — presets, fonts, decorations, token vocabulary. Call it when unsure what
   exists; never invent keys.
2. **`write-hud-theme`** — the tool that changes the look, three ways:
   - **`patch` alone** (the common case): an RFC 7386 merge patch in the theme's own shape, applied
     onto whatever the game currently has — `{"colors": {"primary": "#FF8800"}}`. Nested objects
     merge; `null` at a key deletes it. No read round-trip.
   - **`theme` (preset name) + optional `patch`**: "rift-raider with orange accents" is ONE call.
   - **`theme` (full inline object)**: from-scratch themes only. `theme: null` clears.
3. **`read-hud-theme`** — only when you need to SEE current values (to step a ladder from the
   current number, or to debug a theme that is not applying).

Every successful write returns a **`report`**: what changed, plus contrast pairings computed with
the engine's own colour math. **Read it.** `SUBSTITUTED -> renders #X` means the engine will not
render your literal value there (usually fine — the substitute keeps the hue); `LOW` names a pairing
nothing auto-fixes. The report is the only sight you have of the result.

**CLI projects (`bitmagic`):** the same operations as commands, with the same validation and the
same report:

```bash
bitmagic theme show                                        # current theme + validity + report
bitmagic theme patch '{"colors":{"primary":"#FF8800"}}'    # merge-patch the current theme
bitmagic theme set rift-raider                             # preset | inline JSON | @file | default
bitmagic theme check                                       # non-zero exit if the theme won't apply
```

The stored path is **`worldProfileData.hud.theme`** in the project's `world.json` — the wrapper IS
there in a scaffolded project, and a theme written to top-level `hud.theme` silently never applies.
Use the command rather than hand-editing; it validates before writing and nothing is written on
error.

**Then look.** Run `bitmagic verify` and open `.bitmagic/verify/screenshot.png` — the DOM HUD is in
the picture. That screenshot is how you check "is it actually orange now"; verify's console parse
also surfaces the engine's own `[HUD]` warning (with closest-match suggestions) when a theme fails
to apply. A wrong theme never breaks the game — it silently renders the default look, which is
exactly why you must look.

**Preset names are hyphenated** — `rift-raider`, `village-keep`. The unhyphenated style keys you may
find in engine source (`riftraider`) are not valid `hud.theme` values.

## Common asks → minimal patch

Copy the matching patch and adjust the value — don't invent magnitudes. Every patch below works
verbatim as `write-hud-theme`'s `patch` input and as `bitmagic theme patch '<json>'`. The relative
rule: **"more X" = one ladder stop from the current value (read it first); "much more" = two stops.**
Ladders are in the token reference below.

**"Rounder" / "softer buttons"**
```jsonc
{ "shape": { "radiusPill": 28, "radiusCard": 18 } }
```
Say: "Buttons and pills are rounder now, cards softer."
Watch: 500 is a full pill, not a huge rectangle radius — jumping straight there is "make everything
pills", which is more than "rounder".

**"Sharper" / "boxy" / "square"**
```jsonc
{ "shape": { "radiusPill": 0, "radiusCard": 0 } }
```

**"Make the accents orange" (any specific accent / brand colour)**
```jsonc
{ "colors": { "primary": "#FF8A2A" }, "shape": { "glowColor": "#FF8A2A" } }
```
The engine recomputes the derived inks (`on-primary`, `accent-ink`) automatically — do **not**
touch `colors.text` for an accent change. Check the report and stop.
Say: "The highlight colour is orange now — progress fills, active buttons, the play button."
Watch: "make the UI orange" (not "the accents") usually means surfaces too — move `background` and
`surface` to deep warm tones and let the inks re-derive; ask which they meant if unclear.

**"Darker" / "lighter" overall**
```jsonc
{ "colors": { "background": "#0A0604", "surface": "#1E1410" } }
```
Move `background` and `surface` together, keeping `surface` the lighter of the two on a dark theme.
`text` usually survives via the derived inks — the report tells you if it didn't.

**"Add outlines" / "cartoon style" / "comic edges"** — three tokens travel together; an outline
colour with no widths does nothing:
```jsonc
{ "colors": { "outline": "#1A1206" }, "shape": { "borderWidth": 3 }, "font": { "outlineWidth": 2 } }
```
Pick a near-black FROM the palette, not `#000000`.
Watch: never set `font.outlineWidth` with a pixel font (`press-start-2p`, `vt323`) — the stroke eats
the glyphs.

**"Remove the outlines"** — `null` deletes a key:
```jsonc
{ "colors": { "outline": null }, "shape": { "borderWidth": 0 }, "font": { "outlineWidth": 0 } }
```

**"Neon glow" / "purple glow" / glow in a brand hue**
```jsonc
{ "shape": { "glowColor": "#B44BFF" } }
```
`glowColor` is any 6-digit hex and wins over the curated `glow` key (including over `"none"`, so one
patch turns a zero-glow theme neon). A darker `background` makes a glow read. Remove with
`{"shape": {"glowColor": null}}`.

**"Glossier" / "shinier" / "candy look"**
```jsonc
{ "shape": { "gloss": 0.5, "bevel": 0.6 } }
```
`gloss` is the sheen band across the upper face; `bevel` is the lit-top/shadowed-bottom edge light.
Raise both for moulded 3D plastic. Both are white-alpha overlays over each element's own fill — no
colour to pick.
Watch: a `backdrop` decoration on an element replaces its gloss+bevel layer (documented contract).

**"Flatter" / "matte" / "less 3D"**
```jsonc
{ "shape": { "gloss": 0, "bevel": 0 } }
```

**"Retro" / "pixel" / "8-bit"** — a four-token cluster; copy the whole thing:
```jsonc
{
  "font": { "key": "press-start-2p", "outlineWidth": 0 },
  "shape": { "radiusPill": 0, "radiusCard": 0, "glow": "none", "imageRendering": "pixelated" }
}
```

**"Different font" / a mood font** — one token, but check the case table below first:
```jsonc
{ "font": { "key": "creepster", "case": "normal" } }
```
Mood → font: spooky → `creepster` · retro arcade → `press-start-2p` · tropical → `pacifico` ·
sci-fi/cyber → `orbitron` / `space-grotesk` · cartoon → `lilita-one` · candy/casual → `fredoka` ·
dark fantasy → `grenze-gotisch` · epic fantasy → `cinzel` · sports/action → `bebas-neue`.

**"Bigger text" / "smaller text"**
```jsonc
{ "font": { "sizeScale": 1.1 } }
```
Watch: size cannot fix word cohesion — tracking is em-based and scales with it. If labels read as
scattered letters, the fix is the face or `trackingLabel`, not scale.

**"Make the health bar pop" / a different health colour**
```jsonc
{ "elements": { "healthBar": { "colors": { "primary": "#FF1A1A" }, "shape": { "glow": "horror-red" } } } }
```

**"The bar fill blends into its track"** — give the bar a darker trough than the theme ground:
```jsonc
{ "elements": { "progressBar": { "colors": { "background": "#12100C" } } } }
```
A trough must be the darkest thing in its widget or the fill cannot be the brightest.

**"Add a frame / drips / scanlines"** — a curated decoration on one element class:
```jsonc
{ "decorations": { "healthBar": { "borderImage": "drip-border" } } }
```
Keys and the slots they suit: `get-hud-catalog.decorations`. Remove one with
`{"decorations": {"healthBar": {"borderImage": null}}}`.

**"Style the mobile buttons / joystick"** — the touch layer is the `mobileControls` element class:
```jsonc
{ "elements": { "mobileControls": { "colors": { "primary": "#FF8800", "text": "#FFE8D0" } } } }
```
The action buttons follow its `primary`/`danger`/`warning`, the joystick follows its `text`.

**"Make it look like <genre>"** — preset first, patch second. Archetype matches a preset → write the
name (`rift-raider`, `village-keep`, `nexus`, `simulator`, `racing`). "Like X but ..." → preset +
patch in one call. No preset fits (horror, tropical, candy, brand) → a from-scratch inline theme
(worked examples below). Then handle the cover image (last section).

### Not themeable today — say so

Asks with no token: don't improvise them in game code; tell the user it isn't a supported look yet
(plain language, no token names).

| Ask | Why not |
| --- | --- |
| Glass / translucent panels | compositing over the 3D scene would break the readability guarantees |
| Chamfered / cut corners | corner shape beyond radius isn't a token |
| Different radius for buttons vs pills alone | one `radiusPill` covers the pill family |
| Wider spacing / denser layout | spacing is layout, not skin |
| A full colour ramp across health tiers | tier colours come from `danger`/`warning`/`primary` (+ per-element overrides) |

## Token reference

```jsonc
{
  "name": "Tropical Beach",                 // shown in UI, not load-bearing
  "font": {
    "key": "pacifico",                       // from get-hud-catalog.fonts[].key
    "case": "normal",                         // "upper" | "normal" — display fonts use "normal"
    "weightBody": 400,                        // 300 | 400 | 500 | 700
    "weightHeading": 700,                     // 400 | 500 | 700 | 900
    "trackingLabel": 1.0,                     // 0–4 px letter-spacing for label-voice text
    "outlineWidth": 0,                        // optional 0–3: text outline (in colors.outline) on display-scale text. Keep ≤2; never on pixel fonts.
    "sizeScale": 1                            // optional 0.85–1.3: relative text size over every themed font-size. Raise for narrow / single-weight faces that read small at the same px; omit for none. No shipped preset uses it — they buy legibility with face, weight and tracking instead, because tracking is em-based and scales with the multiplier, so a size bump can never fix word cohesion.
  },
  "colors": {
    "primary":    "#1FB3A4",                 // accent / progress fills / active
    "danger":     "#FF6B4A",                 // low health / destructive
    "background": "#FFF8E7",                 // the GROUND big UI stands on (dialogs, panels)
    "surface":    "#FFD6A5",                 // element fill (counters, toasts, bars, chips)
    "text":       "#1A2E3B",                 // ink on the ground
    "warning":    "#FFB74A",                 // optional
    "success":    "#84C99E",                 // optional
    "textMuted":  "#7B8DA3",                 // optional
    "outline":    "#12234A"                  // optional — border + text-outline colour (cartoon frames, gold trim). Omit = no outline concept.
  },
  "shape": {
    "radiusPill": 500,                        // 0–500. 500 = full pill (Bitmagic). 0 = sharp (retro/horror).
    "radiusCard": 12,                         // 0–32
    "glow":       "warm",                     // "aqua" | "pink" | "warm" | "horror-red" | "gold" | "cyan" | "none"
    "glowColor":  "#B44BFF",                  // optional 6-digit hex: glow in an exact hue; wins over `glow`, including over "none". Omit for keyed glow.
    "imageRendering": "auto",                 // "auto" | "pixelated" (pixel themes only)
    "borderWidth": 0,                         // optional 0–6: border (in colors.outline) around buttons/bars/counters — follows the radius (village-keep uses 3)
    "bevel": 0,                               // optional 0–1: white-top/dark-bottom EDGE light over buttons + fills
    "gloss": 0                                // optional 0–1: specular SHEEN band across the upper face — "glossy / candy". Separate from bevel; raise both for moulded 3D plastic.
  },
  "decorations": {                            // OPTIONAL. Keys are HUD element classes.
    "progressBar": { "borderImage": "vine-corner" },
    "healthBar":   { "decorationAfter": "ribbon-edge" }
  },
  "elements": {                               // OPTIONAL. Per-element token overrides.
    "healthBar": { "colors": { "primary": "#FF6B4A" } }
  }
}
```

Required: `name`, `font.key`, `colors.{primary,danger,background,surface,text}`, `shape` (can be `{}`).

### Value ladders (named stops — pick one, don't invent numbers)

| Token | Ladder |
| --- | --- |
| `shape.radiusPill` | 0 sharp · 8 softened · 14 chunky · 28 rounded · 500 pill |
| `shape.radiusCard` | 0 sharp · 4 crisp · 8 default · 18 soft · 32 max |
| `shape.bevel` | 0 flat · 0.3 hint · 0.6 moulded · 0.85 candy |
| `shape.gloss` | 0 matte · 0.25 sheen · 0.5 candy · 0.8 wet plastic |
| `shape.borderWidth` | 0 none · 2 trim · 3 cartoon · 5 heavy |
| `font.outlineWidth` | 0 none · 1 fine ring · 2 max |
| `font.sizeScale` | 0.9 smaller · 1 default · 1.1 bigger · 1.2 much bigger |
| `font.trackingLabel` | 0.5 tight · 1.0 relaxed · 1.6 airy · 2.5 wide |

### Font + case compatibility (pick the right pair first)

Each font is designed for a specific case style. Pair them correctly upfront — otherwise validation
auto-corrects `font.case` to the supported value and you'll have to explain the swap to the user.

| Font key           | Case to use   | What it evokes                                  |
| ------------------ | ------------- | ----------------------------------------------- |
| `red-hat-display`  | `upper` or `normal` | Default Bitmagic — modern technical sans  |
| `bebas-neue`       | `upper` or `normal` | Tall display — sports, action, news ticker |
| `press-start-2p`   | `upper` or `normal` | 8-bit retro arcade, chiptune              |
| `space-grotesk`    | `upper` or `normal` | Geometric sans — sci-fi, technical        |
| `rubik-mono-one`   | `upper` or `normal` | Heavy slabby blocks — bold, attention      |
| `vt323`            | `upper` or `normal` | CRT terminal monospace — hacker, glitch    |
| `orbitron`         | `upper` or `normal` | Futuristic geometric — sci-fi, cyber, racing |
| `chakra-petch`     | `upper` or `normal` | Chamfered techno — holographic HUD, sci-fi console |
| `ibm-plex-sans`    | `upper` or `normal` | Engineered humanist — instrument panel, tabular data |
| `archivo-narrow`   | `upper` or `normal` | Narrow gothic with ink — motorsport telemetry, overlays |
| `baloo-2`          | `upper` or `normal` | Rounded chunky sans, full 400-800 range — mobile action-RPG chrome |
| `lilita-one`       | `upper` or `normal` | Chunky rounded comic — cartoon battler     |
| `fredoka`          | `upper` or `normal` | Soft rounded bubble — candy, casual mobile |
| `cinzel`           | `upper` or `normal` | Carved Roman caps — epic fantasy, temple   |
| **`creepster`**    | **`normal` only**   | Already display-styled (horror dripping)   |
| **`pacifico`**     | **`normal` only**   | Cursive handwritten (tropical, casual)    |
| **`shrikhand`**    | **`normal` only**   | Italic display (celebratory, party)        |
| **`grenze-gotisch`** | **`normal` only** | Blackletter (dark fantasy) — caps unreadable |

**Rule of thumb**: cursive (Pacifico), already-display-styled (Creepster), italic-display
(Shrikhand), and blackletter (Grenze Gotisch) fonts ALWAYS need `case: "normal"`. If the user wants
both an uppercase brand voice AND a horror/tropical/celebratory feel, suggest an upper-compatible
font that matches the mood (e.g. `bebas-neue` for tropical block letters).

## The colour system — three levels, and the inks you never pick

The engine renders a theme at three levels:

- **Ground** (`background` + `text`/`textMuted`): the canvas big UI stands on — modal cards, the
  lobby panel, a game's own dialogs.
- **Furniture** (`surface`): the elements laid ON a ground — counters, timers, toasts, bars, the
  controls box. Ink on furniture is DERIVED (`on-surface`), never picked.
- **Trough** (per-element `colors.background`): the channel inside a widget — a bar's track. Darkest
  thing in its widget.

On a uniformly dark theme the levels nearly coincide; on a light-ground theme (village-keep) they
are the whole design.

**The derived inks are computed for you.** `on-primary`, `on-danger`, `on-surface(-muted)`,
`accent-ink` and `danger-ink` are derived from the tokens you set, with substitution only where your
literal value could not be read. Practical consequences:

- An accent change never requires touching `text`.
- You cannot break furniture-text readability by darkening `surface`.
- The write report tells you when a substitution fired (`SUBSTITUTED -> renders #X`) and what the
  engine will actually draw — decide from the report, not by guessing.
- The pairings with **no** auto-fix (report marks them `LOW`): `text` on `background`, and a bar
  fill against its trough. Those two are yours.

## Decoration slots

Each HUD element class (`progressBar`, `healthBar`, `counter`, `iconText`, `timer`, `toast`,
`controls`, `reticle`, `mobileControls`) has four optional slots:

- `borderImage` — CSS border-image around the element box (drips, brackets, pixel corners)
- `backdrop` — background image inside the element box (scanlines, circuit traces)
- `decorationBefore` — `::before` flourish ABOVE/before the element
- `decorationAfter` — `::after` flourish BELOW/after the element (blood drips under a health bar)

Each slot value is EITHER:
- A curated key (preferred) — `"drip-border"`, `"scanline"`, `"glow-aura"`, etc. See
  `get-hud-catalog.decorations` for keys and the slots each suits.
- An inline SVG object (≤16kb) — only when no curated decoration fits.

### Authoring a custom inline decoration — the checklist

Start from a curated SVG, not from nothing: `get-hud-catalog` returns the source of any curated
decoration via its `decorationSvg` input (in a CLI project, read `engine/hud/decorations.ts`).
Fetch the one or two closest to what you want and adapt. Then:

1. **`borderImage`: author `borderSlice` in viewBox units.** The engine stamps the SVG's intrinsic
   size, so a `viewBox="0 0 48 48"` frame with 12-unit corners takes `"borderSlice": 12`.
2. **A repeating `backdrop`/flourish must state its tile**: `"size": "32px 32px", "repeat":
   "repeat"` — never `auto`. A viewBox-only SVG has no intrinsic size, so `auto` scales ONE copy
   over the whole element (this shipped: a circuit-trace texture drew giant crosshairs instead of a
   fine grid).
3. **`preserveAspectRatio="none"` needs an explicit size, not `cover`** — `cover` honours the
   viewBox ratio, which is exactly what that attribute disclaims.
4. **Use colour tokens** — `__primary__`, `__danger__`, `__surface__`, `__text__` as fill/stroke —
   so one SVG survives every later palette change.
5. **Then look** (report / verify screenshot). A decoration that renders wrong at one element size
   can look fine at another.

`size` takes `cover`, `contain`, `auto`, or two plain lengths in `px` / `%`. Nothing else — the
value goes straight into a `background-size` declaration.

Three correctly-sized starting points:

```jsonc
// Tiling texture (backdrop): diagonal weave in the theme's text colour
{ "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M-6 6 L6 -6 M0 24 L24 0 M18 30 L30 18' stroke='__text__' stroke-width='2' opacity='0.08' fill='none'/></svg>",
  "size": "24px 24px", "repeat": "repeat" }
```

```jsonc
// Border-image frame: single rounded band with corner dots, slice in viewBox units
{ "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><rect x='4' y='4' width='40' height='40' rx='6' fill='none' stroke='__primary__' stroke-width='3'/><circle cx='8' cy='8' r='2' fill='__primary__'/><circle cx='40' cy='8' r='2' fill='__primary__'/><circle cx='8' cy='40' r='2' fill='__primary__'/><circle cx='40' cy='40' r='2' fill='__primary__'/></svg>",
  "borderSlice": 12, "repeat": "stretch" }
```

```jsonc
// Flourish strip (decorationAfter): repeating triangles hanging under the element
{ "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 12' preserveAspectRatio='none'><path d='M0 0 L5 8 L10 0 L15 8 L20 0 L25 8 L30 0 Z' fill='__primary__' opacity='0.7'/></svg>",
  "size": "30px 100%", "position": "bottom", "repeat": "repeat-x" }
```

## Icons

The engine ships default SVG icons for three slots:

- `heart` — shown next to "HP" on the player health bar
- `mouse` — shown on the "Click to play" pointer-lock overlay
- `arrow` — shown next to W/A/S/D in the controls overlay (one SVG; CSS rotates it for the four directions)

Themes can REPLACE any of these by providing inline SVG markup in the `icons` field:

```jsonc
"icons": {
  "heart": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='__danger__' d='...'/></svg>",
  "arrow": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path stroke='__primary__' ... /></svg>"
}
```

Rules:
- Inline SVG only (≤16kb per slot).
- Use `viewBox` and omit fixed width/height — the icon scales to 1em (the surrounding text size).
- Use `fill="currentColor"` / `stroke="currentColor"` if you want the icon to follow the text color naturally — works in any theme.
- Use `__primary__`, `__danger__`, `__surface__`, `__text__`, etc. tokens for explicit theme colors that the engine substitutes at apply time. Same tokens as decorations.
- Slots you don't provide keep the engine defaults. So a horror theme that only wants a dripping heart can leave `mouse` and `arrow` unset.
- **Replacement is at theme-apply time.** Themes set via the agent trigger a reload, so the iframe rebuilds the HUD and new icons render. If you call `setTheme()` mid-game without a reload, already-rendered icon DOM doesn't update.

### Worked example — Horror dripping heart

```jsonc
"icons": {
  "heart": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='__danger__' d='M12 21s-7.5-4.6-9.8-9.5C.6 7.5 3 3.5 7 3.5c2.1 0 3.7 1 5 2.7 1.3-1.7 2.9-2.7 5-2.7 4 0 6.4 4 4.8 8C19.5 16.4 12 21 12 21z'/><circle cx='10' cy='22' r='0.8' fill='__danger__'/><circle cx='14' cy='23' r='0.5' fill='__danger__'/></svg>"
}
```

The heart picks up the theme's `danger` color (blood red in horror) and adds two small drips below.
`mouse` and `arrow` stay default.

When the user asks for distinctive icons, **author them yourself** — don't tell them "the engine
doesn't support custom icons." It does. Aim for clean monochrome SVGs (one or two paths) that read
well at 1em. Inline `__primary__` / `__danger__` tokens so the icon recolors automatically if the
user later tweaks the palette.

## Per-element overrides

`elements.<className>` overrides the global theme for one element class. The classes are the same
nine the decoration slots use. Three patterns cover nearly every ask:

```jsonc
"elements": {
  // Health bar pops while the rest of the HUD stays calm:
  "healthBar":   { "colors": { "primary": "#FF1A1A", "danger": "#FFE10F" }, "shape": { "glow": "horror-red" } },
  // A bar's TROUGH — the darkest thing in its widget, so the fill reads:
  "progressBar": { "colors": { "background": "#12100C" } },
  // The touch layer (joystick + on-screen buttons) — buttons follow primary/danger/warning, the stick follows text:
  "mobileControls": { "colors": { "primary": "#FF8800" } }
}
```

Overrides re-derive the readable inks per element — darkening one element's `surface` fixes its own
text automatically.

## Built-in presets

Exactly five, one per game genre language. A game with no `worldProfileData.hud.theme` renders the
engine's neutral default look (Bitmagic — aquamarine on dark); that default is **not** a selectable
preset and must not be written as one. There is no horror, retro/pixel, fantasy or candy preset —
those are custom inline themes (worked examples below).

| Preset | Mood | Font |
| --- | --- | --- |
| `rift-raider` | Mobile action-RPG — cast-gold medallion frames on dark indigo glass, chunky cream type, royal borders | `baloo-2` |
| `village-keep` | Cartoon strategy — light parchment panels with darker moulded HUD chips over a sunny world, candy-green glossy buttons, ink-outlined type, zero glow | `fredoka` |
| `nexus` | Holographic sci-fi — hairline cyan on near-black, corner brackets, lit plate buttons, glow | `chakra-petch` |
| `simulator` | Serious instrument panel — flat slate, hard corners, one azure accent, thin meters, no ornament | `ibm-plex-sans` |
| `racing` | Motorsport telemetry — white line-art chrome on black, red reserved for state, narrow gothic caps | `archivo-narrow` |

## Worked examples — from-scratch custom themes

Only for asks no preset covers and no patch reaches. For "preset X but tweaked", never rebuild —
preset + patch in one call.

```jsonc
{
  "name": "Tropical Beach",
  "font": { "key": "pacifico", "case": "normal" },
  "colors": {
    "primary": "#1FB3A4", "danger": "#FF6B4A",
    "background": "#FFF8E7", "surface": "#FFD6A5", "text": "#1A2E3B",
    "warning": "#FFB74A", "success": "#84C99E"
  },
  "shape": { "radiusPill": 500, "radiusCard": 12, "glow": "warm" },
  "decorations": {
    "progressBar": { "borderImage": "vine-corner" }
  }
}
```

### Horror mansion
```jsonc
{
  "name": "Horror Mansion",
  "font": { "key": "creepster", "case": "normal", "trackingLabel": 0.5 },
  "colors": {
    "primary": "#8B0000", "danger": "#FF1A1A",
    "background": "#050505", "surface": "#1A0808", "text": "#E8E0D0"
  },
  "shape": { "radiusPill": 0, "radiusCard": 0, "glow": "horror-red" },
  "decorations": {
    "progressBar": { "borderImage": "drip-border" },
    "toast":       { "borderImage": "bracket-frame" }
  },
  "elements": { "healthBar": { "colors": { "primary": "#C71010" } } }
}
```

### Retro Pixel
```jsonc
{
  "name": "Retro Pixel",
  "font": { "key": "press-start-2p", "case": "normal", "trackingLabel": 0.5 },
  "colors": {
    "primary": "#39FF14", "danger": "#FF0040",
    "background": "#000000", "surface": "#1A1A1A", "text": "#FFFFFF"
  },
  "shape": { "radiusPill": 0, "radiusCard": 0, "glow": "none", "imageRendering": "pixelated" },
  "decorations": {
    "progressBar": { "borderImage": "pixel-corners" }
  }
}
```

## Don't forget the start-screen cover image

A theme change usually implies a mood change, and the cover image (`hud.startScreen.imageUrl`) is
the loudest piece of that mood. Every game created from a community template ships with a *default*
cover matching the original template's vibe — a sunny voxel village, a first-person fantasy valley,
etc. Leaving that default in place after switching to a horror or sci-fi theme is the most common
visible bug.

After `write-hud-theme` succeeds, check the success message — it echoes the current
`hud.startScreen.imageUrl` when one is set. If the cover no longer matches the new mood:

1. Call `imageAssetGenerationTool` with a prompt that matches the new theme (e.g. *"Dark gothic
   voxel courtyard at night, dripping moonlight, painterly horror cover art. No text or UI."* for a
   horror swap).
2. Take the returned URL and write it to `hud.startScreen.imageUrl` in `world.json`, and set
   `hud.startScreen.imageSource` to `"generated"` alongside it (preserve other fields under
   `hud.startScreen`). Sharing requires a cover the game owns — a new URL without `imageSource`
   leaves it looking like the template default.

If the user explicitly told you to leave the existing cover alone, or has already set a custom URL
that fits the new theme, skip the regeneration. Otherwise, treat cover regeneration as part of a
"make this <X> themed" request — don't stop at swapping the HUD theme.

## What you don't need to worry about

- Loading the font. The engine emits a single Google Fonts `<link>` for the active theme's font
  automatically. Published games load exactly one font — no matter how many themes the user tried
  during creation.
- Schema validation on the engine side. The engine's `resolveWorldTheme` falls back to Bitmagic with
  a console warning if a written theme is malformed. Write-time validation catches the issues first,
  but a bad theme will never break the game.
- Re-creating HUD elements after a theme swap. Theme changes are just CSS custom property swaps —
  health bar, counters, etc. keep their existing DOM nodes.
- Hand-checking contrast. The write report computes every derived pairing with the engine's own
  colour math; read the report instead of doing WCAG arithmetic.

## What you DO need to think about

- Don't invent font or decoration keys. Use `get-hud-catalog` first. The catalog is the source of truth.
- Patch, don't rebuild. Incremental asks are `patch` calls; full rewrites are for from-scratch themes only.
- Read the `report` after every write: `SUBSTITUTED` tells you what will actually render; `LOW`
  names the two pairings that are yours to fix (`text` on `background`, bar fill vs trough).
- Pick the font that matches the user's brief (mood table in the cookbook's font entry).
