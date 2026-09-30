/**
 * Which game-server each runtime-AI feature lands on.
 *
 * The module memoizes its /health probe for the life of the page, so every case
 * re-imports it through jest.isolateModulesAsync with its own config mock — one
 * shared instance would let the first test's verdict decide the rest.
 *
 * The shared `engine/__mocks__/engine-config.ts` gives AI_CHAT_URL and
 * GAME_SERVER_HTTP_URL the same value, which would make "used the local one" and
 * "used the hosted one" indistinguishable. These mocks keep them apart.
 */

const LOCAL = 'http://localhost:1666';
const HOSTED = 'https://game-server.example.com';

type Feature = 'chat' | 'speechToText' | 'imageGeneration' | 'meshGeneration' | 'decisions';
type Health = Record<string, boolean> | null;

interface Scenario {
    /** null = nothing answered (connection refused / timeout). */
    health: Health;
    /** Serve the game over https, i.e. a published game rather than local dev. */
    https?: boolean;
    /** What the embedder claims, if anything (the `bitmagic dev` shell does). */
    override?: string;
}

interface Probe {
    resolve(feature: Feature): Promise<string>;
    healthFetches(): number;
}

const originals = {
    fetch: globalThis.fetch,
    window: (globalThis as { window?: unknown }).window,
    override: (globalThis as { BITMAGIC_GAME_SERVER_URL?: string }).BITMAGIC_GAME_SERVER_URL,
};

afterEach(() => {
    globalThis.fetch = originals.fetch;
    (globalThis as { window?: unknown }).window = originals.window;
    (globalThis as { BITMAGIC_GAME_SERVER_URL?: string }).BITMAGIC_GAME_SERVER_URL = originals.override;
    jest.restoreAllMocks();
});

/** Load a fresh copy of the module with the world in the given shape. */
async function load(scenario: Scenario): Promise<Probe> {
    const protocol = scenario.https ? 'https:' : 'http:';
    (globalThis as { window?: unknown }).window = { location: { protocol } };
    if (scenario.override !== undefined) {
        (globalThis as { BITMAGIC_GAME_SERVER_URL?: string }).BITMAGIC_GAME_SERVER_URL = scenario.override;
    }

    const fetchMock = jest.fn(() => (scenario.health === null
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve({ ok: true, json: async () => scenario.health } as unknown as Response)));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    jest.spyOn(console, 'info').mockImplementation(() => {});

    let resolve!: (feature: Feature) => Promise<string>;
    await jest.isolateModulesAsync(async () => {
        jest.doMock('engine/config.js', () => ({ AI_CHAT_URL: scenario.https ? HOSTED : LOCAL, GAME_SERVER_HTTP_URL: HOSTED }));
        const mod = await import('engine/runtimeBackend.js');
        resolve = mod.resolveRuntimeBackendUrl;
    });

    return {
        resolve,
        healthFetches: () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/health')).length,
    };
}

const EVERY_FEATURE: Feature[] = ['chat', 'speechToText', 'imageGeneration', 'meshGeneration', 'decisions'];
const ALL_CAPABLE = { speechToText: true, imageGeneration: true, meshGeneration: true, decisions: true };

describe('resolveRuntimeBackendUrl', () => {
    it('never probes when the game is served over https', async () => {
        // A published game has no localhost to fall back from, and a probe here would
        // fire on every visitor's browser.
        const probe = await load({ health: ALL_CAPABLE, https: true });
        for (const feature of EVERY_FEATURE) {
            await expect(probe.resolve(feature)).resolves.toBe(HOSTED);
        }
        expect(probe.healthFetches()).toBe(0);
    });

    it('uses a local game-server that reports every capability', async () => {
        const probe = await load({ health: ALL_CAPABLE });
        for (const feature of EVERY_FEATURE) {
            await expect(probe.resolve(feature)).resolves.toBe(LOCAL);
        }
    });

    it('falls back per feature when the local game-server lacks Asset Forger credentials', async () => {
        // The ordinary state of this repo's own game-server: chat works off its own
        // provider key, the three Asset Forger features answer 503.
        const probe = await load({
            health: { speechToText: false, imageGeneration: false, meshGeneration: false, decisions: false },
        });
        await expect(probe.resolve('chat')).resolves.toBe(LOCAL);
        await expect(probe.resolve('speechToText')).resolves.toBe(HOSTED);
        await expect(probe.resolve('imageGeneration')).resolves.toBe(HOSTED);
        await expect(probe.resolve('meshGeneration')).resolves.toBe(HOSTED);
        await expect(probe.resolve('decisions')).resolves.toBe(HOSTED);
    });

    it('treats a capability an older game-server does not report as one it cannot serve', async () => {
        // meshGeneration postdates some deployed servers. Routing to one that would
        // answer 503 is strictly worse than routing to the hosted one.
        const probe = await load({ health: { speechToText: true, imageGeneration: true } });
        await expect(probe.resolve('meshGeneration')).resolves.toBe(HOSTED);
        await expect(probe.resolve('speechToText')).resolves.toBe(LOCAL);
    });

    it('sends everything to the hosted server when nothing is listening locally', async () => {
        // `bitmagic dev`: no game-server at all. Chat included — reachability is the
        // signal for chat, and there is nothing to reach.
        const probe = await load({ health: null });
        for (const feature of EVERY_FEATURE) {
            await expect(probe.resolve(feature)).resolves.toBe(HOSTED);
        }
    });

    it('treats a non-2xx /health as no local game-server', async () => {
        (globalThis as { window?: unknown }).window = { location: { protocol: 'http:' } };
        globalThis.fetch = jest.fn(() => Promise.resolve({ ok: false, json: async () => ALL_CAPABLE } as unknown as Response)) as unknown as typeof globalThis.fetch;
        jest.spyOn(console, 'info').mockImplementation(() => {});

        await jest.isolateModulesAsync(async () => {
            jest.doMock('engine/config.js', () => ({ AI_CHAT_URL: LOCAL, GAME_SERVER_HTTP_URL: HOSTED }));
            const { resolveRuntimeBackendUrl } = await import('engine/runtimeBackend.js');
            await expect(resolveRuntimeBackendUrl('chat')).resolves.toBe(HOSTED);
        });
    });

    it('probes once for the whole page, however many calls follow', async () => {
        const probe = await load({ health: ALL_CAPABLE });
        await Promise.all([...EVERY_FEATURE, ...EVERY_FEATURE].map((feature) => probe.resolve(feature)));
        expect(probe.healthFetches()).toBe(1);
    });

    it('prefers the game-server the embedder names over the one the hostname implies', async () => {
        // `bitmagic dev` knows the project's pinned environment; the engine, looking at
        // a localhost URL, does not.
        const pinned = 'https://game-server.bitmagic.ai';
        const probe = await load({ health: null, override: pinned });
        await expect(probe.resolve('speechToText')).resolves.toBe(pinned);
    });

    it('says so once per feature when it redirects, rather than silently', async () => {
        const info = jest.spyOn(console, 'info').mockImplementation(() => {});
        const probe = await load({ health: null });
        await probe.resolve('speechToText');
        await probe.resolve('speechToText');
        await probe.resolve('chat');

        const redirects = info.mock.calls.map(([msg]) => String(msg)).filter((m) => m.includes('[runtimeBackend]'));
        expect(redirects).toHaveLength(2);
        expect(redirects[0]).toContain('speechToText');
        expect(redirects[0]).toContain(HOSTED);
    });
});
