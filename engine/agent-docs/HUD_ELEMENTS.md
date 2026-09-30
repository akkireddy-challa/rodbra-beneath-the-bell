# HUD Elements System

This document provides a complete API reference for the extensible HUD system in `GameHUD.ts`.

## Overview

The HUD system provides two layers:
1. **Built-in elements** - Game name, health bar, controls overlay, reticle, ESC hint (existing functionality)
2. **Extensible element system** - Factory methods for creating custom HUD elements

> **Styling these elements is a separate concern.** Nothing on this page sets a colour or a font:
> every element renders from the active theme's `--hud-*` CSS custom properties. To change how the
> HUD *looks*, see `HUD_THEMES.md` (pick or author a theme — five ready-made presets exist). To
> style a **custom** element so it inherits the theme instead of hardcoding a palette, see
> `HUD_STYLE_GUIDE.md` for the variable list and the `var(--hud-…, fallback)` idiom.

All custom elements are:
- Registered by unique ID in a central registry
- Positioned using an anchor-based system (9 screen positions)
- Easily updated, shown, hidden, or removed at runtime

---

## Default UI Layout

The default HUD layout for all AI-generated games:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  ╔══════════════════╗                                                      │
│  ║  Explorer World  ║  ← Game name (always visible)                        │
│  ╚══════════════════╝                                                      │
│                                                                            │
│  ╔══════════════════╗                                                      │
│  ║ ❤️ HP             ║  ← Health bar (hidden by default, show for combat)   │
│  ║ ████████████░░░░ ║                                                      │
│  ║    75 / 100      ║                                                      │
│  ╚══════════════════╝                                                      │
│                                                                            │
│  ╔══════════════════╗                                                      │
│  ║ Controls         ║  ← Auto-hides after 15 seconds                       │
│  ║──────────────────║    Press H to toggle                                 │
│  ║ W/↑ - Forward    ║                                                      │
│  ║ S/↓ - Backward   ║                                                      │
│  ║ A/← - Left       ║                                                      │
│  ║ D/→ - Right      ║                                                      │
│  ║ Space - Jump     ║                                                      │
│  ║ ESC - Pause menu ║                                                      │
│  ╚══════════════════╝                                                      │
│                                                                            │
│                                   │                                        │
│                                   │                                        │
│                              ─────•─────  ← Reticle (show for ranged)      │
│                                   │                                        │
│                                   │                                        │
│                                                                            │
│                                                                            │
│  ╔════════════════════╗                                                    │
│  ║ Press ESC for menu ║                                                    │
│  ╚════════════════════╝                                                    │
│  ↑ Always visible (bottom-left)                                            │
│                                                      when pointer locked   │
└────────────────────────────────────────────────────────────────────────────┘
```

### Default Element Visibility

| Element | Default State | When Visible |
|---------|--------------|--------------|
| Game Name | Always visible | Always |
| ESC Hint | Auto | Always visible when pointer is locked |
| Controls Guide | Auto-hide | First 15 seconds, then fades. Press H to toggle |
| Health Bar | Hidden | When `showHealth()` called (combat games). Pass `{ width }` to set size. |
| Reticle | Hidden | When `showReticle()` called (ranged weapons) |

### Controls Behavior

```
┌─────────────────────────────────────────────────────────────────┐
│  CONTROLS AUTO-HIDE FLOW                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [Game Start] ──→ [Pointer Lock] ──→ [Controls Visible]        │
│                                              │                  │
│                                              ↓ (15 seconds)     │
│                                       [Fade Out - 1s]           │
│                                              │                  │
│                                              ↓                  │
│                                       [Controls Hidden]         │
│                                              │                  │
│                        ┌─────────────────────┼─────────────┐    │
│                        │                     │             │    │
│                        ↓                     ↓             ↓    │
│                   [H Key]           [Movement Change]   [H Key] │
│                   (toggle)          (re-show controls)  (show)  │
│                        │                     │             │    │
│                        ↓                     ↓             │    │
│                 [Controls Visible] ←─────────┴─────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| H | Toggle controls visibility |
| ESC | Pause menu (in a pointer-locked game, the same press also releases the cursor) |

## Alignment System

