import * as THREE from 'three';
import { resolveProjectileSpawn } from 'engine/weapons/PointBlank.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';

const centre = new THREE.Vector3(10, 1.2, 5);
const muzzle = new THREE.Vector3(10, 1.2, 5.75);   // 0.75 m in front, along +Z

describe('point-blank projectile spawn', () => {
    it('spawns at the muzzle when nothing sits between shooter and muzzle', () => {
        const query = jest.fn(() => false);
        const at = resolveProjectileSpawn(muzzle, centre, CollisionMask.PROJECTILE, query);
        expect(at.toArray()).toEqual(muzzle.toArray());
        // The cast runs centre → muzzle, exactly the muzzle distance.
        const [origin, dir, dist] = query.mock.calls[0] as unknown as [THREE.Vector3, THREE.Vector3, number, number];
        expect(origin.toArray()).toEqual(centre.toArray());
        expect(dir.z).toBeCloseTo(1, 6);
        expect(dist).toBeCloseTo(0.75, 6);
    });

    it('spawns at the shooter centre when an enemy stands inside the muzzle gap', () => {
        const query = jest.fn(() => true);
        const at = resolveProjectileSpawn(muzzle, centre, CollisionMask.PROJECTILE, query);
        expect(at.toArray()).toEqual(centre.toArray());
    });

    it('never asks about scenery — a wall the shooter is pressed into keeps the muzzle spawn', () => {
        const query = jest.fn((_o, _d, _dist, mask: number) => (mask & (CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT)) !== 0);
        const at = resolveProjectileSpawn(muzzle, centre, CollisionMask.PROJECTILE, query);
        expect(at.toArray()).toEqual(muzzle.toArray());
        const mask = (query.mock.calls[0] as unknown as [unknown, unknown, unknown, number])[3];
        expect(mask & CollisionGroup.TERRAIN).toBe(0);
        expect(mask & CollisionGroup.ENEMY).toBe(CollisionGroup.ENEMY);
    });

    it('with no known shooter centre, or a muzzle at the centre, spawns at the muzzle without a query', () => {
        const query = jest.fn(() => true);
        expect(resolveProjectileSpawn(muzzle, null, CollisionMask.PROJECTILE, query).toArray()).toEqual(muzzle.toArray());
        expect(resolveProjectileSpawn(muzzle, muzzle.clone(), CollisionMask.PROJECTILE, query).toArray()).toEqual(muzzle.toArray());
        expect(query).not.toHaveBeenCalled();
    });
});
