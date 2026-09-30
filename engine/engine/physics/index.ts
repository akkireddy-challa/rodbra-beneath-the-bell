export { initRapier, getRapier, isRapierReady, RAPIER } from 'engine/physics/RapierPhysics.js';
export { PhysicsWorld, type RaycastResult, type ContactInfo, type CollisionCallback } from 'engine/physics/PhysicsWorld.js';
export {
    PhysicsBodyFactory,
    type RigidBodyConfig,
    type ColliderConfig,
    type ColliderShape
} from 'engine/physics/PhysicsBodyFactory.js';
export {
    RapierVehicle,
    createWheelConfig,
    type WheelConfig,
    type VehicleConfig,
    type VehicleControls,
    type VehicleBodyPart
} from 'engine/physics/RapierVehicle.js';

// 2D Physics exports
export { initRapier2D, getRapier2D, isRapier2DReady, RAPIER2D } from 'engine/physics/RapierPhysics2D.js';
export { PhysicsWorld2D, type RaycastResult2D, type ContactInfo2D, type CollisionCallback2D } from 'engine/physics/PhysicsWorld2D.js';
export {
    PhysicsBodyFactory2D,
    type RigidBodyConfig2D,
    type ColliderConfig2D,
    type ColliderShape2D
} from 'engine/physics/PhysicsBodyFactory2D.js';

