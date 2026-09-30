// Inspector-specific CSS layered on top of the shared Bitmagic editor stylesheet
// (`editor-styles.ts`). Inspector classes consume the `--bm-*` CSS custom
// properties declared on `:root` by the shared sheet, so brand-token changes
// propagate automatically.
//
// IMPORTANT: call `injectEditorStyles()` BEFORE injecting this stylesheet —
// otherwise `var(--bm-*)` references fall back to the CSS default.
export const OBJECT_INSPECTOR_CSS = `
/* === Panel === */
.oi-panel {
    position: absolute;
    background: var(--bm-surface);
    color: var(--bm-text);
    border-radius: 8px;
    box-shadow: var(--bm-shadow-dialog);
    overflow: hidden;
    pointer-events: auto;
    display: none;
    flex-direction: column;
    z-index: 1000;
    font-family: var(--bm-font);
}

/* === Header === */
.oi-header {
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

.oi-header-buttons {
    display: flex;
    gap: 6px;
    align-items: center;
}

.oi-header-btn {
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
    transition: background 0.15s ease, color 0.15s ease;
}
.oi-header-btn:hover {
    background: var(--bm-border-muted);
    color: var(--bm-text);
}

.oi-header-btn--minimize { font-size: 16px; }
.oi-header-btn--close    { font-size: 18px; }

/* === Content === */
.oi-content {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--bm-text);
}

/* === Resize handle === */
.oi-resize-handle {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 20px;
    height: 20px;
    cursor: nesw-resize;
    background: transparent;
    z-index: 1001;
}

.oi-resize-corner {
    position: absolute;
    bottom: 2px;
    left: 2px;
    width: 0;
    height: 0;
    border-right: 10px solid transparent;
    border-bottom: 10px solid var(--bm-border);
}

/* === Sections === */
.oi-section {
    margin-bottom: 14px;
}

.oi-section-header,
.oi-section-header--simple,
.oi-section-header--config,
.oi-terrain-header {
    background: var(--bm-surface-alt);
    padding: 6px 10px;
    margin-bottom: 6px;
    border-radius: 4px;
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--bm-text);
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.oi-section-header--simple { display: block; }
.oi-section-header--config { margin-bottom: 10px; }

.oi-section-body { padding-left: 10px; }

/* === Field rows === */
.oi-field-row {
    margin-bottom: 4px;
}

.oi-field-label {
    color: var(--bm-text-muted);
    font-weight: 500;
    margin-right: 4px;
}

.oi-field-value {
    color: var(--bm-text);
}

/* === Mechanism section (live-editable engine hazard/mover parameters) === */
.oi-mech-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.oi-mech-input {
    width: 88px;
    background: var(--bm-surface, #222);
    color: var(--bm-text, #eee);
    border: 1px solid var(--bm-border, #444);
    border-radius: 4px;
    padding: 2px 6px;
    font: inherit;
}

.oi-mech-note {
    color: var(--bm-text-muted);
    font-size: 11px;
    margin-top: 6px;
}

.oi-field-subline {
    margin-left: 16px;
    color: var(--bm-text-muted);
    font-size: 11px;
}

.oi-description-text {
    color: var(--bm-text-muted);
    font-size: 11px;
    line-height: 1.5;
    white-space: normal;
    word-break: break-word;
    margin-top: 4px;
}

/* Generated-placeholder marker + one-click HQ regeneration */
.oi-placeholder-badge {
    display: inline-block;
    margin-top: 8px;
    padding: 2px 8px;
    border-radius: 10px;
    background: rgba(255, 193, 7, 0.14);
    border: 1px solid rgba(255, 193, 7, 0.45);
    color: #ffc107;
    font-size: 10px;
    letter-spacing: 0.4px;
    text-transform: uppercase;
}

/* Same shape as the placeholder badge, but "work in progress" rather than
   "needs work" — and pulsing, to match the object's glow out in the world. */
.oi-generating-badge {
    display: inline-block;
    margin-top: 8px;
    padding: 2px 8px;
    border-radius: 10px;
    background: rgba(74, 216, 192, 0.16);
    border: 1px solid rgba(74, 216, 192, 0.5);
    color: #4ad8c0;
    font-size: 10px;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    animation: oi-generating-pulse 1.6s ease-in-out infinite;
}

@keyframes oi-generating-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
}

.oi-hq-generate-btn {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 7px 10px;
    border-radius: 6px;
    border: 1px solid var(--bm-accent, #4a9eff);
    background: rgba(74, 158, 255, 0.12);
    color: var(--bm-accent, #4a9eff);
    font-size: 12px;
    cursor: pointer;
}

.oi-hq-generate-btn:hover:not(:disabled) {
    background: rgba(74, 158, 255, 0.25);
}

.oi-hq-generate-btn:disabled {
    opacity: 0.55;
    cursor: default;
}

/* Scope toggle for the regeneration buttons above it. A <label> is inline by
   default, so on .oi-field-row it flowed onto the placeholder badge's line and
   wrapped its sentence in half; flex gives it its own row with the box beside
   the text. */
.oi-scope-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    cursor: pointer;
}

.oi-scope-row input {
    margin: 0;
    flex: none;
}

/* === Inline pill buttons (secondary) === */
.oi-btn {
    background: var(--bm-surface-alt);
    color: var(--bm-text);
    border: 1px solid var(--bm-border);
    padding: 4px 12px;
    border-radius: 9999px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
}
.oi-btn:hover {
    background: var(--bm-surface-card);
    border-color: var(--bm-text-dim);
}
.oi-button-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
}

/* === Advanced toggle === */
.oi-advanced-toggle {
    background: var(--bm-surface-alt);
    border: 1px solid var(--bm-border);
    color: var(--bm-text-muted);
    padding: 8px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    width: 100%;
    text-align: left;
    transition: background 0.15s ease, color 0.15s ease;
}
.oi-advanced-toggle:hover {
    background: var(--bm-surface-card);
    color: var(--bm-text);
}
.oi-advanced-toggle--expanded {
    background: var(--bm-surface-card);
    color: var(--bm-text);
}

.oi-advanced-content { margin-top: 8px; }

/* === Banners (Pumpkin warning, Canary info) === */
.oi-warning {
    background: rgba(255, 130, 0, 0.12);
    border: 1px solid rgba(255, 130, 0, 0.4);
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 12px;
    color: var(--bm-pumpkin);
    font-size: 11px;
    line-height: 1.5;
}

.oi-info {
    background: rgba(249, 229, 71, 0.12);
    border: 1px solid rgba(249, 229, 71, 0.4);
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 12px;
    color: var(--bm-canary);
    font-size: 11px;
    line-height: 1.5;
}

/* === Cross-links and parent links (Aquamarine accent) === */
.oi-crosslink {
    margin-bottom: 12px;
    padding: 6px 10px;
    background: rgba(160, 218, 185, 0.1);
    border: 1px solid rgba(160, 218, 185, 0.3);
    border-radius: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
}

.oi-crosslink-arrow {
    color: var(--bm-aqua);
}

.oi-crosslink-link,
.oi-parent-link {
    color: var(--bm-aqua);
    text-decoration: underline;
    cursor: pointer;
    font-size: 12px;
    transition: color 0.15s ease;
}
.oi-crosslink-link:hover,
.oi-parent-link:hover {
    color: var(--bm-aqua-hover);
}

/* === Form inputs === */
.oi-input,
.oi-select {
    background: var(--bm-surface-alt);
    color: var(--bm-text);
    border: none;
    box-shadow: inset 0 0 0 1px var(--bm-text-dim);
    padding: 4px 8px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 11px;
    margin-left: 4px;
    outline: none;
    transition: box-shadow 0.15s ease;
}
.oi-input:focus,
.oi-select:focus {
    box-shadow: inset 0 0 0 1px var(--bm-text), 0 0 0 2px rgba(160, 218, 185, 0.45);
}

.oi-input--name { width: 150px; }
.oi-select      { width: 120px; }

/* === Transform editing === */
.oi-transform-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.oi-transform-label {
    color: var(--bm-text-muted);
    font-weight: 500;
    min-width: 60px;
}

.oi-transform-component {
    display: flex;
    align-items: center;
    gap: 4px;
}

.oi-axis-label {
    color: var(--bm-text-dim);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    min-width: 12px;
    cursor: ew-resize;
    user-select: none;
    padding: 2px 4px;
    border-radius: 2px;
}

.oi-axis-input {
    background: var(--bm-surface-alt);
    color: var(--bm-text);
    border: none;
    box-shadow: inset 0 0 0 1px var(--bm-text-dim);
    padding: 4px 6px;
    border-radius: 4px;
    font-family: var(--bm-font);
    font-size: 11px;
    width: 60px;
    text-align: right;
    outline: none;
    transition: box-shadow 0.15s ease;
}
.oi-axis-input:focus {
    box-shadow: inset 0 0 0 1px var(--bm-text), 0 0 0 2px rgba(160, 218, 185, 0.45);
}

/* === Config sliders === */
.oi-config-field { margin-bottom: 12px; }

.oi-config-label {
    color: var(--bm-text-muted);
    font-weight: 500;
    margin-bottom: 4px;
}

.oi-slider-row {
    display: flex;
    align-items: center;
    gap: 8px;
}

.oi-slider {
    flex: 1;
    cursor: pointer;
    accent-color: var(--bm-aqua);
}

.oi-slider-value {
    color: var(--bm-text);
    min-width: 60px;
    text-align: right;
    font-family: var(--bm-font);
}

/* === Physics section === */
.oi-physics-row {
    display: flex;
    margin-bottom: 4px;
    font-size: 11px;
}

.oi-physics-label {
    color: var(--bm-text-muted);
    min-width: 120px;
}

.oi-physics-value {
    color: var(--bm-text);
}

/* === Checkbox row === */
.oi-checkbox-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
}

.oi-checkbox {
    cursor: pointer;
    accent-color: var(--bm-aqua);
}

.oi-checkbox-label {
    color: var(--bm-text-muted);
    font-size: 11px;
    cursor: pointer;
}

/* === Advanced container === */
.oi-advanced-container { margin-top: 12px; }

/* === Remove Object button (destructive — Shocking Pink pill) === */
.oi-remove-btn {
    width: 100%;
    padding: 10px 20px;
    background: var(--bm-pink);
    color: var(--bm-text);
    border: none;
    border-radius: 9999px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.4px;
    cursor: pointer;
    transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.oi-remove-btn:hover {
    background: var(--bm-pink-hover);
    box-shadow: var(--bm-glow-pink);
    transform: scale(1.02);
}
.oi-remove-btn:active {
    background: #B3176D;
    transform: scale(0.99);
}
`;
