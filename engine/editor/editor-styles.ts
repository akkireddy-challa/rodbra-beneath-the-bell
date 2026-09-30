// Shared Bitmagic Design System styles for in-engine editor dialogs.
// Aligned with creator/DESIGN.md. The game iframe does not import the creator's
// BitmagicDesign.css, so this module re-declares the same tokens as CSS custom
// properties and exposes a small set of class-based component primitives used
// by ObjectInspector, SceneHierarchyPanel, and TransformControlsManager.
//
// Usage:
//   import { injectEditorStyles, BM } from 'editor/editor-styles.js';
//   injectEditorStyles();             // idempotent — adds the <style> tag once
//   element.classList.add('bm-pill'); // apply a shared class
//   element.style.color = BM.aqua;    // or read tokens in TS

/** Hex tokens for TS-side use (logic, inline overrides, dynamic state). */
export const BM = {
    bg: '#0b0b0b',
    surface: '#181818',
    surfaceAlt: '#1f1f1f',
    surfaceCard: '#252525',

    textPrimary: '#ffffff',
    textMuted: '#b3b3b3',
    textDim: '#7c7c7c',
    textOnAccent: '#000000',

    border: '#4d4d4d',
    borderMuted: '#2a2a2a',

    aqua: '#A0DAB9',
    aquaHover: '#B8E4CA',
    aquaPressed: '#7DC29C',
    pink: '#E0218A',
    pinkHover: '#F04AA4',
    pinkPressed: '#B3176D',
    pumpkin: '#FF8200',
    canary: '#F9E547',

    shadowDialog: '0 8px 24px rgba(0, 0, 0, 0.5)',
    shadowCard: '0 8px 8px rgba(0, 0, 0, 0.3)',
    glowAqua: '0 0 24px rgba(160, 218, 185, 0.45)',
    glowPink: '0 0 24px rgba(224, 33, 138, 0.4)',
    insetBorderDim: 'inset 0 0 0 1px #7c7c7c',
    insetBorderFocus: 'inset 0 0 0 1px #ffffff, 0 0 0 2px rgba(160, 218, 185, 0.45)',

    font: '"Red Hat Display", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif',
} as const;

const STYLE_ID = 'bm-editor-shared-styles';

/** Shared CSS injected as a single <style> tag. Same tokens as `BM`, exposed as
 *  CSS custom properties on `:root` so child selectors can `var(--bm-*)` them. */
export const BITMAGIC_EDITOR_CSS = `
:root {
    --bm-bg: ${BM.bg};
    --bm-surface: ${BM.surface};
    --bm-surface-alt: ${BM.surfaceAlt};
    --bm-surface-card: ${BM.surfaceCard};
    --bm-text: ${BM.textPrimary};
    --bm-text-muted: ${BM.textMuted};
    --bm-text-dim: ${BM.textDim};
    --bm-border: ${BM.border};
    --bm-border-muted: ${BM.borderMuted};
    --bm-aqua: ${BM.aqua};
    --bm-aqua-hover: ${BM.aquaHover};
    --bm-pink: ${BM.pink};
    --bm-pink-hover: ${BM.pinkHover};
    --bm-pumpkin: ${BM.pumpkin};
    --bm-canary: ${BM.canary};
    --bm-shadow-dialog: ${BM.shadowDialog};
    --bm-shadow-card: ${BM.shadowCard};
    --bm-glow-aqua: ${BM.glowAqua};
    --bm-glow-pink: ${BM.glowPink};
    --bm-font: ${BM.font};
}

/* === Panel (dialog surface) === */
.bm-editor-panel {
    position: absolute;
    background: var(--bm-surface);
    color: var(--bm-text);
    border-radius: 8px;
    box-shadow: var(--bm-shadow-dialog);
    overflow: hidden;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    z-index: 1000;
    font-family: var(--bm-font);
}

/* === Header (drag handle + label voice) === */
.bm-editor-header {
    background: var(--bm-surface-alt);
    padding: 10px 14px;
    border-bottom: 1px solid var(--bm-border-muted);
    font-weight: 700;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--bm-text);
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: move;
    user-select: none;
}

.bm-editor-header-buttons {
    display: flex;
    gap: 6px;
    align-items: center;
}

/* === Circular icon button (toolbar / header controls) === */
.bm-icon-btn {
    background: transparent;
    border: none;
    color: var(--bm-text-muted);
    cursor: pointer;
    padding: 0;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--bm-font);
    font-size: 16px;
    transition: background 0.15s ease, color 0.15s ease;
}
.bm-icon-btn:hover {
    background: var(--bm-border-muted);
    color: var(--bm-text);
}

/* === Pill button (secondary dark) === */
.bm-pill {
    background: var(--bm-surface-alt);
    border: 1px solid var(--bm-border);
    color: var(--bm-text);
    padding: 6px 14px;
    border-radius: 9999px;
    cursor: pointer;
    font-family: var(--bm-font);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.bm-pill:hover:not(.bm-pill--active):not(.bm-pill--destructive) {
    background: var(--bm-surface-card);
    border-color: var(--bm-text-dim);
}

/* Active state — Aquamarine primary CTA fill */
.bm-pill--active {
    background: var(--bm-aqua);
    border-color: var(--bm-aqua);
    color: #000000;
    box-shadow: var(--bm-glow-aqua);
}

/* Destructive — Shocking Pink (delete/remove/discard) */
.bm-pill--destructive {
    background: var(--bm-pink);
    border: none;
    color: var(--bm-text);
    letter-spacing: 1.4px;
}
.bm-pill--destructive:hover {
    background: var(--bm-pink-hover);
    box-shadow: var(--bm-glow-pink);
    transform: scale(1.03);
}

/* === Form input — recessed inset border + Aquamarine focus ring === */
.bm-input {
    background: var(--bm-surface-alt);
    color: var(--bm-text);
    border: none;
    box-shadow: ${BM.insetBorderDim};
    padding: 6px 10px;
    border-radius: 4px;
    font-family: var(--bm-font);
    font-size: 12px;
    outline: none;
    box-sizing: border-box;
    transition: box-shadow 0.15s ease;
}
.bm-input:focus {
    box-shadow: ${BM.insetBorderFocus};
}
.bm-input::placeholder {
    color: var(--bm-text-muted);
}

/* === Level switcher (scene hierarchy header) === */
.bm-editor-level-switcher {
    padding: 6px 10px;
    border-bottom: 1px solid var(--bm-border-muted);
}
.bm-editor-level-select {
    width: 100%;
    cursor: pointer;
}
.bm-editor-level-select:disabled {
    opacity: 0.6;
    cursor: wait;
}

/* === Vertical separator (toolbar) === */
.bm-separator-v {
    width: 1px;
    background: var(--bm-border-muted);
    margin: 4px 6px;
}

/* === Resize handle === */
.bm-resize-handle {
    position: absolute;
    width: 20px;
    height: 20px;
    background: transparent;
    z-index: 1001;
}
.bm-resize-corner {
    position: absolute;
    width: 0;
    height: 0;
    border-bottom: 10px solid var(--bm-border);
}
`;

/** Idempotently inject the shared editor stylesheet. Safe to call from any
 *  editor dialog's constructor; subsequent calls are no-ops. */
export function injectEditorStyles(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = BITMAGIC_EDITOR_CSS;
    document.head.appendChild(style);
}
