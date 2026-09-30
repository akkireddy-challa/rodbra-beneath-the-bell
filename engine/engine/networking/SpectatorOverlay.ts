import { BM } from 'editor/editor-styles.js';

const STYLE_ID = 'bm-spectator-styles';

/** Separate from gameplay HUD, so hiding weapon/health UI cannot hide spectating. */
export class SpectatorOverlay {
    readonly element = document.createElement('div');
    private readonly label = document.createElement('div');
    private readonly status = document.createElement('div');
    private readonly previous = document.createElement('button');
    private readonly next = document.createElement('button');

    constructor(onCycle: (direction: number) => void) {
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = `
.bm-spectator { position: fixed; bottom: max(24px, env(safe-area-inset-bottom)); left: 50%;
 transform: translateX(-50%); z-index: 101; width: max-content; max-width: calc(100vw - 32px); box-sizing: border-box;
 background: ${BM.surface}; color: ${BM.textPrimary}; border-radius: 12px; padding: 16px;
 font: 400 14px/1.5 ${BM.font}; text-align: center; box-shadow: ${BM.shadowDialog}; }
.bm-spectator[hidden] { display: none; }
.bm-spectator-label { font-size: 16px; font-weight: 700; overflow-wrap: anywhere; }
.bm-spectator-status { color: ${BM.textMuted}; min-height: 24px; }
.bm-spectator-controls { display: flex; gap: 12px; justify-content: center; margin-top: 8px; }
.bm-spectator button { background: ${BM.surfaceAlt}; color: ${BM.textPrimary}; border: 1px solid ${BM.border};
 border-radius: 9999px; padding: 12px 16px; min-height: 44px; font: 700 14px/1 ${BM.font};
 letter-spacing: 1.4px; text-transform: uppercase; touch-action: manipulation; cursor: pointer; white-space: nowrap; }
.bm-spectator button:hover, .bm-spectator button:focus-visible { outline: 2px solid ${BM.aqua}; }
.bm-spectator button:disabled { color: ${BM.textDim}; cursor: default; }
`;
            document.head.appendChild(style);
        }
        this.element.className = 'bm-spectator';
        this.element.hidden = true;
        this.element.setAttribute('aria-label', 'Spectator controls');
        this.label.className = 'bm-spectator-label';
        this.label.setAttribute('role', 'status');
        this.status.className = 'bm-spectator-status';
        this.previous.type = this.next.type = 'button';
        this.previous.textContent = '← Previous';
        this.next.textContent = 'Next →';
        this.previous.onclick = () => onCycle(-1);
        this.next.onclick = () => onCycle(1);
        const controls = document.createElement('div');
        controls.className = 'bm-spectator-controls';
        controls.append(this.previous, this.next);
        this.element.append(this.label, this.status, controls);
        // Do not let UI presses bubble to gameplay/camera handlers.
        for (const name of ['pointerdown', 'mousedown', 'touchstart', 'click']) {
            this.element.addEventListener(name, event => event.stopPropagation());
        }
        document.body.appendChild(this.element);
    }

    render(name: string | null, count: number, respawnSeconds: number | null, deathDelay: boolean): void {
        this.label.textContent = deathDelay ? 'You died' : name ? `Spectating ${name}` : 'Waiting for players';
        this.previous.disabled = this.next.disabled = count < 2 || deathDelay;
        this.status.textContent = respawnSeconds !== null && Number.isFinite(respawnSeconds)
            ? `Respawn in ${Math.max(0, Math.ceil(respawnSeconds))}s`
            : '← / → or gamepad bumpers to switch';
    }

    dispose(): void { this.element.remove(); }
}
