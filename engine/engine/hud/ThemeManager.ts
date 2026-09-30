import type {
    ThemeTokens,
    ThemeColors,
    HudElementClass,
    PartialTheme,
    BorderImageValue,
    BackgroundValue,
    BorderImageInline,
    BackgroundInline,
    DecorationSlots,
    GlowKey,
} from 'engine/hud/ThemeTokens.js';
import {
    ACCENT_INK_MIN_CONTRAST,
    ON_SURFACE_MIN_CONTRAST,
    accentInkOn,
    contrastRatio,
    inkOnSurface,
    mixHex,
    mutedInkOnSurface,
    readableTextColor,
    relLuminance,
} from 'engine/hud/colorMath.js';
import { HUD_FONTS, buildGoogleFontsUrl, getFontCssStack } from 'engine/hud/fonts.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';
import { HUD_DECORATIONS, substituteThemeColors, svgToDataUri } from 'engine/hud/decorations.js';
import { setIconsFromTheme } from 'engine/hud/icons.js';

// Applies a ThemeTokens to a HUD root element. Responsibilities:
//   - Set CSS custom properties on the root so hud-base.css picks them up.
//   - Manage a single Google Fonts <link> in <head> (one font in flight at a time).
//   - Generate decoration CSS (with theme-color substitution into SVG tokens) and
//     attach it to the root as a scoped <style> block.
//   - Apply per-element overrides as inline custom properties on individual HUD nodes.
//
// One ThemeManager per HUD root. Multiple roots may coexist (e.g. main HUD + a
// nested mini-HUD with its own theme) — each root scopes its own custom properties.
//
// HUD elements' CSS class names follow `hud-<kebab-class>`; the manager translates
// camelCase HudElementClass values to that form. Pseudo-element decorations require
// hud-base.css to have set `content: ""; position: absolute;` on the corresponding
// ::before/::after — this manager only fills the background-image and sizing.

const FONT_LINK_ID = 'hud-active-font';

export interface ThemeManagerOptions {
    // The DOM node that hosts the HUD. CSS custom properties and the scoped
    // decoration stylesheet are attached here. Required so multiple HUDs can
    // coexist with different themes; pass document.documentElement for a global HUD.
    root: HTMLElement;
    // Whether to manage the Google Fonts <link> in <head>. Set false in published
    // games where the bundler has already baked the active theme's font link into
    // index.html — having two managers fight over the link tag is the failure mode.
    manageFontLink: boolean;
}

export const DEFAULT_THEME_MANAGER_OPTIONS: Omit<ThemeManagerOptions, 'root'> = {
    manageFontLink: true,
};

const HUD_ELEMENT_CLASS_TO_CSS: Readonly<Record<HudElementClass, string>> = {
    progressBar: 'hud-progress-bar',
    healthBar: 'hud-health-bar',
    counter: 'hud-counter',
    iconText: 'hud-icon-text',
    timer: 'hud-timer',
    toast: 'hud-toast',
    controls: 'hud-controls',
    reticle: 'hud-reticle',
    mobileControls: 'hud-mobile-controls',
};

const GLOW_TO_RGBA: Readonly<Record<GlowKey, string>> = {
    aqua: 'rgba(160, 218, 185, 0.45)',
    pink: 'rgba(224, 33, 138, 0.40)',
    warm: 'rgba(255, 130, 0, 0.45)',
    'horror-red': 'rgba(199, 16, 16, 0.50)',
    gold: 'rgba(255, 196, 66, 0.45)',
    cyan: 'rgba(0, 216, 255, 0.45)',
    none: 'transparent',
};

// Bevel gradient stop opacities at bevel strength 1.0 (scaled linearly by the
// theme's shape.bevel). Kept as constants so hudBaseStyles' gradient rule and
// this math stay the only two places the bevel look is defined.
const BEVEL_TOP_ALPHA = 0.38;
const BEVEL_BOTTOM_ALPHA = 0.3;

