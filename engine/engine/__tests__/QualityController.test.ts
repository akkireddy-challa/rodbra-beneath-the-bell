/** @jest-environment jsdom */
import type * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import * as creatorMode from 'engine/CreatorMode.js';
import * as deviceGuess from 'engine/DeviceQualityGuess.js';
import {
    activeDeviceQualityTier, activeDeviceSignature, adoptDeviceQualityTier,
    readAutoDeviceTier, refreshActiveDeviceQuality, setAutoDeviceTier, setQualityPreference,
    type QualityPreference,
} from 'engine/DeviceQuality.js';
import { applyDeviceTierLive } from 'engine/quality/DeviceQualityApply.js';
import { probeTier, runGpuProbe, type GpuProbeResult } from 'engine/quality/DeviceGpuProbe.js';
import { QualityController, QUALITY_SETTLE_FRAMES } from 'engine/quality/QualityController.js';

jest.mock('engine/CreatorMode.js', () => ({ __esModule: true, isCreatorMode: false }));
jest.mock('engine/quality/DeviceQualityApply.js', () => ({ applyDeviceTierLive: jest.fn() }));
jest.mock('engine/quality/DeviceGpuProbe.js', () => ({
    ...jest.requireActual<typeof import('engine/quality/DeviceGpuProbe.js')>('engine/quality/DeviceGpuProbe.js'),
    runGpuProbe: jest.fn(),
}));

const probe = jest.mocked(runGpuProbe);
const apply = jest.mocked(applyDeviceTierLive);

/** Real controller, sampler, policy and storage; only drawing and GPU timing are stubbed. */
function session(backend: 'webgpu' | 'webgl' = 'webgpu', crashRescued = false) {
    const info: {
        programs?: unknown[];
        memory: { geometries: number; textures: number; programs?: number };
    } = { memory: { geometries: 0, textures: 0 } };
    if (backend === 'webgpu') info.memory.programs = 0;
    else info.programs = [];
    const renderer = { info } as unknown as THREE.WebGLRenderer;
    let targetFps = 60;
    const engineState = {
        renderer, getTargetFps: () => targetFps, renderFrameNow: jest.fn(),
        gameLoadComplete: true, renderActive: true, isGameplayRunning: () => true,
        warmupCompileInFlight: false, levelManager: null as { isLoading(): boolean } | null,
    };
    const engine = engineState as unknown as GameEngine;
    const controller = new QualityController(engine, crashRescued);
    let time = 0;
    controller.recordFrame(time, 0, 0, 0);
    return {
        controller, renderer, engine, engineState, info,
        setTargetFps(fps: number) { targetFps = fps; },
        setReady(value: boolean) { engineState.gameLoadComplete = value; },
        gap(ms: number) {
            time += ms;
            controller.recordFrame(time, ms, 2, 1);
        },
        // A 40 FPS stream: steady slow gameplay, independent of GPU submission time.
        advance(ms: number, beforeFrame: (time: number) => void = () => {}, gapMs = 25) {
            const end = time + ms;
            while (time < end) {
                time += gapMs;
                beforeFrame(time);
                controller.recordFrame(time, gapMs, 2, 1);
            }
        },
        choose(pref: QualityPreference) {
            setQualityPreference(pref);
            refreshActiveDeviceQuality();
            applyDeviceTierLive(engine, activeDeviceQualityTier(), pref === 'auto' ? 'auto' : 'pinned');
        },
    };
}

beforeEach(() => {
    window.history.replaceState({}, '', '/');
    setQualityPreference('auto');
    refreshActiveDeviceQuality();
    jest.spyOn(deviceGuess, 'readDeviceSignals').mockReturnValue({
        isMobile: false, automation: true, webGpuAvailable: true,
        logicalCores: 8, deviceMemoryGb: 8, devicePixelRatio: 2,
        screenMinCss: 900, platform: 'other', iosMajorVersion: null, gpuRenderer: null,
    });
    jest.spyOn(performance, 'now').mockReturnValue(0);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    probe.mockReset();
    probe.mockImplementation(async (_renderer, _render, from) => ({
        msPerFrame: 10, tier: probeTier(10, from),
    }));
    apply.mockReset();
    apply.mockImplementation((_engine, tier, source) => {
        adoptDeviceQualityTier(tier, source);
        return [];
    });
});

