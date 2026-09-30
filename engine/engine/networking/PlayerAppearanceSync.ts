/**
 * PlayerAppearanceSync: opt-in helper for per-player multiplayer appearance
 * customization (team colours, chosen tints, etc.).
 *
 * Wires the *end-to-end* flow that games otherwise hand-build every time:
 *   1. Store the local player's chosen appearance (the player's "customData").
 *   2. Tint the local player's character to match.
 *   3. Broadcast the choice so every other client recolours this player.
 *   4. Apply each remote player's choice when their character is created, and
 *      re-broadcast the local choice so late joiners learn it too.
 *
 * The recolor primitive already exists — `NetworkCharacterController.tintBodyPart()`
 * for remote players and `BlockCharacterRenderer.tintBodyPart()` for the local
 * player. This helper just owns the network plumbing around it.
 *
 * Strictly opt-in: a helper templates *call into*. Nothing in MultiplayerSetup
 * or any genre baseline references it.
 *
 * USAGE (in a multiplayer game template, after the player + MultiplayerSetup exist):
 *
 *   import { PlayerAppearanceSync, DEFAULT_TEAM_COLORS } from 'engine/networking/index.js';
 *
 *   // 1. (optional) Ask the player to pick before the match:
 *   const appearance = await PlayerAppearanceSync.pickAppearance(this.engine.container, {
 *       title: 'Choose your team colour',
 *       partName: 'torso',
 *       choices: DEFAULT_TEAM_COLORS,
 *   });
 *
 *   // 2. Create the sync helper (after connecting):
 *   this.appearanceSync = new PlayerAppearanceSync({
 *       multiplayer:    this.multiplayer,
 *       localCharacter: this.playerLoader.getBlockCharacterRenderer()!, // anything with tintBodyPart()
 *       appearance,
 *   });
 *
 *   // 3. Forward remote-player creation to the helper:
 *   //    new MultiplayerSetup({ ..., onRemotePlayerCreated: (id, char) =>
 *   //        this.appearanceSync?.handleRemotePlayerCreated(id, char) })
 *
 *   // 4. Clean up:
 *   this.appearanceSync?.dispose();
 */

import { injectHudBaseStyles } from 'engine/hud/index.js';
import type { MultiplayerSetup } from 'engine/networking/MultiplayerSetup.js';
import type { NetworkCharacterController } from 'engine/networking/NetworkCharacterController.js';

/** The custom network event name used to broadcast appearance choices. */
const APPEARANCE_EVENT = '_playerAppearance';

/** A per-player appearance choice — which body part to recolour and to what colour. */
export interface PlayerAppearance {
    /** Body part to recolour (e.g. 'torso', 'head'). See character-system.md for valid names. */
    partName: string;
    /** Hex colour (e.g. 0xff0000). */
    color: number;
}

/** A selectable colour in the pre-game picker. */
export interface AppearanceChoice {
    /** Label shown under the swatch (e.g. 'Red Team'). */
    label: string;
    /** Hex colour applied when chosen. */
    color: number;
}

/** Options for the optional lightweight pre-game picker. */
export interface AppearancePickerOptions {
    /** Heading shown above the swatches. */
    title: string;
    /** Body part each choice recolours. */
    partName: string;
    /** Selectable colours. */
    choices: AppearanceChoice[];
}

/** Anything that can recolour a named body part — both the local player's
 *  BlockCharacterRenderer and remote NetworkCharacterControllers qualify. */
export interface TintableCharacter {
    tintBodyPart(name: string, color: number): boolean;
}

export interface PlayerAppearanceSyncOptions {
    /** The active multiplayer session. */
    multiplayer: MultiplayerSetup;
    /**
     * The local player's recolourable character. Pass anything exposing
     * `tintBodyPart(name, color)` — typically `playerLoader.getBlockCharacterRenderer()`.
     */
    localCharacter: TintableCharacter;
    /**
     * The local player's chosen appearance, or `null` to set it later via
     * `setAppearance()` (e.g. when a template UI resolves the choice).
     */
    appearance: PlayerAppearance | null;
}

/** A sensible default team-colour palette for `pickAppearance()`. */
export const DEFAULT_TEAM_COLORS: AppearanceChoice[] = [
    { label: 'Red', color: 0xe23b3b },
    { label: 'Blue', color: 0x3b6fe2 },
    { label: 'Green', color: 0x3bbf4f },
    { label: 'Yellow', color: 0xe2c93b },
];

/**
 * Synchronises per-player appearance choices across a multiplayer session.
 * See the file header for the full flow and usage.
 */
export class PlayerAppearanceSync {
    private readonly multiplayer: MultiplayerSetup;
    private readonly localCharacter: TintableCharacter;
    private localAppearance: PlayerAppearance | null;

    /** Last known appearance per remote senderId — applied when their character appears. */
    private readonly remoteAppearances: Map<string, PlayerAppearance> = new Map();

