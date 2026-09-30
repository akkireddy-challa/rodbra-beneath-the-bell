/**
 * MELEE WEAPON AUTHORING — BLOCK AND LOWPOLY
 *
 * Prefer the built-ins: sword, longsword, dagger, axe, spear, mace, hammer,
 * katana, cleaver, staff, club, lightsaber. Existing IDs select improved block
 * art; append `_lowpoly` for the faceted version, e.g. 'sword_lowpoly'.
 * No registration is needed. Both styles keep the same gameplay and moves.
 * See @docs weapon-visuals.md for the visual contract and inspection commands.
 *
 * THIRD PERSON / TOP DOWN:
 *   const system = new WeaponMeleeSystem(engine, physicsWorld);
 *   playerController.setAttackSystem(system);
 *   playerController.onCharacterReady(() => {
 *       system.equipWeaponByType('sword_lowpoly', player, playerController);
 *   });
 * FIRST PERSON: use FirstPersonMeleeSystem with weaponType: 'sword_lowpoly'.
 * PICKUPS: pass the same ID to WeaponPickupManager.spawnWeapon(). Do not mix
 * manual equip with WeaponPickupSystem — the coordinator owns weapon state.
 *
 * CUSTOM AUTHORING:
 * - Local +Y is hilt → tip. Blade breadth lies along Z, thickness along X.
 * - A one-sided cutting edge faces +Z. Curve within the YZ blade plane.
 * - Build around preset.gripOffset; return the actual tip's Y coordinate.
 * - A blade must meet its guard/tang, and the guard must meet the grip.
 * - Block: square sections, intentional steps, edge rails, chunky fittings.
 * - Lowpoly: tapered sections, true points, hard facets, shaped guard/haunches.
 * - Use classed materials (metal/wood/leather/etc.), opaque geometry, and a
 *   small number of surface batches. Changing material alone is not a style.
 *
 * The compiled example below registers a custom weapon in both styles. Call
 * registerDuelistSabres() from template setup, before equipping either ID.
 * Its required preset fields are explicit; it does not depend on a hidden
 * engine singleton or an allocated throwaway weapon to obtain a preset.
 */
import type * as THREE from 'three';
import { WeaponRegistry, type WeaponPreset } from 'engine/WeaponRegistry.js';
import { WeaponMeshBuilder } from 'engine/weapons/WeaponMeshBuilder.js';
import { weaponStyleId, type WeaponVisualStyle } from 'engine/WeaponVisualStyle.js';

export const DUELIST_SABRE_PRESET: WeaponPreset = {
    name: 'Duelist Sabre', damage: 11, impactForce: 380, impulseStrength: 14,
    attackRange: 3.2, bladeRadius: 0.12, gripOffset: 0.15, forwardOffset: 0.08, grip: 'one',
};

export function createDuelistSabre(group: THREE.Group, preset: WeaponPreset, style: WeaponVisualStyle): number {
    const b = new WeaponMeshBuilder(style, { grip: 0x253d42, brass: 0xb68b48 });
    const g = preset.gripOffset;
    b.rod('grip', 0.033, 0.028, [0, g - 0.3, 0], [0, g, 0]);
    b.rod('brass', 0.039, 0.041, [0, g - 0.32, 0], [0, g - 0.285, 0]);
    b.box('brass', [0.05, 0.035, 0.23], [0, g, 0]);
    if (style === 'block') {
        for (let i = 0; i < 5; i++) {
            const centerZ = -i * i * 0.004;
            b.box('steel', [0.025, 0.19, 0.068], [0, g + 0.095 + i * 0.19, centerZ]);
            b.box('edge', [0.01, 0.19, 0.013], [0, g + 0.095 + i * 0.19, centerZ + 0.035]);
        }
    } else {
        b.blade('edge', [0, 0.24, 0.48, 0.73].map(y => ({ y: g + y, z: -y * y * 0.09,
            width: 0.075 - y * 0.02, thickness: 0.03 - y * 0.012 })), [0, g + 0.95, -0.081]);
    }
    b.finish(group);
    return g + 0.95;
}

export function registerDuelistSabres(): void {
    for (const style of ['block', 'lowpoly'] as const) {
        WeaponRegistry.register(weaponStyleId('duelist_sabre', style), {
            preset: DUELIST_SABRE_PRESET,
            createMesh: (group, preset) => createDuelistSabre(group, preset, style),
        });
    }
}
