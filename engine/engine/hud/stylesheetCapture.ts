/**
 * Collect the GAME's head-injected stylesheets for the trailer recording.
 *
 * Custom HUD elements are captured as `innerHTML`, but real games style them
 * with a `<style>` element appended to `document.head` and addressed by class
 * selectors — the container's `cssText` can't hold selector rules, so head
 * injection is the only place descendant styling can live. Without capturing
 * those sheets, the trailer's HUD replay renders bare markup: class names with
 * no rules anywhere in the harness. This module is the recorder's answer — the
 * sheets ride the timeline as `stylesheet` hud ops and the replay harness
 * injects them before drawing.
 *
 * The filter is "has a non-empty id that is not engine-owned". Every observed
 * game sheet carries an id (the games' own idempotency guards need one to
 * check), every engine head sheet's id is enumerated below, and the id-less
 * `<style>` elements the engine's debug panels and index.html create are
 * excluded by the id requirement itself — a page-level sheet with html/body
 * rules would destroy the harness's transparent background.
 */
import { getGameEventLog } from 'engine/recording/GameEventLog.js';
import { GLOBAL_STYLE_ID } from 'engine/hud/hudBaseStyles.js';
import { MODAL_STYLE_ID } from 'engine/ui/modalCard.js';
import { SCREEN_OVERLAY_LAYER_STYLE_ID } from 'engine/ui/screenOverlayLayer.js';

/**
 * Head `<style>` ids the ENGINE injects. These are reproduced in the replay
 * harness by the real GameHUD/UI code, so recording them would only duplicate
 * rules; everything else with an id is presumed game-authored.
 */
export const ENGINE_HEAD_STYLE_IDS: ReadonlySet<string> = new Set([
    // Bound to the owners' constants where the import is cycle-free, so a
    // rename there cannot silently turn an engine sheet into a "game" one.
    GLOBAL_STYLE_ID,
    MODAL_STYLE_ID,
    SCREEN_OVERLAY_LAYER_STYLE_ID,
    // These owners import engine/hud (a cycle) or live outside the engine graph.
    'bm-achievement-toast-styles',
    'bm-editor-shared-styles',
    'object-inspector-styles',
]);

/**
 * Per-sheet ceiling. The largest observed real sheet (a campaign-map screen)
 * is ~8 KB; 4x headroom. Oversized sheets are skipped whole rather than
 * truncated — half a stylesheet styles half a widget, which looks broken in a
 * subtler way than unstyled does.
 */
export const MAX_RECORDED_STYLESHEET_CHARS = 32768;

/** Total budget across all sheets in one collection pass. */
export const MAX_RECORDED_STYLESHEET_TOTAL_CHARS = 131072;

export interface RecordedStylesheet {
    id: string;
    css: string;
}

const warnedSheetIds = new Set<string>();
/** Ids logged into the CURRENT session, so removals can be noticed. */
let loggedSheetIds = new Set<string>();
let warnedSessionSerial = -1;

/** Tests re-run collection with fresh warn-once state. */
export function _resetStylesheetCaptureForTests(): void {
    warnedSheetIds.clear();
    loggedSheetIds = new Set<string>();
    warnedSessionSerial = -1;
}

/**
 * Every game-authored head stylesheet, in document order. Cheap enough to call
 * per HUD op — the event log dedupes unchanged sheets to nothing.
 */
export function collectGameHeadStylesheets(): RecordedStylesheet[] {
    const sheets: RecordedStylesheet[] = [];
    let total = 0;
    const styles = Array.from(document.head.querySelectorAll('style'));
    for (const style of styles) {
        const id = style.id;
        if (!id || ENGINE_HEAD_STYLE_IDS.has(id)) continue;
        // A sheet the game switched off (`sheet.disabled`, a skin toggle) is
        // absent for replay purposes — recording its text would paint both
        // skins at once. CSSOM edits (insertRule) never reach textContent and
        // cannot be captured; the docs say so.
        if (style.sheet?.disabled) continue;
        const css = style.textContent ?? '';
        if (css.length > MAX_RECORDED_STYLESHEET_CHARS) {
            if (!warnedSheetIds.has(id)) {
                warnedSheetIds.add(id);
                console.warn(
                    `[ScreenRecorder] stylesheet #${id} is ${css.length} chars ` +
                        `(cap ${MAX_RECORDED_STYLESHEET_CHARS}) — skipped; its widgets will replay unstyled in trailers`
                );
            }
            continue;
        }
        if (total + css.length > MAX_RECORDED_STYLESHEET_TOTAL_CHARS) {
            if (!warnedSheetIds.has(id)) {
                warnedSheetIds.add(id);
                console.warn(
                    `[ScreenRecorder] stylesheet #${id} skipped — the recording's ` +
                        `${MAX_RECORDED_STYLESHEET_TOTAL_CHARS}-char stylesheet budget is spent`
                );
            }
            continue;
        }
        total += css.length;
        sheets.push({ id, css });
    }
    return sheets;
}

/**
 * Log every game stylesheet into the active recording session. A no-op when no
 * session is active, and the log's repeat-value dedupe reduces an unchanged
 * sheet to nothing — so callers fire this on every custom-element op without
 * bloating the timeline.
 */
export function logGameStylesheets(): void {
    const log = getGameEventLog();
    if (!log.isActive()) return;
    // Warn-once is per recording, not per page load — a second F9 must repeat
    // the diagnostic for a sheet it is still dropping.
    const serial = log.getSessionSerial();
    if (serial !== warnedSessionSerial) {
        warnedSessionSerial = serial;
        warnedSheetIds.clear();
        loggedSheetIds = new Set<string>();
    }
    const present = new Set<string>();
    for (const sheet of collectGameHeadStylesheets()) {
        present.add(sheet.id);
        loggedSheetIds.add(sheet.id);
        log.logHud({ op: 'stylesheet', id: sheet.id, css: sheet.css });
    }
    // A sheet the game tore down needs an explicit tombstone: the replay keeps
    // every id it has ever seen, so a skin swapped by removal would otherwise
    // replay with the old and new rules both applied.
    for (const id of loggedSheetIds) {
        if (present.has(id)) continue;
        loggedSheetIds.delete(id);
        log.logHud({ op: 'stylesheet', id, css: '' });
    }
}
