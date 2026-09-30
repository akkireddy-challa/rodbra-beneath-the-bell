/** Built-in melee art. Y runs from pommel to tip; +Z is the cutting edge. */
import type * as THREE from 'three';
import type { BaseWeaponType, WeaponPreset } from 'engine/WeaponRegistry.js';
import type { WeaponVisualStyle } from 'engine/WeaponVisualStyle.js';
import { WeaponMeshBuilder } from 'engine/weapons/WeaponMeshBuilder.js';

function handle(b: WeaponMeshBuilder, g: number, length: number, radius: number, ornate = false): void {
    b.rod('grip', radius, radius * 0.88, [0, g - length, 0], [0, g, 0]);
    const bands = Math.max(3, Math.round(length / 0.055));
    for (let i = 0; i < bands; i++) {
        const y = g - length + 0.022 + i * (length - 0.045) / bands;
        b.rod('wood', radius * 1.03, radius * 1.03, [0, y, 0], [0, y + 0.013, 0]);
    }
    b.rod('brass', radius * 1.12, radius * 1.12, [0, g - 0.025, 0], [0, g + 0.008, 0]);
    b.rod(ornate ? 'brass' : 'steel', radius * 1.1, radius * 1.3, [0, g - length - 0.035, 0], [0, g - length + 0.005, 0]);
    if (ornate) {
        b.box('dark', [radius * 0.8, 0.028, radius * 2.1], [0, g - length - 0.012, 0]);
    }
}

function guard(b: WeaponMeshBuilder, g: number, width: number): void {
    if (b.style === 'block') {
        b.box('brass', [0.063, 0.04, width], [0, g, 0]);
        for (const side of [-1, 1]) b.box('steel', [0.075, 0.065, 0.045], [0, g - 0.01, side * (width / 2 - 0.017)]);
    } else {
        b.profile('brass', [[-width / 2, -0.065], [-width / 2 + 0.02, -0.012], [-0.07, 0.025],
            [0.07, 0.025], [width / 2 - 0.02, -0.012], [width / 2, -0.065], [0.07, -0.015], [-0.07, -0.015]],
        0.06, 0.006, [0, g, 0]);
    }
    b.box('dark', [0.07, 0.038, 0.075], [0, g + 0.015, 0]);
}

function sword(b: WeaponMeshBuilder, g: number, length: number, width: number, gripLength: number): number {
    handle(b, g, gripLength, width * 0.35, length > 1.5);
    guard(b, g, width * 3.3);
    if (b.style === 'block') {
        // A readable pixel tip, bright cutting rails, and a dark central fuller.
        const shoulders = [1, 0.82, 0.57, 0.28];
        const heights = [0.79, 0.085, 0.075, 0.05];
        let y = g;
        shoulders.forEach((scale, i) => {
            const h = length * heights[i]!;
            b.box('steel', [width * 0.3, h, width * scale], [0, y + h / 2, 0]);
            for (const side of [-1, 1]) b.box('edge', [width * 0.15, h, width * 0.12], [0, y + h / 2, side * width * (scale / 2 - 0.04)]);
            y += h;
        });
        for (const side of [-1, 1]) b.box('dark', [0.002, length * 0.64, width * 0.2], [side * (width * 0.15 + 0.0005), g + length * 0.41, 0]);
    } else {
        b.blade('edge', [
            { y: g + 0.02, z: 0, width, thickness: width * 0.38 },
            { y: g + length * 0.16, z: 0, width: width * 0.95, thickness: width * 0.34 },
            { y: g + length * 0.78, z: 0, width: width * 0.64, thickness: width * 0.23 },
        ], [0, g + length, 0], 'steel');
    }
    return g + length;
}

function haft(b: WeaponMeshBuilder, g: number, bottom: number, top: number, radius: number): void {
    b.rod('wood', radius, radius * 0.85, [0, g + bottom, 0], [0, g + top, 0]);
    for (const y of [bottom + 0.02, top - 0.065]) b.rod('brass', radius * 1.17, radius * 1.17, [0, g + y, 0], [0, g + y + 0.035, 0]);
    for (let i = 0; i < 5; i++) {
        const y = g - 0.08 + i * 0.045;
        b.rod('grip', radius * 1.1, radius * 1.1, [0, y, 0], [0, y + 0.028, 0]);
    }
}