**All HUD elements automatically stack with no overlap.** Elements added to the same anchor position appear in order below earlier items.

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  ╔══════════════════╗                                           │
│  ║  Game Name       ║  ← Built-in (always first in top-left)    │
│  ╚══════════════════╝                                           │
│           ↓ gap                                                 │
│  ╔══════════════════╗                                           │
│  ║ ❤️ HP 75/100     ║  ← Built-in health (if enabled)           │
│  ╚══════════════════╝                                           │
│           ↓ gap                                                 │
│  ╔══════════════════╗                                           │
│  ║ ⚡ Stamina 50/100║  ← YOUR createProgressBar('stamina', ...)  │
│  ╚══════════════════╝                                           │
│           ↓ gap                                                 │
│  ╔══════════════════╗                                           │
│  ║ 🔑 Keys 2/3      ║  ← YOUR createIconText('keys', ...)       │
│  ╚══════════════════╝                                           │
│                                                                 │
│  All elements in the same anchor stack automatically!           │
└─────────────────────────────────────────────────────────────────┘
```

### 9 Anchor Positions

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  top-left           top-center           top-right              │
│  (built-in HUD                                                  │
│   stacks here)                                                  │
│                                                                 │
│  middle-left      middle-center        middle-right             │
│                                                                 │
│  bottom-left      bottom-center        bottom-right             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Stacking Order

Elements in each anchor stack **vertically in order of creation**:

1. **top-left**: Game Name → Health Bar (if enabled) → Controls (if shown) → YOUR elements
2. **top-right**: YOUR elements (in order added) → the engine's pause button (touch devices only, appended last; see `control-system.md`)
3. **top-center**: YOUR elements (in order added)
4. **Other anchors**: YOUR elements (in order added)

### Mobile Layout: Same 9-Anchor Grid as Desktop

**On mobile, the HUD uses the same flexible 9-anchor grid as desktop.** Elements can be placed in all corners, sides, and center—no grouping into a single chunk.

```
Mobile screen:
┌────────────────────────────────────────┐
│ [Game]              [Score] [Timer]    │  ← top-left, top-center, top-right
│                                        │
│ [HP]       (center)         [Mana]     │  ← middle-left, middle-center, middle-right
│                                        │
│     (Game area)                        │
│                                        │
│ [Keys]                  [Stamina]     │  ← bottom-left, bottom-center, bottom-right
│ [Joystick]              [Action btns] │  ← Mobile controls (separate, bottom clearance)
└────────────────────────────────────────┘
```

**Features:**
- Same 9-anchor grid as desktop
- Bottom anchors have extra clearance to avoid joystick and action buttons
- Dynamic viewport-based scaling for compact display

### Recommended Anchors by Use Case

| Use Case | Anchor | Mobile Behavior |
|----------|--------|-----------------|
| Score/counter | `top-right` | ✅ Same position as desktop |
| Timer | `top-center` | ✅ Same position as desktop |
| Stamina/mana bar | `top-left` | ✅ Same position as desktop |
| Key/collectible count | `bottom-left` | ✅ Same position (above joystick zone) |
| Minimap | `bottom-right` | ✅ Same position (above action buttons) |
| Custom HUD | any | ✅ All 9 anchors available |

## Element Types

### Progress Bar

Use for: Health, stamina, cooldowns, loading bars, experience points.

**Create:**
```typescript
hud.createProgressBar('stamina', {
    anchor: 'top-left',      // Screen position (default: 'top-left')
    label: 'Stamina',        // Label text above bar
    color: '#3498db',        // Bar fill color (default: '#4ade80' green)
    width: 150,              // Bar width in pixels (default: 150)
    showText: true,          // Show "current / max" text (default: true)
    initialValue: 100,       // Starting value (default: 100)
    maxValue: 100            // Maximum value (default: 100)
});
```

**Update:**
```typescript
// Update current value only
hud.updateProgressBar('stamina', 75);