    private readonly onAppearanceEvent: (senderId: string, data: Record<string, unknown>) => void;
    private disposed = false;

    constructor(options: PlayerAppearanceSyncOptions) {
        this.multiplayer = options.multiplayer;
        this.localCharacter = options.localCharacter;
        this.localAppearance = options.appearance;

        // Receive remote players' appearance choices and apply them to their characters.
        this.onAppearanceEvent = (senderId, data) => {
            const appearance = PlayerAppearanceSync.parseAppearance(data);
            if (!appearance) return;
            this.remoteAppearances.set(senderId, appearance);
            this.applyToRemote(senderId, appearance);
        };
        this.multiplayer.networkManager.events.on(APPEARANCE_EVENT, this.onAppearanceEvent);

        // Apply + announce any appearance supplied up front (both are no-ops if none).
        this.syncLocal();
    }

    /**
     * Set (or change) the local player's appearance: tint the local character
     * and broadcast the choice to every other client.
     */
    setAppearance(appearance: PlayerAppearance): void {
        this.localAppearance = appearance;
        this.syncLocal();
    }

    /** The local player's current appearance, or `null` if none chosen yet. */
    getAppearance(): PlayerAppearance | null {
        return this.localAppearance;
    }

    /**
     * Call from `MultiplayerSetup`'s `onRemotePlayerCreated` callback. Applies the
     * remote player's known appearance to their freshly-created character, and
     * re-broadcasts the local choice so the newcomer learns it.
     */
    handleRemotePlayerCreated(senderId: string, character: NetworkCharacterController): void {
        const known = this.remoteAppearances.get(senderId);
        if (known) {
            character.tintBodyPart(known.partName, known.color);
        }
        // A new player just appeared — re-announce our colour so they apply it.
        this.broadcast();
    }

    /** Remove the network listener. Call from the template's `dispose()`. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.multiplayer.networkManager.events.off(APPEARANCE_EVENT, this.onAppearanceEvent);
        this.remoteAppearances.clear();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /** Tint the local character and announce the choice to other clients. */
    private syncLocal(): void {
        this.applyLocal();
        this.broadcast();
    }

    private applyLocal(): void {
        if (this.localAppearance) {
            this.localCharacter.tintBodyPart(this.localAppearance.partName, this.localAppearance.color);
        }
    }

    private broadcast(): void {
        if (this.disposed || !this.localAppearance) return;
        this.multiplayer.networkManager.sendEvent(APPEARANCE_EVENT, { ...this.localAppearance });
    }

    /** Apply an appearance to every remote character owned by `senderId`. */
    private applyToRemote(senderId: string, appearance: PlayerAppearance): void {
        for (const [networkId, char] of this.multiplayer.remoteCharacters) {
            // networkId format is "<senderId>:<objectType>" (e.g. "abc123:player").
            if (networkId.startsWith(senderId + ':')) {
                char.tintBodyPart(appearance.partName, appearance.color);
            }
        }
    }

    private static parseAppearance(data: Record<string, unknown>): PlayerAppearance | null {
        const partName = data['partName'];
        const color = data['color'];
        if (typeof partName !== 'string' || typeof color !== 'number') return null;
        return { partName, color };
    }

    // ------------------------------------------------------------------
    // Optional pre-game picker
    // ------------------------------------------------------------------

    /**
     * Show a lightweight full-screen colour picker and resolve with the chosen
     * appearance. Reuses the lobby's theme classes so it matches the lobby UI.
     *
     * Templates that build their own picker UI can skip this entirely and pass
     * the chosen `PlayerAppearance` straight to the constructor / `setAppearance()`.
     */
    static pickAppearance(container: HTMLElement, options: AppearancePickerOptions): Promise<PlayerAppearance> {
        injectHudBaseStyles();

        return new Promise<PlayerAppearance>((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'hud-lobby-overlay';
            container.appendChild(overlay);
            requestAnimationFrame(() => { overlay.dataset.visible = 'true'; });

            const panel = document.createElement('div');
            panel.className = 'hud-lobby-panel';
            overlay.appendChild(panel);

            const title = document.createElement('h2');
            title.className = 'hud-lobby-title';
            title.textContent = options.title;
            panel.appendChild(title);

            const swatches = document.createElement('div');
            swatches.className = 'hud-appearance-swatches';
            panel.appendChild(swatches);

            for (const choice of options.choices) {
                const button = document.createElement('button');
                button.className = 'hud-lobby-button hud-appearance-swatch';
                // Per-swatch colour is dynamic data, not a theme value — inline is correct here.
                button.style.setProperty('--swatch-color', '#' + choice.color.toString(16).padStart(6, '0'));
                button.textContent = choice.label;
                button.addEventListener('click', () => {
                    overlay.remove();
                    resolve({ partName: options.partName, color: choice.color });
                });
                swatches.appendChild(button);
            }
        });
    }
}
