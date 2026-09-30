import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `game/sw-cache-buster.js` ships into every `bitmagic init` project, where Vite serves the game's
 * modules. It used to bust caches with `?v=<timestamp>` — the one parameter Vite reserves for
 * pre-bundled dependency versions and answers with `max-age=31536000,immutable` — and hand that
 * response back for the plain module URL. The browser then kept every game module across ordinary
 * reloads: edits looked like they did nothing (2026-09-18, Vite 7.3). These tests run the real
 * worker file against a server that applies Vite's rule.
 */

/** Vite's own test for "this is a versioned dependency" (vite/dist/node: DEP_VERSION_RE). */
const VITE_DEP_VERSION_RE = /[?&](v=[\w.-]+)\b/;
const WORKER_FILE = path.resolve(__dirname, '../../../../sw-cache-buster.js');
const MODULE_BODY = 'export const BUILD = 2;';
/** The origin `bitmagic dev` serves from — the only kind the worker acts on. */
const DEV_ORIGIN = 'http://localhost:3090';

interface WorkerFetchEvent { request: Request; respondWith(response: Promise<Response>): void }
type Listener = (event: WorkerFetchEvent) => void;

/** A Vite dev server: the reserved `?v=` parameter is answered immutable, everything else no-cache. */
const viteLike = async (request: Request): Promise<Response> => new Response(MODULE_BODY, {
    status: 200,
    headers: {
        'Content-Type': 'text/javascript',
        'Cache-Control': VITE_DEP_VERSION_RE.test(request.url) ? 'max-age=31536000,immutable' : 'no-cache',
        ETag: 'W/"build-2"',
    },
});

/** The worker logs on install and activate; the suite asserts on fetches, not on console noise. */
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

/** Evaluate the worker file as a service worker at `origin`, against a fetch that behaves like Vite's dev server. */
function loadWorker(origin: string, upstream: (request: Request) => Promise<Response> = viteLike) {
    const listeners = new Map<string, Listener>();
    const fetched: Request[] = [];
    const self = {
        location: new URL(origin),
        addEventListener: (type: string, listener: Listener) => { listeners.set(type, listener); },
        skipWaiting: () => undefined,
        clients: { claim: () => Promise.resolve() },
    };
    const fetchStub = (request: Request): Promise<Response> => {
        fetched.push(request);
        return upstream(request);
    };
    new Function('self', 'fetch', 'console', fs.readFileSync(WORKER_FILE, 'utf8'))(self, fetchStub, quiet);

    /** The response the page receives for `url`, or null when the worker leaves the request to the browser. */
    const request = async (url: string): Promise<Response | null> => {
        let answer: Promise<Response> | null = null;
        listeners.get('fetch')!({ request: new Request(url), respondWith: (response) => { answer = response; } });
        return answer;
    };
    return { request, fetched };
}

describe('sw-cache-buster.js', () => {
    const MODULE = `${DEV_ORIGIN}/dist/src/work/MotionBench.js`;

    it('never busts with a parameter Vite answers as an immutable dependency', async () => {
        const worker = loadWorker(DEV_ORIGIN);
        await worker.request(MODULE);
        await worker.request(`${MODULE}?import`);
        expect(worker.fetched.map(r => r.url)).toEqual([
            expect.stringMatching(/MotionBench\.js\?cb=\d+$/),
            expect.stringMatching(/MotionBench\.js\?import&cb=\d+$/),
        ]);
        for (const sent of worker.fetched) {
            expect(sent.url).not.toMatch(VITE_DEP_VERSION_RE);
            expect(sent.cache).toBe('no-cache');
        }
    });

    it('hands the page a response it may not keep, with the module intact', async () => {
        const worker = loadWorker(DEV_ORIGIN);
        const response = (await worker.request(MODULE))!;
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('text/javascript');
        expect(await response.text()).toBe(MODULE_BODY);
    });

    it('switches caching off even when the server marks the response immutable', async () => {
        // GenreLoader imports the entry module as `work/Game.js?v=<timestamp>`, so this URL reaches
        // the worker already carrying Vite's reserved parameter and comes back immutable.
        const worker = loadWorker(DEV_ORIGIN);
        const response = (await worker.request(`${DEV_ORIGIN}/dist/src/work/Game.js?v=1789000000000`))!;
        expect(worker.fetched[0]!.url).toMatch(VITE_DEP_VERSION_RE);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('does not stamp a URL twice', async () => {
        const worker = loadWorker(DEV_ORIGIN);
        await worker.request(`${MODULE}?cb=42`);
        expect(worker.fetched[0]!.url).toBe(`${MODULE}?cb=42`);
    });

    it('leaves everything but work files, and every production origin, to the browser', async () => {
        const dev = loadWorker(DEV_ORIGIN);
        expect(await dev.request(`${DEV_ORIGIN}/dist/engine/engine/GameEngine.js`)).toBeNull();
        const production = loadWorker('https://play.bitmagic.ai');
        expect(await production.request('https://play.bitmagic.ai/dist/src/work/Game.js')).toBeNull();
        expect(dev.fetched).toHaveLength(0);
        expect(production.fetched).toHaveLength(0);
    });

    it('falls back to the original request when the busted one fails', async () => {
        let calls = 0;
        const worker = loadWorker(DEV_ORIGIN, async (request) => {
            if (++calls === 1) throw new TypeError('network down');
            return new Response(`fallback for ${request.url}`);
        });
        const response = (await worker.request(MODULE))!;
        expect(await response.text()).toBe(`fallback for ${MODULE}`);
    });
});
