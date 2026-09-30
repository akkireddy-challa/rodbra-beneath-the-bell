/**
 * Ghost racing, as the AI agent sees it.
 *
 * The whole subsystem behind four calls:
 *
 *     const ghosts = engine.getGhostRacing();
 *     await ghosts.attach({ subject: () => this.kart, input: () => this.input });
 *     ghosts.startRun();                                    // green light
 *     const result = await ghosts.finishRun({ timeMs, name });  // finish line
 *
 * Everything the design argues about — quantization, per-level categories,
 * personal-best gating, read-time dedupe, identity, teardown — happens in here
 * so game code never has to know any of it exists.
 *
 * Playback is addressed by ELAPSED RUN TIME, not wall clock, so countdowns,
 * pauses, and restarts fall out correctly instead of each needing a special
 * case. `startRun()` is the zero point; `updateGhosts(deltaTime)` advances it.
 */

import type * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { PLAY_AUTH_URL } from 'engine/config.js';
import { getLaunchParams, GHOST_PARAM, TRACK_PARAM } from 'engine/LaunchParams.js';
import { getEnvironment, isProduction } from 'engine/environment.js';
import type { GameDataService } from 'engine/gamedata/GameDataService.js';
import type { GamePersistence } from 'engine/persistence/GamePersistence.js';
import type { VehicleDescriptor } from 'engine/networking/NetworkTypes.js';
import { bytesToBase64, encodeRunBytes } from 'engine/replay/ReplayCodec.js';
import type { RunRecord } from 'engine/replay/ReplayTypes.js';
import {
    DEFAULT_REPLAY_RECORDER_OPTIONS,
    ReplayRecorder,
    type ReplayRecorderOptions,
} from 'engine/replay/ReplayRecorder.js';
import {
    createInputSampler,
    createVehicleMotionSampler,
    describeVehicleForGhost,
    type ReplayInputSnapshot,
    type ReplayVehicleSubject,
} from 'engine/replay/ReplaySubjects.js';
import { ReplayPlayer } from 'engine/replay/ReplayPlayer.js';
import { GhostVehicle, DEFAULT_GHOST_VEHICLE_OPTIONS } from 'engine/replay/GhostVehicle.js';
import { DEFAULT_GHOST_MATERIAL_OPTIONS } from 'engine/replay/GhostMaterial.js';
import { GhostIdentity } from 'engine/replay/GhostIdentity.js';
import {
    LOCAL_ENTRY_ID,
    isLocalEntryId,
    localEntryId,
    localBoardRows,
    readLocalRunsFor,
    writeLocalRun,
    type LocalRun,
} from 'engine/replay/GhostLocalRuns.js';
import {
    boardCategoryFor,
    fetchBoard,
    fetchRunSource,
    publishBoardManifest,
    submitRun,
    type BoardEntry,
} from 'engine/replay/GhostBoard.js';
import { loadRun, uploadRun, type RunSource } from 'engine/replay/GhostRunStorage.js';

/**
 * Query parameter carrying a challenge link's target run.
 *
 * Re-exported from `LaunchParams` rather than spelled again: the portal, the
 * level resolver and this file all have to agree on the string, and two
 * definitions of it is one definition too many.
 */
export const CHALLENGE_PARAM = GHOST_PARAM;

/**
 * Keep and race EVERY run, instead of personal bests only.
 *
 * DEFAULT ON for localhost. One machine has one player, and the production
 * rules are built around many: runs upload only when they beat your best, and
 * the board keeps one row per player. Together those make a field of ghosts —
 * and a board with more than one row — impossible to see without a second
 * human, which is precisely what needs testing.
 *
 * There is also no shared board on localhost to pollute, so the safe default is
 * the useful one. `?ghosts=all` forces it on elsewhere; `?ghosts=best` forces
 * production behaviour on for a like-for-like check. Never on in production.
 *
 * ⚠ The parameter reads the GAME frame's URL. On localhost the game is an
 * iframe inside the Creator, so the browser address bar does NOT reach it —
 * which is exactly why localhost cannot depend on a parameter.
 */
