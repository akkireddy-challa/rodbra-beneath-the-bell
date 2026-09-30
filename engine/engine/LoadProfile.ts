/**
 * Load profiler — `?profile=1`.
 *
 * Answers "where does the time go, and is it network or CPU", which are the two questions
 * that pick different fixes: a slow download wants smaller files, a slow build wants less
 * work. Off by default and costing nothing; when armed it prints one table at the end of
 * the load rather than a running commentary, so the numbers can be read at a glance
 * instead of reconstructed from a scroll-back.
 *
 * Three sources, combined:
 *  - PHASES come free from `LoadProgressTracker.subscribe` — the same phases the loading
 *    bar shows, so a row here maps to something the player actually watched.
 *  - MARKS are explicit calls for steps the phase system does not break down (the world
 *    phase alone is 40% of the bar and covers decode, meshing, colliders and scenery).
 *  - NETWORK comes from `PerformanceResourceTiming`, the only way to separate transfer
 *    from processing. Durations only: see `networkRows` for why the sizes cannot be
 *    trusted cross-origin.
 *
 * Timestamps are `performance.now()`, i.e. milliseconds since navigation start, so the
 * first row shows how long the page took to reach us before any of our code ran.
 */

interface Row {
    /** 'phase' rows come from the progress tracker; 'mark' rows are explicit. */
    kind: 'phase' | 'mark';
    name: string;
    at: number;
    detail: string;
}

const rows: Row[] = [];
let armed: boolean | null = null;
let subscribed = false;

/**
 * `?profile=1`. Read once and cached — the answer cannot change mid-load, and re-parsing
 * the URL on every mark would itself show up in the numbers being measured.
 */
export function profilingEnabled(): boolean {
    if (armed !== null) return armed;
    try {
        armed = new URLSearchParams(window.location.search).get('profile') === '1';
    } catch {
        armed = false; // no window (tests, workers)
    }
    if (armed) console.warn('[LoadProfile] armed — a table prints when the load completes');
    return armed;
}

/** Record a step. Free when profiling is off. */
export function profileMark(name: string, detail = ''): void {
    if (!profilingEnabled()) return;
    note('mark', name, detail);
}

/**
 * Start recording phase transitions. Safe to call repeatedly; only the first subscribes.
 * Called from the engine's progress install so the profiler sees the whole load, not just
 * the part after some component happened to import it.
 */
export function installLoadProfiler(subscribe: (fn: (phase: string | null) => void) => void): void {
    if (!profilingEnabled() || subscribed) return;
    subscribed = true;
    let current: string | null = null;
    subscribe((phase) => {
        if (phase === current) return;
        current = phase;
        // NOT a trigger to report. A deferred-boot game (a racing menu, say) completes every
        // engine phase with no level loaded, picks a track, and only then does the work worth
        // measuring — reporting on completion printed a table that ended before the load began.
        note('phase', phase ?? 'engine phases done');
    });
}

/**
 * Print once the load has gone QUIET, rather than at a point we nominate.
 *
 * Any fixed end-point is a guess about a flow that differs per game: deferred boots load a
 * level after the menu, some games load one during boot, and a level switch happens later
 * still. A settle timer needs no such guess — it fires when nothing has happened for a
 * while, which is what "finished" actually looks like. Re-armed by every mark, so a report
 * covers a whole load and a later level switch prints its own.
 */
const SETTLE_MS = 2500;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let reported = 0;

function note(kind: 'phase' | 'mark', name: string, detail = ''): void {
    rows.push({ kind, name, at: performance.now(), detail });
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = null; report(); }, SETTLE_MS);
}

/**
 * Slowest transfers in this segment, by wall-clock duration.
 *
 * DURATION is all we can trust. Safari zeroes `transferSize` and `decodedBodySize` for
 * cross-origin responses unless the server sends `Timing-Allow-Origin`, and the asset
 * bucket does not — so sizes read 0.00 MB for every real asset, and a "transferSize === 0
 * means cache hit" test is true for ALL of them. Reporting either would be inventing
 * data. Sizes are printed only when the browser actually supplied them, and where a size
 * matters (the level container) the mark carries the number we measured ourselves.
 */
