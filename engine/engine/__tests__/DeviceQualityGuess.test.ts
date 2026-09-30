/**
 * The static starting guess.
 *
 * Every case is a named device, because the thing that goes wrong with a table like this
 * is not the arithmetic — it is someone reading a threshold out of context and "tidying"
 * it. A row that says "iPhone stuck on iOS 15" survives that; a row that says
 * "iosMajorVersion <= 15" does not.
 *
 * Two of these are load-bearing beyond their own case: the automation guard (without it,
 * every CI screenshot ships at the rescue rung) and the all-null row (which is what Safari
 * actually looks like, since it exposes no deviceMemory at all).
 */
import { guessStartingTier, deviceSignature, type DeviceSignals } from 'engine/DeviceQualityGuess.js';

/** A device with nothing known about it — every case overrides only what it means to say. */
const unknown = (over: Partial<DeviceSignals>): DeviceSignals => ({
    isMobile: false,
    automation: false,
    webGpuAvailable: false,
    logicalCores: null,
    deviceMemoryGb: null,
    devicePixelRatio: 1,
    screenMinCss: 1080,
    platform: 'other',
    iosMajorVersion: null,
    gpuRenderer: null,
    ...over,
});

describe('static device tier guess', () => {
    describe('automation', () => {
        it('gives every automated browser the full look, whatever it is rendering on', () => {
            // Headless Chrome renders on SwiftShader unless forced (cli/src/browser-gl.ts),
            // so without this rule the software-rasteriser rule below would put every
            // `bitmagic verify` run at the rescue rung — and a project with no cover art
            // publishes its verify screenshot as the game's thumbnail.
            expect(guessStartingTier(unknown({
                automation: true,
                gpuRenderer: 'google swiftshader',
            }))).toBe('ultra');
        });

        it('still demotes the same signals when a real user has them', () => {
            expect(guessStartingTier(unknown({ gpuRenderer: 'google swiftshader' }))).toBe('minimal');
        });

        it('overrides the mobile branch too', () => {
            expect(guessStartingTier(unknown({
                automation: true, isMobile: true, platform: 'ios', iosMajorVersion: 14,
            }))).toBe('ultra');
        });
    });

    describe('desktop', () => {
        it('starts an unrecognised desktop where an untiered build already puts it', () => {
            expect(guessStartingTier(unknown({}))).toBe('ultra');
        });

        it('demotes a software rasteriser to the rescue rung', () => {
            for (const name of ['google swiftshader', 'llvmpipe (llvm 15.0.7, 256 bits)', 'microsoft basic render driver']) {
                expect(guessStartingTier(unknown({ gpuRenderer: name }))).toBe('minimal');
            }
        });

        it('demotes a Chromebook two rungs on two agreeing weak signals', () => {
            expect(guessStartingTier(unknown({ logicalCores: 4, deviceMemoryGb: 4 }))).toBe('medium');
        });

        it('demotes a 4-core Retina MacBook only one rung', () => {
            // hardwareConcurrency is a poor GPU proxy — this machine may well have a
            // discrete GPU — so one signal costs only SSR and a shadow-map step, both of
            // which measurement can hand back within seconds.
            expect(guessStartingTier(unknown({
                logicalCores: 4, deviceMemoryGb: null, devicePixelRatio: 2,
            }))).toBe('high');
        });

        it('demotes a low-memory Windows laptop one rung', () => {
            expect(guessStartingTier(unknown({ logicalCores: 8, deviceMemoryGb: 4 }))).toBe('high');
        });

        it('does not demote a capable machine for lacking WebGPU', () => {
            // Firefox and pre-26 Safari expose no navigator.gpu and are perfectly capable;
            // capping their pixel ratio for it would soften a Retina display for nothing.
            expect(guessStartingTier(unknown({
                webGpuAvailable: false, logicalCores: 16, deviceMemoryGb: 8,
            }))).toBe('ultra');
        });

        it('never demotes a desktop below medium on a guess alone', () => {
            const worst = guessStartingTier(unknown({ logicalCores: 2, deviceMemoryGb: 0.5 }));
            expect(worst).toBe('medium');
        });
    });

    describe('mobile', () => {
        const phone = (over: Partial<DeviceSignals>): DeviceSignals =>
            unknown({ isMobile: true, devicePixelRatio: 3, screenMinCss: 393, ...over });

        it('starts an unrecognised phone where an untiered build already puts it', () => {
            expect(guessStartingTier(phone({ platform: 'android' }))).toBe('low');
            expect(guessStartingTier(phone({ platform: 'ios' }))).toBe('low');
        });

        it('demotes an iPhone that cannot leave iOS 15', () => {
            // iOS 26 runs on the iPhone 11 (A13) and later, so being stuck on 15 is a lower
            // bound on hardware age — and one that cannot rot the wrong way, since a newer
            // phone can never be stuck on an older OS.
            expect(guessStartingTier(phone({
                platform: 'ios', iosMajorVersion: 15, screenMinCss: 375, devicePixelRatio: 2,
            }))).toBe('minimal');
        });

        it('demotes an iPhone SE-1-sized body', () => {
            expect(guessStartingTier(phone({
                platform: 'ios', iosMajorVersion: 15, screenMinCss: 320, devicePixelRatio: 2,
            }))).toBe('minimal');
        });

        it('demotes a 4-core Android and a 2 GB phone', () => {
            expect(guessStartingTier(phone({ platform: 'android', logicalCores: 4 }))).toBe('minimal');
            expect(guessStartingTier(phone({ platform: 'android', logicalCores: 8, deviceMemoryGb: 2 }))).toBe('minimal');
        });

        it('promotes a modern iPhone one rung on OS-implied silicon plus body size', () => {
            expect(guessStartingTier(phone({
                platform: 'ios', iosMajorVersion: 26, webGpuAvailable: true, screenMinCss: 393,
            }))).toBe('medium');
        });

        it('leaves an older-bodied iPhone alone even with WebGPU', () => {
            expect(guessStartingTier(phone({
                platform: 'ios', iosMajorVersion: 26, webGpuAvailable: true,
                screenMinCss: 375, devicePixelRatio: 2,
            }))).toBe('low');
        });

        it('promotes a flagship Android one rung', () => {
            expect(guessStartingTier(phone({
                platform: 'android', webGpuAvailable: true, logicalCores: 8, deviceMemoryGb: 8,
            }))).toBe('medium');
        });

        it('never promotes a phone above medium on a guess alone', () => {
            const best = guessStartingTier(phone({
                platform: 'android', webGpuAvailable: true, logicalCores: 16, deviceMemoryGb: 16,
            }));
            expect(best).toBe('medium');
        });
    });

    describe('absent signals', () => {
        it('lands on the platform default rather than throwing when nothing is known', () => {
            // This IS the Safari row: no deviceMemory, no usable renderer string. A guess
            // that threw here would take the load with it.
            expect(guessStartingTier(unknown({ screenMinCss: 0, devicePixelRatio: 0 }))).toBe('ultra');
            expect(guessStartingTier(unknown({
                isMobile: true, platform: 'ios', screenMinCss: 0, devicePixelRatio: 0,
            }))).toBe('low');
        });

        it('does not read a zero screen size as a tiny phone', () => {
            // An emulated viewport can report 0; that is "unknown", not "320 pt or less".
            expect(guessStartingTier(unknown({ isMobile: true, platform: 'android', screenMinCss: 0 }))).toBe('low');
        });
    });

    describe('device signature', () => {
        it('is stable for the same device', () => {
            const s = unknown({ logicalCores: 8, platform: 'android', isMobile: true });
            expect(deviceSignature(s)).toBe(deviceSignature({ ...s }));
        });

        it('changes when the conclusion should no longer be trusted', () => {
            const base = unknown({ logicalCores: 8, deviceMemoryGb: 8 });
            const sig = deviceSignature(base);
            // A browser update that ships a working WebGPU backend SHOULD invalidate a
            // tier measured without one.
            expect(deviceSignature({ ...base, webGpuAvailable: true })).not.toBe(sig);
            expect(deviceSignature({ ...base, gpuRenderer: 'apple m4' })).not.toBe(sig);
            expect(deviceSignature({ ...base, logicalCores: 4 })).not.toBe(sig);
            expect(deviceSignature({ ...base, isMobile: true })).not.toBe(sig);
        });
    });
});