// Gloss gradient stop opacities at gloss strength 1.0 (scaled linearly by
// shape.gloss) — the bright crest of the sheen band and its lower skirt. Same
// contract as the bevel constants: hudBaseStyles' gradient rule and this math
// are the only two places the gloss look is defined.
const GLOSS_TOP_ALPHA = 0.42;
const GLOSS_FADE_ALPHA = 0.14;

function bevelAlpha(base: number, strength: number): string {
    return String(Math.round(base * strength * 1000) / 1000);
}

// shape.glowColor supplies the hue; the ALPHA comes from the glow key the theme
// pairs it with, so pinning a curated hue as an exact colour never changes the
// glow's intensity — pink carries 0.40 and horror-red 0.50, and a flat constant
// here visibly brightened one and dimmed the other. 0.45 (the weight most keys
// carry) is only the fallback for glow "none"/absent, where no key supplies one.
const GLOW_COLOR_FALLBACK_ALPHA = 0.45;

function glowAlphaOf(key: GlowKey | undefined): number {
    if (key === undefined || key === 'none') return GLOW_COLOR_FALLBACK_ALPHA;
    const match = /([\d.]+)\)$/.exec(GLOW_TO_RGBA[key]);
    return match ? Number(match[1]) : GLOW_COLOR_FALLBACK_ALPHA;
}

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function isInlineBorderImage(v: BorderImageValue): v is BorderImageInline {
    return typeof v !== 'string';
}

function isInlineBackground(v: BackgroundValue): v is BackgroundInline {
    return typeof v !== 'string';
}

// Give a viewBox-only SVG the intrinsic size its own viewBox implies.
//
// A numeric `border-image-slice` is resolved against the RENDERED image, and an
// SVG that declares only a viewBox has no intrinsic size — so the browser renders
// it at the border-image area, which is the ELEMENT's size, and the slice ends up
// cutting a fraction of the element rather than of the artwork. Measured in
// Chromium with a 12-unit viewBox and `slice: 4`: the corner piece paints 72px on
// a 240px-wide element and 177px on a 600px one, where the author wrote 4. Every
// borderSlice in the catalog is authored in viewBox units, so every border-image
// decoration drew the wrong region of its own art — and drew a DIFFERENT wrong
// region at each element size. Stamping width/height makes the same slice paint
// exactly 4px at both widths.
//
// This lives here rather than in the catalog because `drip-border` and
// `vine-corner` also serve background slots, and an intrinsic size changes what
// `background-size: auto` means. The border-image path is the only one that wants
// it.
const ROOT_SVG_TAG = /^\s*<svg\b([^>]*)>/;

function withIntrinsicSize(svg: string): string {
    const attrs = ROOT_SVG_TAG.exec(svg)?.[1];
    if (attrs === undefined) return svg;
    // An entry that states its own dimensions has already made this decision.
    if (/\swidth\s*=/.test(attrs) || /\sheight\s*=/.test(attrs)) return svg;
    const viewBox = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/.exec(attrs);
    const width = viewBox?.[1];
    const height = viewBox?.[2];
    if (width === undefined || height === undefined) return svg;
    return svg.replace(ROOT_SVG_TAG, `<svg${attrs} width="${width}" height="${height}">`);
}

function resolveBorderImageSvg(value: BorderImageValue, colors: ThemeColors): { svg: string; slice: number; repeat: string } {
    if (isInlineBorderImage(value)) {
        return {
            svg: withIntrinsicSize(substituteThemeColors(value.svg, colors)),
            slice: value.borderSlice,
            repeat: value.repeat,
        };
    }
    const entry = HUD_DECORATIONS[value];
    return {
        svg: withIntrinsicSize(substituteThemeColors(entry.svg, colors)),
        slice: entry.borderImage?.borderSlice ?? 30,
        repeat: entry.borderImage?.repeat ?? 'stretch',
    };
}

