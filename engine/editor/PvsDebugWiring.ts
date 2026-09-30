/**
 * Wiring between the debug game-info panel's PVS UI and the engine-level
 * PVS controller. Separate from `EditorWiring.ts` so the PVS subsystem's
 * editor wiring has no coupling to pointer-lock / navmesh helpers.
 */

import type {
    DebugGameInfoPanel,
    PvsStatsSnapshot,
    PvsPruningReportSnapshot,
    PvsApplyPruneResult,
} from '../debug/DebugGameInfoPanel.js';

/**
 * Shape of the PVS controller's surface we read. Kept duck-typed so this
 * file doesn't pull in the full `PvsController` type — the controller may
 * hold no data until a PVS is baked/loaded, so callers pass a getter that
 * returns null until then.
 */
export interface PvsEditor {
    getPvsStats?: () => PvsStatsSnapshot | null;
    pvsCuller?: {
        analyzePvsPruning?: () => PvsPruningReportSnapshot | { error: string } | null;
        applyPvsPruneInMemory?: () => PvsApplyPruneResult | { error: string } | null;
    } | null;
}

/**
 * Connect the debug game-info panel's PVS UI (stats line + the two
 * analyze/apply prune buttons) to the engine-level PVS controller's runtime
 * data. `getPvs` is re-read on every tick because the controller is created
 * during engine boot but only holds data once a PVS is baked/loaded.
 */
export function wirePvsProvidersToDebugPanel(
    panel: DebugGameInfoPanel,
    getPvs: () => PvsEditor | null,
): void {
    panel.setPvsStatsProvider(() => getPvs()?.getPvsStats?.() ?? null);
    panel.setPvsPruneProvider(
        () => getPvs()?.pvsCuller?.analyzePvsPruning?.() ?? { error: 'No PVS data yet — bake visibility first' },
    );
    panel.setPvsApplyPruneProvider(
        () => getPvs()?.pvsCuller?.applyPvsPruneInMemory?.() ?? { error: 'No PVS data yet — bake visibility first' },
    );
}