afterEach(() => {
    jest.restoreAllMocks();
    setQualityPreference('auto');
    refreshActiveDeviceQuality();
});

describe('diagnostic load-time probe and gameplay budget', () => {
    it('measures once without reducing or persisting quality during loading', async () => {
        const s = session();
        s.setReady(false);
        for (let level = 0; level < 4; level++) await s.controller.runProbe(s.renderer);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(s.controller.debugInfo().probeMsPerFrame).toBe(10);
        expect(activeDeviceQualityTier()).toBe('ultra');
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        expect(readAutoDeviceTier(activeDeviceSignature())).toBeNull();
        expect(apply).not.toHaveBeenCalled();
    });

    it('reserves the two-step limit for gameplay, even after a manual reset', async () => {
        const s = session();
        await s.controller.runProbe(s.renderer);
        s.advance(12_000);
        expect(activeDeviceQualityTier()).toBe('high');
        s.advance(100_000);
        expect(activeDeviceQualityTier()).toBe('medium');
        expect(s.controller.debugInfo().downgradesUsed).toBe(2);
        s.choose('ultra');
        s.choose('auto');
        s.advance(100_000);
        expect(activeDeviceQualityTier()).toBe('ultra');
        expect(s.controller.debugInfo().downgradesUsed).toBe(2);
    });

    it('does not repeat calibration on a saved automatic tier on the next boot', async () => {
        setAutoDeviceTier('high', 'measure', activeDeviceSignature());
        refreshActiveDeviceQuality();
        const second = session();
        await second.controller.runProbe(second.renderer);
        expect(probe).not.toHaveBeenCalled();
        expect(activeDeviceQualityTier()).toBe('high');
        // The live monitor can still respond to sustained poor gameplay.
        second.advance(12_000);
        expect(activeDeviceQualityTier()).toBe('medium');
    });

    it('does not add a probe correction after gameplay already lowered the tier', async () => {
        const s = session();
        s.advance(12_000);
        await s.controller.runProbe(s.renderer);
        expect(probe).not.toHaveBeenCalled();
        expect(activeDeviceQualityTier()).toBe('high');
    });

    it('allows a fresh probe when ?quality=auto bypasses a stored conclusion', async () => {
        setAutoDeviceTier('minimal', 'probe', activeDeviceSignature());
        window.history.replaceState({}, '', '?quality=auto');
        refreshActiveDeviceQuality();
        const s = session();
        expect(activeDeviceQualityTier()).toBe('ultra');
        await s.controller.runProbe(s.renderer);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(activeDeviceQualityTier()).toBe('ultra');
    });

    it.each(['expired', 'different device'] as const)('recalibrates an %s automatic record', async (reason) => {
        setAutoDeviceTier('minimal', 'probe', reason === 'expired' ? activeDeviceSignature() : 'another-device');
        if (reason === 'expired') jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86_400_000);
        refreshActiveDeviceQuality();
        const s = session();
        await s.controller.runProbe(s.renderer);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(activeDeviceQualityTier()).toBe('ultra');
    });

    it('does not spend budget on a failed probe, and keeps monitoring gameplay', async () => {
        probe.mockResolvedValueOnce(null);
        const s = session();
        await s.controller.runProbe(s.renderer);
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        s.advance(60_000);
        expect(activeDeviceQualityTier()).toBe('medium');
        expect(s.controller.debugInfo().downgradesUsed).toBe(2);
    });

    it('does not start concurrent probes or count their rendering as gameplay', async () => {
        let finish!: (result: GpuProbeResult) => void;
        probe.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        const s = session();
        const pending = s.controller.runProbe(s.renderer);
        await s.controller.runProbe(s.renderer);
        s.advance(30_000);
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        finish({ msPerFrame: 10, tier: 'high' });
        await pending;
        expect(probe).toHaveBeenCalledTimes(1);
        expect(activeDeviceQualityTier()).toBe('ultra');
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        s.advance(12_000);
        expect(activeDeviceQualityTier()).toBe('high');
    });

    it('leaves Low → Minimal to sustained gameplay measurements', async () => {
        adoptDeviceQualityTier('low', 'auto');
        const s = session();
        await s.controller.runProbe(s.renderer);
        expect(activeDeviceQualityTier()).toBe('low');
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        s.advance(12_000);
        expect(activeDeviceQualityTier()).toBe('minimal');
    });

    it('skips the probe after crash rescue and permits only one gameplay reduction', async () => {
        const s = session('webgpu', true);
        await s.controller.runProbe(s.renderer);
        s.advance(12_000);
        expect(activeDeviceQualityTier()).toBe('ultra');
        s.advance(100_000);
        expect(probe).not.toHaveBeenCalled();
        expect(activeDeviceQualityTier()).toBe('high');
        expect(s.controller.debugInfo().downgradesUsed).toBe(1);
    });
});