// `background-position` has NO hyphenated corner keywords. `bottom-left` is not
// valid CSS: the whole declaration is dropped and the property falls back to its
// initial `0% 0%` — the OPPOSITE corner from the one asked for. Chromium computes
// `bottom-left` as `0% 0%` and `bottom left` as `0% 100%`.
//
// Four of the nine anchors the schema, the `DecorationPosition` union and the
// validator all advertise are spelled that way, so a theme author could pick any
// of them, pass validation, and get a decoration silently pinned to the top-left.
// `vine-corner` does exactly that today and grows its vines DOWN from the top.
//
// The hyphenated spellings stay in the vocabulary — they are in the published
// schema and in already-shipped world.json files, which the engine must keep
// accepting — and are translated to real CSS at the point of emission instead.
const POSITION_TO_CSS: Readonly<Record<string, string>> = {
    'top-left': 'left top',
    'top-right': 'right top',
    'bottom-left': 'left bottom',
    'bottom-right': 'right bottom',
};

function positionToCss(position: string): string {
    return POSITION_TO_CSS[position] ?? position;
}

function resolveBackgroundSvg(value: BackgroundValue, colors: ThemeColors): { svg: string; size: string; position: string; repeat: string } {
    if (isInlineBackground(value)) {
        return {
            svg: substituteThemeColors(value.svg, colors),
            size: value.size,
            position: value.position,
            repeat: value.repeat,
        };
    }
    const entry = HUD_DECORATIONS[value];
    return {
        svg: substituteThemeColors(entry.svg, colors),
        size: entry.background?.size ?? 'auto',
        position: entry.background?.position ?? 'center',
        repeat: entry.background?.repeat ?? 'no-repeat',
    };
}

function buildSlotCss(
    elementClass: HudElementClass,
    slots: Partial<DecorationSlots>,
    colors: ThemeColors,
): string {
    const selector = `.${HUD_ELEMENT_CLASS_TO_CSS[elementClass]}`;
    const lines: string[] = [];
    if (slots.borderImage) {
        const r = resolveBorderImageSvg(slots.borderImage, colors);
        lines.push(
            `${selector} {`,
            `  border-style: solid;`,
            `  border-width: ${r.slice}px;`,
            `  border-image: ${svgToDataUri(r.svg)} ${r.slice} ${r.repeat};`,
            `}`,
        );
    }
    if (slots.backdrop) {
        const r = resolveBackgroundSvg(slots.backdrop, colors);
        lines.push(
            `${selector} {`,
            `  background-image: ${svgToDataUri(r.svg)};`,
            `  background-size: ${r.size};`,
            `  background-position: ${positionToCss(r.position)};`,
            `  background-repeat: ${r.repeat};`,
            `}`,
        );
    }
    for (const [slotKey, pseudo] of [
        ['decorationBefore', '::before'],
        ['decorationAfter', '::after'],
    ] as const) {
        const value = slots[slotKey];
        if (!value) continue;
        const r = resolveBackgroundSvg(value, colors);
        lines.push(
            // The strip is absolutely positioned against its element, so the
            // element has to BE a containing block — and every class the
            // decoration system can target computes to `position: static` in
            // hudBaseStyles. Without this the strip resolves against `.hud-root`
            // instead, which is `position: fixed` and viewport-sized: `top: 100%`
            // then puts a decorationAfter just below the bottom of the screen and
            // `bottom: 100%` puts a decorationBefore just above the top of it.
            // Neither slot has ever appeared in a real HUD for that reason,
            // independently of the `inset` shorthand that also broke `::before`.
            //
            // Emitted here, beside the pseudo-element that needs it, rather than
            // in the base sheet — an element only becomes a containing block when
            // a theme actually hangs something off it.
            `${selector} { position: relative; }`,
            `${selector}${pseudo} {`,
            `  content: "";`,
            `  position: absolute;`,
            // `auto 0 100% 0`, not `auto auto 100% 0`. `inset` is top/right/bottom/left,
            // so leaving RIGHT at auto let the absolutely-positioned pseudo-element
            // shrink-to-fit its own content — and its content is `""`. Every
            // `decorationBefore` in the catalog resolved to a 0px-wide box and had
            // never drawn a pixel; `decorationAfter` pins both sides and always had.
            `  inset: ${slotKey === 'decorationBefore' ? 'auto 0 100% 0' : '100% 0 auto 0'};`,
            `  height: 12px;`,
            `  background-image: ${svgToDataUri(r.svg)};`,
            `  background-size: ${r.size};`,
            `  background-position: ${positionToCss(r.position)};`,
            `  background-repeat: ${r.repeat};`,
            `  pointer-events: none;`,
            `}`,
        );
    }
    return lines.join('\n');
}