function axe(b: WeaponMeshBuilder, g: number): number {
    haft(b, g, -0.15, 0.8, 0.035);
    b.rod('steel', 0.055, 0.05, [0, g + 0.51, 0], [0, g + 0.84, 0]);
    if (b.style === 'block') {
        b.box('steel', [0.073, 0.19, 0.21], [0, g + 0.69, 0.07]);
        b.box('steel', [0.051, 0.29, 0.12], [0, g + 0.66, 0.2]);
        b.box('edge', [0.022, 0.32, 0.044], [0, g + 0.66, 0.278]);
        b.box('dark', [0.085, 0.07, 0.09], [0, g + 0.7, -0.068]);
    } else {
        // Bearded head: narrow socket, flared edge, lower hook; thickness falls toward +Z.
        b.profile('steel', [[-0.09, 0.73], [0.035, 0.8], [0.27, 0.83], [0.3, 0.69], [0.26, 0.5],
            [0.17, 0.48], [0.15, 0.6], [0.03, 0.65], [-0.09, 0.65]], 0.055, 0.005, [0, g, 0]);
        b.profile('edge', [[0.265, 0.833], [0.303, 0.82], [0.327, 0.69], [0.28, 0.49], [0.245, 0.476],
            [0.27, 0.68]], 0.018, 0.003, [0, g, 0]);
    }
    for (const side of [-1, 1]) b.box('brass', [0.007, 0.03, 0.032], [side * 0.052, g + 0.72, 0]);
    return g + 0.85;
}

function polearm(b: WeaponMeshBuilder, g: number, spear: boolean): number {
    const bottom = spear ? -0.3 : -0.4, top = spear ? 1.46 : 1.4;
    haft(b, g, bottom, top, 0.033);
    b.rod('steel', 0.035, 0.039, [0, g + bottom - 0.015, 0], [0, g + bottom + 0.07, 0]);
    if (spear) {
        b.rod('steel', 0.04, 0.045, [0, g + 1.36, 0], [0, g + 1.49, 0]);
        if (b.style === 'lowpoly') {
            b.blade('edge', [{ y: g + 1.43, z: 0, width: 0.06, thickness: 0.027 },
                { y: g + 1.51, z: 0, width: 0.13, thickness: 0.044 }], [0, g + 1.72, 0]);
        } else {
            for (let i = 0; i < 4; i++) b.box(i === 0 ? 'steel' : 'edge', [0.026, 0.06, 0.11 - i * 0.026], [0, g + 1.51 + i * 0.06, 0]);
        }
        return g + 1.72;
    }
    b.rod('brass', 0.049, 0.041, [0, g + 1.34, 0], [0, g + 1.48, 0]);
    for (const y of [1.355, 1.405, -0.365]) b.rod('dark', 0.05, 0.05, [0, g + y, 0], [0, g + y + 0.012, 0]);
    return g + 1.48;
}

function crushing(b: WeaponMeshBuilder, g: number, hammer: boolean): number {
    haft(b, g, -0.15, hammer ? 0.79 : 0.58, hammer ? 0.037 : 0.031);
    if (hammer) {
        if (b.style === 'block') {
            b.box('steel', [0.14, 0.15, 0.28], [0, g + 0.775, 0]);
        } else {
            b.profile('steel', [[-0.17, 0.745], [-0.13, 0.83], [0.115, 0.83], [0.17, 0.8],
                [0.17, 0.72], [0.11, 0.71], [-0.13, 0.71]], 0.14, 0.012, [0, g, 0]);
        }
        for (const side of [-1, 1]) b.box('edge', [0.16, 0.16, 0.03], [0, g + 0.77, side * 0.158]);
        b.box('dark', [0.165, 0.045, 0.11], [0, g + 0.77, 0]);
        b.rod('brass', 0.052, 0.048, [0, g + 0.61, 0], [0, g + 0.695, 0]);
    } else {
        b.rod('dark', 0.069, 0.059, [0, g + 0.43, 0], [0, g + 0.64, 0]);
        const count = b.style === 'block' ? 2 : 6;
        for (let i = 0; i < count; i++) {
            if (b.style === 'block') b.box('steel', [0.035, 0.17, 0.19], [0, g + 0.545, 0], [0, i * Math.PI / 2, 0]);
            else b.profile('steel', [[0.045, 0.42], [0.095, 0.465], [0.127, 0.55], [0.093, 0.615], [0.041, 0.64]],
                0.025, 0.004, [0, g, 0], [0, i * Math.PI / 3, 0]);
        }
        b.rod('brass', 0.065, 0.047, [0, g + 0.62, 0], [0, g + 0.65, 0]);
    }
    return g + (hammer ? 0.85 : 0.65);
}

function katana(b: WeaponMeshBuilder, g: number): number {
    handle(b, g, 0.35, 0.029);
    b.rod('brass', 0.071, 0.071, [0, g - 0.008, 0], [0, g + 0.01, 0]);
    b.box('brass', [0.033, 0.064, 0.066], [0, g + 0.04, 0]);
    if (b.style === 'lowpoly') {
        b.blade('edge', [0, 0.3, 0.6, 0.87].map(t => ({ y: g + 0.065 + t,
            z: -t * t * 0.075, width: 0.07 - t * 0.014, thickness: 0.025 - t * 0.01 })), [0, g + 1.1, -0.096], 'steel');
    } else {
        for (let i = 0; i < 5; i++) {
            const h = 0.22, y = g + 0.11 + i * 0.22;
            b.box('steel', [0.025, h, 0.065 - i * 0.005], [0, y, -i * i * 0.004]);
            b.box('edge', [0.012, h, 0.016], [0, y, 0.03 - i * i * 0.004]);
        }
    }
    // Pale diamonds in the dark handle wrap, visible on both broad sides.
    for (const side of [-1, 1]) for (let i = 0; i < 4; i++) b.box('brass', [0.005, 0.023, 0.018], [side * 0.027, g - 0.075 - i * 0.065, 0], [Math.PI / 4, 0, 0]);
    return g + 1.1;
}

