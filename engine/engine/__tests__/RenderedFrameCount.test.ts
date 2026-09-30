import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';

/**
 * Execute the real engine loop with inert subsystems, without importing its browser/GPU graph.
 * In particular, do not replace animate with a pretend loop: the regression was the position
 * of the counter relative to the real warmup guard and render call.
 */
const source = ts.createSourceFile(
    'GameEngine.ts', fs.readFileSync(path.join(__dirname, '..', 'GameEngine.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true,
);
const declaration = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'GameEngine',
);
if (!declaration) throw new Error('GameEngine class not found');
const names = new Set([
    '_frameCount', 'renderedFrameCount', 'getFrameCount', 'getRenderedFrameCount',
    'animate', 'renderActiveFrame', 'renderFrameNow',
    'isGameplayRunning',
]);
const members = declaration.members.filter((member) => member.name && names.has(member.name.getText(source)));
if (members.length !== names.size) throw new Error('GameEngine render-loop test members missing');
const code = ts.transpileModule(
    `class GameEngine { ${members.map((member) => member.getText(source)).join('\n')} }
     globalThis.TestGameEngine = GameEngine;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

interface LoopEngine {
    animate(): void;
    getRenderedFrameCount(): number;
    renderFrameNow(): void;
    warmupCompileInFlight: boolean;
    renderActive: boolean;
    physicsWorld: { isHalted(): boolean; setSimulationActive(active: boolean): void } | null;
}

function fixture(): {
    engine: LoopEngine;
    render: jest.Mock;
    tick: () => void;
    updates: () => number;
} {
    let now = 100;
    const noop = (): void => {};
    const empty = (): null => null;
    const zero = (): number => 0;
    const context = vm.createContext({
        performance: { now: () => now },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: noop,
        window: {},
        GameState: { PLAYING: 'playing' },
        rendererBackendReady: () => true,
        viewportSize: () => ({ width: 640, height: 360 }),
        _rendererSizeScratch: { x: 640, y: 360 },
        VoxelDebrisManager: { update: noop },
        voxelObjectDebris: { update: noop },
        boneVoxelLimbs: { update: noop },
        shatterScheduler: { beginFrame: noop },
        VisualEffects: { updateScene: noop },
        getDecalSystem: empty,
        getVoxelCarveSystem: empty,
        getHitDebrisSystem: empty,
        getGlobalNavMesh: empty,
        getGlobalPathConflictAvoidance: empty,
        advanceGameplayTimers: noop,
        getGlobalLodScheduler: () => ({ getLastNavDrainMs: zero }),
        NpcController: { takeAvoidanceMs: zero, takePoseMs: zero, takeMoveMs: zero },
        getGlobalCrowdSolver: () => ({ solve: noop }),
        getGlobalCrowd: empty,
        getGlobalCrowdRenderer: () => ({ update: noop }),
        getActiveEnvironmentObjectSystem: empty,
        updatePointLightPoolsFromCamera: noop,
        updateWebGpuSplatMeshes: noop,
        syncViewModelLayer: () => false,
        frameSpanRecorder: { record: noop, endFrame: noop },
        renderViewModelOverlay: noop,
    });
    vm.runInContext(code, context);
    const Engine = context.TestGameEngine as { new(): LoopEngine; getFrameCount(): number };
    const render = jest.fn();
    const engine = Object.assign(new Engine(), {
        genreModule: { update: noop },
        renderActive: true,
        warmupCompileInFlight: false,
        lastFrameTime: 0,
        currentFrameInterval: () => 1000 / 60,
        isRecordingFrames: () => false,
        gameStateManager: { isState: (state: string) => state === 'playing' },
        renderer: { getSize: noop, render },
        scene: {},
        camera: { getWorldPosition: empty },
        physicsWorld: null,
        frameTimer: { tick: () => 1 / 60, discardNext: noop, ambienceTime: 0 },
        quality: { recordFrame: noop, resetSampling: noop, noteDisturbance: noop },
        pushToTalk: { update: noop },
        dynamicObjectManager: { updateMining: noop },
        animalRegistry: { updateAll: noop },
        beforeRenderCallbacks: [],
        updateShadowCameraPosition: noop,
        waterFeatures: { update: noop },
        _physicsHaltedNotified: true,
    });
    return { engine, render, tick: () => { now += 20; engine.animate(); }, updates: () => Engine.getFrameCount() };
}

describe('completed animation-loop renders', () => {
    it('keeps updates advancing during warmup but counts only renders after recovery', () => {
        const { engine, render, tick, updates } = fixture();
        engine.warmupCompileInFlight = true;
        tick();
        tick();
        expect(updates()).toBe(2);
        expect(render).not.toHaveBeenCalled();
        expect(engine.getRenderedFrameCount()).toBe(0);
        engine.warmupCompileInFlight = false;
        tick();
        expect(render).toHaveBeenCalledTimes(1);
        expect(engine.getRenderedFrameCount()).toBe(1);
    });

    it('does not count a failed render or forced warmup/capture draws', () => {
        const { engine, render, tick } = fixture();
        engine.renderFrameNow();
        expect(render).toHaveBeenCalledTimes(1);
        expect(engine.getRenderedFrameCount()).toBe(0);
        render.mockImplementationOnce(() => { throw new Error('render failed'); });
        expect(tick).toThrow('render failed');
        expect(engine.getRenderedFrameCount()).toBe(0);
        tick();
        expect(engine.getRenderedFrameCount()).toBe(1);
    });

    it('counts the render-only recovery path after physics halts, respecting warmup holds', () => {
        const { engine, render, tick } = fixture();
        engine.physicsWorld = { isHalted: () => true, setSimulationActive: () => {} };
        engine.warmupCompileInFlight = true;
        tick();
        expect(engine.getRenderedFrameCount()).toBe(0);
        engine.warmupCompileInFlight = false;
        tick();
        expect(render).toHaveBeenCalledTimes(1);
        expect(engine.getRenderedFrameCount()).toBe(1);
    });

    it('does not count hidden renders or share counts between engine instances', () => {
        const first = fixture();
        first.engine.renderActive = false;
        first.tick();
        expect(first.engine.getRenderedFrameCount()).toBe(0);
        first.engine.renderActive = true;
        first.tick();
        expect(first.engine.getRenderedFrameCount()).toBe(1);
        expect(fixture().engine.getRenderedFrameCount()).toBe(0);
    });
});
