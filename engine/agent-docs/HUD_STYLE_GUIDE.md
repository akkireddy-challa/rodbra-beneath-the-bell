# HUD Style Guide

This document defines the visual style standards for the game HUD system. All HUD elements should follow these guidelines for a consistent, professional appearance across all AI-generated games.

> **Read this when you are WRITING a custom HUD element** and need it to match whatever theme the
> game is running. If instead you want to *change the game's look*, you are on the wrong page: five
> ready-made presets and the full theme vocabulary are in `HUD_THEMES.md`, and switching to one is a
> single value — no CSS involved. The two fit together as: a theme sets the `--hud-*` variables,
> and the rules below are how your own element consumes them.

## What theming actually gives you (and what it does not)

Be accurate with users about this, because the gap is easy to oversell.

**A theme sets tokens, and tokens style the elements the engine already draws.** Picking a preset
restyles the built-in HUD — health bar, counters, timers, toasts, the controls overlay, modals — in
one value, completely and instantly. That is the whole of what `HUD_THEMES.md` delivers, and for
most asks it is enough.

**A theme does not lay out new UI for you.** There is no themed inventory grid, ability-card row,
gauge dial or slot panel that arrives with a preset. If a user asks for "an inventory panel in the
game's style", what exists is: the element factories in `HUD_ELEMENTS.md` for structure, and the
`--hud-*` variables below so what you build inherits the active theme's palette, radii and type.
You are authoring that panel; the theme only makes sure it does not clash.

So: promise a restyle, and build anything beyond the built-in elements yourself against the
variables. Saying "the engine ships a themed inventory panel" would be wrong, and saying "the HUD
cannot be themed" would be equally wrong.

## CSS Variables Reference

These are the theme variables the engine actually sets (ThemeManager writes them on `document.documentElement` from the active HUD theme). Custom elements built with `createCustomElement` MUST use them instead of hardcoded colors — a hardcoded `rgba(0,0,0,0.7)` panel stays navy-dark when the user switches to a candy or parchment theme and reads as a bug.

```css
/* Colors — from the theme's colors block */
--hud-color-primary        /* accent: fills, active states, highlights */
--hud-color-danger         /* damage, destructive emphasis */
--hud-color-warning
--hud-color-success
--hud-color-background     /* outer recessed surface: the ground BIG UI stands on */
--hud-color-surface        /* element fill (cards, tracks, buttons) */
--hud-color-text           /* ink on the background ground */
--hud-color-text-muted
--hud-color-on-primary     /* auto-derived readable text on primary */
--hud-color-on-danger      /* auto-derived readable text on danger */
--hud-color-on-surface     /* auto-derived readable text ON an element fill */
--hud-color-on-surface-muted
--hud-color-outline        /* only set when the theme defines colors.outline */

/* WHICH LEVEL IS AN ENGINE CLASS ON?  Get this wrong and the fix looks like a
   colour bug when it is a level bug.
     GROUND (background + text/text-muted)  .hud-lobby-panel, .ui-modal-card —
       big UI: the canvas that rows, fields, chips and badges sit IN.
     FURNITURE (surface + on-surface/-muted)  .hud-counter, .hud-timer,
       .hud-toast, .hud-progress-bar, .hud-controls, .hud-esc-hint,
       .hud-notification, .hud-npc-speech-bubble, .hud-interaction-prompt,
       .hud-lobby-input — elements laid ON a ground.
   A panel of your own is GROUND. Anything you lay on it is FURNITURE, including
   inside a lobby panel or a modal card.
   ACCENT TYPE on a ground goes through --hud-color-accent-ink (or
   --hud-color-danger-ink for errors), never raw --hud-color-primary: an accent
   picked to sit on dark furniture is 1.3:1 on a light ground. Both are ABSENT on
   a theme where the raw accent already reads, so the var() fallback is the
   normal path. */

/* Which ink to use, and why there are two.
   `text` is the ink for the BACKGROUND ground — dialogs and panels your game
   paints itself. `on-surface` is the ink for anything sitting on a `surface`
   fill. They are the same value on a theme whose ground and elements are both
   dark, and they diverge on one whose big UI is light and whose HUD chips are
   darker: village-keep is light parchment with mid-brown chips, so `text` is
   dark brown and `on-surface` derives to white. If you paint on
   `--hud-color-surface`, use `--hud-color-on-surface` — hard-coding `text` there
   is readable on four presets and 1.8:1 on the fifth. */

/* Typography — from the theme's font block */
--hud-font-family
--hud-font-weight-body
--hud-font-weight-heading
--hud-font-case            /* uppercase | none — use with text-transform */
--hud-font-tracking-label  /* letter-spacing for label-voice text */
--hud-text-outline-width   /* only set when font.outlineWidth > 0 */

/* Shape & effects — from the theme's shape block */
--hud-radius-pill
--hud-radius-card
--hud-glow-color           /* rgba glow for shadows/auras */
--hud-image-rendering      /* auto | pixelated */
--hud-border-width         /* only set when shape.borderWidth > 0 */
--hud-bevel-top            /* only set when shape.bevel > 0 */
--hud-bevel-bottom
```