describe('gameplay sampling lifecycle', () => {
    it.each(['initial load', 'paused/menu', 'hidden', 'warmup', 'level switch'])('does not sample during %s', (phase) => {
        const s = session();
        if (phase === 'initial load') s.engineState.gameLoadComplete = false;
        if (phase === 'paused/menu') s.engineState.isGameplayRunning = () => false;
        if (phase === 'hidden') s.engineState.renderActive = false;
        if (phase === 'warmup') s.engineState.warmupCompileInFlight = true;
        if (phase === 'level switch') s.engineState.levelManager = { isLoading: () => true };
        s.advance(120_000);
        expect(s.controller.debugInfo().lastWindowFps).toBeNull();
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        expect(activeDeviceQualityTier()).toBe('ultra');
    });

    it('does not push a low-tier device to Minimal during intermittent loading stalls', () => {
        adoptDeviceQualityTier('low', 'default');
        const s = session();
        s.setReady(false);
        for (let window = 0; window < 20; window++) {
            s.advance(1000, () => {}, 1000 / 60);
            s.gap(2000);
        }
        expect(activeDeviceQualityTier()).toBe('low');
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
    });

    it('ignores arbitrarily long loading, then starts with discarded frames and fresh grace', () => {
        const s = session();
        s.setReady(false);
        s.advance(120_000, () => {}, 250);
        expect(s.controller.debugInfo().lastWindowFps).toBeNull();
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        expect(readAutoDeviceTier(activeDeviceSignature())).toBeNull();

        s.setReady(true);
        // Even startup frames that take seconds must not become bad windows.
        for (let i = 0; i < QUALITY_SETTLE_FRAMES; i++) s.gap(10_000);
        expect(s.controller.debugInfo().lastWindowFps).toBeNull();
        s.advance(9000);
        expect(activeDeviceQualityTier()).toBe('ultra');
        s.advance(3000);
        expect(activeDeviceQualityTier()).toBe('high');
    });

    it('clears pre-load bad windows and does not count a level switch against the device', () => {
        const s = session();
        s.advance(8500); // Two bad gameplay windows, one short of a downgrade.
        s.setReady(false);
        s.advance(30_000);
        expect(s.controller.debugInfo().lastWindowFps).toBeNull();
        s.setReady(true);
        s.advance(9000);
        expect(activeDeviceQualityTier()).toBe('ultra');
        s.advance(3000);
        expect(activeDeviceQualityTier()).toBe('high');
    });

    it('re-anchors after a load entirely between frames, without replenishing the session budget', () => {
        const s = session();
        s.advance(60_000);
        expect(s.controller.debugInfo().downgradesUsed).toBe(2);
        s.controller.resetSampling();
        s.gap(60_000);
        expect(s.controller.debugInfo().lastWindowFps).toBeNull();
        expect(s.controller.debugInfo().downgradesUsed).toBe(2);
        s.advance(60_000);
        expect(activeDeviceQualityTier()).toBe('medium');
    });

    it('keeps healthy gameplay at full detail after long loading gaps', () => {
        const s = session();
        s.setReady(false);
        s.advance(60_000, () => {}, 500);
        s.setReady(true);
        s.gap(20_000);
        s.advance(60_000, () => {}, 1000 / 60);
        expect(activeDeviceQualityTier()).toBe('ultra');
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        expect(s.controller.debugInfo().lastWindowFps).toBeCloseTo(60);
    });
});

