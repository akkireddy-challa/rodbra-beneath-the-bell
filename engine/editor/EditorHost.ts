/**
 * What the in-engine editor is allowed to ask of whatever embeds it.
 *
 * The editor ships inside the vendored engine and runs under two hosts: the web Creator, and the
 * `bitmagic dev` view. The CLI reaches it by *impersonating* the Creator — its shell loads the game
 * with the same `?source=creator` flag (`cli/src/editor/shell-page.ts`), which is what makes one
 * editor serve both lanes. The cost of that trick is that the editor cannot tell the two apart, so
 * every feature that one host can service and the other cannot used to be discovered at runtime by
 * a message vanishing into the void. The HQ button spent a release inert under `bitmagic dev`
 * exactly that way.
 *
 * So: one object, feature-detected. `getEditorHost().capabilities` says what this host can do, and
 * the editor hides or rewords rather than offering a dead button. A host that says nothing gets
 * `DEFAULT_EDITOR_HOST_CAPABILITIES`, which is today's Creator behaviour — that default is what lets
 * a project's vendored editor and its CLI move independently (they are upgraded by different
 * commands) without either combination regressing.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────────────────
 *
 * **`saveModifications(mods)`.** The engine does not build `WorldJsonModification[]` and must not
 * start: the CLI's builder (`cli/src/editor/save.ts`) emits FUNCTION predicates and updaters, which
 * `postMessage`'s structured clone cannot carry. Those functions are not incidental — the creator's
 * agent writes `world.json` concurrently, so the Creator's snapshot form would silently revert the
 * agent's edits. Each host keeps building its own; the engine keeps answering
 * `CHECK_SCENE_CHANGES` / `GET_SCENE_EDITING_STATUS` and letting the host do the write.
 *
 * **`uploadAsset(blob)`.** Uploads are not host-mediated and should not become so. The engine PUTs
 * its own bytes through `StorageUploadUtil`, and a host that needs authentication puts a loopback
 * proxy in front of `window.AI_AGENT_URL` instead (`cli/src/forge/upload-proxy.ts`). Teaching the
 * engine to carry a bearer token would be a breaking change to every published game to serve one
 * lane.
 */
import type { Asset } from 'types/game.js';
import { isCreatorMode, safePostMessageToCreator } from 'engine/CreatorMode.js';

/** Which regeneration a host can actually run for a placed asset. */
export type EditorHqMethod = 'procedural' | 'generated' | 'upload';

/** Somewhere in the host's own chrome the editor can send the creator. */
export interface EditorNavigationTarget {
    /** A tab in the host's UI. Only `'assets'` is used today. */
    tab?: string;
    /** An asset-specific flow (re-voxelize, replace, …) the host owns the dialog for. */
    assetAction?: { assetId: string; action: string };
}

/** A regeneration the creator asked for from the object inspector. */
export interface EditorHqRequest {
    assetId: string;
    assetName: string;
    method: EditorHqMethod;
    /** Regenerate the asset for every instance of its type, rather than forking this one. */
    replaceAllOfType: boolean;
    objectId: string | null;
}

/**
 * Something the editor did that the host cannot work out on its own.
 *
 * The CLI's journal reconstructs moves, adds and deletes by diffing `world.json`
 * (`cli/src/editor/journal.ts`), so those are deliberately absent here — only edits whose cause is
 * invisible in the file need reporting.
 */
export type EditorHostEvent =
    | { event: 'terrain.saved'; voxelUrl: string }
    | { event: 'terrain.saveFailed'; error: string }
    | { event: 'voxel.saved'; assetId: string; assetName: string }
    | { event: 'voxel.saveFailed'; assetName: string; error: string };

export interface EditorHostCapabilities {
    /** Which regenerations to offer. Empty hides the section entirely. */
    hqMethods: readonly EditorHqMethod[];
    /** The host has chrome of its own to send the creator to. False means `navigate()` is a no-op. */
    hostNavigation: boolean;
    /** The host records `journal()` events somewhere the project's agent can read them. */
    journal: boolean;
}