const MULTI_RUN_PARAM = 'ghosts';

/** How many runs per level multi-run mode retains. */
const MULTI_RUN_KEEP = 5;

function multiRunEnabled(): boolean {
    // No window means no game session — a build script or a unit test, where
    // the production rules are the ones worth exercising.
    if (typeof window === 'undefined' || isProduction()) return false;
    const requested = new URLSearchParams(window.location.search).get(MULTI_RUN_PARAM);
    if (requested === 'all') return true;
    if (requested === 'best') return false;
    return getEnvironment() === 'local';
}


/** Distinct tints so overlapping ghosts stay tellable apart. */
const GHOST_TINTS = [0x66ccff, 0xffaa44, 0xaa66ff, 0x66ff99, 0xff6699];

export interface GhostRacingAttachOptions {
    /** The vehicle to record. A getter, so a respawn can swap it. */
    subject: () => ReplayVehicleSubject | null;
    /** Player input, for the validation track. Omit to record motion only. */
    input: (() => ReplayInputSnapshot) | null;
    /**
     * How the ghost is drawn. Leave null to DERIVE it from the subject, which
     * is almost always what you want — a hand-written descriptor that drifts
     * from the real kart produces a ghost that looks like a different car.
     */
    descriptor: VehicleDescriptor | null;
    /**
     * Vehicle asset the player's kart was spawned from, if any.
     *
     * The vehicle cannot report this itself, and without it the ghost is boxes
     * and cylinders rather than the actual kart.
     */
    assetId: string | null;
    /** Level this board belongs to. Defaults to the engine's active level. */
    levelId: string | null;
    /** Human name for the level, published in the board manifest. */
    levelName: string;
    /** How many ghosts to race against. */
    opponents: number;
    recorder: ReplayRecorderOptions;
}

export const DEFAULT_GHOST_RACING_OPTIONS: GhostRacingAttachOptions = {
    subject: () => null,
    input: null,
    descriptor: null,
    assetId: null,
    levelId: null,
    levelName: '',
    opponents: 3,
    recorder: DEFAULT_REPLAY_RECORDER_OPTIONS,
};

export interface FinishRunInput {
    timeMs: number;
}

export interface FinishRunResult {
    /** 1-based placement on the level's board, or null when not submitted. */
    rank: number | null;
    total: number | null;
    isPersonalBest: boolean;
    /** Shareable link, or null when the run was not submitted. */
    challengeUrl: string | null;
    /** False when nothing was uploaded — not a personal best, or truncated. */
    submitted: boolean;
}

/** Recording diagnostics, for a HUD or a bug report. */
export interface RecordingStats {
    elapsedMs: number;
    motionSamples: number;
    inputTransitions: number;
    /** True when the run hit the recorder's duration cap and stopped early. */
    truncated: boolean;
}

interface ActiveGhost {
    vehicle: GhostVehicle;
    entry: BoardEntry;
}

/** One ghost lined up for the next run. */
export interface ActiveGhostInfo {
    entryId: string;
    name: string;
    timeMs: number;
    /** Vehicle the record was set with, for a "set in the X" line. */
    assetId: string | null;
    /** True for this device's own best lap, which needs no network. */
    isLocal: boolean;
}

/**
 * Portal origin, derived from the play-auth bridge URL.
 *
 * Reused rather than introduced as a second config value: PLAY_AUTH_URL is
 * already the one place that knows where the portal lives, and a challenge link
 * pointing somewhere else than the identity bridge would be a bug waiting to
 * happen. Empty in local dev, where there is no portal to link to.
 */
function portalOrigin(): string {
    if (!PLAY_AUTH_URL) return '';
    try {
        return new URL(PLAY_AUTH_URL).origin;
    } catch {
        return '';
    }
}

/**
 * The result for a lap that never reached the board.
 *
 * `finishRun` has several ways to bow out — not a personal best, a truncated
 * recording, an encode that failed, an upload that failed — and they all report
 * the same thing, so they say it once here rather than four times.
 */