// Compute readable text color for a given background hex. WCAG-style relative
// luminance: dark bg → white text, light bg → black text. Used to auto-pick
// --hud-color-on-primary / --hud-color-on-danger so the agent doesn't have to
// hand-author contrast pairs per theme.
// Set a custom property when the theme gives it a meaningful value, REMOVE it
// otherwise. The new-in-5.x tokens (outline, border width, bevel, text outline)
// must not always-write: base styles carry per-element fallbacks equal to the
// pre-token look (e.g. the play button's 1px primary border), and writing a
// zero/black value would stomp those fallbacks on every existing theme. Removal
// also keeps creator-mode theme switching clean — applying a theme without a
// token clears the previous theme's value.
function setOrRemoveProperty(target: HTMLElement, name: string, value: string | null): void {
    if (value === null) {
        target.style.removeProperty(name);
    } else {
        target.style.setProperty(name, value);
    }
}

// Custom properties go on document.documentElement (`:root`) so they cascade to
// ALL HUD elements — including ones that sit OUTSIDE `.hud-root` like the
// gameplay-layer (ESC hint, reticle, comic bubbles), the Play button in MenuUI,
// and the loading indicator shown BEFORE GameHUD even exists. CSS custom
// properties only inherit through DOM descendants; scoping to .hud-root would
// leave siblings on the default fallbacks.
function setDocumentThemeProperties(theme: ThemeTokens): void {
    const target = document.documentElement;
    const c = theme.colors;
    target.style.setProperty('--hud-color-primary', c.primary);
    target.style.setProperty('--hud-color-danger', c.danger);
    target.style.setProperty('--hud-color-warning', c.warning);
    target.style.setProperty('--hud-color-success', c.success);
    target.style.setProperty('--hud-color-background', c.background);
    target.style.setProperty('--hud-color-surface', c.surface);
    target.style.setProperty('--hud-color-text', c.text);
    target.style.setProperty('--hud-color-text-muted', c.textMuted);
    target.style.setProperty('--hud-color-on-primary', readableTextColor(c.primary));
    target.style.setProperty('--hud-color-on-danger', readableTextColor(c.danger));
    target.style.setProperty('--hud-color-on-surface', inkOnSurface(c.surface, c.text));
    target.style.setProperty('--hud-color-on-surface-muted', mutedInkOnSurface(c.surface, c.textMuted));
    // The accent, made readable as TYPE on the background ground.
    //
    // Accent-coloured type is a real device — a modal title, a lobby heading, a
    // status line — and on every dark-grounded preset it works outright: bright
    // gold or cyan on a near-black card measures 6.0 to 16.9:1. On a light-grounded
    // one it inverts, and no single accent value fixes it. An accent readable on
    // village-keep's parchment ground needs L <= 0.217; one readable on its
    // mid-brown furniture needs L >= 0.442. Those ranges do not overlap, so
    // `primary` cannot be accent type on both levels — the same shape of problem
    // --hud-color-on-surface solves for body text.
    //
    // Written CONDITIONALLY: absent is the normal case, and while it is absent every
    // consumer falls through its var() chain to exactly the colour it used before
    // this token existed, so no dark-grounded theme moves.
    setOrRemoveProperty(target, '--hud-color-accent-ink', accentInkOn(c.background, c.primary));
    // `danger` gets its own, because an error message losing its RED costs more than
    // any other accent losing its hue — the colour IS the message. `success` and
    // `warning` share the accent ink: they are decorative on a ground, and on every
    // theme in the catalog they sit in the same part of the wheel as `primary`.
    setOrRemoveProperty(target, '--hud-color-danger-ink', accentInkOn(c.background, c.danger));

    target.style.setProperty('--hud-font-family', getFontCssStack(theme.font.key));
    target.style.setProperty('--hud-font-weight-body', String(theme.font.weightBody));
    target.style.setProperty('--hud-font-weight-heading', String(theme.font.weightHeading));
    target.style.setProperty('--hud-font-case', theme.font.case === 'upper' ? 'uppercase' : 'none');
    target.style.setProperty('--hud-font-tracking-label', `${theme.font.trackingLabel}px`);
    // Unitless multiplier consumed as calc(<size> * var(--hud-font-scale, 1)).
    // Removed when absent, unusable or exactly 1 so themes that do not rescale
    // render byte-identically and a previous theme's scale cannot linger.
    const fontScale = theme.font.sizeScale;
    setOrRemoveProperty(
        target,
        '--hud-font-scale',
        typeof fontScale === 'number' && Number.isFinite(fontScale) && fontScale > 0 && fontScale !== 1
            ? String(fontScale)
            : null,
    );

    target.style.setProperty('--hud-radius-pill', `${theme.shape.radiusPill}px`);
    target.style.setProperty('--hud-radius-card', `${theme.shape.radiusCard}px`);
    // glowColor (exact hue) wins over the curated key when both are present —
    // an explicit hex is the more specific ask. Same alpha either way.
    const glowColor = theme.shape.glowColor;
    target.style.setProperty(
        '--hud-glow-color',
        typeof glowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(glowColor)
            ? hexToRgba(glowColor, glowAlphaOf(theme.shape.glow))
            : GLOW_TO_RGBA[theme.shape.glow],
    );
    target.style.setProperty('--hud-image-rendering', theme.shape.imageRendering);

    // Conditional tokens — see setOrRemoveProperty. Guard non-finite/≤0 as absent:
    // per-element overrides skip range validation, so garbage must degrade to "off".
    setOrRemoveProperty(target, '--hud-color-outline', c.outline ?? null);
    const borderWidth = theme.shape.borderWidth;
    setOrRemoveProperty(
        target,
        '--hud-border-width',
        Number.isFinite(borderWidth) && borderWidth > 0 ? `${borderWidth}px` : null,
    );
    const bevel = theme.shape.bevel;
    const hasBevel = Number.isFinite(bevel) && bevel > 0;
    setOrRemoveProperty(
        target,
        '--hud-bevel-top',
        hasBevel ? `rgba(255, 255, 255, ${bevelAlpha(BEVEL_TOP_ALPHA, bevel)})` : null,
    );
    setOrRemoveProperty(
        target,
        '--hud-bevel-bottom',
        hasBevel ? `rgba(0, 0, 0, ${bevelAlpha(BEVEL_BOTTOM_ALPHA, bevel)})` : null,
    );
    const gloss = theme.shape.gloss;
    const hasGloss = Number.isFinite(gloss) && gloss > 0;
    setOrRemoveProperty(
        target,
        '--hud-gloss-top',
        hasGloss ? `rgba(255, 255, 255, ${bevelAlpha(GLOSS_TOP_ALPHA, gloss)})` : null,
    );
    setOrRemoveProperty(
        target,
        '--hud-gloss-fade',
        hasGloss ? `rgba(255, 255, 255, ${bevelAlpha(GLOSS_FADE_ALPHA, gloss)})` : null,
    );
    const textOutline = theme.font.outlineWidth;
    setOrRemoveProperty(
        target,
        '--hud-text-outline-width',
        Number.isFinite(textOutline) && textOutline > 0 ? `${textOutline}px` : null,
    );
}