// Update current and max
hud.updateProgressBar('stamina', 75, 100);
```

---

### Counter

Use for: Score, currency, collectibles count. NOT for ammo when using `RangedWeaponSystem` — that system auto-creates and updates its own bottom-right ammo counter (see combat-system.md); creating another one duplicates it.

**Create:**
```typescript
hud.createCounter('score', {
    anchor: 'top-right',     // Screen position (default: 'top-right')
    label: 'Score',          // Label text above value
    icon: '⭐',              // Icon before value (emoji or character)
    initialValue: 0,         // Starting value (default: 0)
    format: (v) => v.toLocaleString()  // Custom formatter (default: adds commas)
});
```

**Update:**
```typescript
hud.updateCounter('score', 15000);
```

---

### Icon + Text

Use for: Key counts, status indicators, simple labels with icons.

**Create:**
```typescript
hud.createIconText('keys', {
    anchor: 'bottom-left',   // Screen position (default: 'bottom-left')
    icon: '🔑',              // Icon (emoji or character)
    text: '0 / 3',           // Text content
    iconSize: 20             // Icon font size in pixels (default: 20)
});
```

**Update:**
```typescript
// Update text only
hud.updateIconText('keys', { text: '2 / 3' });

// Update icon only
hud.updateIconText('keys', { icon: '🗝️' });

// Update both
hud.updateIconText('keys', { icon: '🗝️', text: '3 / 3' });
```

---

### Timer

Use for: Countdown timers, elapsed time, speedrun timers.

**Create:**
```typescript
// Countdown timer
hud.createTimer('level-timer', {
    anchor: 'top-center',    // Screen position (default: 'top-center')
    label: 'Time Left',      // Label text above timer
    countDown: true,         // Count down (default: false = count up)
    startSeconds: 180,       // Starting time in seconds
    format: 'mm:ss',         // Format: 'mm:ss', 'hh:mm:ss', or 'seconds'
    onComplete: () => {      // Callback when countdown reaches 0
        console.log('Time up!');
    }
});

// Elapsed time timer (counts up)
hud.createTimer('playtime', {
    anchor: 'top-right',
    label: 'Time',
    countDown: false,
    startSeconds: 0,
    format: 'hh:mm:ss'
});
```

**Control:**
```typescript
// Start the timer
hud.startTimer('level-timer');

// Pause the timer
hud.pauseTimer('level-timer');

// Reset to original start value
hud.resetTimer('level-timer');

