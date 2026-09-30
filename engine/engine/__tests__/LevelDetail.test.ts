/** @jest-environment jsdom */
/**
 * Level detail tiers.
 *
 * The tier is the TOTAL reduction a player sees. It used to be only "which file", while the
 * load planner applied a floor of its own on top — so asking for 1 rendered like 2, and 1
 * was unreachable. That mattered in the field: on older iPhones the effective-2 load
 * crashed while effective-3/4 survived, which means the real default had never been tried
 * on them. These tests pin the split, because it is the part that silently drifts.
 */
import {
    levelDetailPlan, resolveLevelDetail, setLevelDetail, clearLevelDetail,
    MAX_LEVEL_DETAIL,
    noteLevelLoadStarted, noteLevelLoadFinished, applyPendingDowngrade,
    resetDowngradeCheckForTests,
} from 'engine/LevelDetail.js';

/**
 * What the quality ladder's `low` and `ultra` rungs ask for. Spelled out here rather than
 * imported so this stays a test of the tier arithmetic alone — if the ladder ever moves
 * these, `DeviceQualityRewiring.test.ts` is what notices.
 */
const MOBILE_RUNG = 1;
const DESKTOP_RUNG = 0;

const withUrl = (search: string, fn: () => void): void => {
    window.history.replaceState({}, '', search);
    try { fn(); } finally { window.history.replaceState({}, '', '/'); }
};

describe('level detail tiers', () => {
    beforeEach(() => clearLevelDetail());
    afterEach(() => clearLevelDetail());

    it('splits each tier into a file and an extra planner step', () => {
        // Only two variants are baked, so 3 and 4 reuse the +2 file and coarsen further at
        // load — more blocks for no extra download, which is the right trade for a device
        // that is failing rather than merely slow.
        expect(levelDetailPlan(0)).toEqual({ fileDrop: 0, extraSkipSteps: 0 });
        expect(levelDetailPlan(1)).toEqual({ fileDrop: 1, extraSkipSteps: 0 });
        expect(levelDetailPlan(2)).toEqual({ fileDrop: 2, extraSkipSteps: 0 });
        expect(levelDetailPlan(3)).toEqual({ fileDrop: 2, extraSkipSteps: 1 });
        expect(levelDetailPlan(4)).toEqual({ fileDrop: 2, extraSkipSteps: 2 });
    });

    it('clamps rather than rejects, since tiers come from storage and URLs', () => {
        expect(levelDetailPlan(-3)).toEqual(levelDetailPlan(0));
        expect(levelDetailPlan(99)).toEqual(levelDetailPlan(MAX_LEVEL_DETAIL));
    });

    it('uses the tier\'s answer when nothing has been stored', () => {
        expect(resolveLevelDetail(DESKTOP_RUNG)).toBe(0);
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(1);
    });

    it('treats a stored choice as a FLOOR, taking the coarser of the two', () => {
        // Not a replacement. The stored value has its own writers — the crash rescue and
        // the player's menu — and the quality ladder never writes it, so the two compose
        // rather than one silently discarding the other.
        setLevelDetail(3);
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(3);
        expect(resolveLevelDetail(DESKTOP_RUNG)).toBe(3);
    });

    it('lets a coarse tier win over a finer stored floor', () => {
        // A device whose rung asks for 3 must get 3 even though a stale menu choice of 1
        // is on disk — max, not "stored wins".
        setLevelDetail(1);
        expect(resolveLevelDetail(3)).toBe(3);
    });

    it('composes two coarsening mechanisms by MAX, never by sum', () => {
        // A crash rescue landed on 3 and the tier independently asks for 1. Adding them
        // would drop the device to 4 for one problem; the honest answer is the coarser of
        // the two opinions.
        setLevelDetail(3);
        expect(resolveLevelDetail(1)).toBe(3);
    });

    it('lets ?lod= override even a stored choice', () => {
        // The override is for testing a tier on a device that has already settled on another
        // one — including one an automatic downgrade chose.
        setLevelDetail(1);
        withUrl('/?lod=4', () => expect(resolveLevelDetail(MOBILE_RUNG)).toBe(4));
    });

    it('falls back to the tier once a stored floor is cleared', () => {
        setLevelDetail(4);
        clearLevelDetail();
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(1);
        expect(resolveLevelDetail(DESKTOP_RUNG)).toBe(0);
    });

    it('survives a stored value that is nonsense', () => {
        // Hand-edited, or written by an older build with a different scale. A bad value must
        // not fail a level load.
        localStorage.setItem('bm.levelDetail', 'banana');
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(1);
        localStorage.setItem('bm.levelDetail', '17');
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(MAX_LEVEL_DETAIL);
    });
});