// The custom-property pairs a per-element override resolves to. Split from the
// node-setter because the pairs now have TWO consumers: GameHUD's factory sets
// them on each element node as it is created (applyPartialThemeProperties), and
// applyDecorations emits them as a scoped CSS rule for the one element class
// whose nodes are NOT built by that factory — the mobile controls, which attach
// themselves to document.body. Custom properties cascade identically either way.
function collectPartialThemeProperties(partial: PartialTheme, base: ThemeColors): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    // Per-element FONT was a dead knob: validated on both sides, advertised in
    // the schema, and read by nothing — an override validated cleanly and
    // changed no pixels. It emits the same variables the document-level font
    // block sets, scoped to the element.
    const f = partial.font;
    if (f) {
        if (f.key !== undefined && HUD_FONTS[f.key]) out.push(['--hud-font-family', getFontCssStack(f.key)]);
        if (f.case !== undefined) out.push(['--hud-font-case', f.case === 'upper' ? 'uppercase' : 'none']);
        if (f.weightBody !== undefined) out.push(['--hud-font-weight-body', String(f.weightBody)]);
        if (f.weightHeading !== undefined) out.push(['--hud-font-weight-heading', String(f.weightHeading)]);
        if (f.trackingLabel !== undefined && Number.isFinite(f.trackingLabel)) {
            out.push(['--hud-font-tracking-label', `${f.trackingLabel}px`]);
        }
        if (f.outlineWidth !== undefined && Number.isFinite(f.outlineWidth)) {
            // Explicit per-element semantics, like borderWidth/bevel below: 0 must
            // beat a non-zero global token, so it sets a real value.
            out.push(['--hud-text-outline-width', `${Math.max(0, f.outlineWidth)}px`]);
        }
        if (f.sizeScale !== undefined && Number.isFinite(f.sizeScale) && f.sizeScale > 0) {
            out.push(['--hud-font-scale', String(f.sizeScale)]);
        }
    }
    const c = partial.colors;
    if (c) {
        // The derived inks depend on the tokens they pair, so an override of any
        // one of them has to re-derive here — otherwise an element that darkens
        // its own `surface` keeps the ink derived from the theme-wide one and
        // goes unreadable exactly where the author was being most deliberate.
        if (c.surface !== undefined || c.text !== undefined || c.textMuted !== undefined) {
            const surface = c.surface ?? base.surface;
            out.push(['--hud-color-on-surface', inkOnSurface(surface, c.text ?? base.text)]);
            out.push(['--hud-color-on-surface-muted', mutedInkOnSurface(surface, c.textMuted ?? base.textMuted)]);
        }
        // Same law for the fill labels: a mobile button overridden to a light
        // primary must not keep the white on-primary derived from the dark
        // theme-wide value.
        if (c.primary !== undefined) out.push(['--hud-color-on-primary', readableTextColor(c.primary)]);
        if (c.danger !== undefined) out.push(['--hud-color-on-danger', readableTextColor(c.danger)]);
        if (c.primary !== undefined) out.push(['--hud-color-primary', c.primary]);
        if (c.danger !== undefined) out.push(['--hud-color-danger', c.danger]);
        if (c.warning !== undefined) out.push(['--hud-color-warning', c.warning]);
        if (c.success !== undefined) out.push(['--hud-color-success', c.success]);
        if (c.background !== undefined) out.push(['--hud-color-background', c.background]);
        if (c.surface !== undefined) out.push(['--hud-color-surface', c.surface]);
        if (c.text !== undefined) out.push(['--hud-color-text', c.text]);
        if (c.textMuted !== undefined) out.push(['--hud-color-text-muted', c.textMuted]);
        if (c.outline !== undefined) out.push(['--hud-color-outline', c.outline]);
    }
    const s = partial.shape;
    if (s) {
        if (s.radiusPill !== undefined) out.push(['--hud-radius-pill', `${s.radiusPill}px`]);
        if (s.radiusCard !== undefined) out.push(['--hud-radius-card', `${s.radiusCard}px`]);
        if (s.glowColor !== undefined && /^#[0-9a-fA-F]{6}$/.test(s.glowColor)) {
            out.push(['--hud-glow-color', hexToRgba(s.glowColor, glowAlphaOf(s.glow))]);
        } else if (s.glow !== undefined) {
            out.push(['--hud-glow-color', GLOW_TO_RGBA[s.glow]]);
        }
        if (s.imageRendering !== undefined) out.push(['--hud-image-rendering', s.imageRendering]);
        // Per-element values are EXPLICIT (unlike the global conditional writes):
        // an override of 0 means "no border/bevel/gloss on this element" and must
        // beat a non-zero global token, so 0 sets a real value instead of removing.
        if (s.borderWidth !== undefined && Number.isFinite(s.borderWidth)) {
            out.push(['--hud-border-width', `${Math.max(0, s.borderWidth)}px`]);
        }
        if (s.bevel !== undefined && Number.isFinite(s.bevel)) {
            const strength = Math.max(0, s.bevel);
            if (strength > 0) {
                out.push(['--hud-bevel-top', `rgba(255, 255, 255, ${bevelAlpha(BEVEL_TOP_ALPHA, strength)})`]);
                out.push(['--hud-bevel-bottom', `rgba(0, 0, 0, ${bevelAlpha(BEVEL_BOTTOM_ALPHA, strength)})`]);
            } else {
                out.push(['--hud-bevel-top', 'transparent']);
                out.push(['--hud-bevel-bottom', 'transparent']);
            }
        }
        if (s.gloss !== undefined && Number.isFinite(s.gloss)) {
            const strength = Math.max(0, s.gloss);
            if (strength > 0) {
                out.push(['--hud-gloss-top', `rgba(255, 255, 255, ${bevelAlpha(GLOSS_TOP_ALPHA, strength)})`]);
                out.push(['--hud-gloss-fade', `rgba(255, 255, 255, ${bevelAlpha(GLOSS_FADE_ALPHA, strength)})`]);
            } else {
                out.push(['--hud-gloss-top', 'transparent']);
                out.push(['--hud-gloss-fade', 'transparent']);
            }
        }
    }
    return out;
}

