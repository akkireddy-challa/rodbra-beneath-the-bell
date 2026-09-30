import {
    DEFAULT_THEME_FONT,
    DEFAULT_THEME_SHAPE,
    type ThemeTokens,
    type ThemeFont,
    type ThemeColors,
    type ThemeShape,
    type ThemeIcons,
    type FontKey,
    type DecorationKey,
    type HudElementClass,
    type LabelCase,
    type GlowKey,
    type ImageRendering,
    type Decorations,
    type BorderImageValue,
    type BackgroundValue,
    type DecorationSlots,
    type PartialTheme,
} from 'engine/hud/ThemeTokens.js';
import { HUD_FONTS } from 'engine/hud/fonts.js';
import { HUD_DECORATIONS, type DecorationSlotKind } from 'engine/hud/decorations.js';

// Lightweight runtime validator. Does NOT use ajv — the engine doesn't ship a
// runtime schema validator (would inflate the bundle). Agent-side tools and
// authoring-time tests use the JSON Schema directly via ajv; this file is the
// engine-side check that runs when a theme.json is loaded into a live game.

export interface ValidationIssue {
    path: string;
    message: string;
    suggestion?: string;
}

export type ValidationResult =
    | { ok: true; theme: ThemeTokens; warnings: ValidationIssue[] }
    | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] };

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const FONT_KEYS = Object.keys(HUD_FONTS) as ReadonlyArray<FontKey>;
const DECORATION_KEYS = Object.keys(HUD_DECORATIONS) as ReadonlyArray<DecorationKey>;
const GLOW_KEYS: ReadonlyArray<GlowKey> = ['aqua', 'pink', 'warm', 'horror-red', 'gold', 'cyan', 'none'];
const CASE_VALUES: ReadonlyArray<LabelCase> = ['upper', 'normal'];
const RENDERING_VALUES: ReadonlyArray<ImageRendering> = ['auto', 'pixelated'];
const ELEMENT_CLASSES: ReadonlyArray<HudElementClass> = [
    'progressBar',
    'healthBar',
    'counter',
    'iconText',
    'timer',
    'toast',
    'controls',
    'reticle',
    'mobileControls',
];

interface Ctx {
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Levenshtein, not character containment. The old scorer counted how many of the
// input's characters appear ANYWHERE in a candidate, so long candidates won on
// volume: "balloo2" suggested "rubik-mono-one"-class noise instead of "baloo-2",
// and the suggestion an agent is meant to copy was sometimes worse than no
// suggestion. Edit distance measures what a typo actually is. Only suggest when
// the distance is small relative to the input — a wild guess should get the
// full candidate list from the error message, not false confidence in one name.
function editDistance(a: string, b: string): number {
    // Single-row DP; inputs are short catalog keys, so O(len a * len b) is fine.
    let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur: number[] = [i];
        for (let j = 1; j <= b.length; j++) {
            const deletion = (prev[j] ?? 0) + 1;
            const insertion = (cur[j - 1] ?? 0) + 1;
            const substitution = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
            cur[j] = Math.min(deletion, insertion, substitution);
        }
        prev = cur;
    }
    return prev[b.length] ?? 0;
}

export function suggestClosest(value: string, candidates: ReadonlyArray<string>): string | undefined {
    const v = value.toLowerCase();
    let best: string | undefined;
    let bestScore = Infinity;
    for (const c of candidates) {
        const score = editDistance(v, c.toLowerCase());
        if (score < bestScore) {
            bestScore = score;
            best = c;
        }
    }
    const maxDistance = Math.max(2, Math.ceil(v.length / 3));
    return bestScore <= maxDistance ? best : undefined;
}

function checkHex(ctx: Ctx, path: string, value: unknown): string | null {
    if (typeof value !== 'string') {
        ctx.errors.push({ path, message: `expected hex color string, got ${typeof value}` });
        return null;
    }
    if (!HEX_COLOR.test(value)) {
        ctx.errors.push({
            path,
            message: `${value} is not a valid 6-digit hex color`,
            suggestion: 'Use e.g. "#A0DAB9" — six hex digits with a leading #.',
        });
        return null;
    }
    return value;
}