function notSubmitted(isPersonalBest: boolean): FinishRunResult {
    return { rank: null, total: null, isPersonalBest, challengeUrl: null, submitted: false };
}

/** Slot holding this device's best time per level. */
const PB_SLOT = 'ghost-personal-best';

type PersonalBests = Record<string, number>;

export class GhostRacing {
    private options: GhostRacingAttachOptions = DEFAULT_GHOST_RACING_OPTIONS;
    private recorder: ReplayRecorder | null = null;
    private ghosts: ActiveGhost[] = [];
    private board: BoardEntry[] = [];
    private elapsedMs = 0;
    private running = false;
    private attached = false;
    private remoteBoardLoaded = false;
    /** `?ghosts=all` — see MULTI_RUN_PARAM. Read once so it cannot change mid-race. */
    private readonly multiRun = multiRunEnabled();
    /** Resolved once at attach: explicit if given, otherwise derived. */
    private descriptor: VehicleDescriptor | null = null;

    constructor(
        private readonly engine: EngineLike,
        private readonly service: GameDataService,
        private readonly persistence: GamePersistence,
        private readonly identity: GhostIdentity,
        /** Published game id, for building challenge links. */
        private readonly gameId: string,
    ) {}

    /**
     * Load the level's ghosts and prepare a recorder. Call once per level.
     *
     * Failures here are non-fatal by design: a network hiccup should cost the
     * player their ghosts, never their race. The run still records and submits.
     */
    async attach(options: Partial<GhostRacingAttachOptions>): Promise<void> {
        this.detach();
        this.options = { ...DEFAULT_GHOST_RACING_OPTIONS, ...options };
        this.attached = true;

        const subject = this.options.subject();
        if (!subject) {
            console.warn('[GhostRacing] attach() found no subject — recording is disabled');
            return;
        }

        this.recorder = new ReplayRecorder(
            this.options.recorder,
            createVehicleMotionSampler(subject),
            this.options.input ? createInputSampler(this.options.input) : null,
        );
        this.descriptor = this.options.descriptor
            ?? describeVehicleForGhost(subject, this.options.assetId ?? undefined);

        // Local first, and without awaiting anything remote: your own best lap
        // is already on this device, so it becomes a ghost immediately even
        // with no connection at all.
        await this.addLocalGhost();

        try {
            await this.loadGhosts();
            this.remoteBoardLoaded = true;
        } catch {
            // Deliberately silent.
            //
            // The leaderboard is NOT unavailable: the player's own records are
            // local and already loaded, the board shows them, and their ghost
            // races. All that failed is fetching OTHER players' times, which
            // is an ordinary condition — offline, on a plane, or a game-server
            // that predates these endpoints.
            //
            // Saying "leaderboard unavailable" was simply wrong, and saying it
            // on every level load was noise on top. A game that wants to show
            // "offline — local times only" can ask `isRemoteBoardLoaded()`.
            this.remoteBoardLoaded = false;
        }
    }

    /**
     * False when other players' times could not be fetched.
     *
     * The board still has this device's own records either way — check this to
     * label them "local only", never to decide whether there are times at all.
     */
    isRemoteBoardLoaded(): boolean {
        return this.remoteBoardLoaded;
    }

    /** Begin recording and release the ghosts. Both run off the same clock. */
    startRun(): void {
        this.elapsedMs = 0;
        this.running = true;
        this.recorder?.start();
        for (const ghost of this.ghosts) ghost.vehicle.setVisible(true);
    }

    /** Advance the run clock, the recording, and every ghost. Seconds. */
    updateGhosts(deltaTime: number): void {
        if (!this.running) return;
        this.elapsedMs += deltaTime * 1000;
        this.recorder?.update(deltaTime);
        for (const ghost of this.ghosts) {
            ghost.vehicle.updateAt(this.elapsedMs, deltaTime);
            // A ghost that finished stays parked at the line rather than
            // vanishing — seeing where it stopped is the point of racing it.
            if (ghost.vehicle.isFinished(this.elapsedMs)) ghost.vehicle.setVisible(true);
        }
    }

