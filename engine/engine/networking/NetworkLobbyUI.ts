// Multiplayer lobby UI: name input → room browser → join/create room → optional waiting room
// With autoJoin enabled, skips room browser and auto-joins/creates rooms.
// With waitForPlayers enabled, shows waiting room after connecting until minPlayersToStart met.
//
// Visual styling is fully theme-driven via .hud-lobby-* classes in hud-base.css
// — this module owns DOM construction, event wiring, and lifecycle only.
import type { RoomInfo } from 'engine/networking/NetworkTypes.js';
import { getPreference, setPreference } from 'engine/PreferenceStorage.js';
import { injectHudBaseStyles } from 'engine/hud/index.js';

export interface LobbyJoinEvent {
    roomId: string;
    roomName: string;
    /** The actual gameId for this room (may differ from the base gameId when joining versioned rooms). */
    gameId?: string;
    data?: Record<string, unknown>;
    /** True when the player created this room (vs joining an existing one). */
    isCreator?: boolean;
}

/** Options controlling lobby behaviour. */
export interface LobbyOptions {
    /** Max players per room (default 8). Shown in room list, used for auto-join filtering. */
    maxPlayers?: number;
    /**
     * When true (default), after name input the lobby auto-joins the first open room
     * with space, or auto-creates a new room if none available. Skips room browser entirely.
     */
    autoJoin?: boolean;
    /**
     * When true, after connecting to a room the lobby shows a waiting room UI
     * until minPlayersToStart players are present. Then fires `gameStart` event
     * and hides the lobby. Default: false.
     */
    waitForPlayers?: boolean;
    /**
     * Minimum players needed to start the game (used with waitForPlayers).
     * Default: 2.
     */
    minPlayersToStart?: number;
    /**
     * When true, the game automatically enters PLAYING state after connecting
     * to a room — no "Enter Game" button is shown. The template's `onConnected`
     * callback fires and can immediately show custom UI (e.g. a pre-round lobby).
     *
     * Use this for games where the template controls the start flow (strategy,
     * tower defense, etc.) and doesn't want the engine's built-in "Enter Game"
     * interstitial.
     *
     * Default: false.
     */
    autoEnterGame?: boolean;
}

const MAX_PLAYER_NAME_LENGTH = 16;
const MAX_ROOM_NAME_LENGTH = 40;
const ROOM_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_PLAYERS = 8;
const DEFAULT_MIN_PLAYERS_TO_START = 2;
const INVALID_INPUT_FLASH_MS = 1000;
const FADE_DURATION_MS = 300;

export class NetworkLobbyUI {
    private container: HTMLElement;
    private overlay: HTMLElement | null = null;
    private panel: HTMLElement | null = null;

    // Name input view
    private nameInput: HTMLInputElement | null = null;

    // Room browser view
    private roomListElement: HTMLElement | null = null;
    private roomNameInput: HTMLInputElement | null = null;

    // Waiting room view
    private waitingPlayerCountEl: HTMLElement | null = null;
    private waitingPlayerListEl: HTMLElement | null = null;
    private waitingStartBtn: HTMLButtonElement | null = null;

    // Callbacks
    private onJoin: ((event: LobbyJoinEvent) => void) | null = null;
    private onNameConfirmed: ((playerName: string) => void) | null = null;
    private onGameStart: (() => void) | null = null;
    private onEnterGameRequested: (() => void) | null = null;
    private pollInterval: ReturnType<typeof setInterval> | null = null;

    // State
    private gameId: string = '';
    private playerName: string = '';
    private fetchRoomListFn: ((gameId: string) => Promise<RoomInfo[]>) | null = null;
    private isInWaitingRoom: boolean = false;

    // Options
    private maxPlayers: number = DEFAULT_MAX_PLAYERS;
    private autoJoin: boolean = true;
    private waitForPlayers: boolean = false;
    private minPlayersToStart: number = DEFAULT_MIN_PLAYERS_TO_START;

    constructor(container: HTMLElement) {
        this.container = container;
        // Lobby can show before the in-game HUD has constructed, so inject
        // styles defensively. Idempotent — no-op if already present.
        injectHudBaseStyles();
    }

