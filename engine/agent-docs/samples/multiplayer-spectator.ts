import type * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { PlayerController } from 'engine/PlayerController.js';
import {
    MultiplayerSetup, MultiplayerSpectator, DEFAULT_MULTIPLAYER_SPECTATOR_OPTIONS,
} from 'engine/networking/index.js';

/** One optional death flow per game. Construct after the player and camera load. */
export function createMultiplayerDeathFlow(
    engine: EngineLike,
    player: THREE.Object3D,
    playerController: PlayerController,
    gameId: string,
    weaponHud: HTMLElement,
    canWatchPlayer: (playerId: string) => boolean,
) {
    const multiplayer = new MultiplayerSetup({ engine, player, playerController });
    const spectator = new MultiplayerSpectator({
        engine, multiplayer, playerController,
        getGameplayCamera: () => playerController.getCameraController(),
    }, {
        ...DEFAULT_MULTIPLAYER_SPECTATOR_OPTIONS,
        gameplayHud: [weaponHud],
        // Team games resolve this from their actual team/round state, not character tint.
        canSpectate: canWatchPlayer,
    });
    multiplayer.showLobby(gameId);
    return {
        multiplayer,
        spectator,
        // Call after the normal player and camera update. Continue simulation while dead.
        update(deltaTime: number): void {
            multiplayer.update(deltaTime);
            spectator.update(deltaTime);
        },
        // Call when the game's respawn timer or next round permits it. Coordinates are feet positions.
        respawn(position: THREE.Vector3): void { spectator.respawn(position); },
        dispose(): void {
            spectator.dispose();
            multiplayer.dispose();
        },
    };
}