    /** Abandon without submitting — a retirement, a restart, a menu exit. */
    abandonRun(): void {
        this.running = false;
        this.recorder?.stop();
        for (const ghost of this.ghosts) ghost.vehicle.setVisible(false);
    }

    /**
     * Finish, submit if it is a personal best, and report placement.
     *
     * Only personal bests are uploaded. The board is append-only, so writing
     * every lap would leave one row per attempt forever; gating on the local
     * best means writes track improvement instead of laps driven.
     */
    async finishRun(input: FinishRunInput): Promise<FinishRunResult> {
        this.running = false;
        const run = this.recorder?.stop() ?? null;
        const levelId = this.resolveLevelId();
        const previousBest = this.readPersonalBest()[levelId];
        const isPersonalBest = previousBest === undefined || input.timeMs < previousBest;

        // A truncated run stops mid-track, so its ghost would drive to the cap
        // and then stand still forever. Better no ghost than a broken one — and
        // the time is not trustworthy either, since the recording outlived it.
        const truncated = this.recorder?.isTruncated() ?? false;
        if (truncated) {
            console.warn('[GhostRacing] run exceeded the recording cap — not submitting');
        }

        // Multi-run records every lap; normally only an improvement is worth
        // storing, since the board is append-only.
        const worthKeeping = isPersonalBest || this.multiRun;
        if (!run || run.tracks.length === 0 || !worthKeeping || truncated) {
            return notSubmitted(isPersonalBest);
        }

        // Encoding must not be able to throw at the caller. `finishRun()` is
        // called from a game's finish-line handler, and an exception there
        // takes the results screen down with it — losing the player's lap over
        // a failure that only costs them a ghost. Same reasoning as the
        // truncated case above: no run stored, the race still ends.
        //
        // Bytes are the stored form; base64 is only how a string store holds
        // them, which `localStorage` needs and object storage does not.
        let runBytes: Uint8Array;
        let encodedRun: string;
        try {
            runBytes = await encodeRunBytes(run);
            encodedRun = bytesToBase64(runBytes);
        } catch (error) {
            console.warn('[GhostRacing] encoding the run failed — no ghost saved for this lap:', error);
            return notSubmitted(isPersonalBest);
        }

        // Save locally BEFORE anything touches the network. The upload is a
        // nice-to-have that makes the run visible to other players; the local
        // copy is what makes it visible to THIS player, and it must not depend
        // on a request that may be slow, offline, or rejected.
        writeLocalRun(
            levelId,
            { encodedRun, timeMs: input.timeMs, savedAt: Date.now(), assetId: this.options.assetId },
            this.multiRun ? MULTI_RUN_KEEP : 1,
        );
        this.writePersonalBest(levelId, input.timeMs);

        // Build the ghost NOW, while we are already in async code. Deferring it
        // to startRun() — which is synchronous — meant the decode had not
        // finished when the results screen asked what would race next, so the
        // panel showed nothing and the feature looked broken.
        await this.addLocalGhost();

        try {
            const credential = await this.identity.resolve();
            // The engine owns the name. A signed-in player already chose one on
            // their profile and a guest has a generated one, so there is never
            // a reason for a game to prompt for it.
            const name = await this.identity.displayName();
            // The bytes go to object storage and the entry keeps a URL. Inline
            // only when there is no bucket to put them in — a run inside its
            // entry costs ~20 KB of the game's 1 MB total, which is what used
            // to force a board to stop accepting times after a few dozen laps.
            const runUrl = await uploadRun(this.service, boardCategoryFor(levelId), runBytes);
            const entryId = await submitRun(this.service, {
                levelId,
                timeMs: input.timeMs,
                name,
                playerId: credential.playerId,
                verifier: credential.verifier,
                assetId: this.options.assetId,
                run: runUrl ? { kind: 'url', url: runUrl } : { kind: 'inline', encoded: encodedRun },
            });

            void this.publishManifest(levelId);

            const placement = await this.service
                .rank(boardCategoryFor(levelId), { field: 'values.timeMs', value: Math.round(input.timeMs), direction: 'asc' })
                .catch(() => null);

            return {
                rank: placement?.rank ?? null,
                total: placement?.total ?? null,
                isPersonalBest: true,
                challengeUrl: this.buildChallengeUrl(entryId, levelId),
                submitted: true,
            };
        } catch (error) {
            // The run is already saved locally, so the player keeps their ghost
            // and their personal best; only the shared board misses out.
            console.warn('[GhostRacing] uploading the run failed — kept locally:', error);
            return notSubmitted(isPersonalBest);
        }
    }