/**
 * What a host that has not announced itself gets.
 *
 * These are the WEB CREATOR's values on purpose. A host predating the handshake behaves exactly as
 * it does today, so an older Creator or an older `bitmagic dev` paired with a freshly upgraded
 * engine changes nothing. Every field added here must keep that property: the legacy value is the
 * default, never the safer-looking one.
 */
export const DEFAULT_EDITOR_HOST_CAPABILITIES: EditorHostCapabilities = {
    hqMethods: ['procedural', 'generated', 'upload'],
    hostNavigation: true,
    journal: false,
};

/** Everything off — a published game, where there is no host on the other side at all. */
export const NO_EDITOR_HOST_CAPABILITIES: EditorHostCapabilities = {
    hqMethods: [],
    hostNavigation: false,
    journal: false,
};

export interface EditorHost {
    readonly capabilities: EditorHostCapabilities;
    /** The project's assets, as the host currently knows them. */
    listAssets(): Promise<Asset[]>;
    /** Ask the host to regenerate an asset. Fire-and-forget: the host owns the flow from here. */
    requestHq(request: EditorHqRequest): void;
    /** Send the creator somewhere in the host's own UI. */
    navigate(target: EditorNavigationTarget): void;
    /** Report something the host cannot infer from the files it just wrote. */
    journal(event: EditorHostEvent): void;
}

/** The engine announces itself so a host that booted late can still answer. */
export const EDITOR_HOST_HELLO = 'EDITOR_HOST_HELLO';
/** The host's answer, and its way of changing its mind later. */
export const EDITOR_HOST_CAPABILITIES = 'EDITOR_HOST_CAPABILITIES';
/** Bumped when the shape of the hello/capabilities exchange changes, not when a field is added. */
export const EDITOR_HOST_PROTOCOL_VERSION = 1;

/**
 * Is this message from somewhere we should listen to?
 *
 * Lifted out of `SceneEditor`, which was the only place that checked. Any localhost port passes so
 * that parallel clones on shifted ports work, plus the game's own hostname for a deployed Creator.
 */
function isFromHost(event: MessageEvent): boolean {
    try {
        const origin = new URL(event.origin);
        return origin.hostname === 'localhost'
            || origin.hostname === '127.0.0.1'
            || origin.hostname === window.location.hostname;
    } catch {
        return false;
    }
}

/**
 * Ask the host something and wait for its reply.
 *
 * One place for the listener/timeout/origin dance every request-shaped message used to hand-roll.
 * Resolves `null` on timeout rather than rejecting: a host that is still booting is not an error,
 * it just means the caller should fall back.
 */
export function requestFromHost<T>(
    requestType: string,
    replyType: string,
    timeoutMs: number,
    payload: Record<string, unknown> = {},
): Promise<T | null> {
    if (!isCreatorMode) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
        const finish = (value: T | null): void => {
            window.clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            resolve(value);
        };
        const onMessage = (event: MessageEvent): void => {
            if (!isFromHost(event)) return;
            if (event.data?.type === replyType) finish(event.data as T);
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        window.addEventListener('message', onMessage);
        safePostMessageToCreator({ type: requestType, ...payload });
    });
}

/** How long the assets palette waits before drawing itself empty. */
const ASSETS_REPLY_TIMEOUT_MS = 5000;

/**
 * The real host: whatever owns the parent frame, spoken to over the message names that already
 * exist. Keeping the wire names means the Creator needs no changes to keep working — the contract
 * formalizes the caller, not the protocol.
 */
class PostMessageEditorHost implements EditorHost {
    private announced: EditorHostCapabilities = DEFAULT_EDITOR_HOST_CAPABILITIES;

    constructor() {
        window.addEventListener('message', (event: MessageEvent) => {
            if (!isFromHost(event)) return;
            if (event.data?.type !== EDITOR_HOST_CAPABILITIES) return;
            this.announced = mergeCapabilities(event.data.capabilities);
        });
        safePostMessageToCreator({
            type: EDITOR_HOST_HELLO,
            version: EDITOR_HOST_PROTOCOL_VERSION,
        });
    }

