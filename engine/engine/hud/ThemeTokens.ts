// HUD theme tokens. Mirrors theme.schema.json — when changing one, change the other.
// Authoring rules: engine/CLAUDE.md says option fields are required + use DEFAULT_* constants.
// Theme JSON has its own validation surface (the schema), so partial-theme inputs are
// validated separately via validateTheme.ts before being widened into a full theme.

export type FontKey =
    | 'red-hat-display'
    | 'bebas-neue'
    | 'press-start-2p'
    | 'creepster'
    | 'pacifico'
    | 'space-grotesk'
    | 'rubik-mono-one'
    | 'vt323'
    | 'orbitron'
    | 'shrikhand'
    | 'lilita-one'
    | 'baloo-2'
    | 'fredoka'
    | 'grenze-gotisch'
    | 'cinzel'
    | 'chakra-petch'
    | 'ibm-plex-sans'
    | 'archivo-narrow';

export type DecorationKey =
    | 'drip-border'
    | 'pixel-corners'
    | 'scanline'
    | 'vine-corner'
    | 'glow-aura'
    | 'bracket-frame'
    | 'ribbon-edge'
    | 'circuit-trace'
    | 'candy-gloss'
    | 'ornate-corner'
    | 'royal-frame'
    | 'hazard-stripes'
    | 'pixel-frame'
    | 'grain-texture';

export type GlowKey = 'aqua' | 'pink' | 'warm' | 'horror-red' | 'gold' | 'cyan' | 'none';

export type LabelCase = 'upper' | 'normal';

export type ImageRendering = 'auto' | 'pixelated';

export interface ThemeFont {
    key: FontKey;
    case: LabelCase;
    weightBody: 300 | 400 | 500 | 700;
    weightHeading: 400 | 500 | 700 | 900;
    trackingLabel: number;
    // Text outline width in px (0–3) for display-scale text (play button, counters,
    // timers, toasts). Rendered via -webkit-text-stroke in colors.outline. Keep ≤2 —
    // paint-order support on HTML text varies and thick strokes eat glyph interiors.
    outlineWidth: number;
    // Relative TEXT size multiplier (0.85–1.3) applied to every themed font-size.
    // OPTIONAL even in the resolved theme (same deliberate deviation as
    // `colors.outline`): absence means "this theme does not rescale text", so
    // ThemeManager removes the variable and every element keeps its authored
    // size. Exists because equal px is not equal legibility — a condensed face
    // with no weight axis (bebas-neue) lays down ~70% of the ink of a normal
    // one at the same size, and size is then the only lever a preset has.
    sizeScale?: number;
}

export interface ThemeColors {
    primary: string;
    danger: string;
    warning: string;
    success: string;
    background: string;
    surface: string;
    text: string;
    textMuted: string;
    // Outline/border color for chunky cartoon frames and text strokes. OPTIONAL even
    // in the resolved theme (deliberate deviation from the required+default rule):
    // absence means "this theme has no outline concept" and ThemeManager removes the
    // CSS variable so base styles fall back to their per-element defaults.
    outline?: string;
}

export interface ThemeShape {
    radiusPill: number;
    radiusCard: number;
    glow: GlowKey;
    imageRendering: ImageRendering;
    // Border width in px (0–6) drawn in colors.outline around buttons, bars, counters,
    // timers, toasts. 0 = keep each element's default border. Unlike border-image
    // decorations, this border follows the theme's border-radius.
    borderWidth: number;
    // 3D bevel strength 0–1: a white-top/dark-bottom gradient overlaid on buttons and
    // fills (cartoon/candy gloss). 0 = flat (no overlay).
    bevel: number;
    // Specular sheen strength 0–1: a soft white highlight band across the upper face
    // of buttons, chips and fills — the "glossy / shiny / candy" ask, separate from
    // `bevel` (which lights the EDGES). Both are pure white-alpha overlays drawn
    // over each element's own fill, so neither consumes a colour token. 0 = matte.
    gloss: number;
    // Glow in an exact hue — "purple neon", a brand colour — where the curated
    // `glow` keys don't reach. 6-digit hex; the engine applies the same alpha the
    // curated glows use. When present it wins over `glow`; absent = keyed glow.
    // OPTIONAL in the resolved theme, like colors.outline: absence is meaningful.
    glowColor?: string;
}

