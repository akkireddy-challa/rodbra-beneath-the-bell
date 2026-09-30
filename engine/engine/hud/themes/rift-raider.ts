// Rift Raider theme — mobile action-RPG conventions (the "Rift Raider" kit
// style): cast-gold medallion frames on dark INDIGO glass, cream display type
// with a dark bronze stroke, ornate royal borders and a leather-grain backdrop.
// The outline token is the dark keyline, not the gold: it edges gold buttons AND
// strokes cream text, and both read right in bronze.
//
// The reference's material law is that GOLD IS TRIM, NOT FILL — it belongs to
// the band around a dark face, never to the face itself. `primary` stays gold
// because the engine spends it on frames, rules and accent type; the faces it
// sits against come from `surface`.

export const RIFT_RAIDER_THEME_DATA = {
    name: 'Rift Raider',
    // One-line mood label, read by the agent catalogue so an AI picks the right
    // preset without trying each one. It lives HERE, beside the tokens it
    // describes, so that changing the style and changing its description are the
    // same edit — it drifted badly when it lived only in the agent mirror. The
    // engine validator ignores unknown top-level keys, so this never reaches
    // ThemeTokens; `PRESET_EVOKES` in presets.ts is what exposes it.
    evokes: 'Mobile action-RPG — cast-gold medallion frames on dark indigo glass, chunky cream type with a dark ink ring, royal borders (Diablo-style)',
    font: {
        // Baloo 2, not lilita-one: Google serves Lilita One at a single weight,
        // so `weightBody` and `weightHeading` both collapsed to 400 and this
        // preset had NO type hierarchy at all — the one thing a HUD needs to
        // separate a label from the value it labels. Baloo 2 is the same
        // rounded chunky voice and ships 400-800, and it is the face the kit
        // half of this style already uses.
        key: 'baloo-2',
        case: 'upper',
        weightBody: 500,
        weightHeading: 700,
        trackingLabel: 0.8,
        outlineWidth: 2,
    },
    colors: {
        primary: '#F0B23A',
        danger: '#D6332E',
        warning: '#E07A28',
        success: '#5FB35A',
        // The dark ladder sits at hue ~256, not the old ~217. This style's
        // violet accents live at 269, and against a hue-217 navy the surfaces
        // and the accents read as two unrelated colour families sharing a
        // screen. Lightness is held; only hue moves.
        background: '#0B0716',
        surface: '#191228',
        text: '#FFF6E2',
        textMuted: '#B9A889',
        outline: '#5A3D0C',
    },
    shape: {
        radiusPill: 14,
        radiusCard: 14,
        glow: 'gold',
        imageRendering: 'auto',
        borderWidth: 2,
        bevel: 0.85,
    },
    decorations: {
        progressBar: { borderImage: 'royal-frame' },
        healthBar: { borderImage: 'royal-frame' },
        toast: { borderImage: 'royal-frame' },
        controls: { backdrop: 'grain-texture' },
    },
} as const;