    /**
     * The level's board, best first, one row per player.
     *
     * Includes this device's own record even when the remote board is empty or
     * unreachable. A player who has driven the track HAS a time; showing "no
     * times recorded" because a request failed is simply wrong, and it was
     * wrong on screen as well as in the log.
     */
    getBoard(): readonly BoardEntry[] {
        // `fetchBoard` already merged this device's records in, so `this.board`
        // is complete. When the remote load failed outright, fall back to the
        // local rows directly — the player's own times are never conditional
        // on the network.
        if (this.board.length > 0) return this.board;
        return localBoardRows(this.resolveLevelId());
    }

    /**
     * The ghosts that will actually race on the next run.
     *
     * Distinct from `getBoard()`, which is the shared leaderboard. This is what
     * a "ghosts for the next run" panel should list — including your own local
     * best, which is present the moment you set it and never depends on the
     * upload having landed.
     */
    getActiveGhosts(): ActiveGhostInfo[] {
        return this.ghosts.map((ghost) => ({
            entryId: ghost.entry.entryId,
            name: ghost.entry.name,
            timeMs: ghost.entry.timeMs,
            assetId: ghost.entry.assetId,
            isLocal: isLocalEntryId(ghost.entry.entryId),
        }));
    }

    /**
     * Copy a challenge link to the clipboard.
     *
     * Returns false when there is nothing to copy or the browser refuses.
     * `clipboard-write` is already granted to the game iframe by the portal's
     * player (`portal/src/game-player.ts`), so no permission work is needed —
     * but a copy triggered outside a user gesture will still be rejected, and
     * the caller should keep the link visible as a fallback.
     */
    async copyChallengeLink(url: string): Promise<boolean> {
        if (!url || typeof navigator === 'undefined' || !navigator.clipboard) return false;
        try {
            await navigator.clipboard.writeText(url);
            return true;
        } catch (error) {
            console.warn('[GhostRacing] copying the challenge link failed:', error);
            return false;
        }
    }

    /**
     * What the recorder has captured so far.
     *
     * Exposed because a game may legitimately want to show it — and because a
     * `truncated` run is silently not submitted, which is otherwise invisible.
     */
    getRecordingStats(): RecordingStats {
        return {
            elapsedMs: this.recorder?.getElapsedMs() ?? 0,
            motionSamples: this.recorder?.getMotionSampleCount() ?? 0,
            inputTransitions: this.recorder?.getInputTransitionCount() ?? 0,
            truncated: this.recorder?.isTruncated() ?? false,
        };
    }

    /** True when this session was opened from a challenge link. */
    hasChallenge(): boolean {
        return this.readChallengeParam() !== null;
    }

    /**
     * Release every ghost and stop recording.
     *
     * Must be called on level switch. The scene graph is not a registry, and
     * ghost meshes left parented to a discarded scene are exactly the leak that
     * has bitten vehicles here before.
     */
    detach(): void {
        for (const ghost of this.ghosts) ghost.vehicle.dispose();
        this.ghosts = [];
        this.board = [];
        this.recorder = null;
        this.running = false;
        this.attached = false;
        this.elapsedMs = 0;
    }

    isAttached(): boolean {
        return this.attached;
    }