**Always pair with a fallback equal to the look you'd hardcode** — the variables marked "only set when…" are absent on themes that don't use them:

```css
background: color-mix(in srgb, var(--hud-color-surface, #000000) 70%, transparent); /* translucent panel that tints with the theme */
border: 1px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 30%, transparent); /* subtle border from the text color */
border-radius: var(--hud-radius-card, 8px);
font-family: var(--hud-font-family, system-ui, sans-serif);
```

Spacing, transitions, and exact pixel sizes are NOT themed — use `hud.getScale()` values (see HUD_ELEMENTS.md) or plain literals for those. Colors that carry gameplay meaning (team red vs. blue) stay literal on purpose.

---

## Design Philosophy

The HUD should be **invisible until needed** - clean, minimal, and non-distracting. It should feel like a natural part of any game world, whether fantasy, sci-fi, or realistic.

Key principles:
1. **Readability first** - Text must be readable over any background
2. **Minimal footprint** - Don't obscure gameplay
3. **Consistent styling** - All elements share the same visual language
4. **Responsive feedback** - Animations provide user feedback

---

## Color Palette

Colours come from the theme. **Always write the `var()`**; the literals in this document are the
DEFAULT theme's resolved values and exist only as fallbacks and to show what the default looks like.

| Purpose | Write this | Default resolves to |
|------|-------|-------|
| Panel / container fill | `var(--hud-color-surface, rgba(0, 0, 0, 0.7))` | near-black |
| Big-UI ground (own dialogs) | `var(--hud-color-background, #0b0b0b)` | near-black |
| Main text on a surface fill | `var(--hud-color-on-surface, var(--hud-color-text, #ffffff))` | white |
| Main text on the ground | `var(--hud-color-text, #ffffff)` | white |
| Labels / secondary | `var(--hud-color-on-surface-muted, var(--hud-color-text-muted, #b3b3b3))` | grey |
| Panel border | `color-mix(in srgb, var(--hud-color-text, #ffffff) 20%, transparent)` | faint white |
| Info / highlights / titles | `var(--hud-color-primary, #4a9eff)` | theme accent |
| Healthy / positive | `var(--hud-color-success, #4ade80)` | green |
| Caution / medium | `var(--hud-color-warning, #fbbf24)` | amber |
| Critical / errors | `var(--hud-color-danger, #ef4444)` | red |

### Health Bar Gradients

Tier fills derive from the theme's status colours — shade within the fill, never a second palette:

```css
/* Healthy (>60%) */
background: linear-gradient(180deg, var(--hud-color-success, #4ade80) 0%, color-mix(in srgb, var(--hud-color-success, #4ade80) 72%, #000000) 100%);

/* Warning (30-60%) */
background: linear-gradient(180deg, var(--hud-color-warning, #fbbf24) 0%, color-mix(in srgb, var(--hud-color-warning, #fbbf24) 72%, #000000) 100%);

/* Critical (<30%) */
background: linear-gradient(180deg, var(--hud-color-danger, #ef4444) 0%, color-mix(in srgb, var(--hud-color-danger, #ef4444) 72%, #000000) 100%);
```

## Typography

### Font Stack