/**
 * `background-size`: one of the three keywords, or an explicit tile size.
 *
 * A repeating decoration NEEDS the explicit form. Every decoration SVG carries
 * only a `viewBox`, which gives it no intrinsic size, so `auto` does not mean
 * "one tile at the viewBox dimensions" — the browser scales a single copy to
 * fill the element, and a pattern meant to tile renders as one enormous motif.
 * With only the three keywords available, a hand-authored tiling texture could
 * not be expressed at all.
 *
 * The pattern is deliberately strict rather than "any CSS length". This value is
 * interpolated straight into a `background-size:` declaration, so anything that
 * gets through here is CSS the theme author controls — two plain lengths and
 * nothing else. No `calc()`, no `var()`, no semicolons.
 */
const TILE_SIZE = /^\d{1,4}(?:\.\d{1,2})?(?:px|%) \d{1,4}(?:\.\d{1,2})?(?:px|%)$/;

function checkBackgroundSize(ctx: Ctx, path: string, value: unknown): string | null {
    if (typeof value === 'string' && (value === 'cover' || value === 'contain' || value === 'auto')) {
        return value;
    }
    if (typeof value === 'string' && TILE_SIZE.test(value)) return value;
    ctx.errors.push({
        path,
        message: `${JSON.stringify(value)} is not "cover", "contain", "auto", or an explicit tile size`,
        suggestion: 'Use "32px 32px" for a repeating pattern (a viewBox-only SVG has no intrinsic '
            + 'size, so "auto" stretches one copy over the whole element), or one of the keywords.',
    });
    return null;
}

function checkEnum<T extends string>(
    ctx: Ctx,
    path: string,
    value: unknown,
    allowed: ReadonlyArray<T>,
): T | null {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        const suggestion =
            typeof value === 'string' ? suggestClosest(value, allowed as ReadonlyArray<string>) : undefined;
        ctx.errors.push({
            path,
            message: `${JSON.stringify(value)} is not one of: ${allowed.join(', ')}`,
            suggestion: suggestion ? `Closest match: "${suggestion}"` : undefined,
        });
        return null;
    }
    return value as T;
}

function checkNumber(
    ctx: Ctx,
    path: string,
    value: unknown,
    min: number,
    max: number,
    fallback: number,
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        ctx.errors.push({ path, message: `expected number in [${min}, ${max}]` });
        return fallback;
    }
    if (value < min || value > max) {
        ctx.errors.push({ path, message: `${value} outside allowed range [${min}, ${max}]` });
        return fallback;
    }
    return value;
}

