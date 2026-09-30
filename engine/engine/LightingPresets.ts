import type { FogConfig, LightingConfig } from 'types/game.js';

export type LightingPreset = 'stylized-day' | 'golden-hour' | 'overcast-forest' | 'moonlit-street';
interface AtmospherePreset { lighting: Omit<LightingConfig, 'preset'>; fog: FogConfig }

/** Art-directed light ratios and distance colour. Explicit world fields always win. */
export const LIGHTING_PRESETS: Readonly<Record<LightingPreset, AtmospherePreset>> = {
    'stylized-day': {
        lighting: { sunColor: '#fff1d8', sunIntensity: 0.85, sunElevationDeg: 48, sunAzimuthDeg: 125,
            environmentIntensity: 0.8, skyboxIntensity: 1, ambientFloor: 0.18, ambientColor: '#c4d7e5' },
        fog: { color: '#b4cfda', near: 65, far: 650 },
    },
    'golden-hour': {
        lighting: { sunColor: '#ffd49a', sunIntensity: 0.7, sunElevationDeg: 14, sunAzimuthDeg: 245,
            environmentIntensity: 0.45, skyboxIntensity: 0.7, ambientFloor: 0.22, ambientColor: '#a8bdd9' },
        fog: { color: '#c7adb0', near: 35, far: 420 },
    },
    'overcast-forest': {
        lighting: { sunColor: '#dfe9ea', sunIntensity: 0.24, sunElevationDeg: 62, sunAzimuthDeg: 155,
            environmentIntensity: 0.75, skyboxIntensity: 0.68, ambientFloor: 0.4, ambientColor: '#c3d3cd' },
        fog: { color: '#9eafaa', near: 18, far: 250 },
    },
    'moonlit-street': {
        lighting: { sunColor: '#abc6f2', sunIntensity: 0.23, sunElevationDeg: 32, sunAzimuthDeg: 210,
            environmentIntensity: 0.1, skyboxIntensity: 0.12, ambientFloor: 0.16, ambientColor: '#839abb' },
        fog: { color: '#263748', near: 20, far: 300 },
    },
};

export function resolveLightingConfig(config?: LightingConfig | null): LightingConfig | null {
    if (!config) return null;
    return config.preset ? { ...LIGHTING_PRESETS[config.preset].lighting, ...config } : config;
}

export function resolveAtmosphereFog(lighting: LightingConfig | null, fog: FogConfig | null): FogConfig | null {
    return lighting?.preset ? { ...LIGHTING_PRESETS[lighting.preset].fog, ...fog } : fog;
}