// Reset to new value
hud.resetTimer('level-timer', 300);
```

---

### Action Row (buttons / text inputs)

Use for: **anything the player taps, clicks or types into.** Prefer this over
`createCustomElement` for interactive UI — the engine owns the layout, so the
controls cannot land off-screen, cannot end up nested inside a game panel, and
cannot leak keystrokes or clicks into gameplay.

**Create:**
```typescript
hud.createActionRow('wave-actions', {
    anchor: 'top-right',      // Screen anchor (default: 'bottom-center')
    layout: 'row',            // 'row' | 'column' (default: 'row')
    wrap: true,               // Wrap when narrow instead of overflowing (default: true)
    label: 'Wave controls',   // Accessible group label (optional)
    controls: [
        {
            id: 'start',
            label: 'Start Wave',
            variant: 'primary',   // 'primary' | 'danger' | 'warning' | 'neutral'
            size: 'large',        // 'normal' | 'large' — large = ~25% bigger tap target
            onSelect: () => this.startWave(),
        },
        {
            id: 'cancel',
            label: 'Cancel',
            variant: 'danger',
            onSelect: () => this.cancelWave(),
        },
    ],
});
```

**Buttons with images:** give a button `imageUrl` (PNG/SVG/WebP — a game asset
URL) and the image is drawn ahead of its label. Leave out `label`, or set
`imageOnly: true`, for an icon button squared to the tap target; with
`imageOnly` the label stays the accessible name. Don't build image buttons with
`createCustomElement` — the action row already handles them.
```typescript
hud.createActionRow('shop', {
    anchor: 'bottom-right',
    controls: [
        { id: 'buy', label: 'Buy', imageUrl: '/assets/coin.png', variant: 'primary', onSelect: () => this.buy() },
        { id: 'bag', label: 'Inventory', imageUrl: '/assets/bag.svg', imageOnly: true, onSelect: () => this.openBag() },
    ],
});
hud.updateActionControl('shop', 'buy', { imageUrl: '/assets/gem.png' });  // swap the image
hud.updateActionControl('shop', 'buy', { imageUrl: null });               // remove it
```

**Update / show / hide / remove:**
```typescript
hud.updateActionControl('wave-actions', 'start', { label: 'Wave 2', disabled: true });
hud.updateActionControl('wave-actions', 'cancel', { visible: false });  // one control
hud.setActionRowVisible('wave-actions', false);                          // whole row
hud.removeActionRow('wave-actions');
```

**Text input control:**
```typescript
hud.createActionRow('room-entry', {
    anchor: 'middle-center',
    controls: [
        {
            id: 'name',
            kind: 'text-input',
            label: 'Room name',
            placeholder: 'my-room',
            onInput: (value) => console.log('typing', value),
            onSelect: (value) => this.joinRoom(value),   // fires on Enter
        },
    ],
});
const typed = hud.getActionControlValue('room-entry', 'name');
```

**What the engine guarantees, so you don't have to write it:**

| Guarantee | How |
|-----------|-----|
| Anchor-relative, outside game panels | The row is mounted on the anchor stack itself, never inside another element's HTML |
| Never off-screen | Controls wrap within the anchor's width clamp; portrait phones stack them full-width |
| Safe-area insets | Notch / home-indicator insets added on top of the normal HUD padding |
| 60px tap targets on touch | `--hud-tap-target` is 44px on desktop, 60px on touch runtimes (and `?platform=mobile` previews) |
| Theme-consistent look | Colors, radius, font all come from `--hud-*` tokens — never pass your own colors |
| No input leaking into gameplay | Pointer events stop at the control; a focused button withholds only Enter/Space (WASD still moves the player); a focused text input owns the whole keyboard and freezes player controls until it blurs |
| Taps work on mobile | The row is tagged `data-hud-interactive`, so the touch layer doesn't swallow the tap |

Set `interactive: true` on the row only in pointer-locked games where the mouse
must be released to click the controls — the same meaning it has on
`createCustomElement`. Buttons are clickable either way.

---

### Custom Element

Use for: Anything not covered by built-in types. Full HTML/CSS control.
**Not for buttons, inputs, or anything else the player interacts with** — use
`createActionRow` above for those.

**Create:**
```typescript
hud.createCustomElement('compass', {
    anchor: 'top-center',    // Screen position (default: 'top-left')
    css: `                   // CSS for the container
        background: rgba(0, 0, 0, 0.6);
        border-radius: 50%;
        width: 80px;
        height: 80px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px solid rgba(255, 255, 255, 0.3);
    `,
    html: `                  // Inner HTML content
        <div id="compass-needle" style="
            width: 4px;
            height: 30px;
            background: linear-gradient(to bottom, #ef4444 50%, #ffffff 50%);
            transform-origin: center center;
            transition: transform 0.1s ease-out;
        "></div>
        <div style="position: absolute; top: 5px; color: white; font-size: 10px;">N</div>
    `,
    onCreate: (container) => {
        // Called after element is created
        // Use for setup, storing references, etc.
        console.log('Compass created!', container);
    },
    onUpdate: (container, value) => {
        // Called when updateCustomElement is called
        // value is whatever you pass to updateCustomElement
        const needle = container.querySelector('#compass-needle') as HTMLElement;
        if (needle && typeof value === 'number') {
            needle.style.transform = `rotate(${value}deg)`;
        }
    }
});
```

**Update:**
```typescript
// Pass any value to the onUpdate callback
hud.updateCustomElement('compass', playerHeading);

// Can pass objects too
hud.updateCustomElement('weapon-wheel', { 
    visible: true, 
    selectedSlot: 2 
});
```

**Tappable custom elements MUST set `interactive: true`:**
```typescript
hud.createCustomElement('game-board', {
    anchor: 'middle-center',
    interactive: true,   // ← REQUIRED whenever the element handles clicks/taps
    html: '...',
    onCreate: (el) => { /* wire click / touchstart handlers here */ },
});
```
Without `interactive: true` the element is **dead to touch on mobile**: the engine's
mobile control layer treats taps on it as joystick/camera input and swallows the
click. Desktop mouse clicks still fire, which makes this easy to miss. Leave it
off (the default) for non-interactive HUD (health bars, counters, labels) so taps
fall through to gameplay.

**Do NOT mount gameplay HUD over the start screen.** Create interactive
boards/overlays when the game actually starts (on the first `engine.startGame()` /
play transition), not in your genre's `load()`. The engine keeps the Play button on
its own layer above the HUD, so it stays clickable — but a full-screen, centred
element mounted during `load()` still sits on screen, cluttering the start screen
and confusing players before they press Play. See `START_SCREEN.md`.

### Styling custom elements (and how recording sees them)

Where a custom element's styling may live, and what each choice costs:

- **The `css:` option is the container's INLINE `style.cssText` — only.** It
  silently drops anything with a selector: `.my-class { ... }` in a `css:`
  string does nothing. Use it for the container's own box (size, position,
  background, transform).
- **Descendant rules go in a head-injected `<style>` element with a unique
  `id`.** Build your rules once, scope them under the container
  (`#hud-custom-<yourId> .my-class { ... }`), give the `<style>` an id and
  guard on `document.getElementById(...)` so re-creating the widget doesn't
  duplicate it. The id matters beyond idempotency: the F9 gameplay recorder
  captures head stylesheets **by id** (engine-owned ids excluded, id-less
  styles ignored), so an id-less sheet means your widget replays unstyled in
  trailers.