function cleaver(b: WeaponMeshBuilder, g: number): number {
    handle(b, g + 0.04, 0.2, 0.032);
    b.box('steel', [0.027, 0.12, 0.049], [0, g + 0.076, 0]);
    if (b.style === 'block') {
        b.box('steel', [0.035, 0.39, 0.19], [0, g + 0.3, 0.03]);
        b.box('edge', [0.016, 0.39, 0.026], [0, g + 0.3, 0.136]);
        b.box('dark', [0.04, 0.047, 0.045], [0, g + 0.443, -0.025]);
    } else {
        b.profile('steel', [[-0.065, 0.10], [-0.065, 0.47], [-0.02, 0.494], [0.12, 0.47], [0.12, 0.10]], 0.04, 0.005, [0, g, 0]);
        b.profile('edge', [[0.108, 0.105], [0.108, 0.474], [0.15, 0.454], [0.15, 0.12]], 0.012, 0.002, [0, g, 0]);
    }
    for (const side of [-1, 1]) for (const y of [-0.08, 0.0]) b.box('brass', [0.006, 0.013, 0.013], [side * 0.032, g + y, 0]);
    return g + 0.5;
}

function club(b: WeaponMeshBuilder, g: number): number {
    handle(b, g + 0.12, 0.22, 0.038);
    if (b.style === 'block') {
        b.box('wood', [0.11, 0.35, 0.11], [0, g + 0.3, 0]);
        b.box('wood', [0.145, 0.19, 0.145], [0, g + 0.445, 0]);
    } else {
        b.rod('wood', 0.037, 0.086, [0, g + 0.09, 0], [0.01, g + 0.44, -0.018]);
        b.rod('wood', 0.086, 0.057, [0.01, g + 0.44, -0.018], [0.015, g + 0.55, -0.02]);
    }
    for (const y of [0.29, 0.46]) {
        if (b.style === 'block') b.rod('steel', y > 0.4 ? 0.109 : 0.082, y > 0.4 ? 0.109 : 0.082,
            [0, g + y, 0], [0, g + y + 0.033, 0]);
        else b.rod('steel', y > 0.4 ? 0.087 : 0.066, y > 0.4 ? 0.083 : 0.071,
            [0.008, g + y, -0.01], [0.009, g + y + 0.033, -0.011]);
    }
    return g + 0.55;
}

function lightsaber(b: WeaponMeshBuilder, g: number): number {
    b.rod('steel', 0.044, 0.044, [0, g - 0.28, 0], [0, g + 0.02, 0]);
    for (let i = 0; i < 5; i++) b.rod('dark', 0.047, 0.047, [0, g - 0.235 + i * 0.036, 0], [0, g - 0.218 + i * 0.036, 0]);
    b.rod('brass', 0.053, 0.06, [0, g - 0.008, 0], [0, g + 0.046, 0]);
    b.rod('dark', 0.04, 0.036, [0, g + 0.047, 0], [0, g + 0.063, 0]);
    b.box('glow', [0.01, 0.025, 0.02], [0.045, g - 0.048, 0]);
    b.rod('glow', 0.029, 0.023, [0, g + 0.06, 0], [0, g + 1.18, 0]);
    b.rod('glow', 0.023, 0.002, [0, g + 1.18, 0], [0, g + 1.22, 0]);
    return g + 1.22;
}

/** Build either authored style without changing the preset or hand-space contract. */
export function createMeleeWeaponModel(group: THREE.Group, preset: WeaponPreset, type: BaseWeaponType, style: WeaponVisualStyle): number {
    const b = new WeaponMeshBuilder(style, type === 'lightsaber' ? { glow: 0x6eff9b } : {});
    const g = preset.gripOffset;
    let tip: number;
    switch (type) {
        case 'sword': tip = sword(b, g, 1, 0.115, 0.3); break;
        case 'dagger': tip = sword(b, g, 0.35, 0.078, 0.2); break;
        case 'longsword': tip = sword(b, g, 2, 0.15, 0.5); break;
        case 'axe': tip = axe(b, g); break;
        case 'spear': tip = polearm(b, g, true); break;
        case 'staff': tip = polearm(b, g, false); break;
        case 'mace': tip = crushing(b, g, false); break;
        case 'hammer': tip = crushing(b, g, true); break;
        case 'katana': tip = katana(b, g); break;
        case 'cleaver': tip = cleaver(b, g); break;
        case 'club': tip = club(b, g); break;
        case 'lightsaber': tip = lightsaber(b, g); break;
    }
    b.finish(group);
    return tip;
}
