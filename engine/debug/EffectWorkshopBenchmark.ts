import type { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { WebGPURenderer } from 'three/webgpu';

interface TimerExtension { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
function distribution(values: number[]): { mean: number; median: number; p95: number; max: number; samples: number } | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return { mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        median: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
        max: sorted[sorted.length - 1]!, samples: values.length };
}

/** Three lifetime windows; every measured step advances a four-second fixture by 1/60 s.
 * Shader compilation and jumps between windows are excluded from steady-state timing. */
export async function benchmarkEffect(renderer: WebGLRenderer | WebGPURenderer, step: (time: number) => void,
    metrics: () => Record<string, unknown>, gpuCompute: boolean): Promise<object> {
    const cpu: number[] = [], update: number[] = [], gpu: number[] = [], compute: number[] = [];
    const timestampRenderer = renderer instanceof WebGPURenderer && renderer.hasFeature('timestamp-query') ? renderer : null;
    const context = renderer instanceof WebGPURenderer ? null : renderer.getContext();
    const gl = context instanceof WebGL2RenderingContext ? context : null;
    const extension: TimerExtension | null = gl?.getExtension('EXT_disjoint_timer_query_webgl2') ?? null;
    const queries: WebGLQuery[] = [];
    const phases = [0, 0.34, 0.67], warmup = 8, samples = 24;
    try {
        for (const phase of phases) {
            step(phase);
            for (let frame = 1; frame <= warmup + samples; frame++) {
                const measured = frame > warmup;
                const query = gl && extension && measured ? gl.createQuery() : null;
                if (query && gl && extension) { queries.push(query); gl.beginQuery(extension.TIME_ELAPSED_EXT, query); }
                step(phase + frame / 240);
                if (query && gl && extension) gl.endQuery(extension.TIME_ELAPSED_EXT);
                const current = metrics();
                if (measured) { cpu.push(Number(current.cpuSubmissionMs)); update.push(Number(current.cpuUpdateMs)); }
                if (timestampRenderer) {
                    const renderTime = await timestampRenderer.resolveTimestampsAsync('render');
                    const computeTime = gpuCompute ? await timestampRenderer.resolveTimestampsAsync('compute') : undefined;
                    if (measured && typeof renderTime === 'number') gpu.push(renderTime);
                    if (measured && typeof computeTime === 'number') compute.push(computeTime);
                }
                // WebGPU synchronizes instance colours once per animation frame.
                // Advancing several simulated frames in one browser frame leaves colours stale.
                if (!gl || frame % 8 === 0) await new Promise(requestAnimationFrame);
            }
        }
        if (gl && extension && queries.length) {
            const deadline = performance.now() + 10000;
            while (!gl.getQueryParameter(queries[queries.length - 1]!, gl.QUERY_RESULT_AVAILABLE)) {
                if (performance.now() > deadline) throw new Error('GPU timer queries did not complete');
                await new Promise(requestAnimationFrame);
            }
            if (!gl.getParameter(extension.GPU_DISJOINT_EXT)) {
                for (const query of queries) gpu.push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6);
            }
        }
        return { ...metrics(), phases, warmupFramesPerPhase: warmup, measuredFramesPerPhase: samples,
            cpu: distribution(cpu), update: distribution(update), gpu: distribution(gpu), compute: distribution(compute) };
    } finally { if (gl) for (const query of queries) gl.deleteQuery(query); }
}
