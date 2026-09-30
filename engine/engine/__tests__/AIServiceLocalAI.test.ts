// engine/config.js uses import.meta.env (Vite-only) — stub it out for Jest.
jest.mock('engine/config.js', () => ({
    AI_CHAT_URL: 'https://game-server.example.com',
}));

import { AIService } from 'engine/AIService.js';

/**
 * Contract tests for the opt-in local OpenAI-compatible model path.
 *
 * The default (no bmLocalAI flag) MUST never touch a local server — otherwise
 * every hosted visitor's browser probes localhost, producing CSP-violation /
 * connection-refused console noise on every runtime-AI game. The local path only
 * activates when a developer explicitly sets the localStorage flag.
 */
describe('AIService opt-in local-model path', () => {
    let fetchMock: jest.Mock;
    const originalFetch = globalThis.fetch;
    const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

    function resetSingleton(): void {
        (AIService as unknown as { instance: AIService | null }).instance = null;
    }

    function setFlag(value: string | null): void {
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: (key: string) => (key === 'bmLocalAI' ? value : null),
        };
    }

    function urlsHitting(needle: string): boolean {
        return fetchMock.mock.calls.some(([input]) => String(input).includes(needle));
    }

    /** Find the local chat-completions request for `baseUrl` and return its parsed JSON body. */
    function chatRequestBody(baseUrl: string): Record<string, unknown> {
        const call = fetchMock.mock.calls.find(
            ([input]) => String(input) === `${baseUrl}/v1/chat/completions`);
        expect(call).toBeDefined();
        return JSON.parse((call![1] as RequestInit).body as string);
    }

    beforeEach(() => {
        resetSingleton();
        fetchMock = jest.fn((input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/models')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ data: [{ id: 'gemma3n:e4b' }, { id: 'llama3.2' }] }),
                } as unknown as Response);
            }
            if (url.endsWith('/v1/chat/completions')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: 'local!' } }] }),
                } as unknown as Response);
            }
            // proxy fallback
            return Promise.resolve({
                ok: true,
                json: async () => ({ text: 'proxied', model: 'm', provider: 'p' }),
            } as unknown as Response);
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
        resetSingleton();
    });

    it('does NOT touch any local server when the flag is unset (proxy only)', async () => {
        setFlag(null);

        const text = await AIService.getInstance().callModel('hi');

        expect(urlsHitting('localhost')).toBe(false);
        expect(urlsHitting('/v1/models')).toBe(false);
        expect(text).toBe('proxied');
    });

    it('flag = "1" auto-detects the model from /v1/models — no model needed', async () => {
        setFlag('1');

        const text = await AIService.getInstance().callModel('hi');

        expect(urlsHitting('http://localhost:11434/v1/models')).toBe(true);
        const body = chatRequestBody('http://localhost:11434');
        expect(body.model).toBe('gemma3n:e4b'); // first model reported by /v1/models
        expect(text).toBe('local!');
    });

    it('routes vision (images) to the local model in OpenAI multimodal format', async () => {
        setFlag('1');

        await AIService.getInstance().callModel('what is this?', {
            images: ['data:image/png;base64,AAAA'],
        });

        // images must NOT silently fall through to the proxy
        expect(urlsHitting('/api/ai/chat')).toBe(false);
        const body = chatRequestBody('http://localhost:11434');
        const userMsg = (body.messages as Array<{ role: string; content: unknown }>)
            .find((m) => m.role === 'user')!;
        expect(Array.isArray(userMsg.content)).toBe(true);
        expect(userMsg.content).toEqual([
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ]);
    });

    it('honours a custom baseUrl/model override from a JSON flag', async () => {
        setFlag(JSON.stringify({ baseUrl: 'http://localhost:1234/', model: 'my-model' }));

        await AIService.getInstance().callModel('hi');

        // trailing slash trimmed, custom port used
        expect(urlsHitting('http://localhost:1234/v1/models')).toBe(true);
        const body = chatRequestBody('http://localhost:1234');
        expect(body.model).toBe('my-model'); // override wins over auto-detect
    });

    it('falls back to the proxy when reachable but no models are installed', async () => {
        setFlag('1');
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/models')) {
                return Promise.resolve({ ok: true, json: async () => ({ data: [] }) } as unknown as Response);
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ text: 'proxied', model: 'm', provider: 'p' }),
            } as unknown as Response);
        });

        const text = await AIService.getInstance().callModel('hi');

        expect(urlsHitting('/v1/chat/completions')).toBe(false);
        expect(text).toBe('proxied');
    });

    it('falls back to the proxy when the local server is unreachable', async () => {
        setFlag('1');
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('localhost')) return Promise.reject(new Error('ECONNREFUSED'));
            return Promise.resolve({
                ok: true,
                json: async () => ({ text: 'proxied', model: 'm', provider: 'p' }),
            } as unknown as Response);
        });

        const text = await AIService.getInstance().callModel('hi');

        expect(text).toBe('proxied');
    });
});
