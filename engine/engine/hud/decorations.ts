import type { DecorationKey, ThemeColors } from 'engine/hud/ThemeTokens.js';

// Curated decoration library. Each entry ships inline SVG + sensible per-slot defaults.
// SVGs use `__primary__` / `__danger__` / `__surface__` / `__text__` / `__background__`
// token placeholders (case-sensitive) that ThemeManager substitutes from the active
// theme's colors at apply time. That lets one decoration adapt to any theme palette.

export type DecorationSlotKind = 'borderImage' | 'backdrop' | 'decorationBefore' | 'decorationAfter';

export interface DecorationCatalogEntry {
    key: DecorationKey;
    svg: string;
    // Slot kinds this decoration is designed for. Used by the semantic validator
    // to warn when a decoration is placed in a slot it wasn't designed for.
    suitsSlots: ReadonlyArray<DecorationSlotKind>;
    // Defaults for each slot kind (only the ones in suitsSlots are guaranteed sensible).
    borderImage?: { borderSlice: number; repeat: 'stretch' | 'repeat' | 'round' | 'space' };
    background?: {
        /**
         * `cover` / `contain` / `auto`, or an explicit CSS tile size like
         * `'32px 32px'`.
         *
         * A REPEATING decoration must state an explicit size. Every SVG here
         * carries only a `viewBox`, which gives it no intrinsic size, so `auto`
         * does not mean "one tile at the viewBox dimensions" — the browser
         * scales a single copy to fill the element and the pattern renders as
         * one enormous motif. `circuit-trace` shipped that way and drew giant
         * crosshairs across the controls overlay. A unit test enforces this.
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
    };
    evokes: string;
}

// Compact SVGs (each <500 bytes). Color tokens get substituted at apply time.
const DRIP_BORDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" preserveAspectRatio="none"><rect x="0" y="0" width="60" height="2" fill="__primary__"/><rect x="0" y="0" width="2" height="60" fill="__primary__"/><rect x="58" y="0" width="2" height="60" fill="__primary__"/><path d="M0,58 L60,58 L60,50 Q54,60 48,52 Q42,62 36,53 Q30,64 24,54 Q18,60 12,52 Q6,62 0,52 Z" fill="__primary__"/></svg>`;

const PIXEL_CORNERS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" shape-rendering="crispEdges"><path d="M0,0 H4 V2 H2 V4 H0 Z M8,0 H12 V4 H10 V2 H8 Z M0,8 H2 V10 H4 V12 H0 Z M10,8 H12 V12 H8 V10 H10 Z" fill="__primary__"/></svg>`;

const SCANLINE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" preserveAspectRatio="none"><rect width="4" height="1" fill="__primary__" opacity="0.15"/></svg>`;

const VINE_CORNER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M0,40 Q0,20 8,12 Q16,4 24,8 Q20,16 12,16 Q4,20 4,40 Z" fill="__success__" opacity="0.7"/><circle cx="10" cy="14" r="2" fill="__success__"/><circle cx="16" cy="10" r="1.5" fill="__success__"/></svg>`;

const GLOW_AURA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="g"><stop offset="0%" stop-color="__primary__" stop-opacity="0.5"/><stop offset="60%" stop-color="__primary__" stop-opacity="0.1"/><stop offset="100%" stop-color="__primary__" stop-opacity="0"/></radialGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>`;

const BRACKET_FRAME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0,0 H8 V1 H1 V8 H0 Z M16,0 H24 V8 H23 V1 H16 Z M0,16 H1 V23 H8 V24 H0 Z M16,24 V23 H23 V16 H24 V24 Z" fill="__primary__"/></svg>`;

const RIBBON_EDGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 8" preserveAspectRatio="none"><path d="M0,0 L30,0 L30,4 L26,8 L22,4 L18,8 L14,4 L10,8 L6,4 L2,8 L0,4 Z" fill="__primary__"/></svg>`;

const CIRCUIT_TRACE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M0,16 H10 M22,16 H32 M16,0 V10 M16,22 V32" stroke="__primary__" stroke-width="1" fill="none"/><circle cx="16" cy="16" r="2" fill="none" stroke="__primary__" stroke-width="1"/></svg>`;

// A single soft-edged highlight bowing across the top. The flat-opacity ellipse
// this replaced had a hard rim, so at any size above a small chip it stopped
// reading as light and started reading as a grey shape sitting on the element.
const CANDY_GLOSS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" preserveAspectRatio="none"><radialGradient id="cgh" cx=".5" cy=".28" r=".72"><stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset=".55" stop-color="#fff" stop-opacity=".15"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><ellipse cx="50" cy="8" rx="48" ry="13" fill="url(#cgh)"/></svg>`;

const ORNATE_CORNER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><g id="f"><path d="M2 14 Q2 2 14 2" fill="none" stroke="__primary__" stroke-width="2"/><path d="M8 8 L11 5 L14 8 L11 11 Z" fill="__primary__"/></g></defs><rect x="5" y="5" width="38" height="38" fill="none" stroke="__primary__" stroke-width="1.5"/><use href="#f"/><use href="#f" transform="rotate(90 24 24)"/><use href="#f" transform="rotate(180 24 24)"/><use href="#f" transform="rotate(270 24 24)"/></svg>`;

const ROYAL_FRAME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="3" y="3" width="42" height="42" rx="6" fill="none" stroke="__primary__" stroke-width="2"/><rect x="8" y="8" width="32" height="32" rx="3" fill="none" stroke="__primary__" stroke-width="1" opacity="0.6"/><circle cx="6" cy="6" r="2.4" fill="__primary__"/><circle cx="42" cy="6" r="2.4" fill="__primary__"/><circle cx="6" cy="42" r="2.4" fill="__primary__"/><circle cx="42" cy="42" r="2.4" fill="__primary__"/></svg>`;

const HAZARD_STRIPES_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M-4 4 L4 -4 M0 16 L16 0 M12 20 L20 12" stroke="__warning__" stroke-width="4" opacity="0.12" fill="none"/></svg>`;

const PIXEL_FRAME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><path fill-rule="evenodd" d="M0 0 H16 V16 H0 Z M1 1 V15 H15 V1 Z" fill="__text__"/><path fill-rule="evenodd" d="M3 3 H13 V13 H3 Z M4 4 V12 H12 V4 Z" fill="__primary__"/></svg>`;

const GRAIN_TEXTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><g fill="__text__" opacity="0.07"><rect x="3" y="5" width="1" height="1"/><rect x="11" y="2" width="1" height="1"/><rect x="19" y="9" width="1" height="1"/><rect x="27" y="4" width="1" height="1"/><rect x="35" y="12" width="1" height="1"/><rect x="6" y="17" width="1" height="1"/><rect x="15" y="22" width="1" height="1"/><rect x="24" y="18" width="1" height="1"/><rect x="33" y="26" width="1" height="1"/><rect x="2" y="29" width="1" height="1"/><rect x="12" y="34" width="1" height="1"/><rect x="22" y="31" width="1" height="1"/><rect x="30" y="37" width="1" height="1"/><rect x="38" y="33" width="1" height="1"/></g></svg>`;

export const HUD_DECORATIONS: Readonly<Record<DecorationKey, DecorationCatalogEntry>> = {
    'drip-border': {
        key: 'drip-border',
        svg: DRIP_BORDER_SVG,
        suitsSlots: ['borderImage', 'decorationAfter'],
        borderImage: { borderSlice: 20, repeat: 'repeat' },
        // Explicit tile width for the same reason as `circuit-trace` below, with
        // one extra twist: this SVG also carries `preserveAspectRatio="none"`,
        // so it has no intrinsic RATIO either. Under `background-size: auto`
        // that resolves to 100% 100% — a single drip motif stretched across the
        // whole strip, which is the opposite of drips repeating along an edge.
        // `100%` for the height is deliberate: the strip is 12px and the drips
        // should fill it.
        background: { size: '60px 100%', position: 'bottom', repeat: 'repeat-x' },
        evokes: 'Horror drips on edges',
    },
    'pixel-corners': {
        key: 'pixel-corners',
        svg: PIXEL_CORNERS_SVG,
        suitsSlots: ['borderImage'],
        borderImage: { borderSlice: 4, repeat: 'stretch' },
        evokes: '8-bit pixel corner brackets',
    },
    scanline: {
        key: 'scanline',
        svg: SCANLINE_SVG,
        suitsSlots: ['backdrop'],
        // Explicit tile size: a viewBox-only SVG has no intrinsic size, so
        // `auto` scales ONE copy to the element instead of tiling. See the
        // note on `circuit-trace`.
        background: { size: '4px 4px', position: 'center', repeat: 'repeat' },
        evokes: 'CRT scanlines tiled across the surface',
    },
    'vine-corner': {
        key: 'vine-corner',
        svg: VINE_CORNER_SVG,
        suitsSlots: ['borderImage', 'decorationBefore'],
        borderImage: { borderSlice: 20, repeat: 'stretch' },
        background: { size: 'auto', position: 'bottom-left', repeat: 'no-repeat' },
        evokes: 'Tropical vines / leaves in corners',
    },
    'glow-aura': {
        key: 'glow-aura',
        svg: GLOW_AURA_SVG,
        suitsSlots: ['backdrop', 'decorationBefore', 'decorationAfter'],
        background: { size: 'cover', position: 'center', repeat: 'no-repeat' },
        evokes: 'Soft radial glow halo behind the element',
    },
    'bracket-frame': {
        key: 'bracket-frame',
        svg: BRACKET_FRAME_SVG,
        suitsSlots: ['borderImage'],
        borderImage: { borderSlice: 8, repeat: 'stretch' },
        evokes: 'Sci-fi targeting brackets on each corner',
    },
    'ribbon-edge': {
        key: 'ribbon-edge',
        svg: RIBBON_EDGE_SVG,
        suitsSlots: ['decorationAfter', 'decorationBefore'],
        background: { size: '30px 100%', position: 'bottom', repeat: 'repeat-x' },
        evokes: 'Bunting / banner saw-tooth edge',
    },
    'circuit-trace': {
        key: 'circuit-trace',
        svg: CIRCUIT_TRACE_SVG,
        suitsSlots: ['backdrop'],
        // The tile size is EXPLICIT, and has to be. An inline SVG carrying only
        // a `viewBox` has no intrinsic size, so `background-size: auto` does not
        // mean "32x32" — it scales ONE copy to fill the element. This pattern
        // shipped that way and drew a handful of giant crosshairs across the
        // controls overlay instead of a fine circuit texture.
        //
        // Any tiling decoration added here needs the same treatment: state the
        // tile size, or give the SVG width/height attributes.
        background: { size: '32px 32px', position: 'center', repeat: 'repeat' },
        evokes: 'PCB / circuit board trace pattern',
    },
    'candy-gloss': {
        key: 'candy-gloss',
        svg: CANDY_GLOSS_SVG,
        suitsSlots: ['backdrop', 'decorationBefore'],
        // A FIXED-HEIGHT band, not `cover` and not `100% 100%`.
        //
        // `cover` was the shipped value and was simply wrong: this SVG carries
        // preserveAspectRatio="none", i.e. it is built to be stretched, while
        // `cover` honours the viewBox's 100:40 intrinsic ratio. On a tall element
        // (a CONTROLS panel is ~220px high and ~180 wide) that scaled the image to
        // 550x220 and centred it, so what you saw was the middle of a hugely
        // magnified ellipse — a grey blob across the top third of the panel.
        //
        // `100% 100%` fixes the blob and is still wrong, because it makes the
        // highlight a PROPORTION of the element. On that same panel the gloss then
        // covers the top ~100px and the first rows of key text sit inside it:
        // measured 2.22:1 and 2.92:1 against the muted label colour. A highlight
        // is cast by a light source, so its size is set by the light and not by
        // the object — a fixed band is both the physical answer and the one that
        // cannot swallow a tall element. 56px reads as a full candy gloss on a
        // 36-46px chip and as a sheen along the top edge of a panel.
        background: { size: '100% 56px', position: 'top', repeat: 'no-repeat' },
        evokes: 'Glossy sugar highlight across the top — candy button shine',
    },
    'ornate-corner': {
        key: 'ornate-corner',
        svg: ORNATE_CORNER_SVG,
        suitsSlots: ['borderImage'],
        borderImage: { borderSlice: 14, repeat: 'stretch' },
        evokes: 'Gothic filigree corner frame — dark fantasy, dungeon',
    },
    'royal-frame': {
        key: 'royal-frame',
        svg: ROYAL_FRAME_SVG,
        suitsSlots: ['borderImage'],
        borderImage: { borderSlice: 12, repeat: 'stretch' },
        evokes: 'Double gold-trim picture frame with corner studs — epic fantasy',
    },
    'hazard-stripes': {
        key: 'hazard-stripes',
        svg: HAZARD_STRIPES_SVG,
        suitsSlots: ['backdrop'],
        // Explicit tile size: a viewBox-only SVG has no intrinsic size, so
        // `auto` scales ONE copy to the element instead of tiling. See the
        // note on `circuit-trace`.
        background: { size: '16px 16px', position: 'center', repeat: 'repeat' },
        evokes: 'Faint diagonal caution stripes — military / sci-fi warning panel',
    },
    'pixel-frame': {
        key: 'pixel-frame',
        svg: PIXEL_FRAME_SVG,
        suitsSlots: ['borderImage'],
        borderImage: { borderSlice: 5, repeat: 'round' },
        evokes: 'NES dialog double-ring pixel border',
    },
    'grain-texture': {
        key: 'grain-texture',
        svg: GRAIN_TEXTURE_SVG,
        suitsSlots: ['backdrop'],
        // Explicit tile size: a viewBox-only SVG has no intrinsic size, so
        // `auto` scales ONE copy to the element instead of tiling. See the
        // note on `circuit-trace`.
        background: { size: '40px 40px', position: 'center', repeat: 'repeat' },
        evokes: 'Subtle parchment / leather grain tooth',
    },
};

// Substitutes `__primary__` / `__danger__` etc. with hex codes from the active theme.
// Unknown tokens are left as-is so non-token usages of double-underscored strings
// (none in our SVGs today, but defensive) don't get mangled.
export function substituteThemeColors(svg: string, colors: ThemeColors): string {
    return svg.replace(/__([a-zA-Z][a-zA-Z0-9]*)__/g, (match, name) => {
        const key = name as keyof ThemeColors;
        // `?? match` also covers optional colors (outline): a token for a color the
        // theme doesn't define stays as-is instead of substituting "undefined".
        const value = Object.prototype.hasOwnProperty.call(colors, key) ? colors[key] : undefined;
        return value ?? match;
    });
}

// Wraps SVG markup as a CSS url(...) data URI. The encoder uses encodeURIComponent
// (not base64) because SVG-as-data-URI is smaller that way and renders identically.
export function svgToDataUri(svg: string): string {
    const cleaned = svg.replace(/[\r\n]+/g, '').replace(/\s{2,}/g, ' ');
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(cleaned)}")`;
}