    private resolveLevelId(): string {
        return this.options.levelId ?? 'default';
    }

    /**
     * Load the board and materialize ghosts for the top runs.
     *
     * A challenge link pins its target as opponent one regardless of placement
     * — the whole point of the link is to race THAT run.
     */
    private async loadGhosts(): Promise<void> {
        const levelId = this.resolveLevelId();
        this.board = await fetchBoard(this.service, levelId, this.options.opponents);

        const challengeId = this.readChallengeParam();
        const wanted = [...this.board];
        if (challengeId && !wanted.some((entry) => entry.entryId === challengeId)) {
            // A challenge link carries only an entry id; the rest arrives with
            // the payload fetch, and assetId falls back to the viewer's car.
            wanted.unshift({
                entryId: challengeId, playerId: '', name: '', timeMs: 0, createdAt: '', assetId: null,
            });
        }

        // Your own uploaded runs are dropped: the local copy is the same lap,
        // fresher, and already loaded. Racing both would put two of you on track.
        const mine = await this.identity.resolve().then((c) => c.playerId).catch(() => '');
        const others = wanted.filter((entry) => !mine || entry.playerId !== mine);

        const room = Math.max(0, this.options.opponents - this.ghosts.length);
        for (const [index, entry] of others.slice(0, room).entries()) {
            const source = await fetchRunSource(this.service, levelId, entry.entryId).catch(() => null);
            if (!source) continue;
            await this.spawnGhost(entry, source, index + 1);
        }
    }

    private readChallengeParam(): string | null {
        return getLaunchParams().ghostEntryId;
    }

    /**
     * Build the shareable link.
     *
     * Points at the portal game page rather than the bundle origin so the link
     * records a play and earns play-time XP; the portal forwards both
     * parameters through to the iframe.
     *
     * ⚠ Carries the TRACK as well as the run. A board is one category per
     * level, so an entry id can only be fetched from the level it was set on —
     * a link with the run alone opened the game's start level and found
     * nothing there, which looked like a dead link to whoever received it.
     */
    private buildChallengeUrl(entryId: string, levelId: string): string | null {
        const portal = portalOrigin();
        if (!portal || !this.gameId) return null;
        const params = new URLSearchParams({ [CHALLENGE_PARAM]: entryId, [TRACK_PARAM]: levelId });
        return `${portal}/play/${encodeURIComponent(this.gameId)}/?${params.toString()}`;
    }

    /**
     * Build a ghost from this device's own best lap for the level.
     *
     * Runs before any network call and never fails the attach: a player with no
     * connection still races their own best.
     */
    private async addLocalGhost(): Promise<void> {
        const runs = readLocalRunsFor(this.resolveLevelId());
        if (runs.length === 0) return;

        // Replace rather than stack, so repeatedly beating your own time does
        // not accumulate a crowd of your past selves.
        const remote: ActiveGhost[] = [];
        for (const ghost of this.ghosts) {
            if (isLocalEntryId(ghost.entry.entryId)) ghost.vehicle.dispose();
            else remote.push(ghost);
        }
        this.ghosts = remote;

        const wanted = runs.slice(0, Math.max(1, this.options.opponents));
        for (const [index, run] of wanted.entries()) {
            await this.spawnGhost(
                {
                    // Suffixed so several local ghosts stay individually
                    // identifiable — replaceable as a group, distinct as rows.
                    entryId: localEntryId(index),
                    playerId: '',
                    name: index === 0 ? 'Your best' : `Your run ${index + 1}`,
                    timeMs: run.timeMs,
                    createdAt: '',
                    assetId: run.assetId ?? null,
                },
                { kind: 'inline', encoded: run.encodedRun },
                index,
            );
        }
    }

