/**
 * Data-driven dungeon doors and keys.
 *
 * `DoorSystem` is the entry point — `GameEngine` owns one per game with doors,
 * reachable from game code via `engine.getDoorSystem?.()`. The pieces below it
 * (`DungeonDoor`, `KeyPickup`, `Keyring`) are exported for tests and for game
 * code that needs the types.
 */

export { Keyring } from 'engine/doors/Keyring.js';

export {
    KeyPickup,
    DEFAULT_COLLECTIBLE_SENSOR_FACTORY,
    type CollectibleSensor,
    type CollectibleSensorFactory,
} from 'engine/doors/KeyPickup.js';

export {
    DungeonDoor,
    DEFAULT_DOOR_NOTIFY,
    DEFAULT_DOOR_AUTO_OPEN_RADIUS,
    DOOR_ANIM_MS,
    DOOR_CLOSE_DELAY_MS,
    type DungeonDoorState,
    type DungeonDoorEvents,
    type DoorNotify,
} from 'engine/doors/DungeonDoor.js';

export {
    DoorSystem,
    DOOR_PROXIMITY_INTERVAL_SECONDS,
    type DoorDelta,
    type DoorSnapshot,
    type DoorSystemDeps,
} from 'engine/doors/DoorSystem.js';

export {
    DoorNetworkSync,
    DOORS_SHARED_STATE_NAME,
    DOORS_SNAPSHOT_REQUEST_EVENT,
    type DoorNetworkSyncOptions,
} from 'engine/doors/DoorNetworkSync.js';

export { DoorEngineBridge } from 'engine/doors/DoorEngineBridge.js';
