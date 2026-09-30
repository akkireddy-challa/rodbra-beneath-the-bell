/** Independently versioned, opt-in contract. No MetaHuman/DNA dependency. */
export interface HeroCharacterDefinition {
    type: 'hero-character';
    version: 1;
    id: string;
    /** Every rendered material is assigned explicitly; names must be unique. */
    surfaces: HeroSurface[];
    /** Controls are normalized [0,1]; multiple meshes can share a control. */
    controls: Record<string, HeroMorphBinding[]>;
    correctives: HeroCorrective[];
}

export interface HeroSurface {
    material: string;
    kind: 'skin' | 'cloth' | 'leather' | 'hair' | 'fur' | 'eye' | 'teeth' | 'metal' | 'other';
    roughness: number;
    specularIntensity: number;
    /** Approximate backscatter, not offline/path-traced subsurface scattering. */
    scatter: { color: string; strength: number };
}

export interface HeroMorphBinding {
    mesh: string;
    target: string;
    gain: number;
}

export interface HeroCorrective {
    drivers: string[];
    binding: HeroMorphBinding;
}

export function validateHeroDefinition(d: HeroCharacterDefinition): void {
    if (d.type !== 'hero-character' || d.version !== 1 || !d.id) throw new Error('Unsupported hero character definition');
    const names = new Set<string>();
    for (const surface of d.surfaces) {
        if (!surface.material || names.has(surface.material)) throw new Error(`Duplicate/empty surface: ${surface.material}`);
        names.add(surface.material);
        if (!['skin', 'cloth', 'leather', 'hair', 'fur', 'eye', 'teeth', 'metal', 'other'].includes(surface.kind)) throw new Error('Unknown hero surface kind');
        for (const value of [surface.roughness, surface.specularIntensity, surface.scatter.strength]) {
            if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Hero material values must be in [0,1]');
        }
        if (!/^#[0-9a-f]{6}$/i.test(surface.scatter.color)) throw new Error('Scatter color must be #rrggbb');
        if (surface.kind !== 'skin' && surface.scatter.strength !== 0) throw new Error('Only skin can scatter');
    }
    for (const [name, bindings] of Object.entries(d.controls)) {
        if (!name || bindings.length === 0) throw new Error('Empty hero control');
        bindings.forEach(validateBinding);
    }
    for (const corrective of d.correctives) {
        if (!corrective.drivers.length || corrective.drivers.some(name => !Object.prototype.hasOwnProperty.call(d.controls, name))) {
            throw new Error('Corrective references missing controls');
        }
        validateBinding(corrective.binding);
    }
}

function validateBinding(binding: HeroMorphBinding): void {
    if (!binding.mesh || !binding.target || !Number.isFinite(binding.gain) || binding.gain <= 0 || binding.gain > 1) {
        throw new Error('Invalid hero morph binding');
    }
}
