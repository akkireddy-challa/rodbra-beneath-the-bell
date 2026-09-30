import type { FontKey, LabelCase } from 'engine/hud/ThemeTokens.js';

export interface FontCatalogEntry {
    key: FontKey;
    family: string;
    weights: ReadonlyArray<number>;
    // Which `case` values this font is designed for. Cursive (Pacifico),
    // already-display-styled (Creepster), and italic display (Shrikhand) fonts
    // are intended for sentence case — uppercase on them renders awkwardly,
    // so the validator emits a warning when a theme pairs them with 'upper'.
    suitsCase: ReadonlyArray<LabelCase>;
    // Short label shown in pickers / agent docs ("evokes"). Helps the agent pick
    // a font that matches the prompt without trial and error.
    evokes: string;
}

export const HUD_FONTS: Readonly<Record<FontKey, FontCatalogEntry>> = {
    'red-hat-display': {
        key: 'red-hat-display',
        family: 'Red Hat Display',
        weights: [300, 400, 500, 700],
        suitsCase: ['upper', 'normal'],
        evokes: 'Default Bitmagic — warm, technical, modern sans',
    },
    'chakra-petch': {
        key: 'chakra-petch',
        family: 'Chakra Petch',
        weights: [300, 400, 500, 600, 700],
        suitsCase: ['upper', 'normal'],
        evokes: 'Chamfered techno sans — holographic HUD, sci-fi console, cut corners',
    },
    'ibm-plex-sans': {
        key: 'ibm-plex-sans',
        family: 'IBM Plex Sans',
        weights: [300, 400, 500, 600, 700],
        suitsCase: ['upper', 'normal'],
        evokes: 'Engineered humanist sans — instrument panel, operator console, tabular data',
    },
    'archivo-narrow': {
        key: 'archivo-narrow',
        family: 'Archivo Narrow',
        weights: [400, 500, 600, 700],
        suitsCase: ['upper', 'normal'],
        evokes: 'Narrow gothic that keeps its ink — motorsport telemetry, broadcast overlay',
    },
    'bebas-neue': {
        key: 'bebas-neue',
        family: 'Bebas Neue',
        weights: [400],
        suitsCase: ['upper', 'normal'],
        evokes: 'Tall, bold display — sports, action, news ticker',
    },
    'press-start-2p': {
        key: 'press-start-2p',
        family: 'Press Start 2P',
        weights: [400],
        suitsCase: ['upper', 'normal'],
        evokes: 'Retro arcade pixel — 8-bit, NES, chiptune',
    },
    creepster: {
        key: 'creepster',
        family: 'Creepster',
        weights: [400],
        suitsCase: ['normal'],
        evokes: 'Horror, halloween, dripping — already display-styled',
    },
    pacifico: {
        key: 'pacifico',
        family: 'Pacifico',
        weights: [400],
        suitsCase: ['normal'],
        evokes: 'Handwritten cursive — tropical, beachy, casual',
    },
    'space-grotesk': {
        key: 'space-grotesk',
        family: 'Space Grotesk',
        weights: [400, 500, 700],
        suitsCase: ['upper', 'normal'],
        evokes: 'Geometric sans — sci-fi, technical, modern',
    },
    'rubik-mono-one': {
        key: 'rubik-mono-one',
        family: 'Rubik Mono One',
        weights: [400],
        suitsCase: ['upper', 'normal'],
        evokes: 'Heavy, slabby display — bold, blocky, attention-grabbing',
    },
    vt323: {
        key: 'vt323',
        family: 'VT323',
        weights: [400],
        suitsCase: ['upper', 'normal'],
        evokes: 'CRT terminal monospace — retro computer, hacker, glitch',
    },
    orbitron: {
        key: 'orbitron',
        family: 'Orbitron',
        weights: [400, 500, 700, 900],
        suitsCase: ['upper', 'normal'],
        evokes: 'Futuristic geometric — sci-fi, cyber, racing HUD',
    },
    shrikhand: {
        key: 'shrikhand',
        family: 'Shrikhand',
        weights: [400],
        suitsCase: ['normal'],
        evokes: 'Italic display — celebratory, party, energetic',
    },
    'baloo-2': {
        key: 'baloo-2',
        family: 'Baloo 2',
        weights: [400, 500, 600, 700, 800],
        suitsCase: ['upper', 'normal'],
        evokes: 'Rounded chunky sans with a real weight range — mobile action-RPG chrome',
    },
    'lilita-one': {
        key: 'lilita-one',
        family: 'Lilita One',
        weights: [400],
        suitsCase: ['upper', 'normal'],
        evokes: 'Chunky rounded comic display — cartoon battler, toon town',
    },
    fredoka: {
        key: 'fredoka',
        family: 'Fredoka',
        weights: [300, 400, 500, 700],
        suitsCase: ['upper', 'normal'],
        evokes: 'Soft rounded bubble sans — candy, casual mobile, sweet',
    },
    'grenze-gotisch': {
        key: 'grenze-gotisch',
        family: 'Grenze Gotisch',
        weights: [400, 500, 700, 900],
        suitsCase: ['normal'],
        evokes: 'Readable blackletter — dark fantasy, gothic dungeon',
    },
    cinzel: {
        key: 'cinzel',
        family: 'Cinzel',
        weights: [400, 500, 700, 900],
        suitsCase: ['upper', 'normal'],
        evokes: 'Carved Roman caps — epic fantasy, ancient temple',
    },
};

export interface FontStackOptions {
    fallback: string;
}

export const DEFAULT_FONT_STACK_OPTIONS: FontStackOptions = {
    fallback: '"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif',
};

export function getFontCssStack(key: FontKey, opts: FontStackOptions = DEFAULT_FONT_STACK_OPTIONS): string {
    const entry = HUD_FONTS[key];
    return `"${entry.family}", ${opts.fallback}`;
}

// Builds the Google Fonts CSS URL for a single font with the weights the theme needs.
// Published games only ever load the active theme's font, so this URL is the sole
// font request on the page.
export function buildGoogleFontsUrl(key: FontKey, weights: ReadonlyArray<number>): string {
    const entry = HUD_FONTS[key];
    const allowed = new Set(entry.weights);
    const filtered = weights.filter(w => allowed.has(w));
    const useWeights = filtered.length > 0 ? filtered : entry.weights;
    const family = entry.family.replace(/ /g, '+');
    const wtParam = useWeights.length > 0 ? `:wght@${[...useWeights].sort((a, b) => a - b).join(';')}` : '';
    return `https://fonts.googleapis.com/css2?family=${family}${wtParam}&display=swap`;
}
