// Game state management system
import { getGameEventLog } from 'engine/recording/GameEventLog.js';

export enum GameState {
    MENU = 'menu',
    LOADING = 'loading',
    READY = 'ready',
    PLAYING = 'playing',
    PAUSED = 'paused',
    END = 'end'
}

export type GameStateChangeListener = (newState: GameState, oldState: GameState) => void;
export type ReadyMode = 'menu' | 'editor-preview';
export type PauseReason = 'editor-tab' | 'manual' | 'interactive-ui' | 'system' | 'pointer-lock';

export class GameStateManager {
    private currentState: GameState;
    private listeners: GameStateChangeListener[] = [];
    private hasStartedGameplay = false;
    private readyMode: ReadyMode = 'menu';
    private pauseReasons = new Set<PauseReason>();
    private currentTab: string | null = null;
    private playingRequest = 0;
    private waitingForPlaying = false;

    constructor(
        initialState: GameState = GameState.MENU,
        private readonly beforePlaying?: (resume: () => void) => void,
    ) {
        this.currentState = initialState;
    }

    getCurrentState(): GameState {
        return this.currentState;
    }

    getReadyMode(): ReadyMode {
        return this.readyMode;
    }

    getCurrentTab(): string | null {
        return this.currentTab;
    }

    setCurrentTab(tab: string | null): void {
        this.currentTab = tab;
    }

    hasStarted(): boolean {
        return this.hasStartedGameplay;
    }

    isWaitingForPlayerStart(): boolean {
        return !this.hasStartedGameplay && (this.currentState === GameState.MENU || this.currentState === GameState.READY);
    }

    setState(newState: GameState): void {
        if (newState !== GameState.PLAYING) {
            this.cancelPendingPlaying();
        }
        if (this.currentState === newState) {
            return; // No change
        }

        if (newState === GameState.PLAYING && this.beforePlaying) {
            if (this.waitingForPlaying) return;
            this.waitingForPlaying = true;
            const request = ++this.playingRequest;
            this.beforePlaying(() => {
                // A load, end, or another pause can supersede an outstanding advertisement.
                if (!this.waitingForPlaying || request !== this.playingRequest) return;
                this.waitingForPlaying = false;
                this.commitState(GameState.PLAYING);
            });
            return;
        }
        this.commitState(newState);
    }

    /** Invalidate any outstanding `beforePlaying` resume, so a late callback cannot commit PLAYING. */
    private cancelPendingPlaying(): void {
        this.playingRequest++;
        this.waitingForPlaying = false;
    }

    private commitState(newState: GameState): void {
        const oldState = this.currentState;
        this.currentState = newState;

        console.log(`🎮 Game state changed: ${oldState} → ${newState}`);
        // Trailer timeline: lets the composer trim menu/pause stretches.
        getGameEventLog().logEvent({ type: 'state', data: { from: oldState, to: newState } });

        for (const listener of this.listeners) {
            try {
                listener(newState, oldState);
            } catch (error) {
                console.error('Error in game state listener:', error);
            }
        }
    }

    isState(state: GameState): boolean {
        return this.currentState === state;
    }

    transitionToLoading(): void {
        this.pauseReasons.clear();
        this.setState(GameState.LOADING);
    }

    transitionToMenu(): void {
        this.readyMode = 'menu';
        this.pauseReasons.clear();
        this.setState(GameState.MENU);
    }

    transitionToReady(mode: ReadyMode): void {
        this.readyMode = mode;
        this.pauseReasons.clear();
        this.setState(mode === 'menu' ? GameState.MENU : GameState.READY);
    }

    markPlaying(): void {
        this.hasStartedGameplay = true;
        this.pauseReasons.clear();
        this.setState(GameState.PLAYING);
    }

    setPaused(paused: boolean, reason: PauseReason = 'manual'): void {
        if (!this.hasStartedGameplay) {
            return;
        }

        if (paused) {
            this.pauseReasons.add(reason);
        } else {
            this.pauseReasons.delete(reason);
        }

        this.setState(this.pauseReasons.size > 0 ? GameState.PAUSED : GameState.PLAYING);
    }

    /** Clear all pause reasons — used by the manual Unpause button to force-resume regardless of stacked reasons. */
    forceUnpause(): void {
        this.pauseReasons.clear();
    }

    /** Read-only view of the active pause reasons. Used by PauseScreen to render only on user-initiated pauses. */
    getPauseReasons(): ReadonlySet<PauseReason> {
        return this.pauseReasons;
    }

    /**
     * @internal — call `engine.endGame()` instead.
     *
     * This is the low-level state-machine primitive (kept for symmetry with
     * `transitionToMenu` / `transitionToLoading`). It only flips the state.
     * It does NOT render the end-game overlay, release pointer lock, suppress
     * the engine's click-to-play affordance, or wire the Replay button —
     * skipping any of those produces broken UX (frozen sim with no way to
     * resume). `engine.endGame()` does all of it in one call.
     */
    transitionToEnd(): void {
        this.pauseReasons.clear();
        this.setState(GameState.END);
    }

    resetForNewSession(initialState: GameState = GameState.MENU): void {
        this.cancelPendingPlaying();
        this.hasStartedGameplay = false;
        this.readyMode = 'menu';
        this.pauseReasons.clear();
        this.currentTab = null;
        this.currentState = initialState;
    }

    addListener(listener: GameStateChangeListener): void {
        this.listeners.push(listener);
    }

    removeListener(listener: GameStateChangeListener): void {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
            this.listeners.splice(index, 1);
        }
    }

    clearListeners(): void {
        this.listeners = [];
    }
}

// Singleton instance
let gameStateManager: GameStateManager | null = null;

export function getGameStateManager(): GameStateManager {
    if (!gameStateManager) {
        gameStateManager = new GameStateManager();
    }
    return gameStateManager;
}

export function setGameStateManager(manager: GameStateManager): void {
    gameStateManager = manager;
}

export function resetGameStateManager(): void {
    gameStateManager = null;
}
