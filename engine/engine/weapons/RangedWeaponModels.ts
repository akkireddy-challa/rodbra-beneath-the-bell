/** Ranged art uses +Z down the bore, +Y up, X across the receiver. */
import * as THREE from 'three';
import type { BaseRangedWeaponType, RangedWeaponPreset, RangedWeaponMeshResult } from 'engine/RangedWeaponTypes.js';
import type { WeaponVisualStyle } from 'engine/WeaponVisualStyle.js';
import { WeaponMeshBuilder, type WeaponSurface } from 'engine/weapons/WeaponMeshBuilder.js';

type SingleRangedType = Exclude<BaseRangedWeaponType, `dual_${string}`>;

function receiver(b: WeaponMeshBuilder, surface: WeaponSurface, width: number, y: number, rear: number, front: number, height: number): void {
    if (b.style === 'block') {
        b.box(surface, [width, height * 0.74, front - rear], [0, y, (front + rear) / 2]);
        b.box(surface, [width * 0.78, height * 0.28, (front - rear) * 0.86], [0, y + height * 0.48, (front + rear) / 2]);
    } else {
        const cut = Math.min(height * 0.22, (front - rear) * 0.12);
        b.profile(surface, [[rear, y - height * 0.25], [rear + cut, y + height * 0.5],
            [front - cut, y + height * 0.5], [front, y + height * 0.2], [front - cut * 0.5, y - height * 0.5],
            [rear + cut, y - height * 0.5]], width, Math.min(width * 0.12, 0.006));
    }
}

/** The front lip ends AT the preset muzzle. A dark recessed bore, not a painted cap. */
function barrel(b: WeaponMeshBuilder, y: number, start: number, end: number, radius: number, energy: boolean): void {
    const segments = b.style === 'block' ? 4 : 8;
    const points = [new THREE.Vector2(radius * 0.58, start), new THREE.Vector2(radius, start),
        new THREE.Vector2(radius, end - radius * 0.4), new THREE.Vector2(radius * 1.08, end - radius * 0.4),
        new THREE.Vector2(radius * 1.08, end), new THREE.Vector2(radius * 0.58, end), new THREE.Vector2(radius * 0.58, start)];
    const tube = new THREE.LatheGeometry(points, segments);
    if (b.style === 'block') tube.rotateY(Math.PI / 4);
    tube.rotateX(Math.PI / 2);
    b.add(tube, 'steel', [0, y, 0]);
    b.add(new THREE.CylinderGeometry(radius * 0.575, radius * 0.575, 0.002, segments), energy ? 'glow' : 'dark', [0, y, end - radius * 1.2], [Math.PI / 2, 0, 0]);
}

function grip(b: WeaponMeshBuilder, z: number, top: number, length: number, wood: boolean): void {
    if (b.style === 'block') b.box(wood ? 'wood' : 'grip', [0.03, length, 0.04], [0, top - length / 2, z - 0.008], [-0.18, 0, 0]);
    else b.profile(wood ? 'wood' : 'grip', [[z - 0.023, top], [z + 0.021, top], [z + 0.009, top - length],
        [z - 0.022, top - length - 0.003], [z - 0.035, top - length * 0.8]], 0.034, 0.003);
    for (const side of [-1, 1]) {
        b.box('dark', [0.004, length * 0.61, 0.023], [side * 0.017, top - length * 0.53, z - 0.009], [-0.16, 0, 0]);
        for (const fraction of [0.27, 0.73]) b.box('brass', [0.006, 0.005, 0.005], [side * 0.019, top - length * fraction, z - 0.007]);
    }
    // Open trigger guard, its interior stays empty from either side.
    b.box('dark', [0.018, 0.006, 0.045], [0, top - 0.03, z + 0.033]);
    b.box('dark', [0.018, 0.031, 0.006], [0, top - 0.017, z + 0.054]);
    b.box('steel', [0.008, 0.02, 0.006], [0, top - 0.011, z + 0.027], [0.22, 0, 0]);
}

function sights(b: WeaponMeshBuilder, y: number, rear: number, front: number): void {
    // Rear notch is physically open; it is not a solid bar across the sight line.
    for (const side of [-1, 1]) b.box('dark', [0.006, 0.012, 0.008], [side * 0.012, y, rear]);
    b.box('dark', [0.006, 0.013, 0.008], [0, y, front]);
    b.box('brass', [0.003, 0.004, 0.003], [0, y + 0.005, front - 0.0045]);
}

