/**
 * The static starting guess for a device's quality tier — signals a browser will answer
 * synchronously, turned into an opening rung that measurement then corrects.
 *
 * TWO ENGINE COMMENTS EXPLICITLY REJECT A DEVICE TABLE, and they are right about the thing
 * they reject. `levels/levelResolve.ts` ("there is no reliable way to ask an iPhone how
 * much memory it has … so a table would be a guess that goes stale with every new
 * handset") and `ShadowCamera.ts` ("trying to detect specific Adreno chips via
 * UNMASKED_RENDERER_WEBGL doesn't work under WebGPU") are both describing a table of
 * CEILINGS — one that says "this chip is worth at most tier X". That kind of table rots by
 * construction: the moment it says "Adreno 750 ⇒ high", an Adreno 850 ships, reads as
 * unknown, and someone has to remember to update it.
 *
 * This is not that table, for two reasons:
 *
 *  1. It only picks a STARTING rung. `DeviceGpuProbe` measures the real scene a few
 *     hundred milliseconds later and the in-play tuner keeps measuring after that, and
 *     both persist their correction. A wrong guess costs one load, not a classification.
 *  2. It contains only LOWER bounds — things that are certainly weak. New hardware can
 *     only ever fail to match a "certainly weak" rule and land on the neutral default, so
 *     the table cannot rot in the dangerous direction. There is no rule anywhere below
 *     that caps a device it does not recognise.
 *
 * Consequently the guess is conservative toward what ships today: an unrecognised desktop
 * starts at `ultra` and an unrecognised phone starts at `low`, which is exactly the
 * untiered behaviour. The worst case for the static half is the status quo.
 *
 * It must also be SYNCHRONOUS. `GameEngine` sets the renderer's pixel ratio in its
 * constructor, before `WebGPURenderer.init()` has resolved — so `getActiveBackend()`, which
 * is the honest answer to "did WebGPU actually start", is not available yet and belongs to
 * the probe instead. `navigator.gpu` is the synchronous stand-in used here.
 */

import type { DeviceQualityTier } from 'engine/DeviceQuality.js';

/**
 * Everything the guess is allowed to look at, passed in rather than probed so every
 * threshold below is unit-testable against a fabricated handset.
 */
export interface DeviceSignals {
    isMobile: boolean;
    /** `navigator.webdriver` — Playwright, `bitmagic verify`, lab-smoke, CI. See rule 0. */
    automation: boolean;
    /**
     * `navigator.gpu !== undefined`. Presence is a weak POSITIVE only; absence proves
     * nothing (Firefox and pre-26 Safari are perfectly capable without it).
     */
    webGpuAvailable: boolean;
    /** `navigator.hardwareConcurrency`, or null where it is not exposed. */
    logicalCores: number | null;
    /** `navigator.deviceMemory` in GB. Chromium only — always null on Safari. */
    deviceMemoryGb: number | null;
    devicePixelRatio: number;
    /** `min(screen.width, screen.height)` in CSS px — a body-size bucket, not a resolution. */
    screenMinCss: number;
    platform: 'ios' | 'android' | 'other';
    /** iOS major version from the UA, or null. A lower bound on hardware age — see below. */
    iosMajorVersion: number | null;
    /** `UNMASKED_RENDERER_WEBGL`, lowercased. Desktop only; null everywhere else. */
    gpuRenderer: string | null;
}

/**
 * Renderer strings that mean "there is no GPU here".
 *
 * The one rule in this file that is a CERTAINTY rather than a guess, and the one that
 * cannot go stale: these strings are stable and a new GPU never starts matching them.
 * `cli/src/browser-gl.ts` measured the gap at 0.29 ms vs 97.8 ms per frame.
 */
const SOFTWARE_RENDERERS = ['swiftshader', 'llvmpipe', 'software', 'microsoft basic render'];

/**
 * The rung an automated browser gets, regardless of what it is running on.
 *
 * NOT an optimisation — a correctness rule, and the reason it is first. Headless Chrome
 * renders on SwiftShader unless explicitly forced (`cli/src/browser-gl.ts`), so without
 * this the software-rasteriser rule below would put every `bitmagic verify`, lab-smoke and
 * CI run at `minimal`: 0.75 pixel ratio, matte materials, no shadows, no post. A project
 * with no cover art publishes its verify screenshot as the game's thumbnail, so those
 * frames would ship. Same reasoning as `DEFAULT_MATERIAL_QUALITY` being `high` so that an
 * asset preview shows the asset's full look.
 */