| Purpose | Write this |
|---------|-------------|
| Primary | `var(--hud-font-family, system-ui, sans-serif)` — the THEME's font, never a hardcoded family |
| Monospace | `'Courier New', monospace` — timers/counters only, when tabular digits matter more than the theme voice |
| Impact | `'Impact', 'Arial Black', sans-serif` — comic bubbles / special effects only |

**Usage:**
- Primary: all standard HUD text. Weights via `var(--hud-font-weight-body, 400)` /
  `var(--hud-font-weight-heading, 700)`; casing via `text-transform: var(--hud-font-case, none)`.
- Monospace: timers, counters, numeric values
- Impact: comic bubbles, special effects

### Size Scale

| Name | Size | Usage |
|------|------|-------|
| xs | `10px` | Hints, badges, fine print |
| sm | `11px` | Labels, secondary text |
| md | `12px` | Body text, progress labels |
| lg | `14px` | Controls guide, descriptions |
| xl | `16px` | Emphasized text, icon-text |
| 2xl | `20px` | Icons |
| 3xl | `24px` | Game name, headings, counters |
| 4xl | `28px` | Large timers |

### Text Shadows

Always use text shadows for readability over varied backgrounds:

```css
/* Light - for small text */
text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);

/* Medium - for body text */
text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);

/* Strong - for headings */
text-shadow: 2px 2px 6px rgba(0, 0, 0, 1.0);
```

---

## Container Styles

### Standard Panel

Used for: Health bar, controls guide, custom elements

```css
background: var(--hud-color-surface, rgba(0, 0, 0, 0.7));
padding: 10px 15px;
border-radius: 8px;
border: 2px solid rgba(255, 255, 255, 0.3);
```

### Title Panel

Used for: Game name display

```css
background: var(--hud-color-surface, rgba(0, 0, 0, 0.7));
padding: 15px 20px;
border-radius: 10px;
border: 2px solid rgba(255, 255, 255, 0.3);
font-size: 24px;
font-weight: bold;
```

### Subtle Badge

Used for: ESC hint, small indicators

```css
background: rgba(0, 0, 0, 0.4);
padding: 6px 12px;
border-radius: 4px;
font-size: 11px;
opacity: 0.8;
/* No border */
```

### Compact Panel

Used for: Icon+text, small status indicators

```css
background: var(--hud-color-surface, rgba(0, 0, 0, 0.7));
padding: 8px 12px;
border-radius: 8px;
border: 2px solid rgba(255, 255, 255, 0.3);
```

---

## Spacing System

### Spacing Scale

| Name | Size | Usage |
|------|------|-------|
| xs | `4px` | Tight spacing within elements |
| sm | `8px` | Gap between stacked elements |
| md | `10px` | Internal panel padding |
| lg | `15px` | Standard panel padding |
| xl | `20px` | Screen edge margins |

### Screen Margins

All HUD elements should maintain `20px` margin from screen edges:

```
    20px
  ┌──┬────────────────────────────────────┬──┐
  │  │                                    │  │
20px │          GAME VIEWPORT             │ 20px
  │  │                                    │  │
  │  │                                    │  │
  └──┴────────────────────────────────────┴──┘
    20px
```

### Gap Between Elements

Elements at the same anchor position stack with `8px` gap:

```css
gap: 8px;
```

### Anchors are independent — content wraps, never pushes

Each of the 9 anchors is its own absolutely-positioned stack with a width clamp
(corners/edges ~38vw, centers ~72vw). A wide element or long toast in one anchor
can NEVER move another anchor or push UI off-screen — oversized content wraps
inside its own stack instead. Don't try to "make room" for other anchors with
spacers or width hacks; just place elements at the anchor you want.

---

## Animation & Transitions

### Timing Functions

| Name | Value | Usage |
|------|-------|-------|
| Default | `ease-out` | Most UI transitions |
| Snappy | `ease-in-out` | Toggles, quick actions |
| Smooth | `cubic-bezier(0.4, 0, 0.2, 1)` | Elaborate animations |

### Duration Scale