function stock(b: WeaponMeshBuilder, z: number, wood: boolean): void {
    const surface = wood ? 'wood' : 'body';
    if (b.style === 'block') {
        b.box(surface, [0.045, 0.04, 0.105], [0, 0.012, z - 0.025]);
        b.box(surface, [0.05, 0.067, 0.055], [0, -0.003, z - 0.1]);
    } else b.profile(surface, [[z + 0.027, 0.034], [z - 0.13, 0.032], [z - 0.135, -0.04],
        [z - 0.091, -0.047], [z - 0.062, -0.014], [z + 0.018, 0.008]], 0.047, 0.005);
    b.box('dark', [0.055, 0.078, 0.012], [0, -0.006, z - 0.137]);
    b.box('dark', [0.039, 0.007, 0.075], [0, 0.036, z - 0.067]);
}

function gun(b: WeaponMeshBuilder, preset: RangedWeaponPreset, type: SingleRangedType): void {
    const pistol = type === 'pistol' || type === 'laser_pistol';
    const energy = type === 'laser_pistol' || type === 'laser_blaster';
    const shotgun = type === 'shotgun';
    const { y: boreY, z: muzzle } = preset.muzzleOffset;
    const rear = pistol ? -0.035 : -0.15;
    const front = pistol ? muzzle - 0.018 : muzzle * (energy ? 0.64 : 0.45);
    const width = pistol ? 0.043 : 0.058;
    const height = pistol ? 0.039 : 0.066;
    receiver(b, energy ? 'body' : 'steel', width, boreY, rear, front, height);
    b.box('dark', [width * 0.87, 0.017, front - rear - 0.02], [0, boreY - height * 0.46, (front + rear) / 2]);
    grip(b, pistol ? 0 : -0.092, boreY - height * 0.3, pistol ? 0.075 : 0.09, shotgun);
    barrel(b, boreY, front - 0.016, muzzle, shotgun ? 0.016 : pistol ? 0.01 : 0.012, energy);
    sights(b, boreY + height * 0.64, rear + 0.02, pistol ? front - 0.008 : muzzle - 0.045);
    if (!pistol) {
        // The front post rises from a barrel-mounted tower, never floats in space.
        b.rod('dark', 0.018, 0.018, [0, boreY, muzzle - 0.053], [0, boreY, muzzle - 0.037]);
        b.box('dark', [0.012, height * 0.52, 0.012], [0, boreY + height * 0.32, muzzle - 0.045]);
    }

    // Broad side surfaces get one panel and a bolt, keeping the silhouette quiet.
    for (const side of [-1, 1]) {
        b.box(energy ? 'steel' : 'body', [0.003, height * 0.46, (front - rear) * 0.48],
            [side * (width / 2 + 0.002), boreY, (front + rear) / 2]);
        b.box('brass', [0.005, 0.008, 0.008], [side * (width / 2 + 0.003), boreY, rear + 0.014]);
        if (energy) {
            for (let i = 0; i < 3; i++) b.box('glow', [0.004, height * 0.17, pistol ? 0.008 : 0.019],
                [side * (width / 2 + 0.004), boreY + height * 0.02, front - 0.026 - i * (pistol ? 0.015 : 0.04)]);
        }
    }
    // Ejection port and charging handle belong on one side, both read in first person.
    if (!energy) {
        b.box('dark', [0.004, height * 0.3, pistol ? 0.032 : 0.047], [width / 2 + 0.004, boreY + 0.011, rear + (pistol ? 0.07 : 0.11)]);
        b.box('edge', [0.014, 0.007, 0.01], [width / 2 + 0.01, boreY - 0.003, rear + 0.059]);
    }
    if (pistol) {
        for (const side of [-1, 1]) for (let i = 0; i < 4; i++) b.box('dark', [0.003, 0.022, 0.003],
            [side * (width / 2 + 0.002), boreY, rear + 0.012 + i * 0.007]);
        b.box('steel', [0.037, 0.008, 0.044], [0, boreY - 0.09, -0.01]);
        return;
    }
    stock(b, rear, shotgun);
    const hold = preset.foregrip ?? new THREE.Vector3(0, -0.02, 0.1);
    if (shotgun) {
        b.rod('dark', 0.011, 0.011, [0, boreY - 0.032, 0.02], [0, boreY - 0.032, muzzle - 0.04]);
        receiver(b, 'wood', 0.05, hold.y, hold.z - 0.068, hold.z + 0.082, 0.039);
        for (let i = 0; i < 6; i++) b.box('grip', [0.054, 0.005, 0.006], [0, hold.y - 0.016, hold.z - 0.043 + i * 0.019]);
    } else {
        receiver(b, 'body', width * 0.88, boreY, front - 0.008, muzzle - 0.085, height * 0.78);
        for (const side of [-1, 1]) for (let i = 0; i < 4; i++) b.box('dark', [0.004, 0.017, 0.011],
            [side * width * 0.46, boreY, front + 0.02 + i * (muzzle - front - 0.13) / 3]);
        b.rod('grip', 0.019, 0.02, [hold.x, hold.y - 0.027, hold.z], [hold.x, boreY - 0.02, hold.z]);
        // Leave a gap between the swept magazine and the compact foregrip.
        const magazineZ = -0.015;
        if (b.style === 'block') b.box('dark', [0.037, 0.105, 0.065], [0, -0.045, 0.025 + magazineZ], [0.15, 0, 0]);
        else b.profile('dark', [[-0.013, 0.015], [0.052, 0.015], [0.064, -0.055], [0.097, -0.096],
            [0.05, -0.113], [0.017, -0.079]].map(([z, y]) => [z! + magazineZ, y!] as [number, number]), 0.037, 0.003);
        b.box(energy ? 'glow' : 'steel', [0.04, 0.008, 0.043], [0, -0.088, 0.055 + magazineZ]);
        for (let i = 0; i < 6; i++) b.box('dark', [0.024, 0.008, 0.01], [0, boreY + height * 0.51, 0.025 + i * 0.025]);
    }
}