export interface BorderImageInline {
    svg: string;
    borderSlice: number;
    repeat: 'stretch' | 'repeat' | 'round' | 'space';
}

export interface BackgroundInline {
    svg: string;
    /**
     * `cover` / `contain` / `auto`, or an explicit tile size like `'32px 32px'`.
     *
     * A REPEATING background needs the explicit form: these SVGs carry only a
     * `viewBox` and so have no intrinsic size, which makes `auto` scale one copy
     * over the whole element rather than tile it. The validator constrains the
     * string form to two plain lengths, because it is interpolated directly into
     * a `background-size:` declaration.
     */
    size: 'cover' | 'contain' | 'auto' | (string & {});
    position:
        | 'top'
        | 'top-right'
        | 'right'
        | 'bottom-right'
        | 'bottom'
        | 'bottom-left'
        | 'left'
        | 'top-left'
        | 'center';
    repeat: 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y';
}

export type BorderImageValue = DecorationKey | BorderImageInline;
export type BackgroundValue = DecorationKey | BackgroundInline;

export interface DecorationSlots {
    borderImage: BorderImageValue | null;
    backdrop: BackgroundValue | null;
    decorationBefore: BackgroundValue | null;
    decorationAfter: BackgroundValue | null;
}

export type HudElementClass =
    | 'progressBar'
    | 'healthBar'
    | 'counter'
    | 'iconText'
    | 'timer'
    | 'toast'
    | 'controls'
    | 'reticle'
    // The touch layer: joystick + on-screen action buttons. Every game must be
    // mobile-playable, and this is the surface that used to be unreachable by
    // theming. The base CSS already derives the stick from --hud-color-text and
    // the buttons from --hud-color-primary/danger/warning, so a per-element
    // colors override restyles the whole layer with no dedicated tokens.
    | 'mobileControls';

export type Decorations = Partial<Record<HudElementClass, Partial<DecorationSlots>>>;

// Theme-authorable icon SVGs. Replaces the engine's built-in heart / mouse /
// arrow defaults. Each value is an inline SVG string (≤16kb). SVGs can use
// `currentColor` for fill/stroke OR `__primary__` / `__danger__` / etc.
// color tokens that the engine substitutes at apply time.
export interface ThemeIcons {
    heart?: string;
    mouse?: string;
    arrow?: string;
}

export interface PartialTheme {
    font: Partial<ThemeFont> | null;
    colors: Partial<ThemeColors> | null;
    shape: Partial<ThemeShape> | null;
    decorations: Partial<DecorationSlots> | null;
}

export interface ThemeTokens {
    name: string;
    font: ThemeFont;
    colors: ThemeColors;
    shape: ThemeShape;
    decorations: Decorations;
    elements: Partial<Record<HudElementClass, PartialTheme>>;
    icons: ThemeIcons;
}

// The JSON files in themes/ may omit optional sub-keys (decorations, elements,
// font.case, etc.). resolveTheme() widens an input blob into a complete ThemeTokens
// by filling in defaults from DEFAULT_THEME_TOKENS.
export type ThemeInput = Omit<Partial<ThemeTokens>, 'font' | 'colors' | 'shape'> & {
    name: string;
    font: ThemeTokens['font'] | (Partial<ThemeFont> & { key: FontKey });
    colors: ThemeTokens['colors'];
    shape: ThemeTokens['shape'] | Partial<ThemeShape>;
};

export const DEFAULT_THEME_FONT: ThemeFont = {
    key: 'red-hat-display',
    case: 'upper',
    weightBody: 400,
    weightHeading: 700,
    trackingLabel: 1.4,
    outlineWidth: 0,
};

export const DEFAULT_THEME_SHAPE: ThemeShape = {
    radiusPill: 500,
    radiusCard: 8,
    glow: 'aqua',
    imageRendering: 'auto',
    borderWidth: 0,
    bevel: 0,
    gloss: 0,
};