const AUTOMATION_TIER: DeviceQualityTier = 'ultra';

/**
 * The opening rung for `signals`. Pure.
 *
 * Desktop starts at `ultra` and is demoted only on evidence; mobile starts at `low` — what
 * every phone gets today — and moves either way only on a signal that is hard to be wrong
 * about. Nothing here promotes a phone above `medium` or demotes a desktop below `medium`,
 * except a software rasteriser: those are measurement's calls to make, not a table's.
 */
export function guessStartingTier(s: DeviceSignals): DeviceQualityTier {
    if (s.automation) return AUTOMATION_TIER;
    return s.isMobile ? guessMobileTier(s) : guessDesktopTier(s);
}

function guessDesktopTier(s: DeviceSignals): DeviceQualityTier {
    const gpu = s.gpuRenderer;
    if (gpu !== null && SOFTWARE_RENDERERS.some((n) => gpu.includes(n))) return 'minimal';
    // `deviceMemory` and `hardwareConcurrency` are both poor GPU proxies on their own — a
    // 4-core MacBook with a discrete GPU trips the core rule — so one signal moves ONE
    // rung, into a tier whose only losses are wet-weather SSR and one shadow-map step.
    // Two independent weak signals agreeing is what a Chromebook looks like, and that
    // earns the pixel-ratio cap.
    const lowMemory = s.deviceMemoryGb !== null && s.deviceMemoryGb <= 4;
    const fewCores = s.logicalCores !== null && s.logicalCores <= 4;
    if (lowMemory && fewCores) return 'medium';
    if (lowMemory || fewCores) return 'high';
    return 'ultra';
}

/**
 * Phones, where the honest answer is a three-bucket split.
 *
 * THE APPLE PROBLEM, stated plainly: Safari reports `Apple GPU` for everything from an
 * iPhone 8 to an M4, so `UNMASKED_RENDERER_WEBGL` is worthless on Apple hardware and
 * `deviceMemory` is absent there entirely. That is exactly why the old Unity build carried
 * the third-party 51Degrees canvas-fingerprint library. We are not taking that dependency,
 * so the signals that remain are:
 *
 *   iosMajorVersion   A LOWER BOUND on hardware age, via Apple's own support matrix. It
 *                     cannot rot in the wrong direction: a newer phone can never be stuck
 *                     on an older OS. The single best Apple signal available.
 *   navigator.gpu     On iOS implies iPadOS/iOS 26+, hence A13 or later. One-way.
 *   screenMinCss      A coarse body-family bucket. 320 pt is an SE-1 body; 390+ is an
 *                     iPhone 12 or later. Correlates with silicon on Apple's line.
 *
 * This cannot tell an iPhone 12 from a 16 Pro Max and does not try. Expect roughly 70-80%
 * agreement with a measured tier — and note the errors are asymmetric by construction: a
 * mis-bucketed iPhone starts at `low`, which is what ships today, so the failure mode is
 * "no improvement", never "a regression".
 */
function guessMobileTier(s: DeviceSignals): DeviceQualityTier {
    const tinyMemory = s.deviceMemoryGb !== null && s.deviceMemoryGb <= 2;
    const weakAndroid = s.platform === 'android' && s.logicalCores !== null && s.logicalCores <= 4;
    // iOS 26 runs on the iPhone 11 (A13) and later, so a device stuck on 15 is an A11/A12
    // or older — the generations the old Unity tiering also put in its bottom buckets.
    const oldIos = s.platform === 'ios' && s.iosMajorVersion !== null && s.iosMajorVersion <= 15;
    const tinyScreen = s.screenMinCss > 0 && s.screenMinCss <= 320;
    if (tinyMemory || weakAndroid || oldIos || tinyScreen) return 'minimal';

    const modernIphone = s.platform === 'ios' && s.webGpuAvailable && s.screenMinCss >= 390;
    const flagshipAndroid = s.platform === 'android'
        && s.webGpuAvailable
        && s.logicalCores !== null && s.logicalCores >= 8
        && (s.deviceMemoryGb === null || s.deviceMemoryGb >= 6);
    if (modernIphone || flagshipAndroid) return 'medium';

    return 'low';
}