| Name | Duration | Usage |
|------|----------|-------|
| Instant | `0ms` | No transition needed |
| Fast | `150ms` | Hover states, small changes |
| Normal | `300ms` | Show/hide, value changes |
| Slow | `500ms` | Fade out, elaborate effects |
| Very Slow | `1000ms` | Controls auto-hide fade |

### Common Transitions

```css
/* Fade In */
opacity: 0 → 1;
transition: opacity 300ms ease-out;

/* Fade Out */
opacity: 1 → 0;
transition: opacity 500ms ease-out;

/* Controls Auto-Hide */
opacity: 1 → 0;
transition: opacity 1000ms ease-out;

/* Value Change (progress bars) */
transition: width 300ms ease-out;

/* Color Change (health bar) */
transition: background 300ms ease-out;
```

---

## Component Visual Reference

### Game Name

```
╔═══════════════════════╗
║   Explorer World      ║   24px bold white
╚═══════════════════════╝   Dark panel, prominent border
```

### Health Bar

```
╔═══════════════════════╗
║ ❤️ HP                  ║   12px bold label
║ ████████████░░░░░░░░░ ║   20px bar height, gradient fill
║     75 / 100          ║   11px centered text
╚═══════════════════════╝
```

### Controls Guide

```
╔═══════════════════════╗
║ Controls              ║   14px bold var(--hud-color-primary, #4a9eff) (accent)
║───────────────────────║
║ W/↑ - Move Forward    ║   14px white
║ S/↓ - Move Backward   ║   Strong keys, light description
║ A/← - Move Left       ║
║ ...                   ║
╚═══════════════════════╝
```

### ESC Hint (Always Visible)

```
╔════════════════════╗
║ Press ESC for menu ║
╚════════════════════╝

Position: Bottom-left corner (bottom: 20px, left: 20px)
Background: var(--hud-color-surface, rgba(0, 0, 0, 0.7))
Border: 2px solid rgba(255, 255, 255, 0.3)
Font size: 14px
Padding: 10px 16px
Border radius: 8px

Visibility: ALWAYS visible when pointer is locked
Transition: 0.3s fade in/out
```

**Reserved Area:** The bottom-left anchor container is offset to `bottom: 70px` to avoid overlapping with this hint. Do not place large elements at `bottom-left` that might visually conflict.

### Counter (Score, Currency — ammo counters are engine-owned, see combat-system.md)

```
╔═══════════════════════╗
║ SCORE                 ║   11px uppercase label, muted
║ ⭐ 15,000             ║   24px bold value + 20px icon
╚═══════════════════════╝
```

### Timer

```
╔═══════════════════════╗
║     TIME LEFT         ║   11px uppercase label
║      02:45            ║   28px monospace, bold
╚═══════════════════════╝
```

### Icon + Text

```
╔═══════════════════════╗
║ 🔑  2 / 3             ║   20px icon, 16px text
╚═══════════════════════╝   8px gap between
```

### Reticle (Crosshair)

```
          │
          │
     ─────•─────    White lines + center dot
          │         4px gap from center
          │         2px thickness
                   Drop shadow for visibility
```

---

## Full Screen Mockup

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  ╔══════════════════╗                                                      │
│  ║  Explorer World  ║                                                      │
│  ╚══════════════════╝                                                      │
│                                                                            │
│  ╔══════════════════╗                                                      │
│  ║ ❤️ HP             ║                                                      │
│  ║ ████████████░░░░ ║                                                      │
│  ║    75 / 100      ║                                                      │
│  ╚══════════════════╝                                                      │
│                                                                            │
│  ╔══════════════════╗       (Controls fade out after 15s)                  │
│  ║ Controls         ║  ─┐                                                  │
│  ║──────────────────║   │                                                  │
│  ║ W/↑ - Forward    ║   │  opacity: 1 → 0                                  │
│  ║ S/↓ - Backward   ║   │  over 1 second                                   │
│  ║ A/← - Left       ║   │                                                  │
│  ║ D/→ - Right      ║  ─┘                                                  │
│  ║ Space - Jump     ║                                                      │
│  ║ ESC - Pause menu ║                                                      │
│  ╚══════════════════╝                                                      │
│                                                                            │
│                                                                            │
│                                   │                                        │
│                                   │                                        │
│                              ─────•─────    (Reticle - when armed)         │
│                                   │                                        │
│                                   │                                        │
│                                                                            │
│                                                                            │
│                                                                            │
│  ╔═══════════╗                                                             │
│  ║ 🔑 2 / 3  ║  ← bottom-left anchor (offset at 70px)                      │
│  ╚═══════════╝                                                             │
│                                                                            │
│  ╔════════════════════╗                                                    │
│  ║ Press ESC for menu ║  ← ESC hint (always visible, bottom: 20px)         │
│  ╚════════════════════╝                                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Best Practices for AI Agents

