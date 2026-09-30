// Simulator theme — instrument-panel conventions (the "Simulator" kit style):
// flat slate plates, hard corners, neutral grey-blue structure and ONE azure
// accent reserved for state. No glow and no decoration on the plates — the seriousness
// IS the absence of jewellery. Bars run semantic green / amber / red.

export const SIMULATOR_THEME_DATA = {
    name: 'Simulator',
    // One-line mood label, read by the agent catalogue so an AI picks the right
    // preset without trying each one. It lives HERE, beside the tokens it
    // describes, so that changing the style and changing its description are the
    // same edit — it drifted badly when it lived only in the agent mirror. The
    // engine validator ignores unknown top-level keys, so this never reaches
    // ThemeTokens; `PRESET_EVOKES` in presets.ts is what exposes it.
    evokes: 'Serious instrument panel — flat slate, hard corners, one azure accent for state, thin meters and a bare dial, no glow or ornament (flight/truck sim)',
    font: {
        key: 'ibm-plex-sans',
        case: 'upper',
        weightBody: 400,
        weightHeading: 700,
        trackingLabel: 0.8,
        outlineWidth: 0,
    },
    colors: {
        primary: '#2E9BDB',
        danger: '#C8453F',
        warning: '#D8A32E',
        success: '#4E9E57',
        background: '#0E141B',
        surface: '#161E27',
        text: '#DDE5EC',
        textMuted: '#A2B0BE',   // 4.84:1 -> 7.60:1; 4.5:1 is a 12-14px bar, not a 10px one
        outline: '#46586A',
    },
    shape: {
        // CONTOURED, NOT MOULDED — and that split is deliberate.
        //
        // The reference has neither: across eight screens of the Farming
        // Simulator UI there is not one moulded control, and the first pass
        // took it literally and set `bevel: 0`. Dead flat read as underdrawn
        // next to the rest of the kit, so the call was made to depart from the
        // reference here: `bevel` is what paints the white-top/dark-bottom
        // gradient over buttons, counters and bars, and a modest 0.35 gives the
        // fill and edge some depth.
        //
        // What stays gone is the SILHOUETTE moulding — the lip, the dome, the
        // cast shadow — which is what made this style look like a mobile game
        // wearing a simulator's palette. `borderWidth` stays 1: the edge here is
        // a hairline, not the 2px rim the four physical styles carry.
        radiusPill: 4,
        radiusCard: 2,
        glow: 'none',
        imageRendering: 'auto',
        borderWidth: 1,
        bevel: 0.35,
    },
} as const;