describe('player choice and context gates', () => {
    it('does not mistake healthy pause/resume transitions for slow gameplay', () => {
        const s = session();
        for (let cycle = 0; cycle < 12; cycle++) {
            s.setTargetFps(30);
            for (let frame = 1; frame < 60; frame++) {
                s.controller.recordFrame(cycle * 2000 + frame * 1000 / 30, 1000 / 30, 2, 1);
            }
            s.setTargetFps(60);
            s.controller.recordFrame(cycle * 2000 + 2000 - 1000 / 60, 1000 / 60, 2, 1);
            s.controller.recordFrame((cycle + 1) * 2000, 1000 / 60, 2, 1);
        }
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        expect(activeDeviceQualityTier()).toBe('ultra');
    });

    it('stops on a pin, then resumes Auto with fresh grace and no stale bad streak', () => {
        const s = session();
        s.advance(8000); // Two bad windows, one short of a downgrade.
        s.choose('high');
        expect(s.controller.debugInfo().adapting).toBe(false);
        s.advance(30_000);
        expect(activeDeviceQualityTier()).toBe('high');
        expect(readAutoDeviceTier(activeDeviceSignature())).toBeNull();
        s.choose('auto');
        expect(s.controller.debugInfo().adapting).toBe(true);
        s.advance(9000);
        expect(activeDeviceQualityTier()).toBe('ultra');
        s.advance(3000);
        expect(activeDeviceQualityTier()).toBe('high');
    });

    it('can enter Auto when the session booted with a pin', () => {
        setQualityPreference('high');
        refreshActiveDeviceQuality();
        const s = session();
        s.advance(30_000);
        expect(activeDeviceQualityTier()).toBe('high');
        s.choose('auto');
        s.advance(12_000);
        expect(activeDeviceQualityTier()).toBe('high');
        expect(s.controller.debugInfo().downgradesUsed).toBe(1);
    });

    it.each([false, true])('rejects an in-flight probe after a player choice (back to Auto: %s)', async (backToAuto) => {
        let finish!: (result: GpuProbeResult) => void;
        probe.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        const s = session();
        const pending = s.controller.runProbe(s.renderer);
        s.choose('ultra');
        if (backToAuto) s.choose('auto');
        finish({ msPerFrame: 10, tier: 'high' });
        await pending;
        expect(activeDeviceQualityTier()).toBe('ultra');
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        expect(readAutoDeviceTier(activeDeviceSignature())).toBeNull();
    });

    it.each(['?quality=high&autotune=1', '?autotune=0'])('honors %s without automatic writes', async (search) => {
        window.history.replaceState({}, '', search);
        const s = session();
        const openingTier = activeDeviceQualityTier();
        await s.controller.runProbe(s.renderer);
        s.advance(100_000);
        // Choosing Auto cannot override a diagnostic URL's no-writes contract.
        s.choose('auto');
        s.advance(100_000);
        expect(s.controller.debugInfo().adapting).toBe(false);
        expect(activeDeviceQualityTier()).toBe(openingTier);
        expect(readAutoDeviceTier(activeDeviceSignature())).toBeNull();
        expect(probe).not.toHaveBeenCalled();
    });

    it('keeps Creator adaptation off unless explicitly enabled', () => {
        jest.replaceProperty(creatorMode, 'isCreatorMode', true);
        const editor = session();
        editor.advance(30_000);
        expect(editor.controller.debugInfo().adapting).toBe(false);
        expect(activeDeviceQualityTier()).toBe('ultra');
        window.history.replaceState({}, '', '?autotune=1');
        const forced = session();
        forced.advance(12_000);
        expect(activeDeviceQualityTier()).toBe('high');
    });
});

describe.each(['webgpu', 'webgl'] as const)('%s compilation safeguard', (backend) => {
    it('discards compilation windows, then adapts when slow gameplay continues without compiles', () => {
        const s = session(backend);
        s.advance(30_000, (time) => {
            const count = Math.floor(time / 1000);
            if (backend === 'webgpu') s.info.memory.programs = count;
            else s.info.programs = Array.from({ length: count }, () => ({}));
        });
        expect(activeDeviceQualityTier()).toBe('ultra');
        expect(s.controller.debugInfo().downgradesUsed).toBe(0);
        s.advance(8000);
        expect(activeDeviceQualityTier()).toBe('high');
    });
});
