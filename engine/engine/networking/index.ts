// Networking module — Photon-like multiplayer for the game engine
//
// The lobby UI is MANDATORY and always shows two views:
//   1. Name input — player must enter a display name
//   2. Room browser — player creates or joins a room
//
// CRITICAL: Remote players MUST use NetworkCharacterController — NEVER use capsules or placeholders.
//
// USAGE EXAMPLE:
//
//   import { NetworkManager, NetworkObject, NetworkCharacterController } from 'engine/networking/index.js';
//   import type { StateMessage } from 'engine/networking/index.js';
//   import { getDefaultCharacterUrl } from 'engine/CharacterConfig.js';
//   import { buildAnimationList } from 'engine/AnimationPacks.js';
//
//   const net = new NetworkManager();
//   net.onStateChanged = (state) => {
//       if (state === 'connected') onMultiplayerConnected();
//   };
//
//   // Spawn remote players as full animated block characters:
//   net.onUnknownObject = async (senderId, networkId, state) => {
//       const remoteChar = await NetworkCharacterController.create({
//           engine, networkId, initialState: state,
//           playerName: state.playerName ?? 'Player',
//           characterUrl: getDefaultCharacterUrl(),
//           blockCharacterFactory: engine.blockCharacterFactory!,
//           baseAnimations: buildAnimationList(),
//       });
//       net.registerObject(remoteChar.getNetworkObject());
//   };
//   net.events.onPlayerLeft = (playerId) => { remoteChar.dispose(); };
//
//   // Show lobby (name input → room browser) — MANDATORY, always last in setup
//   net.showLobby(gameId, container, (playerName) => {
//       localPlayerName = playerName;
//   });
//
//   // Register local player with animation + weapon sync:
//   const animCtrl = playerLoader.getAnimationController();
//   const playerNetObj = new NetworkObject(player, id, true, {
//       speedGetter: () => velocity.length(),
//       playerName: localPlayerName,
//       animationProvider: animCtrl ? {
//           getAnimationState: () => animCtrl.getCurrentState(),
//           getAttackId: () => animCtrl.getIsAttacking() ? 'attack' : null,
//           getCustomAnimId: () => null,
//           // Weapon sync (remote characters auto-equip matching weapon):
//           getEquippedWeaponId: () => this.currentWeaponId,  // "melee:sword" or "ranged:pistol"
//           getWeaponAimYaw: () => this.weaponAimYaw,         // ranged only
//           getWeaponAimPitch: () => this.weaponAimPitch,     // ranged only
//       } : undefined,
//   });
//
//   // Every frame:
//   net.update(deltaTime);
//   remoteChar.update(deltaTime);  // updates animation + block character + name label
//
//   // Cleanup:
//   net.disconnect();

export { NetworkManager } from 'engine/networking/NetworkManager.js';
export { NetworkObject } from 'engine/networking/NetworkObject.js';
export { NetworkEvents } from 'engine/networking/NetworkEvents.js';
export { NetworkInterpolation } from 'engine/networking/NetworkInterpolation.js';
export { NetworkAnimationSync } from 'engine/networking/NetworkAnimationSync.js';
export { NetworkCharacterController } from 'engine/networking/NetworkCharacterController.js';
export type { NetworkCharacterCreateParams } from 'engine/networking/NetworkCharacterController.js';
export { NetworkVehicleController } from 'engine/networking/NetworkVehicleController.js';
export type { NetworkVehicleCreateParams } from 'engine/networking/NetworkVehicleController.js';
export { NetworkAnimalController } from 'engine/networking/NetworkAnimalController.js';
export type { NetworkAnimalCreateParams } from 'engine/networking/NetworkAnimalController.js';
export { MultiplayerSetup } from 'engine/networking/MultiplayerSetup.js';
export type { MultiplayerSetupOptions, ExplosionEvent } from 'engine/networking/MultiplayerSetup.js';
export { MultiplayerSpectator, DEFAULT_MULTIPLAYER_SPECTATOR_OPTIONS } from 'engine/networking/MultiplayerSpectator.js';
export type { MultiplayerSpectatorOptions, MultiplayerSpectatorDependencies } from 'engine/networking/MultiplayerSpectator.js';
export type { SpectatorGameplayCamera } from 'engine/networking/SpectatorCamera.js';
export { PlayerAppearanceSync, DEFAULT_TEAM_COLORS } from 'engine/networking/PlayerAppearanceSync.js';
export type {
    PlayerAppearance,
    PlayerAppearanceSyncOptions,
    AppearanceChoice,
    AppearancePickerOptions,
    TintableCharacter,
} from 'engine/networking/PlayerAppearanceSync.js';
export { BlancoMultiplayerSetup } from 'engine/networking/BlancoMultiplayerSetup.js';
export type { BlancoMultiplayerSetupOptions } from 'engine/networking/BlancoMultiplayerSetup.js';
export { NetworkRoomOwnership } from 'engine/networking/NetworkRoomOwnership.js';
export { NetworkLobbyUI } from 'engine/networking/NetworkLobbyUI.js';
export type { LobbyOptions } from 'engine/networking/NetworkLobbyUI.js';
export { createNameLabelSprite } from 'engine/networking/NetworkUtils.js';
export type {
    NetworkState,
    PlayerLifeState,
    PlayerLifeSnapshot,
    NetworkMessage,
    StateMessage,
    JoinMessage,
    LeaveMessage,
    PingMessage,
    EventMessage,
    RoomInfo,
    RemotePlayerInfo,
    NetworkObjectOptions,
    ShootData,
    AnimationStateProvider,
    AnimationStateReceiver,
    WeaponStateReceiver,
    VehicleDescriptor,
} from 'engine/networking/NetworkTypes.js';
export {
    ACTIVE_SYNC_INTERVAL,
    IDLE_SYNC_INTERVAL,
    PING_INTERVAL,
    STALE_TIMEOUT,
} from 'engine/networking/NetworkTypes.js';