- **Inline `style="..."` attributes inside `html`** always work and always
  record — right for one-off values (a needle's `transform`, a fill's
  `width: 43%`), verbose for shared rules.

How the F9 recorder sees a custom element — write with these in mind:

- Markup is recorded as the container's `innerHTML` on every
  `updateCustomElement` call, with a 16 KB cap per entry. Over the cap the two
  paths differ, and both warn once per recording: a **create or F9 snapshot**
  records an empty shell (the styled container still appears, its content does
  not), while an **update** is skipped, so the widget freezes on its last
  under-cap markup rather than blanking mid-shot. **DOM writes that bypass
  `updateCustomElement` are invisible to the recording** — a widget that
  positions itself with direct `element.style.left = ...` every frame will
  replay frozen at its last recorded state.
- The container's `cssText` and your head stylesheets (32 KB per sheet, 128 KB
  across all of them) are recorded and replayed. Sheets are re-collected whenever a custom element is
  created or updated, so a rule you rewrite through
  `styleEl.textContent = ...` is picked up on the next such call — a reskin
  with no accompanying element op can be missed. Removing a sheet, or switching
  it off with `sheet.disabled`, is recorded too, so a swapped skin replays
  without the old rules. Only the `<style>` element's text is captured: rules
  added through the CSSOM (`insertRule`) and `<link rel="stylesheet">` files
  are invisible to the recording.
- CSS **animations and transitions do not play in replay** — overlays are
  discrete screenshots. Each is frozen at the phase it would have been in at
  that moment of the recording, so a spinning needle replays at the right
  angle, while a widget mid-fade lands on the fade's end state.
- Canvas content, `onCreate`/`onUpdate` closures and JS-driven motion cannot
  be recorded; toast `anchor` is.

---

## Common Methods

All element types support these methods:

```typescript
// Show an element (makes visible)
hud.showElement('stamina');

// Hide an element (makes invisible but keeps in DOM)
hud.hideElement('stamina');

// Remove an element completely (removes from DOM and registry)
hud.removeElement('stamina');

// Get element reference for advanced manipulation
const element = hud.getElement('stamina');
if (element) {
    console.log('Element type:', element.type);
    console.log('Container:', element.container);
}
```

---

## Complete Example: Game with Multiple HUD Elements

```typescript
import { GameHUD } from 'engine/GameHUD.js';

export class MyGame {
    private hud: GameHUD;
    private score: number = 0;
    private keysCollected: number = 0;
    private stamina: number = 100;

    initialize(): void {
        // Create HUD with game name
        this.hud = new GameHUD('My Adventure', 'Dark Forest');
        
        // Score counter (top-right)
        this.hud.createCounter('score', {
            anchor: 'top-right',
            label: 'Score',
            icon: '⭐',
            initialValue: 0
        });
        
        // Stamina bar (below built-in health on left)
        this.hud.createProgressBar('stamina', {
            anchor: 'top-left',
            label: 'Stamina',
            color: '#3498db',
            initialValue: 100,
            maxValue: 100
        });
        
        // Key collection status (bottom-left)
        this.hud.createIconText('keys', {
            anchor: 'bottom-left',
            icon: '🔑',
            text: '0 / 3'
        });
        
        // Level countdown timer (top-center)
        this.hud.createTimer('level-timer', {
            anchor: 'top-center',
            label: 'Time Left',
            countDown: true,
            startSeconds: 300,
            format: 'mm:ss',
            onComplete: () => this.onTimeUp()
        });
        
        // Start the timer
        this.hud.startTimer('level-timer');
    }

    // Called when player scores points
    addScore(points: number): void {
        this.score += points;
        this.hud.updateCounter('score', this.score);
    }

    // Called when stamina changes
    updateStamina(current: number): void {
        this.stamina = current;
        this.hud.updateProgressBar('stamina', current, 100);
    }

    // Called when player collects a key
    collectKey(): void {
        this.keysCollected++;
        this.hud.updateIconText('keys', { 
            text: `${this.keysCollected} / 3` 
        });
        
        if (this.keysCollected >= 3) {
            this.hud.updateIconText('keys', { 
                icon: '🗝️',
                text: 'All Keys!' 
            });
        }
    }

    // Called when timer reaches zero
    onTimeUp(): void {
        // End the session via the engine — themed modal, replay button,
        // simulation freeze, and PokiSDK gameplayStop all in one call.
        // NEVER use showToast / hand-rolled overlays for game-over.
        // See `@docs end-game.md` for outcome variants and stats.
        this.engine.endGame({ outcome: 'lose', title: "Time's up!" });
    }

    // Cleanup
    dispose(): void {
        this.hud.dispose();
    }
}
```