/**
 * Exported for the trailer's HUD replay harness (game/hud-replay.html), which
 * builds toast nodes itself and needs the same per-element override the engine
 * applies in `applyElementOverride`. Pure — it only writes custom properties
 * onto the node it is given.
 */
export function applyPartialThemeProperties(node: HTMLElement, partial: PartialTheme, base: ThemeColors): void {
    for (const [name, value] of collectPartialThemeProperties(partial, base)) {
        node.style.setProperty(name, value);
    }
}

function ensureGoogleFontLink(theme: ThemeTokens): void {
    const entry = HUD_FONTS[theme.font.key];
    const remoteUrl = buildGoogleFontsUrl(theme.font.key, entry.weights);
    const url = ASSET_MAP.get(remoteUrl) ?? remoteUrl;
    const existing = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
    if (existing && existing.href === url) return;
    if (existing) {
        existing.href = url;
        return;
    }
    const link = document.createElement('link');
    link.id = FONT_LINK_ID;
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
}

export interface ApplyThemeGlobalsOptions {
    // Whether to inject/update the Google Fonts <link> tag. Set false in published
    // games where the bundler has already baked the active theme's font link into
    // index.html — having two managers fight over the link tag is the failure mode.
    manageFontLink: boolean;
}

export const DEFAULT_APPLY_THEME_GLOBALS_OPTIONS: ApplyThemeGlobalsOptions = {
    manageFontLink: true,
};

