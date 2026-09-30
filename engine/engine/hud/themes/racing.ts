// Racing theme — motorsport telemetry conventions (the "Racing" kit style):
// white line-art structure on near-black, red reserved for STATE, tall condensed
// display caps, hard corners, nothing glazed. Danger is a hot red-orange kept
// distinct from the crimson brand; caution is amber; sectors are green.

export const RACING_THEME_DATA = {
    name: 'Racing',
    // One-line mood label, read by the agent catalogue so an AI picks the right
    // preset without trying each one. It lives HERE, beside the tokens it
    // describes, so that changing the style and changing its description are the
    // same edit — it drifted badly when it lived only in the agent mirror. The
    // engine validator ignores unknown top-level keys, so this never reaches
    // ThemeTokens; `PRESET_EVOKES` in presets.ts is what exposes it.
    evokes: 'Motorsport telemetry — white line-art chrome on black with red reserved for state, tall narrow gothic caps, amber caution / green sector',
    font: {
        key: 'archivo-narrow',
        case: 'upper',
        weightBody: 500,
        weightHeading: 700,
        trackingLabel: 1.2,
        outlineWidth: 0,
    },
    colors: {
        // NOT red. The engine spends `primary` on both FILLS and accent TYPE —
        // 13 `color: var(--hud-color-primary)` sites in hudBaseStyles/modalCard
        // (lobby title + status, success toast, reticle, counters, modal title)
        // plus whatever the game's own panels use it for. Any red here is red
        // TYPE on a near-black HUD, which is what kept getting reported, and no
        // saturated red can be fixed by tuning: even pure #FF0000 tops out at
        // 4.87:1 on this surface.
        //
        // So Racing takes the OTHER half of its own reference: white line-art
        // chrome, with red reserved for state. Red did not leave the style — it
        // moved to `danger` below, where it means the redline, a failed run and
        // critical health, which is exactly how a real timing board uses it.
        primary: '#E8EDF2',
        danger: '#FF4D3A',
        warning: '#FFB000',
        success: '#22C55E',
        background: '#07090C',
        surface: '#0E1319',
        text: '#F2F5F8',
        textMuted: '#9BA4AE',   // 5.99:1 -> 7.39:1 under bebas-neue's narrow strokes
        outline: '#C9D2DA',
    },
    shape: {
        // Buttons are OBJECTS even when the panels are flat: `bevel` paints the
        // white-top/dark-bottom gradient over buttons, counters and bars, and a
        // 2px border in colors.outline follows the radius. The plates keep their
        // hairline language — only the controls gain relief.
        radiusPill: 4,
        radiusCard: 2,
        glow: 'none',
        imageRendering: 'auto',
        borderWidth: 2,
        bevel: 0.5,
    },
} as const;