function checkFont(ctx: Ctx, path: string, raw: unknown): ThemeFont | null {
    if (!isObject(raw)) {
        ctx.errors.push({ path, message: 'missing font object' });
        return null;
    }
    const key = checkEnum<FontKey>(ctx, `${path}.key`, raw.key, FONT_KEYS);
    if (!key) return null;
    const labelCase = raw.case === undefined
        ? DEFAULT_THEME_FONT.case
        : checkEnum<LabelCase>(ctx, `${path}.case`, raw.case, CASE_VALUES) ?? DEFAULT_THEME_FONT.case;
    const weightBody = raw.weightBody === undefined
        ? DEFAULT_THEME_FONT.weightBody
        : (checkEnum<'300' | '400' | '500' | '700'>(
              ctx,
              `${path}.weightBody`,
              String(raw.weightBody),
              ['300', '400', '500', '700'],
          )
              ? (raw.weightBody as 300 | 400 | 500 | 700)
              : DEFAULT_THEME_FONT.weightBody);
    const weightHeading = raw.weightHeading === undefined
        ? DEFAULT_THEME_FONT.weightHeading
        : (checkEnum<'400' | '500' | '700' | '900'>(
              ctx,
              `${path}.weightHeading`,
              String(raw.weightHeading),
              ['400', '500', '700', '900'],
          )
              ? (raw.weightHeading as 400 | 500 | 700 | 900)
              : DEFAULT_THEME_FONT.weightHeading);
    const trackingLabel = raw.trackingLabel === undefined
        ? DEFAULT_THEME_FONT.trackingLabel
        : checkNumber(ctx, `${path}.trackingLabel`, raw.trackingLabel, 0, 4, DEFAULT_THEME_FONT.trackingLabel);
    const outlineWidth = raw.outlineWidth === undefined
        ? DEFAULT_THEME_FONT.outlineWidth
        : checkNumber(ctx, `${path}.outlineWidth`, raw.outlineWidth, 0, 3, DEFAULT_THEME_FONT.outlineWidth);
    // Absent stays absent — the resolved field is optional on purpose.
    const sizeScale = raw.sizeScale === undefined
        ? undefined
        : checkNumber(ctx, `${path}.sizeScale`, raw.sizeScale, 0.85, 1.3, 1);

    // Auto-correct case if the font doesn't support the requested case (e.g.
    // Pacifico + 'upper' looks awkward — snap to the font's supported case
    // and emit a warning explaining the swap). The resolved theme stored in
    // the registry uses the corrected value, so the HUD renders cleanly even
    // when the input was wrong.
    const fontEntry = HUD_FONTS[key];
    const effectiveCase: LabelCase = fontEntry.suitsCase.includes(labelCase)
        ? labelCase
        : (fontEntry.suitsCase[0] ?? labelCase);
    if (effectiveCase !== labelCase) {
        ctx.warnings.push({
            path: `${path}.case`,
            message: `font "${key}" is designed for case "${effectiveCase}" — auto-corrected from "${labelCase}". Pick a different font (e.g. "bebas-neue", "rubik-mono-one") if you want case "${labelCase}".`,
            suggestion: `Either keep the auto-correction (case: "${effectiveCase}") or change font.key.`,
        });
    }

    return {
        key, case: effectiveCase, weightBody, weightHeading, trackingLabel, outlineWidth,
        // Spread so an absent scale leaves the KEY absent, not set to undefined.
        ...(sizeScale === undefined ? {} : { sizeScale }),
    };
}

function checkColors(ctx: Ctx, path: string, raw: unknown): ThemeColors | null {
    if (!isObject(raw)) {
        ctx.errors.push({ path, message: 'missing colors object' });
        return null;
    }
    const required: ReadonlyArray<keyof ThemeColors> = ['primary', 'danger', 'background', 'surface', 'text'];
    const result: Partial<ThemeColors> = {};
    let allRequiredOk = true;
    for (const field of required) {
        const hex = checkHex(ctx, `${path}.${field}`, raw[field]);
        if (hex) result[field] = hex;
        else allRequiredOk = false;
    }
    for (const field of ['warning', 'success', 'textMuted'] as const) {
        if (raw[field] !== undefined) {
            const hex = checkHex(ctx, `${path}.${field}`, raw[field]);
            if (hex) result[field] = hex;
        } else {
            // Fallbacks chosen to remain on-brand without forcing the agent to fill them.
            if (field === 'warning') result.warning = result.primary ?? '#FF8200';
            if (field === 'success') result.success = result.primary ?? '#F9E547';
            if (field === 'textMuted') result.textMuted = '#b3b3b3';
        }
    }
    // outline stays ABSENT when omitted — no fallback fill. Absence means "no outline
    // concept" and lets base styles keep their per-element default borders.
    if (raw.outline !== undefined) {
        const hex = checkHex(ctx, `${path}.outline`, raw.outline);
        if (hex) result.outline = hex;
    }
    if (!allRequiredOk) return null;
    return result as ThemeColors;
}

