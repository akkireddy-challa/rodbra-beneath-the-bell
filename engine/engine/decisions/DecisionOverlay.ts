/**
 * A HUD panel showing what the decision model just decided and how sure it was:
 * one probability bar per option, the pick highlighted, the round trip's latency,
 * size and model id.
 *
 * It is opt-in and a developer surface — a player never needs it, but anyone
 * tuning a question does, because a probability that is nearly flat is the model
 * saying it is guessing. Turn it on with `?decisions=1`, or drive `setVisible`
 * from a key the game registers.
 *
 * The game owns the instance: it owns the loop, and only it knows when gameplay
 * has started and where the panel belongs.
 */

import { injectEditorStyles } from 'editor/editor-styles.js';
import type { IGameHUD, HUDAnchor } from 'engine/IGameHUD.js';
import type { DecisionLoopStats } from 'engine/decisions/DecisionLoop.js';
import type { DecisionSnapshot } from 'engine/decisions/DecisionSnapshot.js';
import {
    renderDecisionPanel,
    DECISION_PANEL_CSS,
    DECISION_PANEL_CSS_COMPACT,
    DEFAULT_DECISION_PANEL_OPTIONS,
    type DecisionPanelOptions,
} from 'engine/decisions/DecisionOverlayMarkup.js';

export interface DecisionOverlayOptions extends DecisionPanelOptions {
    /** Where the panel sits. */
    anchor: HUDAnchor;
    /** Mounted and drawn from the start, or waiting for `setVisible(true)`. */
    visible: boolean;
    /** Seconds between redraws. The markup lands in recordings; do not make this tiny. */
    refreshS: number;
}

export const DEFAULT_DECISION_OVERLAY_OPTIONS: DecisionOverlayOptions = {
    ...DEFAULT_DECISION_PANEL_OPTIONS,
    anchor: 'top-left',
    visible: false,
    refreshS: 0.15,
};

/**
 * What the panel reads. `DecisionLoop` satisfies it whatever its view and result
 * types are, so the overlay carries none of the game's generics.
 */
export interface DecisionReadout {
    snapshots(): readonly DecisionSnapshot[];
    stats(): DecisionLoopStats;
}

const PANEL_ID = 'bm-decisions';

/** `?decisions=1` in the page URL — works in the Creator frame and in `bitmagic dev`. */
export function decisionOverlayRequested(): boolean {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('decisions') === '1';
}

export class DecisionOverlay {
    private mounted = false;
    private visible: boolean;
    private sinceRefresh = 0;
    private readonly options: DecisionOverlayOptions;

    constructor(
        private readonly hud: IGameHUD,
        private readonly loop: DecisionReadout,
        options: DecisionOverlayOptions,
    ) {
        this.options = { ...options };
        this.visible = options.visible;
        injectEditorStyles();
    }

    /** Narrow (or widen) what the panel lists — see `DecisionPanelOptions.filter`. */
    setFilter(filter: DecisionOverlayOptions['filter']): void {
        this.options.filter = filter;
    }

    setVisible(visible: boolean): void {
        if (visible === this.visible) return;
        this.visible = visible;
        if (visible) this.mount();
        else this.unmount();
    }

    /** `deltaTime` in seconds. Cheap while hidden. */
    update(deltaTime: number): void {
        if (!this.visible) return;
        this.mount();
        this.sinceRefresh += deltaTime;
        if (this.sinceRefresh < this.options.refreshS) return;
        this.sinceRefresh = 0;
        this.hud.updateCustomElement(PANEL_ID, this.render());
    }

    private render(): string {
        return renderDecisionPanel(this.loop.snapshots(), this.loop.stats(), performance.now(), this.options);
    }

    private mount(): void {
        if (this.mounted) return;
        this.mounted = true;
        this.hud.createCustomElement(PANEL_ID, {
            anchor: this.options.anchor,
            css: this.options.compact ? DECISION_PANEL_CSS_COMPACT : DECISION_PANEL_CSS,
            html: this.render(),
            onUpdate: (container, value) => {
                if (typeof value === 'string') container.innerHTML = value;
            },
        });
    }

    private unmount(): void {
        if (!this.mounted) return;
        this.mounted = false;
        this.hud.removeElement(PANEL_ID);
    }

    dispose(): void {
        this.unmount();
        this.visible = false;
    }
}