    /**
     * Show the lobby overlay — starts with the mandatory name input view.
     * After the player enters a name:
     * - If autoJoin is true (default): auto-joins first open room or creates one.
     * - If autoJoin is false: transitions to the room browser.
     * After connecting (if waitForPlayers is true): shows waiting room until minPlayersToStart met.
     */
    show(
        gameId: string,
        fetchRoomList: (gameId: string) => Promise<RoomInfo[]>,
        onJoin: (event: LobbyJoinEvent) => void,
        onNameConfirmed?: (playerName: string) => void,
        options?: LobbyOptions,
    ): void {
        this.gameId = gameId;
        this.fetchRoomListFn = fetchRoomList;
        this.onJoin = onJoin;
        this.onNameConfirmed = onNameConfirmed ?? null;
        this.maxPlayers = options?.maxPlayers ?? DEFAULT_MAX_PLAYERS;
        this.autoJoin = options?.autoJoin ?? true;
        this.waitForPlayers = options?.waitForPlayers ?? false;
        this.minPlayersToStart = options?.minPlayersToStart ?? DEFAULT_MIN_PLAYERS_TO_START;

        if (this.overlay) this.dispose();
        this.createOverlay();
        this.showNameInputView();
    }

    hide(): void {
        this.stopPolling();
        this.isInWaitingRoom = false;
        if (this.overlay) {
            delete this.overlay.dataset.visible;
            setTimeout(() => {
                this.overlay?.remove();
                this.overlay = null;
                this.panel = null;
            }, FADE_DURATION_MS);
        }
    }

    dispose(): void {
        this.stopPolling();
        this.isInWaitingRoom = false;
        this.overlay?.remove();
        this.overlay = null;
        this.panel = null;
        this.roomListElement = null;
        this.roomNameInput = null;
        this.nameInput = null;
        this.waitingPlayerCountEl = null;
        this.waitingPlayerListEl = null;
        this.waitingStartBtn = null;
        this.onJoin = null;
        this.onNameConfirmed = null;
        this.onGameStart = null;
        this.onEnterGameRequested = null;
        this.fetchRoomListFn = null;
    }

    /** Get the confirmed player name. Available after the name input step. */
    getPlayerName(): string {
        return this.playerName;
    }

    /** Whether waitForPlayers mode is active. */
    isWaitingForPlayers(): boolean {
        return this.waitForPlayers;
    }

    /**
     * Show the waiting room view (called by NetworkManager after connection).
     * @param onGameStart — called when enough players are present and game should start
     */
    showWaitingRoom(onGameStart: () => void): void {
        this.onGameStart = onGameStart;
        this.isInWaitingRoom = true;
        this.showWaitingRoomView();
    }

    showEnterGameView(onEnterGameRequested: () => void): void {
        this.onEnterGameRequested = onEnterGameRequested;
        this.isInWaitingRoom = false;
        this.stopPolling();

        const panel = this.createPanel();

        const title = document.createElement('h2');
        title.className = 'hud-lobby-title';
        title.textContent = 'Ready to Enter';
        panel.appendChild(title);

        const body = document.createElement('p');
        body.className = 'hud-lobby-body';
        body.textContent = 'Your room is ready. Tap below to enter the game.';
        panel.appendChild(body);

        const enterBtn = this.createButton('Enter Game', () => {
            this.onEnterGameRequested?.();
        });
        enterBtn.classList.add('hud-lobby-button--full-width');
        panel.appendChild(enterBtn);
    }

    /**
     * Update the waiting room player list. Called by NetworkManager on join/leave.
     * @param players — array of { playerId, playerName } currently in the room (including local)
     */
    updateWaitingRoom(players: Array<{ playerId: string; playerName: string }>): void {
        if (!this.isInWaitingRoom) return;

        // Update count — show "ready!" once threshold met
        if (this.waitingPlayerCountEl) {
            this.waitingPlayerCountEl.textContent = players.length >= this.minPlayersToStart
                ? `${players.length} players — ready!`
                : `${players.length} / ${this.minPlayersToStart}`;
        }

        // Update player list
        if (this.waitingPlayerListEl) {
            this.waitingPlayerListEl.replaceChildren();
            for (const p of players) {
                const row = document.createElement('div');
                row.className = 'hud-lobby-player-row';
                const dot = document.createElement('span');
                dot.className = 'hud-lobby-player-row__dot';
                row.appendChild(dot);
                const nameEl = document.createElement('span');
                nameEl.textContent = p.playerName;
                row.appendChild(nameEl);
                this.waitingPlayerListEl.appendChild(row);
            }
        }

        // Enable/disable start button based on player count
        if (this.waitingStartBtn) {
            this.waitingStartBtn.disabled = players.length < this.minPlayersToStart;
        }
    }