// Module-level cache of the most recently applied theme. Lets GameHUD (and
// other components constructed after applyThemeGlobals has already run) use
// the current document-level theme as their initial state instead of unconditionally
// resetting to DEFAULT_HUD_THEME — which would overwrite the tokens we set early
// to keep the StartScreen from flashing default styles before the real theme
// is wired up.
let _lastAppliedTheme: ThemeTokens | null = null;

export function getLastAppliedTheme(): ThemeTokens | null {
    return _lastAppliedTheme;
}

// Apply theme tokens to documentElement + optionally inject the font link.
// Use this when you need theming BEFORE a GameHUD (and thus a ThemeManager)
// exists — e.g. the loading indicator shown during world-data fetch. Calling
// it again later from ThemeManager.applyTheme is idempotent.
//
// Also updates the icon registry (theme-supplied heart / mouse / arrow SVGs
// replace the engine defaults) so any subsequently-constructed HUD or overlay
// renders with the theme's icons. DOM nodes built BEFORE applyThemeGlobals
// won't re-render — they need a reload to pick up new icons.
export function applyThemeGlobals(
    theme: ThemeTokens,
    options: ApplyThemeGlobalsOptions = DEFAULT_APPLY_THEME_GLOBALS_OPTIONS,
): void {
    setDocumentThemeProperties(theme);
    setIconsFromTheme(theme.icons, theme.colors);
    if (options.manageFontLink) ensureGoogleFontLink(theme);
    _lastAppliedTheme = theme;
}