function launcher(b: WeaponMeshBuilder, preset: RangedWeaponPreset): void {
    const { y, z } = preset.muzzleOffset;
    barrel(b, y, -0.3, z, 0.062, false);
    b.rod('body', 0.071, 0.071, [0, y, -0.22], [0, y, z - 0.085]);
    // Shell stops behind the muzzle; it never caps the bore.
    for (const center of [-0.21, z - 0.105]) {
        b.rod('dark', 0.078, 0.078, [0, y, center - 0.02], [0, y, center + 0.02]);
        b.box('brass', [0.014, 0.014, 0.043], [0.076, y, center]);
    }
    // Open front aperture has a second short exposed section beyond the body.
    grip(b, -0.16, y - 0.061, 0.07, false);
    const hold = preset.foregrip ?? new THREE.Vector3(0, -0.05, 0.15);
    b.box('grip', [0.048, 0.035, 0.11], [hold.x, hold.y - 0.01, hold.z]);
    b.box('dark', [0.04, 0.013, 0.17], [0, y + 0.079, 0.02]);
    b.box('steel', [0.036, 0.055, 0.011], [0, y + 0.11, 0.085]);
    b.box('glow', [0.017, 0.02, 0.003], [0, y + 0.117, 0.078]);
    for (let i = 0; i < 3; i++) b.box('brass', [0.012, 0.006, 0.043], [0.025 - i * 0.025, y + 0.069, z - 0.19]);
}

function arrow(b: WeaponMeshBuilder, y: number, nock: number, tip: number): void {
    b.rod('wood', 0.004, 0.0035, [0, y, nock], [0, y, tip - 0.035]);
    b.rod('edge', 0.013, 0, [0, y, tip - 0.039], [0, y, tip]);
    for (let i = 0; i < 3; i++) b.box('brass', [0.002, 0.023, 0.035], [0, y, nock + 0.032], [0, 0, i * Math.PI * 2 / 3]);
}