    /** Load a stored run and put a ghost in the scene. Bad runs are skipped. */
    private async spawnGhost(entry: BoardEntry, source: RunSource, tintIndex: number): Promise<void> {
        // Loading and building fail for different reasons and must not share a
        // catch. Lumping them together reported a crash in OUR vehicle-building
        // code as "skipping unreadable ghost", which points the reader at the
        // stored data — the one thing that was fine.
        let record: RunRecord;
        try {
            record = await loadRun(source);
        } catch (error) {
            // A run recorded by a newer format, or one whose object could not
            // be fetched, is skipped rather than guessed at. A ghost that plays
            // back subtly wrong is worse than no ghost.
            console.warn(`[GhostRacing] skipping unreadable run ${entry.entryId}:`, error);
            return;
        }

        try {
            const descriptor = this.descriptorForRun(entry.assetId);
            if (!descriptor) return;
            const vehicle = new GhostVehicle(new ReplayPlayer(record), descriptor, {
                ...DEFAULT_GHOST_VEHICLE_OPTIONS,
                engine: this.engine,
                // Clone the live car when the ghost IS that car. Exact, instant,
                // and it sidesteps rebuilding a body from a descriptor.
                bodyTemplate: this.bodyTemplateFor(entry.assetId),
                material: {
                    ...DEFAULT_GHOST_MATERIAL_OPTIONS,
                    tint: GHOST_TINTS[tintIndex % GHOST_TINTS.length] ?? null,
                },
            });
            vehicle.setVisible(false);
            const scene = this.engine.scene;
            if (!scene) {
                vehicle.dispose();
                return;
            }
            scene.add(vehicle.getObject3D());
            this.ghosts.push({ vehicle, entry });
        } catch (error) {
            console.error(
                `[GhostRacing] failed to BUILD the ghost for ${entry.entryId} — the run decoded `
                + 'fine, so this is an engine bug, not bad data:',
                error,
            );
        }
    }

    /**
     * The car a ghost should be drawn as.
     *
     * A record belongs to the vehicle that set it, so a run replays in ITS car
     * rather than whatever the viewer happens to be driving. Two cases fall back
     * to the local player's own vehicle: a run recorded before the asset was
     * captured, and an asset the game no longer ships — a creator can delete or
     * rename a kart at any time, and an old record must not vanish over it.
     */
    private descriptorForRun(assetId: string | null): VehicleDescriptor | null {
        if (!this.descriptor) return null;
        if (!assetId || assetId === this.options.assetId) return this.descriptor;
        if (!this.assetExists(assetId)) {
            console.warn(
                `[GhostRacing] ghost was set with '${assetId}', which this game no longer has `
                + '— drawing it as your own vehicle',
            );
            return this.descriptor;
        }
        return { ...this.descriptor, assetId };
    }

    /**
     * The live vehicle's body, when the ghost is driving the same car.
     *
     * Null for a ghost set in a DIFFERENT vehicle — cloning the player's car
     * there would misrepresent the record — which falls back to the asset load.
     */
    private bodyTemplateFor(assetId: string | null): THREE.Object3D | null {
        if (assetId && assetId !== this.options.assetId) return null;
        return this.options.subject()?.getChassisObject() ?? null;
    }

    /** Assets resolve by id OR name, matching how the loader looks them up. */
    private assetExists(assetId: string): boolean {
        const assets = this.engine.getGameData?.()?.assets;
        if (!assets) return false;
        return assets.some((asset) => asset.id === assetId || asset.name === assetId);
    }

    private readPersonalBest(): PersonalBests {
        const result = this.persistence.load<PersonalBests>(PB_SLOT);
        return result.data && typeof result.data === 'object' ? result.data : {};
    }

    private writePersonalBest(levelId: string, timeMs: number): void {
        const bests = this.readPersonalBest();
        bests[levelId] = timeMs;
        this.persistence.save(bests, PB_SLOT);
    }

    private async publishManifest(levelId: string): Promise<void> {
        if (!this.options.levelName) return;
        try {
            await publishBoardManifest(this.service, {
                levelId,
                levelName: this.options.levelName,
                category: boardCategoryFor(levelId),
            });
        } catch (error) {
            console.warn('[GhostRacing] publishing the board manifest failed:', error);
        }
    }
}
