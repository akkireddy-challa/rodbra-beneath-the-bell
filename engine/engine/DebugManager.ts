import type { EngineLike } from 'types/game.js';

/**
 * True when a text field owns the keyboard. Single-letter debug keys must not
 * fire while the user is typing — the creator's prompt box sits in the parent
 * document, but an in-game HUD input would be here.
 */
function isTextEntryFocused(): boolean {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true;
}

interface DebugCallbacks {
    onSpawnTestObjects?: () => void;
    onTestPlacement?: () => void;
    onToggleFlyingMovement?: () => void;
    onToggleDebugInfo?: () => void;
    /** Debug perf A/B: freeze and hide every NPC/animal (see GameEngine.setDebugDisableNpcs). */
    onToggleNpcs?: () => void;
    onTakeScreenshot?: () => void;
}

/**
 * DebugManager handles debug-only functionality that should not be in production.
 * This is in the engine folder so templates can access it.
 *
 * Debug features include:
 * - Debug key bindings (F5-F8, backtick, etc.)
 * - Debug state flags
 * - Debug spawning utilities
 *
 * NOTE: Editor functionality (F2 toggle, scene editing) is in editor/EditorManager.ts
 */
export class DebugManager {
    private engine: EngineLike;
    private isDebugEnabled: boolean = true;
    private debugInfoVisible: boolean = false;
    private callbacks: DebugCallbacks = {};

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    enableDebug(): void {
        this.isDebugEnabled = true;
    }

    disableDebug(): void {
        this.isDebugEnabled = false;
    }

    isDebugActive(): boolean {
        return this.isDebugEnabled;
    }

    setCallbacks(callbacks: DebugCallbacks): void {
        this.callbacks = { ...callbacks };
    }

    /**
     * Handle debug key events. Returns true if the key was handled.
     */
    onKeyDown(event: KeyboardEvent): boolean {
        if (!this.isDebugEnabled) return false;

        switch (event.code) {
            case 'F5':
                event.preventDefault();
                this.callbacks.onTestPlacement?.();
                return true;

            case 'F6':
                event.preventDefault();
                this.callbacks.onToggleFlyingMovement?.();
                return true;

            case 'F7':
                event.preventDefault();
                this.callbacks.onSpawnTestObjects?.();
                return true;

            case 'Backquote':
                event.preventDefault();
                this.debugInfoVisible = !this.debugInfoVisible;
                this.callbacks.onToggleDebugInfo?.();
                return true;

            case 'KeyN':
                // Perf A/B toggle. A KEY rather than a panel checkbox because
                // gameplay holds pointer lock — clicking the checkbox means
                // alt-tabbing out, which perturbs the very frame rate being
                // measured. Ignore it while a text field has focus so typing an
                // 'n' into the creator prompt does not silently freeze the NPCs.
                if (isTextEntryFocused()) return false;
                event.preventDefault();
                this.callbacks.onToggleNpcs?.();
                return true;

            case 'F8':
                event.preventDefault();
                this.callbacks.onTakeScreenshot?.();
                return true;
        }

        return false;
    }

    isDebugInfoVisible(): boolean {
        return this.debugInfoVisible;
    }

    setDebugInfoVisible(visible: boolean): void {
        this.debugInfoVisible = visible;
    }

    dispose(): void {
        this.callbacks = {};
    }
}
