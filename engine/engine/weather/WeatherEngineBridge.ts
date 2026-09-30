import type { WeatherConfig } from 'types/game.js';
import type { GameEngine } from 'engine/GameEngine.js';
import { rebuildComposerPasses } from 'engine/GameEnginePostFx.js';
import { VxlSceneTerrainSystem } from 'engine/VxlSceneTerrainSystem.js';
import { getActiveRapierVehicles } from 'engine/physics/RapierVehicle.js';
import {
    WeatherSystem, resolveWeatherUrlOverride, type WeatherSystemDeps, type WeatherTerrainInfo,
} from 'engine/weather/WeatherSystem.js';

/**
 * WeatherEngineBridge — friend module for the weather wiring, the same seam as
 * GameEnginePostFx: GameEngine.ts sits at the repo's max-lines cap, so the
 * class carries only a thin `applyWeatherConfig` delegate + one animate() call
 * and the construction/teardown logic lives here, reaching private state
 * through the sanctioned element-access escape hatch.
 *
 * Import-cycle note: GameEngine imports this module. Safe for the same reason
 * as GameEnginePostFx — the GameEngine binding is type-position only, and
 * `rebuildComposerPasses` is called at apply time, never at module evaluation.
 */
export function applyEngineWeatherConfig(eng: GameEngine, config?: WeatherConfig | null): void {
    if (config !== undefined) {
        eng['currentWeatherConfig'] = config;
    }
    const effective = resolveWeatherUrlOverride(eng['currentWeatherConfig']);
    const raining = effective?.precipitation === 'rain';

    if (raining && !eng['weatherSystem']) {
        eng['weatherSystem'] = new WeatherSystem(buildWeatherDeps(eng));
    }
    eng['weatherSystem']?.applyConfig(raining ? effective : null);
    if (!raining && eng['weatherSystem']) {
        eng['weatherSystem']?.dispose();
        eng['weatherSystem'] = null;
    }

    // The SSR pass follows the weather config — rebuild the post chain.
    rebuildComposerPasses(eng);
}

function buildWeatherDeps(eng: GameEngine): WeatherSystemDeps {
    return {
        getScene: () => eng['scene'],
        getCamera: () => eng['camera'],
        getRenderer: () => eng['renderer'],
        getTerrain: (): WeatherTerrainInfo | null => {
            const baked = eng.getDynamicObjectManager().getBakedTerrain();
            if (!(baked instanceof VxlSceneTerrainSystem)) return null;
            return {
                group: baked.getVoxelChunkGroup(),
                bounds: baked.getBounds(),
                // Baked world only: foliage and scenery props must NEVER stop
                // rain or float splashes in mid-air (see getBakedSurfaceHeightAt).
                heightAt: (x, z) => baked.getBakedSurfaceHeightAt(x, z),
                generation: baked.getWorldGeneration(),
            };
        },
        // The module registry, NOT the VehicleManager: racing templates create
        // and update their karts directly, so the manager can be empty while
        // six vehicles race.
        getVehicles: () => Array.from(getActiveRapierVehicles()),
    };
}
