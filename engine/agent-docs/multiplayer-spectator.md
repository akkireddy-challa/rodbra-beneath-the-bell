# Spectating after death

`MultiplayerSpectator` is an opt-in helper for character-based `MultiplayerSetup` games.
It subscribes to `PlayerController` death without replacing `onPlayerDeath`, holds the
death view for one second, then follows a living remote player. Left/right arrows,
the previous/next buttons, and standard gamepad bumpers switch targets. Drag/touch
or pointer-lock mouse movement or the gamepad right stick orbit the camera.

Start from the compiled example `samples/multiplayer-spectator.ts`
(read with `@docs samples/multiplayer-spectator`).
Construct the helper before `showLobby`, then call `spectator.update(deltaTime)`
AFTER `multiplayer.update(deltaTime)` and the normal camera update each frame.
Dispose the spectator before the multiplayer setup and the player controller.

Spread `DEFAULT_MULTIPLAYER_SPECTATOR_OPTIONS` and override the game-specific values:

- `canSpectate(playerId)`: restrict team games to living teammates. The ID is a
  player ID, not the `playerId:player` key used by `remoteCharacters`. The default
  allows every living remote player. Character colour is not a team identifier.
- `gameplayHud`: weapon/health DOM elements to hide. Their previous `hidden` flags
  are restored when spectating ends. Keep scoreboard and end-screen elements separate.
- `onActiveChanged(active)`: gate custom weapon handlers, game-owned view models,
  interactions, and delayed attack callbacks. Check `spectator.isActive` before
  game-specific combat actions. The engine player controls, physics capsule,
  interaction prompts and engine view-model scene are handled automatically.
- `getRespawnSeconds()`: return the remaining time or `null` to omit a countdown.
- `isMatchOver()`: hide spectator controls when the match ends. The engine's pause
  and end states also hide controls and suppress spectator input.
- `deathDelaySeconds` and `distanceInHeights`: tune the death hold and camera framing.

The game owns respawn timing and match rules. Do not call game-over or pause the
engine on an individual multiplayer death. Keep player updates (for the death
ragdoll), remote updates, NPC simulation and host responsibilities running. A dead
host remains the host. When the game's timer or next round allows revival, call
`spectator.respawn(feetPosition)`. This clears the death ragdoll, releases any ride,
restores health, teleports with the terrain-collider hold, restores camera/input/HUD,
and publishes alive state. Omitting the position uses the player's initial spawn.
`PlayerController.reviveAt(feetPosition)` is also available independently. The older
`respawn()` method retains its existing fade/teleport behavior.

Dead or departed targets are skipped automatically. When no eligible player remains,
the camera holds its last shot and displays “Waiting for players”. It resumes following
when an eligible character arrives or revives. Custom match results take precedence.

Life state is included in periodic and forced join snapshots and flushed immediately
on transitions. Revisions reject delayed older life states. State is retained while
characters load, so late joins/deaths during GLB loading do not create living ghosts.
The camera follows interpolated remote transforms and never moves the local body.
Dead remote visuals include their weapons and name labels; corpse replication is
not part of this helper.

Games without this helper keep their existing behavior. Manual networking integrations
can opt in using `NetworkManager.setLocalPlayerLifeState('alive' | 'dead')` and the
`NetworkObjectOptions.playerLifeState` provider returning
`networkManager.getLocalPlayerLifeState()`. Existing peers without life state are
treated as alive; reliable death filtering requires all participating games to opt in.
`NetworkManager.events.onPlayerLifeStateChanged()` returns an unsubscribe function.

The relay continues to forward the existing message format. Spectator eligibility is
a game/client rule, not server-enforced concealment of enemy positions.

Engine verification: `node game/scripts/verify-multiplayer-spectator.mjs` from the
repository root runs three isolated browser clients through the production relay
code with persistence disabled. It uses small player adapters; Jest separately
covers actual player revival methods and asynchronous remote-character creation.
The script closes its temporary loopback listener, sockets and browsers on exit.
