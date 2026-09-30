// engine/config.js uses import.meta.env (Vite-only) — stub it out for Jest.
jest.mock('engine/config.js', () => ({
    AI_CHAT_URL: 'https://game-server.example.com',
}));

import { AIService } from 'engine/AIService.js';

/**
 * Contract tests for the opt-in in-browser web-llm path.
 *
 * web-llm runs an LLM on WebGPU with no server. The library is lazy-loaded from a
 * CDN only when the `bmWebLLM` localStorage flag is set, so it must never affect
 * ordinary visitors. The actual engine load needs WebGPU + a CDN and isn't
 * unit-testable; these tests pin the routing contract and the proxy fallback that
 * fires when WebGPU is unavailable (the common real-world case, and the case in
 * the Node test environment, which has no `navigator.gpu`).
 */
describe('AIService opt-in web-llm path', () => {
    let fetchMock: jest.Mock;
    const originalFetch = globalThis.fetch;
    const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

    function resetSingleton(): void {
        (AIService as unknown as { instance: AIService | null }).instance = null;
    }

    function setFlag(value: string | null): void {
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: (key: string) => (key === 'bmWebLLM' ? value : null),
        };
    }

    function urlsHitting(needle: string): boolean {
        return fetchMock.mock.calls.some(([input]) => String(input).includes(needle));
    }

    beforeEach(() => {
        resetSingleton();
        fetchMock = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: async () => ({ text: 'proxied', model: 'm', provider: 'p' }),
            } as unknown as Response),
        );
        globalThis.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
        resetSingleton();
    });

    it('does NOT touch web-llm when the flag is unset (proxy only)', async () => {
        setFlag(null);

        const text = await AIService.getInstance().callModel('hi');

        expect(urlsHitting('esm.run')).toBe(false);
        expect(urlsHitting('/api/ai/chat')).toBe(true);
        expect(text).toBe('proxied');
    });

    it('falls back to the proxy when the flag is set but WebGPU is unavailable', async () => {
        // The Node test environment has no navigator.gpu, so loadWebLLMEngine returns
        // null before any CDN import is attempted and the call routes to the proxy.
        setFlag('1');

        const text = await AIService.getInstance().callModel('hi');

        expect(urlsHitting('esm.run')).toBe(false);
        expect(urlsHitting('/api/ai/chat')).toBe(true);
        expect(text).toBe('proxied');
    });

    it('falls back to the proxy for vision calls too when WebGPU is unavailable', async () => {
        setFlag('1');

        const text = await AIService.getInstance().callModel('what is this?', {
            images: ['data:image/png;base64,AAAA'],
        });

        expect(urlsHitting('/api/ai/chat')).toBe(true);
        expect(text).toBe('proxied');
    });
});