function checkShape(ctx: Ctx, path: string, raw: unknown): ThemeShape {
    if (raw === undefined) return { ...DEFAULT_THEME_SHAPE };
    if (!isObject(raw)) {
        ctx.errors.push({ path, message: 'expected shape object' });
        return { ...DEFAULT_THEME_SHAPE };
    }
    const radiusPill = raw.radiusPill === undefined
        ? DEFAULT_THEME_SHAPE.radiusPill
        : checkNumber(ctx, `${path}.radiusPill`, raw.radiusPill, 0, 500, DEFAULT_THEME_SHAPE.radiusPill);
    const radiusCard = raw.radiusCard === undefined
        ? DEFAULT_THEME_SHAPE.radiusCard
        : checkNumber(ctx, `${path}.radiusCard`, raw.radiusCard, 0, 32, DEFAULT_THEME_SHAPE.radiusCard);
    const glow = raw.glow === undefined
        ? DEFAULT_THEME_SHAPE.glow
        : checkEnum<GlowKey>(ctx, `${path}.glow`, raw.glow, GLOW_KEYS) ?? DEFAULT_THEME_SHAPE.glow;
    const imageRendering = raw.imageRendering === undefined
        ? DEFAULT_THEME_SHAPE.imageRendering
        : checkEnum<ImageRendering>(ctx, `${path}.imageRendering`, raw.imageRendering, RENDERING_VALUES) ??
          DEFAULT_THEME_SHAPE.imageRendering;
    const borderWidth = raw.borderWidth === undefined
        ? DEFAULT_THEME_SHAPE.borderWidth
        : checkNumber(ctx, `${path}.borderWidth`, raw.borderWidth, 0, 6, DEFAULT_THEME_SHAPE.borderWidth);
    const bevel = raw.bevel === undefined
        ? DEFAULT_THEME_SHAPE.bevel
        : checkNumber(ctx, `${path}.bevel`, raw.bevel, 0, 1, DEFAULT_THEME_SHAPE.bevel);
    const gloss = raw.gloss === undefined
        ? DEFAULT_THEME_SHAPE.gloss
        : checkNumber(ctx, `${path}.gloss`, raw.gloss, 0, 1, DEFAULT_THEME_SHAPE.gloss);
    // Absent stays absent — like colors.outline, absence is meaningful (keyed glow).
    const glowColor = raw.glowColor === undefined
        ? undefined
        : checkHex(ctx, `${path}.glowColor`, raw.glowColor) ?? undefined;
    // No warning for glow:'none' + glowColor: the explicit hex simply wins,
    // including over 'none'. An agent patching glowColor onto a zero-glow theme
    // is asking for a glow in one edit — making 'none' veto it would turn the
    // most direct ask ("purple neon") into a two-token puzzle. Turning a glow
    // OFF again is deleting glowColor.
    return {
        radiusPill, radiusCard, glow, imageRendering, borderWidth, bevel, gloss,
        ...(glowColor === undefined ? {} : { glowColor }),
    };
}

function checkBorderImageValue(ctx: Ctx, path: string, raw: unknown): BorderImageValue | null {
    if (typeof raw === 'string') {
        return checkEnum<DecorationKey>(ctx, path, raw, DECORATION_KEYS);
    }
    if (isObject(raw) && typeof raw.svg === 'string') {
        if (raw.svg.length > 16384) {
            ctx.errors.push({ path: `${path}.svg`, message: `inline SVG exceeds 16kb limit` });
            return null;
        }
        const borderSlice = checkNumber(ctx, `${path}.borderSlice`, raw.borderSlice ?? 30, 0, 200, 30);
        const repeat = checkEnum<'stretch' | 'repeat' | 'round' | 'space'>(
            ctx,
            `${path}.repeat`,
            raw.repeat ?? 'stretch',
            ['stretch', 'repeat', 'round', 'space'],
        ) ?? 'stretch';
        return { svg: raw.svg, borderSlice, repeat };
    }
    ctx.errors.push({ path, message: 'expected curated decoration key string or inline SVG object' });
    return null;
}

function checkBackgroundValue(ctx: Ctx, path: string, raw: unknown): BackgroundValue | null {
    if (typeof raw === 'string') {
        return checkEnum<DecorationKey>(ctx, path, raw, DECORATION_KEYS);
    }
    if (isObject(raw) && typeof raw.svg === 'string') {
        if (raw.svg.length > 16384) {
            ctx.errors.push({ path: `${path}.svg`, message: `inline SVG exceeds 16kb limit` });
            return null;
        }
        const size = checkBackgroundSize(ctx, `${path}.size`, raw.size ?? 'auto') ?? 'auto';
        const position = checkEnum(ctx, `${path}.position`, raw.position ?? 'center', [
            'top',
            'top-right',
            'right',
            'bottom-right',
            'bottom',
            'bottom-left',
            'left',
            'top-left',
            'center',
        ] as const) ?? 'center';
        const repeat = checkEnum<'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y'>(
            ctx,
            `${path}.repeat`,
            raw.repeat ?? 'no-repeat',
            ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'],
        ) ?? 'no-repeat';
        return { svg: raw.svg, size, position, repeat };
    }
    ctx.errors.push({ path, message: 'expected curated decoration key string or inline SVG object' });
    return null;
}