function networkRows(since: number, until: number): string[] {
    if (typeof performance === 'undefined' || !performance.getEntriesByType) return [];
    const out: string[] = [];
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const heavy = entries
        // Bounded at BOTH ends. The report prints on a settle timer, well after the
        // segment's last mark, and a PerformanceResourceTiming entry only appears once its
        // request finishes — so an open lower bound listed requests belonging to the NEXT
        // segment, and the same download appeared in three consecutive tables.
        .filter((e) => e.startTime >= since && e.startTime <= until && e.duration >= 20)
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 12);
    for (const e of heavy) {
        const name = (e.name.split('/').pop()?.split('?')[0] ?? e.name).slice(-46);
        const size = e.transferSize > 0
            ? `${(e.transferSize / 1048576).toFixed(2)} MB wire`
            : 'size withheld (cross-origin)';
        out.push(`      ${name.padEnd(46)} ${e.duration.toFixed(0).padStart(6)}ms  ${size}`);
    }
    return out;
}

/**
 * Print the table. Rows are shown in the order they happened, each with the gap since the
 * previous one — that gap, not the absolute time, is what a given step cost.
 */
export function report(): void {
    if (!profilingEnabled() || rows.length === reported) return;
    // Only what is NEW. A deferred-boot game reports its engine phases, then its level
    // load, then any later switch — each as its own table, instead of re-printing the
    // whole session every time and burying the segment being asked about.
    const segment = rows.slice(reported);
    const start = reported === 0 ? 0 : rows[reported - 1]!.at;
    // The gap that OPENS a later segment is idle, by construction: a segment exists
    // precisely because nothing happened for SETTLE_MS, so that gap is the menu sitting
    // there waiting for a tap. Counting it made "level load START" the single biggest cost
    // of a load at 80%, which is worse than useless — it buries the real costs under a
    // number that measures the player.
    // A gap is idle only when nothing was RUNNING across it. The settle timer cannot tell
    // the difference on its own: a single step that takes longer than SETTLE_MS and emits
    // no marks (scenery, 3.4s) splits the segment exactly like a player sitting on the menu
    // does, and the first version of this called that 3.4s of real work "idle".
    //
    // So the answer is declared, not guessed: a step that will outlast the timer emits a
    // `… START` mark, and a segment whose predecessor ended on one opened mid-operation.
    const openedMidOperation = reported > 0 && rows[reported - 1]!.name.endsWith('START');
    const idleLead = reported === 0 || openedMidOperation ? 0 : segment[0]!.at - start;
    const measuredFrom = start + idleLead;
    reported = rows.length;
    const total = segment[segment.length - 1]!.at - measuredFrom;
    const lines: string[] = [
        '',
        `[LoadProfile] segment ${(total / 1000).toFixed(2)}s` +
        `  (from ${(measuredFrom / 1000).toFixed(2)}s to ${(segment[segment.length - 1]!.at / 1000).toFixed(2)}s since page start)` +
        (idleLead > 0 ? `  — after ${(idleLead / 1000).toFixed(2)}s idle` : ''),
        `    ${'step'.padEnd(30)} ${'took'.padStart(8)} ${'at'.padStart(8)}  ${'%'.padStart(5)}`,
    ];
    let prev = measuredFrom;
    const worst: Array<{ name: string; ms: number }> = [];
    for (const r of segment) {
        const took = r.at - prev;
        prev = r.at;
        // The opening mark of a later segment measures the wait before it, not itself.
        if (r === segment[0] && idleLead > 0) {
            lines.push(`    ${`  ${r.name}`.padEnd(30)} ${'—'.padStart(6)}  ${(r.at / 1000).toFixed(2).padStart(7)}s ${'idle'.padStart(6)}  ${r.detail}`);
            continue;
        }
        worst.push({ name: r.name, ms: took });
        const label = r.kind === 'phase' ? `[${r.name}]` : `  ${r.name}`;
        lines.push(
            `    ${label.padEnd(30)} ${took.toFixed(0).padStart(6)}ms ${(r.at / 1000).toFixed(2).padStart(7)}s` +
            ` ${(100 * took / total).toFixed(1).padStart(5)}%  ${r.detail}`,
        );
    }
    worst.sort((a, b) => b.ms - a.ms);
    lines.push('', '    biggest costs:');
    for (const w of worst.slice(0, 6)) {
        lines.push(`      ${w.name.padEnd(30)} ${w.ms.toFixed(0).padStart(6)}ms  ${(100 * w.ms / total).toFixed(1)}%`);
    }
    const net = networkRows(measuredFrom, segment[segment.length - 1]!.at);
    if (net.length > 0) lines.push('', '    network in this segment (slowest first):', ...net);
    lines.push('');
    console.warn(lines.join('\n'));
}

// Manual dump — the settle timer covers the normal case, this covers the rest (a load that
// never goes quiet because something polls, or simply wanting the numbers sooner).
if (typeof window !== 'undefined') {
    (window as unknown as { __bmProfile?: () => void }).__bmProfile = () => report();
}
