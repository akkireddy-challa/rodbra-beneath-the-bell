// Nexus theme — holographic sci-fi conventions (the "Nexus" kit style):
// hairline cyan on near-black, chamfer-small radii, wide-tracked tech caps,
// corner brackets and a circuitry backdrop. Depth is carried by glow alone —
// hairline PANELS; buttons carry a bevel and a 2px rim. Threat states run orange.

export const NEXUS_THEME_DATA = {
    name: 'Nexus',
    // One-line mood label, read by the agent catalogue so an AI picks the right
    // preset without trying each one. It lives HERE, beside the tokens it
    // describes, so that changing the style and changing its description are the
    // same edit — it drifted badly when it lived only in the agent mirror. The
    // engine validator ignores unknown top-level keys, so this never reaches
    // ThemeTokens; `PRESET_EVOKES` in presets.ts is what exposes it.
    evokes: 'Holographic sci-fi — hairline cyan on near-black, corner brackets, lit teal plate buttons with a graded cyan bezel, depth by glow (Mass Effect-style)',
    font: {
        key: 'chakra-petch',
        case: 'upper',
        weightBody: 500,
        weightHeading: 700,
        // 1.4, not 2.5: orbitron is the widest face in the catalogue and at
        // 2.5px per glyph a label like "RIFT PROGRESS" nearly fills the corner
        // anchor budget on a phone, breaking mid-word. Wide tracking also costs
        // word cohesion at HUD sizes — the opposite defect from the lab's Nexus.
        trackingLabel: 1.4,
        outlineWidth: 0,
    },
    colors: {
        primary: '#4FD8E8',
        danger: '#FF6B4A',
        warning: '#F0A22E',
        success: '#6FD9A4',
        background: '#04070C',
        surface: '#0A121A',
        text: '#E6F6FA',
        // Lifted from '#7EA3B2'. Checked against the panel's LIT header band
        // rather than its nominal face — a secondary label that clears on the
        // flat colour can still miss where the face gradient is brightest.
        textMuted: '#9DBBC8',
        outline: '#2E9FB5',
    },
    shape: {
        // Buttons are OBJECTS even when the panels are flat: `bevel` paints the
        // white-top/dark-bottom gradient over buttons, counters and bars, and a
        // 2px border in colors.outline follows the radius. The plates keep their
        // hairline language — only the controls gain relief.
        radiusPill: 6,
        radiusCard: 4,
        glow: 'cyan',
        imageRendering: 'auto',
        borderWidth: 2,
        bevel: 0.5,
    },
    // NO `controls` backdrop. `circuit-trace` used to sit here and rendered as
    // GIANT CROSSHAIRS across the controls overlay rather than the fine PCB
    // texture it is meant to be — see the sizing note on the decoration itself.
    // The pattern is fixed now, but this style does not need it: the corner
    // brackets already carry the scanner language, and a texture behind the
    // control hints competed with the type sitting on top of it.
    decorations: {
        progressBar: { borderImage: 'bracket-frame' },
        counter: { borderImage: 'bracket-frame' },
        // `backdrop`, not `decorationBefore`. The before/after slots are 12px
        // strips hung OUTSIDE the element, so what this asked for was a glow
        // floating above the crosshair rather than around it — and glow-aura's
        // whole intent is "soft radial glow halo BEHIND the element". It never
        // showed either way, because the slot itself could not render (see
        // buildSlotCss), so the mistake was invisible until the slot was fixed.
        reticle: { backdrop: 'glow-aura' },
    },
} as const;