function checkDecorationSlots(ctx: Ctx, path: string, raw: unknown): Partial<DecorationSlots> {
    if (!isObject(raw)) return {};
    const slots: Partial<DecorationSlots> = {};
    const slotKinds: ReadonlyArray<DecorationSlotKind> = [
        'borderImage',
        'backdrop',
        'decorationBefore',
        'decorationAfter',
    ];
    for (const kind of slotKinds) {
        if (raw[kind] === undefined) continue;
        const value = kind === 'borderImage'
            ? checkBorderImageValue(ctx, `${path}.${kind}`, raw[kind])
            : checkBackgroundValue(ctx, `${path}.${kind}`, raw[kind]);
        if (value !== null) {
            if (typeof value === 'string') {
                const entry = HUD_DECORATIONS[value];
                if (!entry.suitsSlots.includes(kind)) {
                    ctx.warnings.push({
                        path: `${path}.${kind}`,
                        message: `decoration "${value}" isn't designed for slot "${kind}" (suits: ${entry.suitsSlots.join(', ')})`,
                    });
                }
            }
            // Workaround for noUncheckedIndexedAccess narrowing on the union literal.
            (slots as Record<string, BorderImageValue | BackgroundValue>)[kind] = value;
        }
    }
    return slots;
}

function checkDecorations(ctx: Ctx, path: string, raw: unknown): Decorations {
    if (raw === undefined) return {};
    if (!isObject(raw)) {
        ctx.errors.push({ path, message: 'expected decorations object' });
        return {};
    }
    const out: Decorations = {};
    for (const key of Object.keys(raw)) {
        if (!ELEMENT_CLASSES.includes(key as HudElementClass)) {
            ctx.errors.push({
                path: `${path}.${key}`,
                message: `unknown HUD element class "${key}"`,
                suggestion: `Known: ${ELEMENT_CLASSES.join(', ')}.`,
            });
            continue;
        }
        out[key as HudElementClass] = checkDecorationSlots(ctx, `${path}.${key}`, raw[key]);
    }
    return out;
}

// Per-element override leaves are validated as WARN-AND-DROP, not as errors.
// These blocks used to be raw casts, so `elements.healthBar.colors.background:
// "bright-green"` sailed through validation and produced broken CSS with no
// message anywhere — the quietest possible failure. Errors would be the wrong
// fix: an error rejects the WHOLE theme, and already-published games carry
// frozen inline themes this validator must keep accepting. Dropping the one bad
// leaf keeps the theme rendering exactly as it did before, and the warning
// finally names the field. (The agent-side validator is deliberately stricter —
// at WRITE time a bad leaf is an error; at LOAD time it cannot be.)
function dropLeaf(ctx: Ctx, path: string, message: string, suggestion?: string): undefined {
    ctx.warnings.push({ path, message: `${message} — ignoring this override`, ...(suggestion ? { suggestion } : {}) });
    return undefined;
}

function checkPartialColors(ctx: Ctx, path: string, raw: unknown): PartialTheme['colors'] {
    if (!isObject(raw)) {
        dropLeaf(ctx, path, 'expected a colors object');
        return null;
    }
    const KNOWN: ReadonlyArray<keyof ThemeColors> = [
        'primary', 'danger', 'warning', 'success', 'background', 'surface', 'text', 'textMuted', 'outline',
    ];
    const out: Partial<ThemeColors> = {};
    for (const key of Object.keys(raw)) {
        if (!KNOWN.includes(key as keyof ThemeColors)) {
            dropLeaf(ctx, `${path}.${key}`, `unknown color token "${key}"`, `Known: ${KNOWN.join(', ')}.`);
            continue;
        }
        const value = raw[key];
        if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
            dropLeaf(ctx, `${path}.${key}`, `${JSON.stringify(value)} is not a valid 6-digit hex color`);
            continue;
        }
        out[key as keyof ThemeColors] = value;
    }
    return out;
}