/**
 * A short, stable fingerprint of what this device IS, so a stored conclusion can be
 * recognised as being about something else.
 *
 * Deliberately excludes anything that varies within a session (window size, orientation)
 * and includes everything a conclusion depends on — a browser update that ships a working
 * WebGPU backend, or a user switching browsers, SHOULD invalidate a measured tier.
 */
export function deviceSignature(s: DeviceSignals): string {
    const parts = [
        s.isMobile ? 'm' : 'd',
        s.platform,
        s.iosMajorVersion ?? '-',
        s.webGpuAvailable ? 'gpu' : 'nogpu',
        s.logicalCores ?? '-',
        s.deviceMemoryGb ?? '-',
        s.devicePixelRatio,
        s.screenMinCss,
        s.gpuRenderer ?? '-',
    ].join('|');
    // FNV-1a: short, dependency-free, and this is a change detector rather than a hash
    // anyone relies on for uniqueness.
    let h = 0x811c9dc5;
    for (let i = 0; i < parts.length; i++) {
        h ^= parts.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

/**
 * Read the signals from this browser. The only impure function here.
 *
 * Every probe is individually guarded: this runs on the boot path before anything is set
 * up, and "cannot determine a signal" must degrade to null, never to a throw. Outside a
 * browser (tests, workers, the offscreen thumbnail renderer) it reports automation, which
 * lands on `AUTOMATION_TIER` — the full look, which is what those contexts want.
 */
export function readDeviceSignals(isMobile: boolean): DeviceSignals {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
        return {
            isMobile,
            automation: true,
            webGpuAvailable: false,
            logicalCores: null,
            deviceMemoryGb: null,
            devicePixelRatio: 1,
            screenMinCss: 0,
            platform: 'other',
            iosMajorVersion: null,
            gpuRenderer: null,
        };
    }

    const ua = navigator.userAgent;
    const platform = detectPlatform(ua);
    return {
        isMobile,
        automation: navigator.webdriver === true,
        webGpuAvailable: (navigator as { gpu?: unknown }).gpu !== undefined,
        logicalCores: finiteOrNull(navigator.hardwareConcurrency),
        deviceMemoryGb: finiteOrNull((navigator as { deviceMemory?: number }).deviceMemory),
        devicePixelRatio: finiteOrNull(window.devicePixelRatio) ?? 1,
        screenMinCss: Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0),
        platform,
        iosMajorVersion: platform === 'ios' ? readIosMajorVersion(ua) : null,
        // Desktop only: the string is worthless on Apple hardware, and a spare GL context
        // is most expensive on exactly the devices least able to afford one.
        gpuRenderer: isMobile ? null : readGpuRenderer(),
    };
}

function finiteOrNull(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function detectPlatform(ua: string): DeviceSignals['platform'] {
    if (/Android/i.test(ua)) return 'android';
    // Includes the iPadOS-13+ case, which reports a Macintosh UA: `isMobileRuntime` has
    // already resolved that via touch, and the OS version parse below works either way.
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 0)) return 'ios';
    return 'other';
}

/** `OS 17_4` (mobile Safari) or `Version/17.4` (the iPadOS desktop-UA case). */
function readIosMajorVersion(ua: string): number | null {
    const os = /OS (\d+)[_.]/.exec(ua);
    if (os) return Number.parseInt(os[1]!, 10);
    const version = /Version\/(\d+)\./.exec(ua);
    if (version) return Number.parseInt(version[1]!, 10);
    return null;
}

/**
 * The unmasked renderer string from a throwaway 1x1 context, immediately released.
 *
 * Returns null in every failure case, and null is a fully supported input: Firefox with
 * `privacy.resistFingerprinting` hides the extension, some browsers return only the masked
 * string, and a context may simply not be creatable. The only rule that reads this treats
 * a match as evidence and a non-match — including null — as no evidence at all.
 */
function readGpuRenderer(): string | null {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const gl = canvas.getContext('webgl2');
        if (!gl) return null;
        try {
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            if (!info) return null;
            const raw: unknown = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
            return typeof raw === 'string' ? raw.toLowerCase() : null;
        } finally {
            // Contexts are a scarce per-page resource and the browser drops the OLDEST
            // when it runs out — leaking this one would eventually cost the game its own.
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
    } catch {
        return null;
    }
}