    get capabilities(): EditorHostCapabilities {
        return this.announced;
    }

    async listAssets(): Promise<Asset[]> {
        const reply = await requestFromHost<{ assets?: Asset[] }>(
            'REQUEST_ASSETS', 'ASSETS_RESPONSE', ASSETS_REPLY_TIMEOUT_MS,
        );
        if (!reply) {
            console.warn('[EditorHost] Timed out waiting for the host to list assets');
            return [];
        }
        return reply.assets ?? [];
    }

    requestHq(request: EditorHqRequest): void {
        safePostMessageToCreator({ type: 'REGENERATE_ASSET', ...request });
    }

    navigate(target: EditorNavigationTarget): void {
        if (!this.announced.hostNavigation) return;
        if (target.assetAction) {
            safePostMessageToCreator({
                type: 'OPEN_ASSET_ACTION',
                assetId: target.assetAction.assetId,
                action: target.assetAction.action,
            });
        }
        if (target.tab) {
            safePostMessageToCreator({ type: 'SWITCH_TO_TAB', tab: target.tab });
        }
    }

    journal(event: EditorHostEvent): void {
        if (!this.announced.journal) return;
        safePostMessageToCreator({ type: 'EDITOR_JOURNAL_EVENT', ...event });
    }
}

/**
 * No host at all — a published or standalone game, where `EditorManager` is still constructed but
 * `safePostMessageToCreator` no-ops. Assets come from the loaded game data, which is what
 * `SceneEditor` already fell back to.
 */
class NullEditorHost implements EditorHost {
    readonly capabilities = NO_EDITOR_HOST_CAPABILITIES;

    constructor(private readonly getAssets: () => Asset[]) {}

    async listAssets(): Promise<Asset[]> {
        return this.getAssets();
    }

    requestHq(): void { /* nothing can service it */ }
    navigate(): void { /* there is no chrome to navigate */ }
    journal(): void { /* nobody is reading */ }
}

/**
 * Fold an announcement into the defaults, ignoring anything malformed.
 *
 * Field-by-field rather than a spread so that a host announcing only what it differs on keeps the
 * legacy value for everything else — which is how a new capability reaches an old host safely.
 *
 * Exported for its own tests: this function is where the backward-compatibility promise actually
 * lives, and it is the one part of the contract worth pinning independently of a browser.
 */
export function mergeCapabilities(announced: unknown): EditorHostCapabilities {
    if (typeof announced !== 'object' || announced === null) {
        return DEFAULT_EDITOR_HOST_CAPABILITIES;
    }
    const source = announced as Partial<Record<keyof EditorHostCapabilities, unknown>>;
    const hqMethods = Array.isArray(source.hqMethods)
        ? source.hqMethods.filter((method): method is EditorHqMethod =>
            method === 'procedural' || method === 'generated' || method === 'upload')
        : DEFAULT_EDITOR_HOST_CAPABILITIES.hqMethods;
    return {
        hqMethods,
        hostNavigation: typeof source.hostNavigation === 'boolean'
            ? source.hostNavigation
            : DEFAULT_EDITOR_HOST_CAPABILITIES.hostNavigation,
        journal: typeof source.journal === 'boolean'
            ? source.journal
            : DEFAULT_EDITOR_HOST_CAPABILITIES.journal,
    };
}

let host: EditorHost | null = null;
let assetFallback: () => Asset[] = () => [];

/**
 * Where the null host reads assets from when there is no parent frame. Installed once by
 * `EditorManager`, which is the only thing holding a `GameEngine`.
 * @internal
 */
export function setEditorHostAssetFallback(getAssets: () => Asset[]): void {
    assetFallback = getAssets;
}

/** The host this editor is running under. Constructed on first use, never re-negotiated. */
export function getEditorHost(): EditorHost {
    if (!host) {
        host = isCreatorMode ? new PostMessageEditorHost() : new NullEditorHost(() => assetFallback());
    }
    return host;
}

/** Test seam: drop the cached host so the next `getEditorHost()` rebuilds it. @internal */
export function resetEditorHostForTests(): void {
    host = null;
    assetFallback = () => [];
}