    /**
     * Temporarily hide or re-show the lobby overlay without disposing it.
     * Used by the editor to hide the lobby when switching to non-prompt tabs.
     */
    setVisible(visible: boolean): void {
        if (!this.overlay) return;
        if (visible) {
            this.overlay.style.display = 'flex';
            // Restart room polling if we have a room list visible
            if (this.roomListElement && !this.pollInterval) {
                this.refreshRoomList();
                this.pollInterval = setInterval(() => this.refreshRoomList(), ROOM_POLL_INTERVAL_MS);
            }
        } else {
            this.overlay.style.display = 'none';
            this.stopPolling();
        }
    }

    // =========================================================================
    // Overlay shell (shared by all views)
    // =========================================================================

    private createOverlay(): void {
        this.overlay = document.createElement('div');
        this.overlay.className = 'hud-lobby-overlay';
        this.overlay.dataset.networkLobby = 'true';
        this.container.appendChild(this.overlay);

        // Fade in: set data-visible on next frame so the opacity transition fires.
        requestAnimationFrame(() => {
            if (this.overlay) this.overlay.dataset.visible = 'true';
        });
    }

    private createPanel(): HTMLElement {
        this.panel?.remove();
        const panel = document.createElement('div');
        panel.className = 'hud-lobby-panel';
        this.panel = panel;
        this.overlay?.appendChild(panel);
        return panel;
    }

    // =========================================================================
    // View 1: Name Input
    // =========================================================================

