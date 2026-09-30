// Bitmagic theme — the default. Mirrors creator/DESIGN.md (Aquamarine primary,
// Shocking Pink danger, etc.). Goes through validateAndResolveTheme in presets.ts
// so any drift between this object and the schema fails at engine boot.

export const BITMAGIC_THEME_DATA = {
    name: 'Bitmagic',
    font: {
        key: 'red-hat-display',
        case: 'upper',
        weightBody: 400,
        weightHeading: 700,
        trackingLabel: 1.6,
    },
    colors: {
        primary: '#A0DAB9',
        danger: '#E0218A',
        warning: '#FF8200',
        success: '#F9E547',
        background: '#0b0b0b',
        surface: '#181818',
        text: '#ffffff',
        textMuted: '#b3b3b3',
    },
    shape: {
        radiusPill: 500,
        radiusCard: 8,
        glow: 'aqua',
        imageRendering: 'auto',
    },
} as const;
