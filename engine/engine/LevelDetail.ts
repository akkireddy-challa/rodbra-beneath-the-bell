/**
 * Level detail tier — how coarse a baked level is loaded, 0 (full) to 4 (coarsest).
 *
 * ONE number the player, the game and the engine all agree on, because the alternative
 * confused everybody: a tier used to mean "which file" while the load planner separately
 * applied a floor of its own, so asking for 1 rendered like 2 and there was no way to ask
 * for 1 at all. A tier here is the TOTAL reduction, reached by combining the pre-baked
 * variant with an extra planner step when the variants run out:
 *
 *   tier 0  full container            + 0 extra   (desktop default)
 *   tier 1  +1 variant                + 0 extra   (mobile default)
 *   tier 2  +2 variant                + 0 extra
 *   tier 3  +2 variant                + 1 extra
 *   tier 4  +2 variant                + 2 extra
 *
 * Only two variants are baked, so 3 and 4 reuse the +2 file and coarsen further at load —
 * bigger blocks for no extra download, which is the right trade for a device that is
 * failing rather than merely slow.
 *
 * Resolution order: `?lod=` (dev/testing) → the COARSER of the stored tier and the device
 * quality tier's answer → the device quality tier's answer.
 *
 * The stored value composes as a FLOOR rather than replacing the tier, and by MAX rather
 * than by sum — see `resolveLevelDetail`. Two automatic mechanisms can now say "coarser"
 * (the one-strike crash downgrade below, and the quality ladder), and adding their
 * opinions together would drop a device twice for one problem.
 */

/** Coarsest tier that means anything; beyond this nothing more is dropped. */
export const MAX_LEVEL_DETAIL = 4;

const STORAGE_KEY = 'bm.levelDetail';

/** How a tier splits into "which file" and "how much more to shed at load". */
export interface LevelDetailPlan {
    /** Finest quad LOD levels the FILE already dropped — picks the variant. */
    fileDrop: number;
    /** Extra effective-size steps the load planner should shed on top. */
    extraSkipSteps: number;
}

/**
 * Split a tier into its file and planner halves. Values outside 0..MAX are clamped rather
 * than rejected: this is read from storage and from a URL, and a stale or hand-edited
 * value should degrade to the nearest sane tier instead of failing a level load.
 */
export function levelDetailPlan(tier: number): LevelDetailPlan {
    const t = Math.max(0, Math.min(MAX_LEVEL_DETAIL, Math.round(tier)));
    return { fileDrop: Math.min(2, t), extraSkipSteps: Math.max(0, t - 2) };
}

/** `?lod=<n>` — forces a tier for this load only, overriding stored and automatic values. */
function urlOverride(): number | null {
    try {
        const raw = new URLSearchParams(window.location.search).get('lod');
        if (raw === null) return null;
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? Math.min(MAX_LEVEL_DETAIL, n) : null;
    } catch {
        return null; // no window (tests, workers)
    }
}

function stored(): number | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return null;
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? Math.min(MAX_LEVEL_DETAIL, n) : null;
    } catch {
        return null; // privacy mode, no storage
    }
}

/**
 * The tier this load should use. `fallback` — the device quality tier's answer
 * (`DeviceQualityPolicy.deferred.levelDetail`) — is passed in rather than looked up so this
 * module keeps its own storage and URL handling, imports nothing, and is trivially testable:
 * the convention every sibling policy follows.
 *
 * Applies a pending crash downgrade on the way through, once per page. Doing it here
 * rather than from a boot hook is deliberate: there is then no ordering to get wrong and
 * no call site that can forget it — a tier cannot be READ before the downgrade that
 * should have changed it has been applied.
 *
 * THE STORED VALUE IS A FLOOR, COMPOSED BY MAX. It is not "the quality tier's level detail
 * field" — it has its own writers (the crash rescue, and the player's menu choice) and the
 * quality ladder never writes it. Composing by max means two mechanisms that each say
 * "coarser" land on the coarser of their two answers; composing by sum, or letting either
 * simply replace the other, is how a device gets dropped twice for one problem — or how a
 * ladder silently discards the hardest evidence there is, a load that killed the tab.
 */
export function resolveLevelDetail(fallback: number): number {
    applyPendingDowngrade(fallback);
    return urlOverride() ?? Math.max(stored() ?? 0, fallback);
}

