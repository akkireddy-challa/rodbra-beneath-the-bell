/** Existing IDs retain block art; the suffix selects an alternate built-in mesh. */
export type WeaponVisualStyle = 'block' | 'lowpoly';

/** Also useful when enumerating a loadout or building a weapon selection screen. */
export function weaponStyleId<T extends string>(baseId: T, style: WeaponVisualStyle): T | `${T}_lowpoly` {
    return style === 'lowpoly' ? `${baseId}_lowpoly` : baseId;
}

/** Parsing alone does not validate a weapon ID; the appropriate registry does. */
export function splitWeaponStyleId(id: string): { baseId: string; style: WeaponVisualStyle } {
    const normalized = id.toLowerCase().trim();
    return normalized.endsWith('_lowpoly')
        ? { baseId: normalized.slice(0, -8), style: 'lowpoly' }
        : { baseId: normalized, style: 'block' };
}