function partialNumber(ctx: Ctx, path: string, value: unknown, min: number, max: number): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        return dropLeaf(ctx, path, `${JSON.stringify(value)} is not a number in [${min}, ${max}]`);
    }
    return value;
}

function checkPartialShape(ctx: Ctx, path: string, raw: unknown): PartialTheme['shape'] {
    if (!isObject(raw)) {
        dropLeaf(ctx, path, 'expected a shape object');
        return null;
    }
    const out: NonNullable<PartialTheme['shape']> = {};
    if (raw.radiusPill !== undefined) out.radiusPill = partialNumber(ctx, `${path}.radiusPill`, raw.radiusPill, 0, 500);
    if (raw.radiusCard !== undefined) out.radiusCard = partialNumber(ctx, `${path}.radiusCard`, raw.radiusCard, 0, 32);
    if (raw.borderWidth !== undefined) out.borderWidth = partialNumber(ctx, `${path}.borderWidth`, raw.borderWidth, 0, 6);
    if (raw.bevel !== undefined) out.bevel = partialNumber(ctx, `${path}.bevel`, raw.bevel, 0, 1);
    if (raw.glow !== undefined) {
        if (typeof raw.glow === 'string' && GLOW_KEYS.includes(raw.glow as GlowKey)) out.glow = raw.glow as GlowKey;
        else dropLeaf(ctx, `${path}.glow`, `${JSON.stringify(raw.glow)} is not one of: ${GLOW_KEYS.join(', ')}`);
    }
    if (raw.imageRendering !== undefined) {
        if (raw.imageRendering === 'auto' || raw.imageRendering === 'pixelated') out.imageRendering = raw.imageRendering;
        else dropLeaf(ctx, `${path}.imageRendering`, `${JSON.stringify(raw.imageRendering)} is not "auto" or "pixelated"`);
    }
    if (raw.gloss !== undefined) out.gloss = partialNumber(ctx, `${path}.gloss`, raw.gloss, 0, 1);
    if (raw.glowColor !== undefined) {
        if (typeof raw.glowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.glowColor)) out.glowColor = raw.glowColor;
        else dropLeaf(ctx, `${path}.glowColor`, `${JSON.stringify(raw.glowColor)} is not a valid 6-digit hex color`);
    }
    return out;
}

function checkPartialFont(ctx: Ctx, path: string, raw: unknown): PartialTheme['font'] {
    if (!isObject(raw)) {
        dropLeaf(ctx, path, 'expected a font object');
        return null;
    }
    const out: NonNullable<PartialTheme['font']> = {};
    if (raw.key !== undefined) {
        if (typeof raw.key === 'string' && FONT_KEYS.includes(raw.key as FontKey)) out.key = raw.key as FontKey;
        else {
            const close = typeof raw.key === 'string' ? suggestClosest(raw.key, FONT_KEYS) : undefined;
            dropLeaf(ctx, `${path}.key`, `${JSON.stringify(raw.key)} is not a curated font key`,
                close ? `Closest match: "${close}"` : undefined);
        }
    }
    if (raw.case !== undefined) {
        if (raw.case === 'upper' || raw.case === 'normal') out.case = raw.case;
        else dropLeaf(ctx, `${path}.case`, `${JSON.stringify(raw.case)} is not "upper" or "normal"`);
    }
    if (raw.trackingLabel !== undefined) out.trackingLabel = partialNumber(ctx, `${path}.trackingLabel`, raw.trackingLabel, 0, 4);
    if (raw.outlineWidth !== undefined) out.outlineWidth = partialNumber(ctx, `${path}.outlineWidth`, raw.outlineWidth, 0, 3);
    if (raw.sizeScale !== undefined) out.sizeScale = partialNumber(ctx, `${path}.sizeScale`, raw.sizeScale, 0.85, 1.3);
    if (raw.weightBody !== undefined) {
        if ([300, 400, 500, 700].includes(raw.weightBody as number)) out.weightBody = raw.weightBody as 300 | 400 | 500 | 700;
        else dropLeaf(ctx, `${path}.weightBody`, `${JSON.stringify(raw.weightBody)} is not one of 300, 400, 500, 700`);
    }
    if (raw.weightHeading !== undefined) {
        if ([400, 500, 700, 900].includes(raw.weightHeading as number)) out.weightHeading = raw.weightHeading as 400 | 500 | 700 | 900;
        else dropLeaf(ctx, `${path}.weightHeading`, `${JSON.stringify(raw.weightHeading)} is not one of 400, 500, 700, 900`);
    }
    return out;
}