// ---------------------------------------------------------------------------
// One-strike crash downgrade
//
// iOS gives us exactly one chance. A web process killed for memory reloads, but a SECOND
// kill takes the whole site down for the user — so a device that dies on its first load
// must come back at a lower tier, not try the same one again and spend the last life.
//
// A marker written before the load and cleared after it survives a jetsam kill (localStorage
// outlives the tab); a load that finished leaves nothing behind. `pagehide` clears it too,
// which is what separates a crash from an ordinary navigation: a deliberate leave fires the
// event, a killed process does not. Without that, refreshing mid-load would look identical
// to dying mid-load and would quietly ratchet a healthy device down tier by tier.
// ---------------------------------------------------------------------------

const LOADING_MARKER_KEY = 'bm.levelDetail.loading';

/**
 * How far one failure drops us. TWO, not one — the budget is a single retry, so the tier
 * we come back at has to be one that WORKS, not merely the next one down. Stepping by one
 * spends the only remaining life on a guess; from the mobile default that is 1 → 3, which
 * measured as survivable on the phones that died at 2.
 */
const DOWNGRADE_STEPS = 2;

let downgradeChecked = false;
let leaveHookInstalled = false;

function clearLoadingMarker(): void {
    try {
        localStorage.removeItem(LOADING_MARKER_KEY);
    } catch { /* no storage — nothing was written either */ }
}

/**
 * Record that a level load is in flight. Cleared by `noteLevelLoadFinished`, by leaving
 * the page, or — if neither happens, i.e. the process was killed — read at the next boot
 * as evidence that this tier cannot be loaded on this device.
 *
 * Not written while `?lod=` is in play: that override exists to TEST a tier, and a test
 * that dies should not also rewrite the stored setting the device will use afterwards.
 */
export function noteLevelLoadStarted(): void {
    if (urlOverride() !== null) return;
    try {
        localStorage.setItem(LOADING_MARKER_KEY, '1');
    } catch {
        return; // no storage: no marker, so no downgrade — degrades to today's behaviour
    }
    if (leaveHookInstalled) return;
    try {
        // `pagehide` rather than `beforeunload`: iOS fires pagehide reliably, including
        // into the back-forward cache, where beforeunload is not guaranteed at all.
        window.addEventListener('pagehide', clearLoadingMarker);
        leaveHookInstalled = true;
    } catch { /* no window (tests, workers) */ }
}

/** Record that the load completed. The device survived this tier; nothing to carry forward. */
export function noteLevelLoadFinished(): void {
    clearLoadingMarker();
}

/**
 * If a previous load never finished, drop `DOWNGRADE_STEPS` tiers. Runs at most once per page.
 *
 * Returns the new tier when it downgraded, else null — the return exists so a caller can
 * TELL the player their detail was lowered, which matters: the game silently looking worse
 * after a crash is the kind of thing that reads as a broken game rather than a deliberate
 * rescue.
 */
export function applyPendingDowngrade(fallback: number): number | null {
    if (downgradeChecked) return null;
    downgradeChecked = true;
    let marker: string | null = null;
    try {
        marker = localStorage.getItem(LOADING_MARKER_KEY);
    } catch {
        return null;
    }
    if (marker === null) return null;
    clearLoadingMarker();
    // The tier it died on is whatever it would have used — including the platform default,
    // which is why this reads through the same resolution the load itself used rather than
    // only the stored value. A device with nothing stored still gets rescued.
    const died = Math.max(stored() ?? 0, fallback);
    if (died >= MAX_LEVEL_DETAIL) {
        console.warn('[LevelDetail] load failed at the coarsest tier — nothing left to drop');
        return null;
    }
    const next = Math.min(MAX_LEVEL_DETAIL, died + DOWNGRADE_STEPS);
    setLevelDetail(next);
    console.warn(`[LevelDetail] previous load did not finish — detail lowered ${died} → ${next}`);
    return next;
}

/** Test seam: forget that the downgrade check already ran this page. */
export function resetDowngradeCheckForTests(): void {
    downgradeChecked = false;
}

/**
 * Persist a chosen tier. Takes effect on the NEXT level load — a level already built is not
 * rebuilt, since re-loading underneath a player mid-race is worse than the detail they
 * asked to change.
 *
 * Stored rather than held in memory because the two things that set it both need to
 * survive the page going away: a menu setting the player expects to stick, and the
 * automatic downgrade after a load that killed the tab.
 */
export function setLevelDetail(tier: number): void {
    const t = Math.max(0, Math.min(MAX_LEVEL_DETAIL, Math.round(tier)));
    try {
        localStorage.setItem(STORAGE_KEY, String(t));
    } catch {
        /* privacy mode — the choice applies to this session only */
    }
}

/** Forget the stored choice, returning to the platform default. */
export function clearLevelDetail(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* nothing stored, nothing to clear */
    }
}
