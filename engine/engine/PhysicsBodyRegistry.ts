import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * Global registry mapping Rapier body handles to human-readable type names.
 * Used for collision logging and debugging.
 */

/** Map of body handle -> type name */
export const physicsBodyRegistry = new Map<number, string>();

/** Register a physics body with a type name for collision logging */
export function registerPhysicsBody(body: RAPIER.RigidBody, typeName: string): void {
    physicsBodyRegistry.set(body.handle, typeName);
}

/** Unregister a physics body (call when destroying) */
export function unregisterPhysicsBody(body: RAPIER.RigidBody): void {
    physicsBodyRegistry.delete(body.handle);
}

/** Get type name from body handle */
export function getBodyTypeName(handle: number): string | undefined {
    return physicsBodyRegistry.get(handle);
}

/** Get handle from a Rapier body or collider */
export function getPhysicsHandle(body: RAPIER.RigidBody | RAPIER.Collider | null | undefined): number {
    if (!body) return 0;
    return body.handle;
}
