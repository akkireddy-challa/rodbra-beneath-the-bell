/** @jest-environment jsdom */
/**
 * The stylesheet capture is what turns "custom HUD replays as bare markup"
 * into styled trailer overlays: game widgets keep ~100% of their design in
 * head-injected <style id="..."> sheets, and these tests pin the filter that
 * decides which sheets ride the timeline — game-authored ids in, engine ids
 * and id-less page styles out — plus the caps and the log-side dedupe that
 * make re-collecting on every HUD op affordable.
 */
import {
    ENGINE_HEAD_STYLE_IDS,
    MAX_RECORDED_STYLESHEET_CHARS,
    collectGameHeadStylesheets,
    logGameStylesheets,
    _resetStylesheetCaptureForTests,
} from 'engine/hud/index.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';
import { SCREEN_OVERLAY_LAYER_STYLE_ID } from 'engine/ui/screenOverlayLayer.js';
import { GLOBAL_STYLE_ID } from 'engine/hud/hudBaseStyles.js';
import { MODAL_STYLE_ID } from 'engine/ui/modalCard.js';

function addHeadStyle(id: string | null, css: string): HTMLStyleElement {
    const style = document.createElement('style');
    if (id !== null) style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
    return style;
}

describe('collectGameHeadStylesheets', () => {
    beforeEach(() => {
        document.head.querySelectorAll('style').forEach((s) => s.remove());
        _resetStylesheetCaptureForTests();
    });

    it('collects game-id sheets and excludes engine ids and id-less styles', () => {
        addHeadStyle('hud-base-styles', '.hud-element { position: relative; }');
        addHeadStyle('boiler-gauge-styles', '.bg-row { display: flex; }');
        // index.html's parse-time style and the debug panels carry no id — a
        // page-level sheet with html/body rules would wreck the harness's
        // transparent background, and the id requirement excludes them all.
        addHeadStyle(null, 'body { background: black; }');
        expect(collectGameHeadStylesheets()).toEqual([
            { id: 'boiler-gauge-styles', css: '.bg-row { display: flex; }' },
        ]);
    });

    it('knows every engine head style id', () => {
        // The denylist is the one place the engine's own head sheets are
        // enumerated; a new engine sheet must be added there or it starts
        // riding every recording as if a game wrote it. Bound to the real
        // constant where one is exported, so a rename breaks this test rather
        // than silently leaking that sheet into recordings — the literals below
        // pin the rest, whose ids live inline at their injection sites.
        expect(ENGINE_HEAD_STYLE_IDS.has(SCREEN_OVERLAY_LAYER_STYLE_ID)).toBe(true);
        expect(ENGINE_HEAD_STYLE_IDS.has(GLOBAL_STYLE_ID)).toBe(true);
        expect(ENGINE_HEAD_STYLE_IDS.has(MODAL_STYLE_ID)).toBe(true);
        for (const id of ['bm-achievement-toast-styles', 'bm-editor-shared-styles', 'object-inspector-styles']) {
            expect(ENGINE_HEAD_STYLE_IDS.has(id)).toBe(true);
        }
        expect(ENGINE_HEAD_STYLE_IDS.size).toBe(6);
    });

    it('treats a disabled sheet as absent — a skin switched off must not replay', () => {
        const off = addHeadStyle('skin-a', '.a { color: red; }');
        off.sheet!.disabled = true;
        addHeadStyle('skin-b', '.a { color: blue; }');
        expect(collectGameHeadStylesheets()).toEqual([{ id: 'skin-b', css: '.a { color: blue; }' }]);
    });

    it('skips an oversized sheet whole and warns exactly once', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            addHeadStyle('huge-styles', 'x'.repeat(MAX_RECORDED_STYLESHEET_CHARS + 1));
            addHeadStyle('small-styles', '.ok { color: red; }');
            expect(collectGameHeadStylesheets()).toEqual([
                { id: 'small-styles', css: '.ok { color: red; }' },
            ]);
            collectGameHeadStylesheets();
            const oversize = warnSpy.mock.calls.filter((c) => String(c[0]).includes('huge-styles'));
            expect(oversize).toHaveLength(1);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('logGameStylesheets', () => {
    beforeEach(() => {
        document.head.querySelectorAll('style').forEach((s) => s.remove());
        _resetStylesheetCaptureForTests();
    });

    it('logs each sheet once, changed sheets again, and nothing without a session', () => {
        addHeadStyle('skin-styles', '.a { color: red; }');

        // No session: a plain no-op, so call sites need no gating of their own.
        logGameStylesheets();

        const log = getGameEventLog();
        log.startSession(() => 0, 'recorder');
        try {
            logGameStylesheets();
            logGameStylesheets(); // unchanged — dedupes to nothing
            const style = document.getElementById('skin-styles');
            if (style) style.textContent = '.a { color: blue; }';
            logGameStylesheets(); // changed — logs again
        } finally {
            const session = log.endSession('recorder');
            const sheets = (session?.hud ?? []).filter((op) => op.op === 'stylesheet');
            expect(sheets).toEqual([
                { frame: 0, op: 'stylesheet', id: 'skin-styles', css: '.a { color: red; }' },
                { frame: 0, op: 'stylesheet', id: 'skin-styles', css: '.a { color: blue; }' },
            ]);
        }
    });

    it('tombstones a sheet the game removed so replay stops applying it', () => {
        addHeadStyle('skin-a', '.a { color: red; }');
        const log = getGameEventLog();
        log.startSession(() => 0, 'recorder');
        try {
            logGameStylesheets();
            document.getElementById('skin-a')?.remove();
            addHeadStyle('skin-b', '.a { color: blue; }');
            logGameStylesheets();
        } finally {
            const session = log.endSession('recorder');
            const sheets = (session?.hud ?? []).filter((op) => op.op === 'stylesheet');
            expect(sheets).toEqual([
                { frame: 0, op: 'stylesheet', id: 'skin-a', css: '.a { color: red; }' },
                { frame: 0, op: 'stylesheet', id: 'skin-b', css: '.a { color: blue; }' },
                // Empty css: without it the replay keeps skin-a forever and
                // paints both skins at once.
                { frame: 0, op: 'stylesheet', id: 'skin-a', css: '' },
            ]);
        }
    });

    it('warns again about the same oversized sheet in a second recording', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const log = getGameEventLog();
        try {
            addHeadStyle('huge-styles', 'x'.repeat(MAX_RECORDED_STYLESHEET_CHARS + 1));
            log.startSession(() => 0, 'recorder');
            logGameStylesheets();
            log.endSession('recorder');
            // A second F9 must repeat the diagnostic: warn-once is per
            // recording, not per page load, or the second unstyled trailer
            // looks like a brand-new bug.
            log.startSession(() => 0, 'recorder');
            logGameStylesheets();
            log.endSession('recorder');
            const oversize = warnSpy.mock.calls.filter((c) => String(c[0]).includes('huge-styles'));
            expect(oversize).toHaveLength(2);
        } finally {
            warnSpy.mockRestore();
        }
    });
});
