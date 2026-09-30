import { BITMAGIC_THEME_DATA } from 'engine/hud/themes/bitmagic.js';
import { RIFT_RAIDER_THEME_DATA } from 'engine/hud/themes/rift-raider.js';
import { VILLAGE_KEEP_THEME_DATA } from 'engine/hud/themes/village-keep.js';
import { NEXUS_THEME_DATA } from 'engine/hud/themes/nexus.js';
import { SIMULATOR_THEME_DATA } from 'engine/hud/themes/simulator.js';
import { RACING_THEME_DATA } from 'engine/hud/themes/racing.js';
import { validateAndResolveTheme } from 'engine/hud/validateTheme.js';
import type { ThemeTokens } from 'engine/hud/ThemeTokens.js';

// Built-in theme presets — THE FIVE SELECTABLE STYLES. Each preset's raw data
// lives in its own TS module (themes/*.ts) and goes through
// validateAndResolveTheme — so the same path that user themes go through
// catches preset bugs at engine boot.
//
// `bitmagic` is deliberately NOT in this set. It is the engine's DEFAULT/
// FALLBACK look (what a game with no `hud.theme` — or an invalid one — renders
// with), exported as DEFAULT_HUD_THEME. Listing it as a preset made every "cycle
// all styles" feature show six looks and every agent catalogue advertise a
// style that is really the absence of one.
//
// Built-in presets are TS modules, not .json files, because the engine runtime
// loads modules from /dist/ where tsc doesn't copy non-TS files. User-authored
// themes ship as theme.json on disk (next to world.json) and are fetched +
// validated at game load time.

export type PresetName =
    | 'rift-raider'
    | 'village-keep'
    | 'nexus'
    | 'simulator'
    | 'racing';

/**
 * The one-line mood label each preset carries beside its tokens.
 *
 * Exported separately because `evokes` is deliberately NOT part of `ThemeTokens`
 * — it is authoring metadata for whoever (or whatever) is choosing a preset, not
 * a rendering token, and `validateAndResolveTheme` drops it on the way through.
 * The agent catalogue mirrors this map and a drift gate compares the two, so a
 * style and its description cannot part company.
 */
export const PRESET_EVOKES: Readonly<Record<PresetName, string>> = {
    'rift-raider': RIFT_RAIDER_THEME_DATA.evokes,
    'village-keep': VILLAGE_KEEP_THEME_DATA.evokes,
    nexus: NEXUS_THEME_DATA.evokes,
    simulator: SIMULATOR_THEME_DATA.evokes,
    racing: RACING_THEME_DATA.evokes,
};

function resolvePreset(raw: unknown, name: string): ThemeTokens {
    const result = validateAndResolveTheme(raw);
    if (!result.ok) {
        throw new Error(
            `Built-in preset "${name}" failed validation: ` +
                result.errors.map(e => `${e.path}: ${e.message}`).join('; '),
        );
    }
    return result.theme;
}

/**
 * The engine's default look — applied when a game sets no `hud.theme`, and the
 * fallback when a theme is unknown or fails validation. Not a selectable preset.
 */
export const BITMAGIC_THEME: ThemeTokens = resolvePreset(BITMAGIC_THEME_DATA, 'bitmagic');
export const DEFAULT_HUD_THEME: ThemeTokens = BITMAGIC_THEME;
export const RIFT_RAIDER_THEME: ThemeTokens = resolvePreset(RIFT_RAIDER_THEME_DATA, 'rift-raider');
export const VILLAGE_KEEP_THEME: ThemeTokens = resolvePreset(VILLAGE_KEEP_THEME_DATA, 'village-keep');
export const NEXUS_THEME: ThemeTokens = resolvePreset(NEXUS_THEME_DATA, 'nexus');
export const SIMULATOR_THEME: ThemeTokens = resolvePreset(SIMULATOR_THEME_DATA, 'simulator');
export const RACING_THEME: ThemeTokens = resolvePreset(RACING_THEME_DATA, 'racing');

export const HUD_PRESETS: Readonly<Record<PresetName, ThemeTokens>> = {
    'rift-raider': RIFT_RAIDER_THEME,
    'village-keep': VILLAGE_KEEP_THEME,
    nexus: NEXUS_THEME,
    simulator: SIMULATOR_THEME,
    racing: RACING_THEME,
};
