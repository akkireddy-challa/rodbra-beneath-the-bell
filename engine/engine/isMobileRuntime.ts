/**
 * Detects whether this runtime is a mobile or small-screen touch device.
 *
 * Single source of truth for the UA-sniff + touch + screen-size heuristic.
 * Handles three cases:
 *   1. Explicit mobile UA (Android, iPhone, pre-iPadOS-13 iPad, etc.)
 *   2. iPadOS 13+ which reports a desktop Macintosh UA but has touch.
 *   3. Other tablets: touch-capable + small screen (< 1366px on both axes)
 *      AND primary pointer is coarse (no precision pointer attached).
 *
 * Excludes desktop touch monitors (large screen, no mobile UA hit) and
 * convertibles like Surface Pro with the Type Cover attached (Windows UA,
 * may report small CSS screen at high DPI scaling, but primary pointer is
 * a trackpad/mouse so `pointer: coarse` is false).
 *
 * NOTE: keep in sync with creator/src/utils/mobileDetection.ts — the creator
 * is a separate TypeScript project and cannot import from game/src/engine/,
 * so this helper is intentionally duplicated there.
 */
export function isMobileRuntime(): boolean {
    // Explicit platform override from the iframe URL (?platform=mobile|desktop).
    // The creator sets this when previewing a game whose primaryPlatform is 'mobile'
    // so the whole engine boots in mobile mode (touch controls, mobile HUD, no
    // pointer-lock / keyboard-controls hints) even on a desktop browser. Absent
    // param falls through to real device detection; published/standalone games
    // never carry the param, so they are unaffected.
    const override = readPlatformOverride();
    if (override !== null) return override;

    // No browser at all (node tests, workers, headless tooling): nothing here can
    // answer the question, and "not mobile" is the answer that leaves every caller
    // on its full-detail path. Without this the UA/screen probes below throw, which
    // turns a capability QUERY into a crash for any code that runs outside a page —
    // `readPlatformOverride` already guards itself for the same reason.
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

    const ua = navigator.userAgent;
    const hasTouch = !!navigator.maxTouchPoints && navigator.maxTouchPoints > 0;

    // 1. Explicit mobile UA
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;

    // 2. iPadOS 13+ reports as Macintosh; disambiguate via touch capability.
    //    Real Macs don't have maxTouchPoints > 0 (the Touch Bar doesn't count).
    //    Without this branch, 12.9" iPad Pro (1366x1024) bypasses mobile
    //    orientation lock and HUD scaling. Do NOT "clean up" this branch.
    if (/Macintosh/i.test(ua) && hasTouch) return true;

    // 3. Other tablets: touch + small screen + primary pointer is coarse.
    //    The pointer-coarse gate excludes Surface Pro / convertibles with a
    //    Type Cover attached — their CSS screen can fall under 1366px at high
    //    DPI scaling but a trackpad/mouse is the primary pointer, so desktop
    //    controls are the right experience.
    const small = window.screen?.width < 1366 && window.screen?.height < 1366;
    // `matchMedia` is a capability probe, like the window/navigator check above: jsdom and
    // other non-browser hosts lack it, and "cannot determine the pointer" is not the same
    // as "the pointer is coarse". Without this, any code path that asks whether this is a
    // mobile runtime THROWS outside a real browser — which is a poor failure mode for a
    // question whose honest answer there is simply "no".
    const coarsePointer = typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches;
    return hasTouch && small && coarsePointer;
}

/**
 * Make ad-hoc touch-capability probes agree with a forced mobile platform.
 *
 * When the creator previews a mobile-platform game it appends
 * `?platform=mobile`, which forces {@link isMobileRuntime} to true — but game
 * code frequently probes the device directly (`'ontouchstart' in window`,
 * `navigator.maxTouchPoints > 0`) to pick its mobile vs desktop layout, hints,
 * and popups. On a desktop browser those probes stay false, so the preview
 * silently renders the desktop variant of game UI while a real phone renders
 * the mobile one (e.g. HUD pills anchored to different corners).
 *
 * Installing own-property shims (a maxTouchPoints getter and an ontouchstart
 * slot) makes those probes match the override. Must run before any game code.
 * No-op without the override or on devices with real touch support;
 * published/standalone games never carry the param, so they are unaffected.
 */
export function installForcedMobileTouchShim(): void {
    if (readPlatformOverride() !== true) return;
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
    try {
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
    } catch {
        // Best-effort: an exotic environment may expose maxTouchPoints as a
        // non-configurable own property. The ontouchstart shim below still
        // satisfies the common `'ontouchstart' in window || maxTouchPoints > 0`.
    }
    (window as Window & { ontouchstart?: ((ev: TouchEvent) => void) | null }).ontouchstart = null;
}

/**
 * Reads the `?platform=` override from the current iframe URL.
 * Returns `true` for `mobile`, `false` for `desktop`, `null` when the param is
 * absent or unrecognized (real device detection should apply).
 */
function readPlatformOverride(): boolean | null {
    try {
        const platform = new URLSearchParams(window.location.search).get('platform');
        if (platform === 'mobile') return true;
        if (platform === 'desktop') return false;
    } catch {
        // window.location unavailable (e.g. non-browser test env)
    }
    return null;
}