---

## Custom Element Examples

### Weapon Wheel (Radial Menu)

```typescript
this.hud.createCustomElement('weapon-wheel', {
    anchor: 'middle-center',
    css: `
        width: 200px;
        height: 200px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.4) 100%);
        border: 3px solid rgba(255, 255, 255, 0.5);
        display: none;
        position: relative;
    `,
    html: `
        <div class="weapon-slot" data-slot="0" style="position: absolute; top: 10px; left: 50%; transform: translateX(-50%); font-size: 24px;">🗡️</div>
        <div class="weapon-slot" data-slot="1" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 24px;">🔫</div>
        <div class="weapon-slot" data-slot="2" style="position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-size: 24px;">💣</div>
        <div class="weapon-slot" data-slot="3" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 24px;">🏹</div>
    `,
    onUpdate: (container, value) => {
        const data = value as { visible: boolean; selectedSlot: number };
        container.style.display = data.visible ? 'block' : 'none';
        
        container.querySelectorAll('.weapon-slot').forEach((slot, i) => {
            const el = slot as HTMLElement;
            el.style.transform = i === data.selectedSlot 
                ? 'scale(1.5)' 
                : el.style.transform.replace('scale(1.5)', '');
            el.style.filter = i === data.selectedSlot 
                ? 'drop-shadow(0 0 10px gold)' 
                : '';
        });
    }
});

// Show weapon wheel with slot 0 selected
this.hud.updateCustomElement('weapon-wheel', { visible: true, selectedSlot: 0 });

// Hide weapon wheel
this.hud.updateCustomElement('weapon-wheel', { visible: false, selectedSlot: 0 });
```

### Mini-Map Placeholder

```typescript
this.hud.createCustomElement('minimap', {
    anchor: 'bottom-right',
    css: `
        width: 150px;
        height: 150px;
        background: rgba(0, 0, 0, 0.7);
        border-radius: 8px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        overflow: hidden;
        position: relative;
    `,
    html: `
        <div id="minimap-content" style="width: 100%; height: 100%; position: relative;">
            <div id="player-marker" style="
                position: absolute;
                top: 50%;
                left: 50%;
                width: 8px;
                height: 8px;
                background: #4ade80;
                border-radius: 50%;
                transform: translate(-50%, -50%);
                box-shadow: 0 0 5px #4ade80;
            "></div>
        </div>
    `,
    onUpdate: (container, value) => {
        const data = value as { rotation: number };
        const content = container.querySelector('#minimap-content') as HTMLElement;
        if (content) {
            content.style.transform = `rotate(${-data.rotation}deg)`;
        }
    }
});

// Update minimap rotation based on player facing
this.hud.updateCustomElement('minimap', { rotation: playerYaw });
```

### Notification Toast

Use the built-in `showToast` primitive — do NOT roll your own toast helper, keyframes, or `<style>` injection.

```typescript
this.hud.showToast('Achievement Unlocked!', { variant: 'success' });
```

Options: `duration` (ms, default 2500), `variant` (`'info' | 'success' | 'warning' | 'error'`, default `'info'`), `anchor` (default `'top-center'`). Multiple concurrent toasts stack vertically.

---

## Type Exports

The following types are exported from `GameHUD.ts` for TypeScript users:

```typescript
import type { 
    HUDAnchor,           // 'top-left' | 'top-center' | ... | 'bottom-right'
    HUDElementType,      // 'progress' | 'counter' | 'icon-text' | 'timer' | 'custom'
    HUDElement,          // Element interface with id, type, container, update, dispose
    ProgressBarOptions,  // Options for createProgressBar
    CounterOptions,      // Options for createCounter
    IconTextOptions,     // Options for createIconText
    TimerOptions,        // Options for createTimer
    CustomElementOptions,     // Options for createCustomElement
    HUDActionRowOptions,      // Options for createActionRow
    HUDActionControlOptions,  // One button / text input inside a row
    HUDActionControlUpdate,   // Mutations accepted by updateActionControl
    HUDActionVariant,         // 'primary' | 'danger' | 'warning' | 'neutral'
    HUDActionControlKind      // 'button' | 'text-input'
} from 'engine/GameHUD.js';
```

---

## Best Practices

1. **Use descriptive IDs** - Element IDs should clearly indicate their purpose (e.g., `'player-health'`, `'enemy-count'`, `'boss-timer'`)

2. **Batch updates** - If updating multiple values, do it in your game loop's update cycle rather than scattered event handlers

3. **Clean up on dispose** - Call `hud.dispose()` when cleaning up your game to remove all elements

4. **Prefer built-in types** - Use `createProgressBar`, `createCounter`, `createActionRow`, etc. when they fit your needs - only use `createCustomElement` for truly custom, *non-interactive* UI

5. **Test anchor positions** - Different screen sizes may affect layout. Test your HUD at various resolutions

6. **Keep custom HTML simple** - For `createCustomElement`, keep HTML minimal and do complex logic in `onUpdate`

---

## Built-in Health Bar

The built-in health bar is a separate element from custom progress bars. It is hidden by default and shown via `showHealth()`.

```typescript
// Show health bar with default width (150px desktop)
this.hud.showHealth();

// Show health bar with custom width (matches custom progress bars)
this.hud.showHealth({ width: 110 });

// Update health value
this.hud.updateHealth(currentHP, maxHP);

// Hide health bar
this.hud.hideHealth();
```

**IMPORTANT — Matching sizes with custom bars:** When `width` is specified, both `showHealth()` and `createProgressBar()` use `box-sizing: border-box`, so the value is the **total visual width** including padding and border. Pass the same `width` to both and they will render at exactly the same size:

```typescript
const BAR_WIDTH = 110;
this.hud.showHealth({ width: BAR_WIDTH });
this.hud.createProgressBar('xp', { anchor: 'top-left', label: 'XP', width: BAR_WIDTH });
```

**DO NOT** use `document.getElementById('health-container')` to manually resize the health bar — use the `width` option instead.

---

## Built-in Controls Methods

```typescript
// Show controls with auto-hide (default behavior)
hud.showControlsTemporarily();

// Show controls permanently (no auto-hide)
hud.showControlsPermanently();

// Hide controls immediately
hud.hideControls();

// Toggle controls (same as H key)
hud.toggleControls();
```

---

## Mobile Support

The HUD system is fully mobile-compatible:

### Automatic Adaptations

| Feature | Desktop | Mobile |
|---------|---------|--------|
| ESC Hint | Shown (bottom-left) | Hidden (no pointer lock) |
| Controls Guide | Shown (auto-hide) | Hidden (on-screen controls instead) |
| Anchor Margins | 20px | 10px (more screen space) |
| bottom-left offset | 70px (room for ESC hint) | 10px (standard) |

### Best Practices for Mobile

1. **Avoid bottom-center** - May overlap with on-screen joystick
2. **Use larger fonts** - 14px+ recommended for readability
3. **Keep elements minimal** - Mobile has less screen real estate
4. **Test both orientations** - Landscape and portrait layouts differ

### Mobile Detection

The HUD uses this detection internally:
```typescript
private isMobile(): boolean {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}
```

### Responsive Scaling

All HUD elements automatically scale based on device type **and screen size**.

**Desktop:** Fixed pixel values for consistent appearance.

**Mobile:** Dynamic viewport-based scaling that adapts to screen width:
- Base scale = `min(vw * 2.5, 10)` where `vw = window.innerWidth / 100`
- Bar width = ~18% of screen width
- Max element width = ~40% of screen (prevents oversized elements)
- Game name truncates with ellipsis if too long

