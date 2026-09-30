/**
 * The WCAG colour arithmetic behind the derived HUD inks — relative luminance,
 * contrast ratios, and the substitution rules that make `--hud-color-on-surface`,
 * `--hud-color-accent-ink` and friends safe to derive.
 *
 * A separate module for one load-bearing reason: it is PURE. No DOM, no engine
 * imports — so the agent-side drift gate (game-play-agent/scripts/
 * check-hud-catalog.ts) can import it under tsx and compare the hand-mirrored
 * copies in game-play-agent and cli against the engine's own arithmetic,
 * behaviourally, over a colour grid. The formulas are WCAG spec constants and
 * will not change; the substitution thresholds and mix factors are OURS and
 * can — which is exactly what the gate watches.
 */

export function relLuminance(hex: string): number {
    const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(parseInt(hex.slice(1, 3), 16) / 255)
        + 0.7152 * lin(parseInt(hex.slice(3, 5), 16) / 255)
        + 0.0722 * lin(parseInt(hex.slice(5, 7), 16) / 255);
}

export function contrastRatio(a: string, b: string): number {
    const la = relLuminance(a);
    const lb = relLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mixHex(from: string, to: string, amount: number): string {
    const channel = (i: number): string => {
        const f = parseInt(from.slice(i, i + 2), 16);
        const t = parseInt(to.slice(i, i + 2), 16);
        return Math.round(f * amount + t * (1 - amount)).toString(16).padStart(2, '0');
    };
    return `#${channel(1)}${channel(3)}${channel(5)}`;
}

export function readableTextColor(hex: string): string {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return '#ffffff';
    return relLuminance(hex) > 0.5 ? '#000000' : '#ffffff';
}

// The ink for anything painted ON `surface`, plus its muted companion.
//
// Same species as --hud-color-on-primary: the engine picks the readable pair so a
// theme author does not have to hand-author contrast per element. It exists
// because `text` carries TWO jobs that only agree on a uniformly dark theme. It is
// the ink on the `background` canvas — a game's own dialogs paint themselves with
// that pair — AND the ink on every counter, timer, toast, bubble and panel filled
// with `surface`. A style whose big UI is a light canvas and whose HUD furniture is
// darker cannot satisfy both from one value: with a single ink the furniture caps
// out around #9E9276, which is 1.4:1 against a sunny world and so not furniture at
// all. Village Keep spent three rounds oscillating between a washed-out HUD and a
// uniformly dark one for exactly this reason.
//
// It PREFERS the theme's own ink, because a tinted parchment or a cold cyan is part
// of a style's identity and must survive. It substitutes only where the declared
// pairing is unusable — below 3:1, the WCAG floor for large text, and far below
// every pairing in the catalog: the presets measure 9.6 to 17.8 for `text` and 5.7
// to 9.3 for `textMuted`, so this cannot fire on a theme that was already coherent.
export const ON_SURFACE_MIN_CONTRAST = 3;

export function inkOnSurface(surface: string, preferred: string): string {
    if (!/^#[0-9a-fA-F]{6}$/.test(surface) || !/^#[0-9a-fA-F]{6}$/.test(preferred)) return preferred;
    if (contrastRatio(preferred, surface) >= ON_SURFACE_MIN_CONTRAST) return preferred;
    return readableTextColor(surface);
}

// Target 4.5:1 rather than the 3:1 the on-surface inks use: this one paints
// headings and status lines, which are body-scale on some surfaces, and the
// margin is free — the lowest any shipped preset measures is 6.02:1, so raising
// the bar cannot make the token fire on a theme that was already fine.
export const ACCENT_INK_MIN_CONTRAST = 4.5;

export function accentInkOn(ground: string, accent: string): string | null {
    if (!/^#[0-9a-fA-F]{6}$/.test(ground) || !/^#[0-9a-fA-F]{6}$/.test(accent)) return null;
    if (contrastRatio(accent, ground) >= ACCENT_INK_MIN_CONTRAST) return null;
    // Walk the accent toward the ground's opposite pole and stop at the FIRST value
    // that clears, so the result keeps as much of the accent as the ground allows.
    // Mixing toward black or white preserves the HUE, which is the part that makes
    // an accent an accent: village-keep's candy lime lands on a forest green rather
    // than on brown, and a forest green on parchment is what the reference draws.
    const pole = relLuminance(ground) > 0.5 ? '#000000' : '#ffffff';
    for (let keep = 0.95; keep > 0.05; keep -= 0.05) {
        const candidate = mixHex(accent, pole, keep);
        if (contrastRatio(candidate, ground) >= ACCENT_INK_MIN_CONTRAST) return candidate;
    }
    return readableTextColor(ground);
}

export function mutedInkOnSurface(surface: string, preferred: string): string {
    if (!/^#[0-9a-fA-F]{6}$/.test(surface) || !/^#[0-9a-fA-F]{6}$/.test(preferred)) return preferred;
    if (contrastRatio(preferred, surface) >= ON_SURFACE_MIN_CONTRAST) return preferred;
    // A secondary label steps BACK toward its own backdrop rather than taking the
    // full-strength ink — otherwise the substitution would make muted text the
    // loudest thing on the element it was meant to sit quietly on. 0.78 is the
    // point where it still clears AA on the lightest surface that can reach this
    // branch at all (a mid-brown at 4.65:1) while reading as clearly quieter than
    // the full ink beside it.
    return mixHex(readableTextColor(surface), surface, 0.78);
}