function checkPartialTheme(ctx: Ctx, path: string, raw: unknown): PartialTheme {
    if (!isObject(raw)) {
        ctx.errors.push({ path, message: 'expected partial theme object' });
        return { font: null, colors: null, shape: null, decorations: null };
    }
    return {
        font: raw.font === undefined ? null : checkPartialFont(ctx, `${path}.font`, raw.font),
        colors: raw.colors === undefined ? null : checkPartialColors(ctx, `${path}.colors`, raw.colors),
        shape: raw.shape === undefined ? null : checkPartialShape(ctx, `${path}.shape`, raw.shape),
        decorations:
            raw.decorations === undefined
                ? null
                : (checkDecorationSlots(ctx, `${path}.decorations`, raw.decorations) as PartialTheme['decorations']),
    };
}

function checkElements(
    ctx: Ctx,
    path: string,
    raw: unknown,
): Partial<Record<HudElementClass, PartialTheme>> {
    if (raw === undefined) return {};
    if (!isObject(raw)) {
        ctx.errors.push({ path, message: 'expected elements object' });
        return {};
    }
    const out: Partial<Record<HudElementClass, PartialTheme>> = {};
    for (const key of Object.keys(raw)) {
        if (!ELEMENT_CLASSES.includes(key as HudElementClass)) {
            ctx.errors.push({ path: `${path}.${key}`, message: `unknown HUD element class "${key}"` });
            continue;
        }
        out[key as HudElementClass] = checkPartialTheme(ctx, `${path}.${key}`, raw[key]);
    }
    return out;
}

function checkIcons(ctx: Ctx, path: string, raw: unknown): ThemeIcons {
    if (raw === undefined || raw === null) return {};
    if (!isObject(raw)) {
        ctx.errors.push({ path, message: 'icons must be an object with optional heart/mouse/arrow SVG strings' });
        return {};
    }
    const ICON_SLOTS = ['heart', 'mouse', 'arrow'] as const;
    const out: ThemeIcons = {};
    for (const key of Object.keys(raw)) {
        if (!(ICON_SLOTS as ReadonlyArray<string>).includes(key)) {
            ctx.errors.push({
                path: `${path}.${key}`,
                message: `unknown icon slot "${key}"`,
                suggestion: `Known: ${ICON_SLOTS.join(', ')}`,
            });
            continue;
        }
        const value = raw[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') {
            ctx.errors.push({ path: `${path}.${key}`, message: 'icon SVG must be a string' });
            continue;
        }
        if (value.length > 16384) {
            ctx.errors.push({ path: `${path}.${key}`, message: `icon SVG exceeds 16kb limit` });
            continue;
        }
        out[key as keyof ThemeIcons] = value;
    }
    return out;
}

export function validateAndResolveTheme(input: unknown): ValidationResult {
    const ctx: Ctx = { errors: [], warnings: [] };
    if (!isObject(input)) {
        ctx.errors.push({ path: '', message: 'theme must be an object' });
        return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
    }
    const name = typeof input.name === 'string' && input.name.length > 0 ? input.name : null;
    if (!name) {
        ctx.errors.push({ path: 'name', message: 'name is required and must be non-empty' });
    }
    const font = checkFont(ctx, 'font', input.font);
    const colors = checkColors(ctx, 'colors', input.colors);
    const shape = checkShape(ctx, 'shape', input.shape);
    const decorations = checkDecorations(ctx, 'decorations', input.decorations);
    const elements = checkElements(ctx, 'elements', input.elements);
    const icons = checkIcons(ctx, 'icons', input.icons);

    if (ctx.errors.length > 0 || !name || !font || !colors) {
        return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
    }

    return {
        ok: true,
        theme: { name, font, colors, shape, decorations, elements, icons },
        warnings: ctx.warnings,
    };
}