| Property | Desktop | Mobile (dynamic) |
|----------|---------|------------------|
| Font XS | 10px | ~6px (scales) |
| Font SM | 11px | ~7px (scales) |
| Font MD | 12px | ~8px (scales) |
| Font LG | 14px | ~9px (scales) |
| Font XL | 16px | ~10px (scales) |
| Font 2XL | 20px | ~11px (scales) |
| Font 3XL | 24px | ~12px (scales) |
| Font 4XL | 28px | ~13px (scales) |
| Padding SM | 6px | ~3px (scales) |
| Padding MD | 10px | ~4px (scales) |
| Padding LG | 15px | ~5px (scales) |
| Gap | 8px | ~2px (scales) |
| Margin | 20px | ~6px (scales) |
| Bar Width | 150px | ~18vw (viewport %) |
| Bar Height | 20px | ~8px (scales) |
| Icon Size | 20px | ~10px (scales) |
| Border Radius | 8px | ~4px (scales) |
| Border Width | 2px | 1px (fixed) |

*Mobile values adapt dynamically based on actual viewport width*

### Using Scale in Custom Elements

Access scale values for consistent custom elements:

```typescript
const s = hud.getScale();
hud.createCustomElement('custom', {
    anchor: 'top-left',
    css: `
        background: rgba(0, 0, 0, 0.7);
        padding: ${s.paddingMd}px ${s.paddingLg}px;
        font-size: ${s.fontLg}px;
        border-radius: ${s.borderRadius}px;
        border: ${s.borderWidth}px solid rgba(255, 255, 255, 0.3);
    `,
    html: '<div>Custom content</div>'
});
```

---

## ESC Hint (Desktop Only)

The "Press ESC for menu" hint appears in the **bottom-left corner** whenever the pointer is locked on desktop. ESC releases the cursor and opens the pause card in one press, and the card's Resume click takes the cursor back. The "Click to play" prompt appears only when gameplay starts without a click inside the game.

**Note:** This hint is NOT shown on mobile devices since pointer lock doesn't exist there.

**Visibility Logic:**
- **Always visible** when pointer is locked (gameplay active)
- **Hidden** when pointer is unlocked
- Fades in/out with 0.3s transition

**Position:** Bottom-left corner, inset by a viewport-scaled clamp

**Styling:** themed, not hardcoded — `.hud-esc-hint` in `hudBaseStyles.ts` draws its
background from `--hud-color-surface`, its text from `--hud-color-on-surface`, its
corners from `--hud-radius-card` and its type from the `--hud-font-*` tokens. No
border. Size and padding are viewport-scaled `clamp()`s, so it follows the theme
rather than a fixed palette.

The ESC hint is automatically shown/hidden by `setGameplayUIVisible()` which is called when pointer lock state changes.

---

## Trailer Timeline — log gameplay milestones (required)

Wherever the game updates a score/lap/goal/objective counter (or any big moment the engine can't see itself), also call `engine.logGameEvent()` — a free no-op outside F9 recording sessions, but it's what lets the trailer tool find the highlights:

```typescript
engine.logGameEvent({ type: 'score', intensity: 0.9, data: { score: newScore } });
engine.logGameEvent({ type: 'lap', data: { lap: 2, position: 1 } });
```

`type` is free-form (`score`, `lap`, `goal`, `combo`, `objective`, …); optional `intensity` is 0–1 (how exciting this instance is), optional `position` an `{x,y,z}`. Combat, explosions, collisions, deaths, and pickups are logged by the engine automatically — do not log those yourself.


## World-space health bars

`WorldSpaceHealthBar` tracks any Object3D and reads health through callbacks, so it
works for NPCs and for arbitrary destructibles.

```typescript
const healthBar = new WorldSpaceHealthBar(engine, {
    target: npc.getCharacter(),
    getHealth: () => npc.getHealth(),
    getMaxHealth: () => npc.getMaxHealth(),
    offset: new THREE.Vector3(0, 2.5, 0),
});
```

`onHealthChanged` fires with the previous value, which is what lets you react only to
damage:

```typescript
const healthBar = new WorldSpaceHealthBar(engine, {
    target: tower.mesh,
    getHealth: () => tower.health,
    getMaxHealth: () => tower.maxHealth,
    onHealthChanged: (current, max, previous) => {
        if (current < previous) showDamageFlash();
    },
});
```