export class ThemeManager {
    private root: HTMLElement;
    private manageFontLink: boolean;
    private decorationStyleEl: HTMLStyleElement | null = null;
    private current: ThemeTokens | null = null;

    constructor(options: ThemeManagerOptions) {
        this.root = options.root;
        this.manageFontLink = options.manageFontLink;
    }

    getTheme(): ThemeTokens | null {
        return this.current;
    }

    applyTheme(theme: ThemeTokens): void {
        this.current = theme;
        applyThemeGlobals(theme, { manageFontLink: this.manageFontLink });
        this.applyDecorations(theme);
        this.root.dataset.hudTheme = theme.name.toLowerCase().replace(/\s+/g, '-');
        // Activates the [data-pixel-mode] font-smoothing rules in hudBaseStyles
        // (pixel fonts need smoothing off to render crisply).
        if (theme.shape.imageRendering === 'pixelated') {
            this.root.dataset.pixelMode = 'true';
        } else {
            delete this.root.dataset.pixelMode;
        }
    }

    private applyDecorations(theme: ThemeTokens): void {
        const css: string[] = [];
        for (const [elementClass, slots] of Object.entries(theme.decorations) as Array<[
            HudElementClass,
            Partial<DecorationSlots>,
        ]>) {
            css.push(buildSlotCss(elementClass, slots, theme.colors));
        }
        // The mobile-controls override rides this stylesheet instead of the
        // per-node path every other class uses: its nodes (joystick container,
        // each action button) attach themselves to document.body from
        // MobileControls, so GameHUD's factory never sees them and
        // applyElementOverride has nothing to hook. A scoped rule on the shared
        // class cascades the same custom properties to the same descendants.
        const mobileOverride = theme.elements.mobileControls;
        if (mobileOverride) {
            const pairs = collectPartialThemeProperties(mobileOverride, theme.colors);
            if (pairs.length > 0) {
                css.push(
                    `.${HUD_ELEMENT_CLASS_TO_CSS.mobileControls} {\n`
                    + pairs.map(([name, value]) => `  ${name}: ${value};`).join('\n')
                    + `\n}`,
                );
            }
        }
        const block = css.filter(s => s.length > 0).join('\n\n');
        if (!this.decorationStyleEl) {
            this.decorationStyleEl = document.createElement('style');
            this.decorationStyleEl.dataset.hudDecorations = 'true';
            this.root.appendChild(this.decorationStyleEl);
        }
        this.decorationStyleEl.textContent = block;
    }

    // Apply per-element overrides to a freshly-created HUD element node. Called by
    // the HUD factory methods after creating a node and assigning its element class.
    applyElementOverride(node: HTMLElement, elementClass: HudElementClass): void {
        if (!this.current) return;
        const override = this.current.elements[elementClass];
        if (!override) return;
        applyPartialThemeProperties(node, override, this.current.colors);
    }

    destroy(): void {
        if (this.decorationStyleEl) {
            this.decorationStyleEl.remove();
            this.decorationStyleEl = null;
        }
        if (this.manageFontLink) {
            const link = document.getElementById(FONT_LINK_ID);
            link?.remove();
        }
        this.current = null;
    }
}
