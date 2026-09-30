import { DEFAULT_HUD_THEME, HUD_PRESETS, type PresetName } from 'engine/hud/presets.js';
import { suggestClosest, validateAndResolveTheme } from 'engine/hud/validateTheme.js';
import type { ThemeTokens } from 'engine/hud/ThemeTokens.js';

// Resolve a `hud.theme` value from world.json into a ThemeTokens.
//
//   - undefined / null / unknown shape → DEFAULT_HUD_THEME (the engine's default look)
//   - string matching a preset name    → the preset
//   - string not matching any preset   → DEFAULT_HUD_THEME + console warning
//                                        (this includes legacy names such as
//                                        'bitmagic' and 'horror' — the first
//                                        IS the default, so it is visually a
//                                        no-op; the second no longer ships)
//   - object                           → validateAndResolveTheme(obj). On success,
//                                        the resolved theme. On failure, DEFAULT_HUD_THEME
//                                        + console warning that includes field paths.
//
// This is the single integration point: don't bypass it. The engine calls it
// once per loadGame() after world data is parsed. Failures never block the game
// from loading — a broken theme is recoverable; failing the load is not.

function isPresetName(value: string): value is PresetName {
    return value in HUD_PRESETS;
}

export function resolveWorldTheme(value: string | Record<string, unknown> | undefined | null): ThemeTokens {
    if (value === undefined || value === null) return DEFAULT_HUD_THEME;

    if (typeof value === 'string') {
        if (isPresetName(value)) return HUD_PRESETS[value];
        // The closest-match hint catches the two real spelling traps: the
        // unhyphenated internal style keys (`riftraider`) and plain typos.
        const close = suggestClosest(value, Object.keys(HUD_PRESETS));
        console.warn(
            `[HUD] Unknown theme preset "${value}". Known presets: ${Object.keys(HUD_PRESETS).join(', ')}.`
            + `${close ? ` Closest match: "${close}".` : ''} Falling back to the default theme.`,
        );
        return DEFAULT_HUD_THEME;
    }

    const result = validateAndResolveTheme(value);
    // Suggestions ride in parentheses INSIDE each issue. The validator's
    // `suggestion` field carries the actionable half of every message — the
    // closest-match name, the font-case remedy — and this warn used to format
    // only `path: message`, so the hint was computed and then thrown away at
    // the last hop. This console line is the ONLY channel the CLI lane has
    // (`bitmagic verify` parses it; there is no write-tool there to return
    // suggestions), so dropping it here dropped it everywhere.
    // The `[HUD]` marker and the two leading phrases are cli/src/verify/
    // hud-theme.ts's parse contract — the suggestion text extends the detail
    // and must never reword them.
    const formatIssue = (issue: { path: string; message: string; suggestion?: string }): string =>
        `${issue.path}: ${issue.message}${issue.suggestion ? ` (${issue.suggestion})` : ''}`;
    if (!result.ok) {
        console.warn(
            '[HUD] Custom theme failed validation; falling back to the default theme. Errors:',
            result.errors.map(formatIssue).join('; '),
        );
        return DEFAULT_HUD_THEME;
    }
    if (result.warnings.length > 0) {
        console.warn(
            '[HUD] Custom theme has warnings:',
            result.warnings.map(formatIssue).join('; '),
        );
    }
    return result.theme;
}
