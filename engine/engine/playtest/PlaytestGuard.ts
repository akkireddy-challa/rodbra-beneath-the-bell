// Isolation for a hidden automatic play test (?playtest=1). Imported FIRST by
// GameTemplate so it runs before any other engine module touches the browser.
//
// The play-test page runs the user's game next to their live preview, on the
// same origin in production, with nobody at the controls. Anything it writes
// would land in the user's world: saves and menu picks in localStorage, rows in
// the Game Data API, runtime-AI spend, a multiplayer seat. So instead of editing
// every call site, the page loses the ability to write at all — one choke point
// that also covers game code the AI writes later. Reads (asset downloads,
// leaderboard fetches) still work, so the game loads and plays as normal.
// See game/docs/playtest-mode.md.

import { isPlaytestMode } from 'engine/CreatorMode.js';

/** Prefix on every refusal, so the probe can tell a guard block from a game bug. */
export const PLAYTEST_TAG = '[playtest]';

/** In-memory Storage: the page reads and writes normally, nothing persists or leaks. */
export class MemoryStorage implements Storage {
    private readonly items = new Map<string, string>();

    get length(): number {
        return this.items.size;
    }

    clear(): void {
        this.items.clear();
    }

    getItem(key: string): string | null {
        return this.items.get(String(key)) ?? null;
    }

    key(index: number): string | null {
        return [...this.items.keys()][index] ?? null;
    }

    removeItem(key: string): void {
        this.items.delete(String(key));
    }

    setItem(key: string, value: string): void {
        this.items.set(String(key), String(value));
    }
}

/** GET/HEAD fetch the game's assets and read-only data; everything else could change something. */
export function isReadOnlyMethod(method: string | undefined): boolean {
    const m = (method ?? 'GET').toUpperCase();
    return m === 'GET' || m === 'HEAD';
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string | undefined {
    if (init?.method) return init.method;
    return typeof Request !== 'undefined' && input instanceof Request ? input.method : undefined;
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

function refuse(what: string): Error {
    return new Error(`${PLAYTEST_TAG} blocked ${what} — the play test cannot write anywhere`);
}

function installStorage(): void {
    for (const name of ['localStorage', 'sessionStorage'] as const) {
        Object.defineProperty(window, name, { configurable: true, value: new MemoryStorage() });
    }
}

function installNetwork(): void {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = requestMethod(input, init);
        if (!isReadOnlyMethod(method)) {
            return Promise.reject(refuse(`${method} ${requestUrl(input)}`));
        }
        return realFetch(input, init);
    };

    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        if (!isReadOnlyMethod(method)) throw refuse(`${method} ${String(url)}`);
        return (realOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;

    // Multiplayer relay, runtime-AI streams, world-shard sync: all sockets are writers.
    class RefusedWebSocket {
        constructor(url: string | URL) {
            throw refuse(`WebSocket ${String(url)}`);
        }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, writable: true, value: RefusedWebSocket });

    if (typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon = (): boolean => false;
    }
}

function installPointerLock(): void {
    // PointerLockManager treats a document without `pointerLockElement` as not
    // supporting pointer lock and runs gameplay in free-mouse mode. Otherwise a
    // start without a click shows "Click to play" and pauses the game behind it.
    delete (Document.prototype as unknown as Record<string, unknown>).pointerLockElement;
    Element.prototype.requestPointerLock = function (): Promise<void> {
        return Promise.resolve();
    } as typeof Element.prototype.requestPointerLock;
}

function installAudio(): void {
    // Every context starts suspended and cannot resume: no sound from a page the
    // user cannot see. Decoding still works, so audio code runs as normal.
    const RealAudioContext = window.AudioContext;
    if (!RealAudioContext) return;
    class SilentAudioContext extends RealAudioContext {
        constructor(options?: AudioContextOptions) {
            super(options);
            void super.suspend();
        }

        resume(): Promise<void> {
            return Promise.resolve();
        }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, writable: true, value: SilentAudioContext });
}

function installDialogs(): void {
    // A modal dialog would block the hidden page until someone dismissed it.
    window.alert = (message?: unknown): void => {
        console.error(`${PLAYTEST_TAG} alert: ${String(message)}`);
    };
    window.confirm = (): boolean => false;
    window.prompt = (): null => null;
}

/** Install every guard. Exported for tests; the module installs itself in play-test mode. */
export function installPlaytestGuard(): void {
    installStorage();
    installNetwork();
    installPointerLock();
    installAudio();
    installDialogs();
}

if (isPlaytestMode) {
    installPlaytestGuard();
}
