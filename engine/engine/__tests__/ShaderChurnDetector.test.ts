import { ShaderChurnDetector, WEBGPU_CHURN_PAIRING_WINDOW_MS, describeProgram, type ProgramIdentity } from 'engine/ShaderChurnDetector.js';

let nextId = 1;
function program(cacheKey: string, name = 'MeshBasicMaterial'): ProgramIdentity {
    return { id: nextId++, cacheKey, name };
}

describe('ShaderChurnDetector — WebGL program list', () => {
    beforeEach(() => { nextId = 1; });

    it('ignores programs that only ever appear, and deletions that never come back', () => {
        const d = new ShaderChurnDetector();
        const a = program('key-a');
        const b = program('key-b');
        expect(d.observePrograms([a, b], 0)).toEqual([]);
        expect(d.observePrograms([a, b], 16)).toEqual([]);      // unchanged list: early-out
        expect(d.observePrograms([a], 32)).toEqual([]);          // b deleted
        expect(d.observePrograms([a, program('key-c', 'PointsMaterial')], 48)).toEqual([]);
        expect(d.totalRecompiles).toBe(0);
    });

    it('reports a program that comes back with a cache key seen deleted, named by material', () => {
        const d = new ShaderChurnDetector();
        const base = program('key-base', 'MeshStandardMaterial');
        const arc = program('key-arc', 'MeshBasicMaterial');
        d.observePrograms([base, arc], 0);
        d.observePrograms([base], 500);                          // arc disposed
        const again = program('key-arc', 'MeshBasicMaterial');
        expect(d.observePrograms([base, again], 1000)).toEqual(['MeshBasicMaterial']);
        expect(d.totalRecompiles).toBe(1);
        expect(d.eventLog).toEqual([{ t: 1000, name: 'MeshBasicMaterial', count: 1 }]);

        // Delete and recreate in the SAME frame: length is equal but the last id moved.
        const third = program('key-arc', 'MeshBasicMaterial');
        expect(d.observePrograms([base, third], 1500)).toEqual(['MeshBasicMaterial']);
        expect(d.eventLog[1]).toEqual({ t: 1500, name: 'MeshBasicMaterial', count: 2 });
    });

    it('names an unnamed built-in program from its cache key shader id', () => {
        expect(describeProgram({ id: 1, cacheKey: 'basic,highp,3,,,-1,-1', name: '' })).toBe('MeshBasicMaterial');
        expect(describeProgram({ id: 2, cacheKey: 'points,highp', name: '' })).toBe('PointsMaterial');
        expect(describeProgram({ id: 3, cacheKey: '17,42,highp', name: '' })).toBe('custom shader');
        expect(describeProgram({ id: 4, cacheKey: 'basic', name: 'ArcMaterial' })).toBe('ArcMaterial');

        const d = new ShaderChurnDetector();
        const a = program('physical,highp', '');
        d.observePrograms([a], 0);
        d.observePrograms([], 10);
        expect(d.observePrograms([program('physical,highp', '')], 20)).toEqual(['MeshStandardMaterial']);
    });

    it('reset forgets deleted keys', () => {
        const d = new ShaderChurnDetector();
        const a = program('key-a');
        d.observePrograms([a], 0);
        d.observePrograms([], 10);
        d.reset();
        expect(d.observePrograms([program('key-a')], 20)).toEqual([]);
        expect(d.totalRecompiles).toBe(0);
    });
});

describe('ShaderChurnDetector — WebGPU program count', () => {
    it('pairs a rise with a recent drop and names it a render pipeline', () => {
        const d = new ShaderChurnDetector();
        expect(d.observeProgramCount(40, 0)).toEqual([]);       // baseline
        expect(d.observeProgramCount(42, 100)).toEqual([]);     // genuinely new programs
        expect(d.observeProgramCount(41, 200)).toEqual([]);     // one released
        expect(d.observeProgramCount(43, 300)).toEqual(['render pipeline']); // one paired, one new
        expect(d.totalRecompiles).toBe(1);
    });

    it('does not pair a rise with a drop older than the pairing window', () => {
        const d = new ShaderChurnDetector();
        d.observeProgramCount(40, 0);
        d.observeProgramCount(20, 100);                          // level unloaded
        expect(d.observeProgramCount(35, 100 + WEBGPU_CHURN_PAIRING_WINDOW_MS + 1)).toEqual([]);
        expect(d.totalRecompiles).toBe(0);
    });
});