function archery(b: WeaponMeshBuilder, preset: RangedWeaponPreset, crossbow: boolean): void {
    const hold = preset.foregrip ?? new THREE.Vector3(0, 0, 0.2);
    const length = crossbow ? 0.27 : 0.34;
    const rootZ = crossbow ? 0.36 : hold.z;
    // Recurved limbs: broad root, narrow working limb, swept-back horn.
    const stations = b.style === 'block'
        ? [[0, 0, 0.026], [0.38, 0.015, 0.024], [0.75, -0.05, 0.018], [1, -0.12, 0.011]]
        : [[0, 0, 0.026], [0.25, 0.016, 0.026], [0.57, -0.012, 0.022], [0.85, -0.094, 0.014], [1, -0.11, 0.007]];
    for (const side of [-1, 1]) {
        const points = stations.map(([t, z, width]) => ({ p: new THREE.Vector3(crossbow ? side * t! * length : 0,
            crossbow ? 0.025 : side * t! * length, rootZ + z!), radius: width! * 0.57 }));
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i]!, c = points[i + 1]!;
            b.rod(crossbow ? 'steel' : 'wood', a.radius, c.radius, a.p.toArray(), c.p.toArray());
            b.rod('brass', a.radius * 0.28, c.radius * 0.28,
                [a.p.x + (crossbow ? 0 : a.radius * 0.8), a.p.y + (crossbow ? a.radius * 0.8 : 0), a.p.z],
                [c.p.x + (crossbow ? 0 : c.radius * 0.8), c.p.y + (crossbow ? c.radius * 0.8 : 0), c.p.z]);
        }
        const tip = points[points.length - 1]!.p;
        b.rod('grip', 0.009, 0.007, points[points.length - 2]!.p.toArray(), tip.toArray());
        b.rod('brass', 0.0018, 0.0018, tip.toArray(), [0, preset.muzzleOffset.y, crossbow ? 0.04 : 0.055]);
    }
    if (crossbow) {
        receiver(b, 'wood', 0.053, -0.015, -0.22, 0.43, 0.055);
        stock(b, -0.16, true);
        grip(b, -0.15, -0.025, 0.07, true);
        for (const side of [-1, 1]) b.box('steel', [0.012, 0.016, 0.43], [side * 0.014, 0.019, 0.22]);
        b.box('grip', [0.045, 0.025, 0.095], [hold.x, hold.y, hold.z]);
        b.box('brass', [0.07, 0.014, 0.048], [0, 0.013, rootZ]);
        sights(b, 0.05, -0.02, 0.36);
    } else {
        b.rod('grip', 0.022, 0.022, [0, -0.053, rootZ], [0, 0.053, rootZ]);
        for (const y of [-0.057, 0.045]) b.rod('brass', 0.025, 0.025, [0, y, rootZ], [0, y + 0.013, rootZ]);
    }
    arrow(b, preset.muzzleOffset.y, crossbow ? 0.04 : 0.055, preset.muzzleOffset.z);
}

/** Presets own the muzzle/support points; the mesh returns its rear handle center. */
export function createRangedWeaponModel(group: THREE.Group, preset: RangedWeaponPreset, type: SingleRangedType, style: WeaponVisualStyle): RangedWeaponMeshResult {
    const energy = type === 'laser_blaster' || type === 'laser_pistol';
    const b = new WeaponMeshBuilder(style, energy ? { body: 0xc7cbd0, steel: 0x4c586c, grip: 0x273343 }
        : { steel: 0x3b4b58, body: 0x536456, grip: 0x29323a });
    if (type === 'bazooka') launcher(b, preset);
    else if (type === 'bow' || type === 'crossbow') archery(b, preset, type === 'crossbow');
    else gun(b, preset, type);
    b.finish(group);
    // Keep hand targets on the authored handle, independently of legacy preset
    // offsets. Both art styles use the same handle center and support point.
    const pistol = type === 'pistol' || type === 'laser_pistol';
    const gripPoint = type === 'bow' ? preset.gripOffset.clone()
        : type === 'crossbow' ? new THREE.Vector3(0, -0.06, -0.158)
        : type === 'bazooka' ? new THREE.Vector3(0, preset.muzzleOffset.y - 0.096, -0.168)
        : new THREE.Vector3(0, preset.muzzleOffset.y - (pistol ? 0.0492 : 0.0648), pistol ? -0.008 : -0.1);
    return { grip: gripPoint, foregrip: preset.hands === 1 ? null : preset.foregrip?.clone() ?? null };
}
