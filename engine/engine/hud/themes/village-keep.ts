// Village Keep theme — cartoon-strategy conventions (the "Village Keep" kit
// style): a light parchment ground for the big UI, darker moulded furniture for
// the HUD itself, candy-green buttons, rounded everything, maximum gloss and
// zero glow.
//
// THREE LEVELS, and they are the whole point of this preset:
//
//   background  #E9E1CE   the light ground the BIG UI stands on — a game's own
//                         dialogs and panels paint themselves with this, and the
//                         lobby's text input is a light well because of it.
//   surface     #6E5C44   the HUD FURNITURE — counters, timers, toasts, the
//                         controls box, bubbles. 4.92:1 darker than the ground it
//                         sits on and 3.29:1 against a sunny-green world, so it
//                         reads as an object laid over the field rather than a
//                         patch of it.
//   trough      #3A3126   per-element, for the two bars: a channel has to be the
//                         darkest thing in the widget or the fill cannot be the
//                         brightest.
//
// Getting those three apart needed an engine token. `text` used to carry two
// jobs — ink on the light ground AND ink on the furniture — which only agree on a
// uniformly dark theme. With one ink the furniture caps out around #9E9276, which
// is 1.4:1 against grass and so is not furniture at all; that ceiling is why this
// style spent three rounds flipping between a washed-out HUD and a uniformly dark
// one. `--hud-color-on-surface` (see ThemeManager) derives the second ink, so the
// ground can stay light while the furniture goes as dark as it needs to. Here it
// resolves to white at 6.41:1, and its muted companion to #DEDAD5 at 4.65:1.
//
// What the palette still has to solve by hand:
//
//  - `primary`, `danger` and `warning` are each a FILL colour and an accent TYPE
//    colour, and on this style the type sits on `surface` (five of the six
//    `color: var(--hud-color-primary)` rules do). Type wants a light value,
//    which is the opposite of the usual instinct for a fill — but going light
//    lets `--hud-color-on-primary` / `--hud-color-on-danger` derive BLACK, and a
//    dark label on a bright candy fill clears far more than white on a mid one.
//    Both jobs come out ahead.
//  - the one place that trade does NOT hold is the health bar, whose fill sits in
//    a near-black trough where a pale salmon reads as neither red nor alarming.
//    That is what the per-element overrides at the bottom are for.

export const VILLAGE_KEEP_THEME_DATA = {
    name: 'Village Keep',
    // One-line mood label, read by the agent catalogue so an AI picks the right
    // preset without trying each one. It lives HERE, beside the tokens it
    // describes, so that changing the style and changing its description are the
    // same edit — it drifted badly when it lived only in the agent mirror. The
    // engine validator ignores unknown top-level keys, so this never reaches
    // ThemeTokens; `PRESET_EVOKES` in presets.ts is what exposes it.
    evokes: 'Cartoon strategy — light parchment panels with darker moulded HUD chips over a sunny world, candy-green glossy buttons, ink-outlined type, zero glow (Clash-style)',
    font: {
        key: 'fredoka',
        case: 'upper',
        weightBody: 500,
        weightHeading: 700,
        trackingLabel: 0.6,
        // Light type on the furniture wants a dark ring — the pairing the ink
        // ring was invented for, and what keeps the bar's inside-value legible
        // where it crosses its own fill.
        outlineWidth: 2,
    },
    colors: {
        primary: '#9BDB4F',   // 3.86:1 as accent type on the furniture; auto-label black 12.64
        danger: '#FFA898',    // 3.45:1 as type; auto-label black 11.31
        warning: '#FFC46B',   // 4.08:1 as type; the mobile button's black label 13.36
        success: '#A5E27E',   // 4.20:1 as type
        background: '#E9E1CE',
        surface: '#6E5C44',
        text: '#413A2C',      // 8.64:1 on the ground — this ink is for the BIG UI
        textMuted: '#585040',  // 6.12:1 on the ground
        outline: '#3A6212',   // dark forest edge: the button's ring and the panel's border
    },
    shape: {
        radiusPill: 14,
        radiusCard: 18,
        glow: 'none',
        imageRendering: 'auto',
        borderWidth: 3,
        bevel: 0.9,
    },
    decorations: {
        // The gloss is on the small pill only. On a near-black surface it cost
        // nothing to put it on the controls box as well, but against mid-brown
        // furniture the highlight lifts the backdrop under the first key rows far
        // enough to take their muted label from 4.65:1 to 3.88:1 — and a
        // highlight is a button-and-chip device in the reference anyway, not
        // something laid across an information panel.
        toast: { backdrop: 'candy-gloss' },
    },
    elements: {
        // `background` is the light ground now, and `hudBaseStyles` paints a bar
        // TRACK with it — which would put a light fill inside a light channel and
        // leave the reading to guesswork. The reference settles it the same way:
        // its resource meters are near-black troughs precisely so the coloured
        // fill is the brightest thing in the bar.
        progressBar: { colors: { background: '#3A3126' } },
        healthBar: {
            colors: {
                background: '#3A3126',
                // Deeper than the global values, which are tuned to be legible as
                // TYPE on the mid-brown furniture. In a near-black trough that
                // tuning inverts: a pale salmon is 1.9:1 there and reads as
                // neither red nor urgent, where this is 3.11:1 and unmistakable.
                danger: '#E2452F',
                warning: '#E89A2A',
            },
        },
    },
} as const;