    private showNameInputView(): void {
        const panel = this.createPanel();

        // Title
        const title = document.createElement('h2');
        title.className = 'hud-lobby-title';
        title.textContent = 'Enter Your Name';
        panel.appendChild(title);

        // Name input
        this.nameInput = document.createElement('input');
        this.nameInput.type = 'text';
        this.nameInput.className = 'hud-lobby-input';
        this.nameInput.placeholder = 'Your name...';
        this.nameInput.maxLength = MAX_PLAYER_NAME_LENGTH;
        this.nameInput.value = getPreference('player-name') ?? 'Player';
        this.nameInput.style.textAlign = 'center';
        this.nameInput.addEventListener('focus', () => { this.nameInput?.select(); });
        this.nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === 'Enter') this.handleNameSubmit();
        });
        panel.appendChild(this.nameInput);

        // Continue button
        const continueBtn = this.createButton('Continue', () => this.handleNameSubmit());
        continueBtn.classList.add('hud-lobby-button--full-width');
        panel.appendChild(continueBtn);

        // Auto-focus after frame to ensure overlay is visible
        requestAnimationFrame(() => {
            this.nameInput?.focus();
            this.nameInput?.select();
        });
    }

    private handleNameSubmit(): void {
        if (!this.nameInput) return;
        const name = this.nameInput.value.trim();
        if (!name) {
            this.flashInvalid(this.nameInput);
            return;
        }
        this.playerName = name;
        setPreference('player-name', name);
        this.onNameConfirmed?.(name);

        if (this.autoJoin) {
            this.attemptAutoJoin();
        } else {
            this.showRoomBrowserView();
        }
    }

    // =========================================================================
    // Auto-join: skip room browser, find or create a room automatically
    // =========================================================================

    private async attemptAutoJoin(): Promise<void> {
        // Show a "Finding game..." status while we fetch rooms
        const panel = this.createPanel();
        const status = document.createElement('div');
        status.className = 'hud-lobby-status';
        status.textContent = 'Finding game...';
        panel.appendChild(status);

        try {
            const rooms = this.fetchRoomListFn ? await this.fetchRoomListFn(this.gameId) : [];

            // Find first open room with space, prefer fullest (occupancy sort)
            const openRoom = rooms
                .filter(r => {
                    const cap = (r.data?.['maxPlayers'] as number) || this.maxPlayers;
                    return r.data?.['closed'] !== true && r.clients < cap;
                })
                .sort((a, b) => b.clients - a.clients)[0];

            if (openRoom) {
                // Auto-join existing room
                this.onJoin?.({
                    roomId: openRoom.roomId,
                    roomName: openRoom.name,
                    gameId: openRoom.gameId,
                });
            } else {
                // Auto-create a new room
                const roomId = crypto.randomUUID();
                const roomName = `${this.playerName}'s Game`;
                this.onJoin?.({
                    roomId,
                    roomName,
                    isCreator: true,
                    data: { maxPlayers: this.maxPlayers },
                });
            }
        } catch (_err) {
            // On error, fall back to room browser so player can manually create/join
            status.textContent = 'Could not find rooms, showing browser...';
            status.classList.add('hud-lobby-status--error');
            setTimeout(() => this.showRoomBrowserView(), 1000);
        }
    }

    // =========================================================================
    // View 2: Room Browser
    // =========================================================================

    private showRoomBrowserView(): void {
        const panel = this.createPanel();

        // Title row: heading + player name badge
        const titleRow = document.createElement('div');
        titleRow.className = 'hud-lobby-title-row';

        const title = document.createElement('h2');
        title.className = 'hud-lobby-title';
        title.textContent = 'Multiplayer Rooms';
        titleRow.appendChild(title);

        // Player name badge
        const nameBadge = document.createElement('div');
        nameBadge.className = 'hud-lobby-name-badge';
        nameBadge.textContent = this.playerName;
        titleRow.appendChild(nameBadge);
        panel.appendChild(titleRow);

        // Room list container
        this.roomListElement = document.createElement('div');
        this.roomListElement.className = 'hud-lobby-list';
        panel.appendChild(this.roomListElement);

        // Loading text
        const loading = document.createElement('div');
        loading.className = 'hud-lobby-muted';
        loading.textContent = 'Loading rooms...';
        this.roomListElement.appendChild(loading);

        // Divider
        const divider = document.createElement('hr');
        divider.className = 'hud-lobby-divider';
        panel.appendChild(divider);

        // Create room section
        const createSection = document.createElement('div');
        createSection.className = 'hud-lobby-create-section';

        this.roomNameInput = document.createElement('input');
        this.roomNameInput.type = 'text';
        this.roomNameInput.className = 'hud-lobby-input hud-lobby-input--inline';
        this.roomNameInput.placeholder = 'New room name...';
        this.roomNameInput.maxLength = MAX_ROOM_NAME_LENGTH;
        this.roomNameInput.addEventListener('keydown', (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === 'Enter') this.handleCreateRoom();
        });
        createSection.appendChild(this.roomNameInput);

        const createBtn = this.createButton('Create Room', () => this.handleCreateRoom());
        createSection.appendChild(createBtn);

        panel.appendChild(createSection);

        // Start fetching rooms
        this.refreshRoomList();
        this.pollInterval = setInterval(() => this.refreshRoomList(), ROOM_POLL_INTERVAL_MS);
    }

    // =========================================================================
    // View 3: Waiting Room (waitForPlayers mode)
    // =========================================================================

    private showWaitingRoomView(): void {
        this.stopPolling();
        const panel = this.createPanel();

        // Title
        const title = document.createElement('h2');
        title.className = 'hud-lobby-title';
        title.textContent = 'Waiting for Players';
        title.style.marginBottom = '8px';
        panel.appendChild(title);

        // Subtitle with player count
        const subtitle = document.createElement('div');
        subtitle.className = 'hud-lobby-waiting-subtitle';
        subtitle.appendChild(document.createTextNode('Need '));

        this.waitingPlayerCountEl = document.createElement('span');
        this.waitingPlayerCountEl.className = 'hud-lobby-count';
        this.waitingPlayerCountEl.textContent = `0 / ${this.minPlayersToStart}`;
        subtitle.appendChild(this.waitingPlayerCountEl);

        subtitle.appendChild(document.createTextNode(' players to start'));
        panel.appendChild(subtitle);

        // Player list
        this.waitingPlayerListEl = document.createElement('div');
        this.waitingPlayerListEl.className = 'hud-lobby-list hud-lobby-list--compact';
        panel.appendChild(this.waitingPlayerListEl);

        // Loading placeholder
        const loadingEl = document.createElement('div');
        loadingEl.className = 'hud-lobby-muted';
        loadingEl.textContent = 'Connecting...';
        this.waitingPlayerListEl.appendChild(loadingEl);

        // Divider
        const divider = document.createElement('hr');
        divider.className = 'hud-lobby-divider';
        panel.appendChild(divider);

        // Start Game button (disabled until minPlayers met)
        this.waitingStartBtn = this.createButton('Start Game', () => {
            this.onGameStart?.();
        });
        this.waitingStartBtn.classList.add('hud-lobby-button--full-width');
        this.waitingStartBtn.disabled = true;
        panel.appendChild(this.waitingStartBtn);
    }

    // =========================================================================
    // Shared helpers
    // =========================================================================

    private createButton(text: string, onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = 'hud-lobby-button';
        btn.textContent = text;
        btn.addEventListener('click', () => {
            if (!btn.disabled) onClick();
        });
        return btn;
    }

    private flashInvalid(input: HTMLInputElement): void {
        input.classList.add('is-invalid');
        setTimeout(() => {
            input.classList.remove('is-invalid');
        }, INVALID_INPUT_FLASH_MS);
    }

    private async refreshRoomList(): Promise<void> {
        if (!this.roomListElement || !this.fetchRoomListFn) return;

        try {
            const rooms = await this.fetchRoomListFn(this.gameId);
            this.renderRoomList(rooms);
        } catch (_err) {
            if (!this.roomListElement) return;
            this.roomListElement.replaceChildren();
            const errEl = document.createElement('div');
            errEl.className = 'hud-lobby-muted hud-lobby-status--error';
            errEl.textContent = 'Could not load rooms';
            this.roomListElement.appendChild(errEl);
        }
    }

    private renderRoomList(rooms: RoomInfo[]): void {
        if (!this.roomListElement) return;
        this.roomListElement.replaceChildren();

        if (rooms.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'hud-lobby-muted';
            empty.textContent = 'No rooms yet — create one!';
            this.roomListElement.appendChild(empty);
            return;
        }

        for (const room of rooms) {
            const isClosed = room.data?.['closed'] === true;
            const roomMaxPlayers = (room.data?.['maxPlayers'] as number) || this.maxPlayers;
            const isFull = room.clients >= roomMaxPlayers;

            const row = document.createElement('div');
            row.className = 'hud-lobby-room-row';
            if (isClosed || isFull) row.classList.add('is-disabled');

            const info = document.createElement('div');
            info.className = 'hud-lobby-room-row__info';

            const nameRow = document.createElement('div');
            nameRow.className = 'hud-lobby-room-row__name-row';

            const name = document.createElement('div');
            name.className = 'hud-lobby-room-row__name';
            name.textContent = room.name;
            nameRow.appendChild(name);

            // Player count badge (e.g. "3/8")
            const countBadge = document.createElement('span');
            countBadge.className = isFull ? 'hud-lobby-room-badge hud-lobby-room-badge--full' : 'hud-lobby-room-badge';
            countBadge.textContent = `${room.clients}/${roomMaxPlayers}`;
            nameRow.appendChild(countBadge);

            const players = document.createElement('div');
            players.className = 'hud-lobby-room-row__players';
            const playerNames = room.players.map(p => p.playerName);
            players.textContent = room.clients === 0 ? 'Empty' : playerNames.join(', ');

            info.appendChild(nameRow);
            info.appendChild(players);
            row.appendChild(info);

            if (isClosed || isFull) {
                const badge = document.createElement('span');
                badge.className = 'hud-lobby-room-badge hud-lobby-room-badge--status';
                badge.textContent = isClosed ? 'In Progress' : 'Full';
                row.appendChild(badge);
            } else {
                const joinBtn = this.createButton('Join', () => {
                    this.onJoin?.({ roomId: room.roomId, roomName: room.name, gameId: room.gameId });
                });
                joinBtn.classList.add('hud-lobby-button--small');
                row.appendChild(joinBtn);
            }

            this.roomListElement.appendChild(row);
        }
    }

    private handleCreateRoom(): void {
        if (!this.roomNameInput) return;
        const name = this.roomNameInput.value.trim();
        if (!name) {
            this.flashInvalid(this.roomNameInput);
            return;
        }

        // Generate a unique room ID (UUID)
        const roomId = crypto.randomUUID();
        this.onJoin?.({ roomId, roomName: name, isCreator: true, data: { maxPlayers: this.maxPlayers } });
    }

    private stopPolling(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }
}