1. **Match existing style** - When creating new HUD elements, use the colors, fonts, and spacing defined in this guide

2. **Use factory methods** - Prefer `createProgressBar`, `createCounter`, etc. over custom elements when possible

3. **Keep it minimal** - Only show information that's immediately relevant to gameplay

4. **Respect the layout** - Don't place elements that overlap with the game name or built-in elements

5. **Test visibility** - Ensure text is readable over both light and dark game backgrounds

6. **Consider mobile** - Controls guide and ESC hint are hidden on mobile; use larger fonts (14px+)

7. **Use consistent transitions** - Follow the duration scale for animations

---

## Mobile Considerations

The HUD system automatically adapts for mobile devices with **dynamic viewport-based scaling** and the **same 9-anchor grid layout as desktop**.

### Mobile Layout: Same 9-Anchor Grid as Desktop

On mobile, **the HUD uses the same flexible layout as desktop**—elements can be placed in all corners, sides, and center. No grouping into a single chunk.

```
┌────────────────────────────────────────┐
│ [Game]              [Score] [Timer]   │ ← top-left, top-center, top-right
│                                        │
│ [HP]       (center)         [Mana]     │ ← middle-left, middle-center, middle-right
│                                        │
│          (Gameplay area)               │
│                                        │
│ [Keys]                  [Stamina]     │ ← bottom-left, bottom-center, bottom-right
│ [Joystick]              [Action btns] │ ← Mobile controls (with bottom clearance)
└────────────────────────────────────────┘
```

### What Changes on Mobile

| Element | Desktop | Mobile |
|---------|---------|--------|
| ESC Hint | Shown bottom-left | Hidden (no pointer lock) |
| Controls Guide | Auto-hide after 15s | Hidden (has on-screen controls) |
| Anchor System | 9 separate containers | Same 9-anchor grid |
| Element Sizing | Fixed pixel values | Dynamic viewport-based |
| Bar Width | 150px fixed | ~18% of viewport width |
| Game Name | Full display | Truncated with ellipsis |
| Bottom clearance | 70px (ESC hint) | 100–110px (joystick/buttons) |

### Mobile Design Tips

1. **Same anchors as desktop** - Place elements in any of the 9 positions
2. **Bottom anchors have clearance** - Extra offset to avoid joystick and action buttons
3. **Use viewport-relative sizes** - Built-in elements scale dynamically
4. **Test on multiple sizes** - Scaling adapts to viewport width

### Reserved Zones (Automatic)

**Desktop:** Standard 9-anchor grid with offsets:
- `bottom-left`: 70px from bottom (above ESC hint)

**Mobile:** Same 9-anchor grid with extra bottom clearance:
- `bottom-left`: 110px from bottom (above joystick zone)
- `bottom-right`: 110px from bottom (above action/interact buttons)
- `bottom-center`: 100px from bottom (clearance)

### Automatic Scaling

All built-in HUD elements automatically scale for mobile (very compact):
- **Fonts**: ~50% smaller on mobile (e.g., 24px → 13px)
- **Padding**: ~60% smaller (e.g., 15px → 6px)
- **Progress bars**: 80px wide on mobile vs 150px on desktop
- **Borders**: 1px on mobile vs 2px on desktop
- **Bar height**: 10px on mobile vs 20px on desktop

For custom elements, use `hud.getScale()` to access these values:

```typescript
const s = hud.getScale();
// s.fontLg = 14 on desktop, 10 on mobile
// s.paddingMd = 10 on desktop, 4 on mobile
// s.barWidth = 150 on desktop, 80 on mobile
```

