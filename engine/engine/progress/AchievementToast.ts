/**
 * AchievementToast — the in-game "achievement unlocked" popup.
 *
 * ENGINE-OWNED ON PURPOSE. The first version routed this through
 * `genreModule.hud.showToast()`, but `hud` is OPTIONAL on GenreGameInterface, so
 * in any genre that does not expose one the unlock silently showed nothing —
 * players earned achievements with no feedback at all. Unlocking is an engine
 * feature, so its notification cannot depend on a genre hook: this renders
 * straight into `document.body` and works in every game, published ones included.
 *
 * Shows the achievement's generated art, its name, and what it is worth. Toasts
 * QUEUE rather than replace: unlocking two things at once is common (a kill that
 * completes two goals), and the single-slot `InGameNotification` banner would
 * have shown only the last one.
 */

import { injectHudBaseStyles } from 'engine/hud/index.js';

/** What the toast needs to render one unlock. */
export interface AchievementToastEntry {
    name: string;
    /** Generated artwork; omitted/null renders the fallback mark instead. */
    imageUrl?: string | null;
    /** XP the achievement is worth; omitted/0 hides the XP line. */
    xp?: number;
}

/** How long a single toast stays on screen before the next one shows. */
export const ACHIEVEMENT_TOAST_MS = 4200;

const STYLE_ID = 'bm-achievement-toast-styles';

const CSS = `
.bm-achievement-toast {
  position: fixed;
  left: 50%;
  bottom: 12%;
  transform: translate(-50%, 16px);
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: min(420px, 86vw);
  padding: 10px 16px 10px 10px;
  border-radius: var(--hud-radius-card, 12px);
  background: color-mix(in srgb, var(--hud-color-surface, #0c0c10) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 18%, transparent);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  color: var(--hud-color-text, #ffffff);
  font-family: var(--hud-font-family, system-ui, sans-serif);
  opacity: 0;
  transition: opacity 220ms ease, transform 220ms ease;
  pointer-events: none;
  z-index: 2147483000;
}
.bm-achievement-toast[data-visible='true'] {
  opacity: 1;
  transform: translate(-50%, 0);
}
.bm-achievement-toast__art {
  width: 56px;
  height: 56px;
  flex: 0 0 auto;
  border-radius: 8px;
  object-fit: cover;
  background: rgba(255, 255, 255, 0.08);
}
.bm-achievement-toast__art--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  opacity: 0.5;
}
.bm-achievement-toast__text { min-width: 0; }
.bm-achievement-toast__label {
  font-size: 11px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  opacity: 0.72;
}
.bm-achievement-toast__name {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bm-achievement-toast__xp {
  font-size: 12px;
  font-weight: 600;
  color: var(--hud-color-primary, #7cf3d8);
}
`;

function injectStyles(): void {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

/** Escape untrusted text (creator-authored names) before it reaches innerHTML. */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Build the toast's inner markup. PURE so the escaping and the
 * art/XP fallbacks are unit-testable without a DOM.
 */
export function buildToastHtml(entry: AchievementToastEntry): string {
    const art = entry.imageUrl
        ? `<img class="bm-achievement-toast__art" src="${escapeHtml(entry.imageUrl)}" alt="">`
        : `<div class="bm-achievement-toast__art bm-achievement-toast__art--empty">?</div>`;
    const xp = typeof entry.xp === 'number' && entry.xp > 0
        ? `<div class="bm-achievement-toast__xp">+${Math.floor(entry.xp)} XP</div>`
        : '';
    return (
        `${art}<div class="bm-achievement-toast__text">` +
        `<div class="bm-achievement-toast__label">Achievement unlocked</div>` +
        `<div class="bm-achievement-toast__name">${escapeHtml(entry.name)}</div>` +
        `${xp}</div>`
    );
}

export class AchievementToast {
    private element: HTMLDivElement | null = null;
    private readonly queue: AchievementToastEntry[] = [];
    private showing = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    /** Enqueue one unlock. Safe to call before/without a DOM (no-ops). */
    show(entry: AchievementToastEntry): void {
        if (typeof document === 'undefined') return;
        this.queue.push(entry);
        if (!this.showing) this.next();
    }

    private next(): void {
        const entry = this.queue.shift();
        if (!entry) {
            this.showing = false;
            return;
        }
        this.showing = true;
        injectHudBaseStyles();
        injectStyles();

        if (!this.element) {
            this.element = document.createElement('div');
            this.element.className = 'bm-achievement-toast';
            document.body.appendChild(this.element);
        }
        this.element.innerHTML = buildToastHtml(entry);
        // Two-frame flip so the opacity transition has both sides to interpolate
        // (the InGameNotification precedent).
        requestAnimationFrame(() => {
            if (this.element) this.element.dataset.visible = 'true';
        });

        this.timer = setTimeout(() => {
            if (this.element) delete this.element.dataset.visible;
            this.timer = setTimeout(() => this.next(), 240);
        }, ACHIEVEMENT_TOAST_MS);
    }

    dispose(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.queue.length = 0;
        this.showing = false;
        this.element?.parentElement?.removeChild(this.element);
        this.element = null;
    }
}
