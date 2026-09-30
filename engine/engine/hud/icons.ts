// Theme-aware HUD icon registry.
//
// Why a registry (rather than exported const SVG strings):
//   Themes can override individual icons (e.g. a horror "dripping heart"
//   instead of the default heart) without forking the engine. Callers always
//   read the CURRENT icon for a slot; the registry returns the theme's
//   override when present and the default otherwise.
//
// Lifecycle:
//   - Defaults are baked in at module load.
//   - applyThemeGlobals(theme) (in ThemeManager) calls setIconsFromTheme(theme)
//     which replaces slots with substituted theme SVGs.
//   - Callers use createNamedIcon('heart') / arrowIconHtml('up') etc.
//
// Limitation: DOM nodes already rendered with one icon won't re-render when
// the theme changes mid-session. Theme swap via agent triggers a full iframe
// reload, so this is fine in practice — but live setTheme() calls don't
// repaint existing icon nodes. Documented for future readers.

import { substituteThemeColors } from 'engine/hud/decorations.js';
import type { ThemeColors, ThemeIcons } from 'engine/hud/ThemeTokens.js';

export type IconName = 'heart' | 'mouse' | 'arrow';

// Defaults: compact inline SVGs using currentColor so the icon picks up its
// container's text color. Use the `__primary__` / `__danger__` / etc. tokens
// in theme-provided icons if you want explicit theme-color fills instead.
const DEFAULT_ICON_HEART =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 21s-7.5-4.6-9.8-9.5C.6 7.5 3 3.5 7 3.5c2.1 0 3.7 1 5 2.7 1.3-1.7 2.9-2.7 5-2.7 4 0 6.4 4 4.8 8C19.5 16.4 12 21 12 21z"/>' +
    '</svg>';

const DEFAULT_ICON_MOUSE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"' +
    ' d="M12 2.5c-3.6 0-6.5 2.9-6.5 6.5v6c0 3.6 2.9 6.5 6.5 6.5s6.5-2.9 6.5-6.5V9c0-3.6-2.9-6.5-6.5-6.5z"/>' +
    '<path fill="currentColor" d="M12 6.5a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M12 2.5v6"/>' +
    '</svg>';

const DEFAULT_ICON_ARROW_UP =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"' +
    ' d="M12 5v14M5 12l7-7 7 7"/>' +
    '</svg>';

export const DEFAULT_ICONS: Readonly<Record<IconName, string>> = {
    heart: DEFAULT_ICON_HEART,
    mouse: DEFAULT_ICON_MOUSE,
    arrow: DEFAULT_ICON_ARROW_UP,
};

// Mutable registry. Theme apply replaces entries; getIcon falls back to
// DEFAULT_ICONS when an entry is missing or explicitly cleared (null).
const registry: Record<IconName, string> = { ...DEFAULT_ICONS };

export function getIcon(name: IconName): string {
    return registry[name] ?? DEFAULT_ICONS[name];
}

// Re-export the legacy constant names so callers that imported them keep
// compiling. New code should use createNamedIcon('heart') etc. so theme
// overrides flow through automatically.
export const ICON_HEART = DEFAULT_ICON_HEART;
export const ICON_MOUSE = DEFAULT_ICON_MOUSE;
export const ICON_ARROW_UP = DEFAULT_ICON_ARROW_UP;

const ICON_NAMES: ReadonlyArray<IconName> = ['heart', 'mouse', 'arrow'];

// Apply theme overrides to the icon registry. Each slot's SVG goes through
// substituteThemeColors so `__primary__` / `__danger__` / etc. tokens resolve
// against the active palette. Slots not present in the theme reset to default.
export function setIconsFromTheme(icons: ThemeIcons | undefined, colors: ThemeColors): void {
    for (const slot of ICON_NAMES) {
        const override = icons?.[slot];
        registry[slot] = override
            ? substituteThemeColors(override, colors)
            : DEFAULT_ICONS[slot];
    }
}

// Test-only: restore defaults so tests don't bleed state.
export function _resetIconsForTests(): void {
    for (const slot of ICON_NAMES) {
        registry[slot] = DEFAULT_ICONS[slot];
    }
}

export type ArrowDirection = 'up' | 'down' | 'left' | 'right';

// Returns innerHTML-safe markup wrapping the named icon. Use when building
// HTML strings (e.g. the controls-overlay key caps).
export function iconHtml(svg: string, extraClass = ''): string {
    const cls = extraClass ? `hud-icon ${extraClass}` : 'hud-icon';
    return `<span class="${cls}">${svg}</span>`;
}

export function namedIconHtml(name: IconName, extraClass = ''): string {
    return iconHtml(getIcon(name), extraClass);
}

export function arrowIconHtml(direction: ArrowDirection): string {
    return iconHtml(getIcon('arrow'), `hud-icon-arrow hud-icon-arrow--${direction}`);
}

// Element-based variant. Used by callers that build DOM via createElement.
export function createIcon(svg: string, extraClass = ''): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = extraClass ? `hud-icon ${extraClass}` : 'hud-icon';
    span.innerHTML = svg;
    return span;
}

export function createNamedIcon(name: IconName, extraClass = ''): HTMLSpanElement {
    return createIcon(getIcon(name), extraClass);
}
