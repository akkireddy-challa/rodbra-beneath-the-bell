/**
 * Vehicle Module - Re-exports RapierVehicle for backward compatibility.
 * 
 * The vehicle physics system has been migrated from AmmoJS to Rapier.
 * This file re-exports the RapierVehicle implementation under the Vehicle name
 * to maintain backward compatibility with existing code.
 */
export {
    RapierVehicle as Vehicle,
    createWheelConfig,
    DEFAULT_WHEEL_SIDE_FRICTION_STIFFNESS,
    type WheelConfig,
    type WheelTerrainInfo,
    type VehicleConfig,
    type VehicleControls,
    type VehicleBodyPart
} from 'engine/physics/RapierVehicle.js';

export {
    BasicDrivingComponent,
    DEFAULT_BASIC_DRIVING_OPTIONS,
    SMOOTH_DRIVING_OPTIONS,
    type IVehicleDrivingComponent,
    type BasicDrivingOptions,
    type BasicDrivingRecoveryOptions,
    type VehicleDrivingStatus
} from 'engine/VehicleDrivingComponent.js';

export { DEFAULT_RACING_CAR_CONFIG, scaleVehicleConfig } from 'engine/VehicleSpawner.js';

export {
    derivedClimbGrade,
    type VehicleFootprint,
    type VehiclePassResult,
    type PassFailure,
    type PathSample
} from 'engine/vehicleTraversability.js';

export {
    VehicleAutoRightSystem,
    DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS,
    type VehicleAutoRightOptions
} from 'engine/VehicleAutoRightSystem.js';

export {
    FACE,
    headingToward,
    headingTangent
} from 'engine/VehicleHeading.js';

export {
    VehicleStuckSystem,
    DEFAULT_VEHICLE_STUCK_OPTIONS,
    type VehicleStuckOptions,
    type VehicleRespawnProvider
} from 'engine/VehicleStuckSystem.js';

export {
    VehicleUnstuckSystem,
    DEFAULT_VEHICLE_UNSTUCK_OPTIONS,
    type VehicleUnstuckOptions
} from 'engine/VehicleUnstuckSystem.js';

export {
    RacingSetup,
    installRacingDefaults,
    DEFAULT_RACING_SETUP_OPTIONS,
    type RacingSetupOptions
} from 'engine/RacingSetup.js';

export {
    VehicleSafetySystems,
    installVehicleSafety,
    DEFAULT_VEHICLE_SAFETY_OPTIONS,
    type VehicleSafetyOptions
} from 'engine/VehicleSafetySystems.js';

export {
    VehicleRouteRecoverySystem,
    DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS,
    type VehicleRouteRecoveryOptions,
    type VehicleRouteRegistration,
    type VehicleRouteProvider,
    type VehicleRouteState,
    type VehicleRejoinPlan
} from 'engine/VehicleRouteRecovery.js';

export {
    buildTrackCenterline,
    DEFAULT_TRACK_CENTERLINE_OPTIONS,
    type TrackCenterlineOptions,
    type CenterlinePoint
} from 'engine/TrackCenterline.js';