describe('one-strike crash downgrade', () => {
    beforeEach(() => {
        clearLevelDetail();
        localStorage.removeItem('bm.levelDetail.loading');
        resetDowngradeCheckForTests();
    });

    it('drops TWO tiers when a previous load never finished', () => {
        // The marker is what a killed process leaves behind: no catch, no finally and no
        // event runs, so its mere survival in storage is the whole signal.
        setLevelDetail(1);
        noteLevelLoadStarted();
        resetDowngradeCheckForTests(); // stand in for the reload
        expect(applyPendingDowngrade(MOBILE_RUNG)).toBe(3);
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(3);
    });

    it('leaves the tier alone when the load completed', () => {
        setLevelDetail(1);
        noteLevelLoadStarted();
        noteLevelLoadFinished();
        resetDowngradeCheckForTests();
        expect(applyPendingDowngrade(MOBILE_RUNG)).toBeNull();
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(1);
    });

    it('rescues a device that has never stored a tier', () => {
        // The common case: a phone dies on its first ever load, on its tier's own rung.
        noteLevelLoadStarted();
        resetDowngradeCheckForTests();
        expect(applyPendingDowngrade(MOBILE_RUNG)).toBe(3); // mobile default 1 -> 3
    });

    it('drops from the rung it actually died on, not an assumed one', () => {
        // Reading the mobile rung unconditionally would send a crashed desktop to 2 when
        // it had never been past 0.
        noteLevelLoadStarted();
        resetDowngradeCheckForTests();
        expect(applyPendingDowngrade(DESKTOP_RUNG)).toBe(2); // desktop default 0 -> 2
    });

    it('runs at most once per page, so one crash costs exactly one downgrade', () => {
        // resolveLevelDetail is called several times per load (file choice, then the load
        // planner). If each one downgraded, a single crash would ratchet to the floor.
        noteLevelLoadStarted();
        resetDowngradeCheckForTests();
        expect(resolveLevelDetail(DESKTOP_RUNG)).toBe(2);
        expect(resolveLevelDetail(DESKTOP_RUNG)).toBe(2);
        expect(applyPendingDowngrade(DESKTOP_RUNG)).toBeNull();
    });

    it('clamps the two-step drop to the coarsest tier', () => {
        // 3 + 2 is 5, which is not a tier. Landing on 4 is still a real downgrade, so it
        // must clamp rather than bail out the way an exhausted tier does.
        setLevelDetail(3);
        noteLevelLoadStarted();
        resetDowngradeCheckForTests();
        expect(applyPendingDowngrade(MOBILE_RUNG)).toBe(MAX_LEVEL_DETAIL);
    });

    it('stops at the coarsest tier instead of running off the end', () => {
        setLevelDetail(MAX_LEVEL_DETAIL);
        noteLevelLoadStarted();
        resetDowngradeCheckForTests();
        expect(applyPendingDowngrade(MOBILE_RUNG)).toBeNull();
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(MAX_LEVEL_DETAIL);
    });

    it('writes no marker under ?lod=, so a deliberate test cannot ratchet the setting', () => {
        // Testing tier 1 on a device that dies must not also rewrite what that device
        // uses when the flag is gone.
        setLevelDetail(1);
        withUrl('/?lod=0', () => noteLevelLoadStarted());
        resetDowngradeCheckForTests();
        expect(applyPendingDowngrade(MOBILE_RUNG)).toBeNull();
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(1);
    });

    it('treats leaving the page as a clean exit, not a crash', () => {
        // Otherwise refreshing mid-load is indistinguishable from dying mid-load, and a
        // healthy device ratchets down every time someone reloads.
        setLevelDetail(1);
        noteLevelLoadStarted();
        window.dispatchEvent(new Event('pagehide'));
        resetDowngradeCheckForTests();
        expect(applyPendingDowngrade(MOBILE_RUNG)).toBeNull();
        expect(resolveLevelDetail(MOBILE_RUNG)).toBe(1);
    });
});
