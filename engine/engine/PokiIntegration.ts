/** Shared Poki lifecycle adapter. Inert when the export did not include the SDK. */
import * as THREE from 'three';
import { GameState, type GameStateChangeListener } from 'engine/GameStateManager.js';

interface PokiSDKInterface {
    init(): Promise<void>;
    gameLoadingStart?(): void;
    gameLoadingFinished(): void;
    gameplayStart(): void;
    gameplayStop(): void;
    commercialBreak(): Promise<void>;
    setDebug(enabled: boolean): void;
}

declare global {
    interface Window { PokiSDK?: PokiSDKInterface; }
}

export type CameraGetter = () => THREE.Camera | null;

/** Input the advertisement must swallow, so a click on the ad never also reaches the game. */
const BLOCKED_INPUT_EVENTS = ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click', 'touchstart', 'touchend'];

export class PokiIntegration {
    private sdk: PokiSDKInterface | null = null;
    private initPromise: Promise<void> | null = null;
    private getCamera: CameraGetter | null = null;
    private playing = false;
    private hasPlayed = false;
    private loadingFinished = false;
    private breakPromise: Promise<void> | null = null;

    constructor() {
        this.sdk = window.PokiSDK ?? null;
    }

    setCameraGetter(getter: CameraGetter): void { this.getCamera = getter; }

    init(): Promise<void> {
        if (!this.sdk) return Promise.resolve();
        if (!this.initPromise) {
            // SDK/ad blocking is a supported runtime condition. Catch sync throws as well, and
            // own the rejection even when callers intentionally do not await initialization.
            this.initPromise = Promise.resolve().then(() => this.sdk?.init()).then(() => undefined)
                .catch(() => { this.sdk = null; });
        }
        return this.initPromise;
    }

    /** Used by the state manager before committing PLAYING. No SDK preserves synchronous starts. */
    beforePlaying(resume: () => void): void {
        if (!this.sdk) { resume(); return; }
        void this.init().then(async () => {
            if (this.sdk && this.hasPlayed) {
                if (!this.breakPromise) {
                    this.breakPromise = this.commercialBreak().finally(() => { this.breakPromise = null; });
                }
                await this.breakPromise;
            }
            resume();
        });
    }

    createStateListener(): GameStateChangeListener {
        return (state) => {
            if (!this.sdk) return;
            void this.init().then(() => {
                const sdk = this.sdk;
                if (!sdk) return;
                if (state === GameState.PLAYING) {
                    this.finishLoading();
                    if (!this.playing) {
                        this.playing = true;
                        this.hasPlayed = true;
                        sdk.gameplayStart();
                    }
                } else {
                    if (this.playing) { this.playing = false; sdk.gameplayStop(); }
                    // A reset can start loading while the SDK still owns the ad. No lifecycle
                    // events may be sent during it; loading-start is an optional legacy signal.
                    if (state === GameState.LOADING && !this.breakPromise) sdk.gameLoadingStart?.();
                    if (state === GameState.MENU || state === GameState.READY) this.finishLoading();
                }
            });
        };
    }

    private finishLoading(): void {
        if (this.loadingFinished || !this.sdk) return;
        this.loadingFinished = true;
        this.sdk.gameLoadingFinished();
    }

    private async commercialBreak(): Promise<void> {
        const listener = this.getCamera?.()?.children.find(
            (child): child is THREE.AudioListener => child instanceof THREE.AudioListener,
        );
        const volume = listener?.getMasterVolume();
        const block = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
        for (const event of BLOCKED_INPUT_EVENTS) window.addEventListener(event, block, { capture: true, passive: false });
        listener?.setMasterVolume(0);
        try {
            await this.sdk?.commercialBreak();
        } catch {
            // No-fill and ad-blocked breaks resume gameplay just like completed advertisements.
        } finally {
            for (const event of BLOCKED_INPUT_EVENTS) window.removeEventListener(event, block, true);
            if (volume !== undefined) listener?.setMasterVolume(volume);
        }
    }
}
