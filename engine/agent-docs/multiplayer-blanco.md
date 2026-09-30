# Blanco: Event-Based Multiplayer

Multiplayer for games with **no walking avatar** — board, card, puzzle, turn-based, party.
Start at `@docs networking-system.md`; do NOT mix this with `MultiplayerSetup`.

---

Use `BlancoMultiplayerSetup` for games **without a walking player character**: board games, card games, puzzles, turn-based strategy, party games, and similar.

### When to use

- Players don't walk around — the camera shows a board, cards, or abstract UI
- Game logic is turn-based or event-based, not real-time position sync
- No player avatar, NPCs, animals, or weapons
- Examples: chess, tic-tac-toe, card games, trivia, strategy, idle/clicker

### Quick Start

```typescript
import { BlancoMultiplayerSetup } from 'engine/networking/index.js';

// Property
private multiplayer: BlancoMultiplayerSetup | null = null;

async load(gameId: string) {
    // Set up your game (board, cards, UI, camera — no player character)
    this.setupBoard();
    this.setupCamera();

    this.multiplayer = new BlancoMultiplayerSetup({
        engine: this.engine,
        lobbyOptions: { waitForPlayers: true, minPlayersToStart: 2, maxPlayers: 2 },
        onConnected: (_net, playerName) => {
            this.localPlayerName = playerName;
        },
        onPlayerJoined: (playerId, playerName) => {
            this.updatePlayerListUI();
        },
        onPlayerLeft: (playerId) => {
            this.handleDisconnection(playerId);
        },
    });

    // Register handlers BEFORE showLobby
    this.multiplayer.onGameState((_senderId, state) => {
        this.applyGameState(state);
    });
    this.multiplayer.onMove((senderId, move) => {
        if (this.multiplayer!.isRoomHost) {
            this.validateAndApplyMove(senderId, move);
        }
    });
    this.multiplayer.onTurnChange((_senderId, data) => {
        this.currentTurn = data.currentPlayerId;
        this.updateTurnUI();
    });

    this.multiplayer.showLobby(gameId);
}

// update()
this.multiplayer?.update(deltaTime);

// dispose()
this.multiplayer?.dispose();
```

### Pattern: Turn-Based Game (Tic-Tac-Toe)

Host validates all moves and broadcasts authoritative state. Non-host sends moves to host.

```typescript
// Player clicks a cell
onCellClicked(row: number, col: number): void {
    if (this.currentTurn !== this.multiplayer!.localPlayerId) return; // not your turn
    if (this.board[row][col] !== null) return; // cell taken

    if (this.multiplayer!.isRoomHost) {
        // Host: apply directly and broadcast
        this.applyMove(row, col, this.multiplayer!.localPlayerId);
        this.broadcastState();
    } else {
        // Non-host: send move to host for validation
        this.multiplayer!.sendMove({ row, col });
    }
}

// Host receives moves from non-host players (set up in load() above)
validateAndApplyMove(senderId: string, move: Record<string, unknown>): void {
    const row = move['row'] as number;
    const col = move['col'] as number;
    if (this.board[row][col] !== null) return; // invalid move
    if (this.currentTurn !== senderId) return; // wrong turn
    this.applyMove(row, col, senderId);
    this.broadcastState();
}

broadcastState(): void {
    this.multiplayer!.sendGameState({
        board: this.board,
        scores: this.scores,
        winner: this.winner,
    });
    const nextPlayer = this.getNextPlayer();
    this.currentTurn = nextPlayer;
    this.multiplayer!.sendTurnChange({
        currentPlayerId: nextPlayer,
        turnNumber: this.turnNumber,
    });
}
```

### Pattern: Real-Time Event Game (Card Game / Puzzle)

For games where any player can act at any time and the host arbitrates:

```typescript
// Any player plays a card
playCard(cardId: string): void {
    this.multiplayer!.sendMove({ action: 'playCard', cardId });
}

// Host validates and broadcasts
// In onMove handler:
if (this.multiplayer!.isRoomHost) {
    const action = move['action'] as string;
    if (action === 'playCard') {
        const result = this.resolveCardPlay(senderId, move['cardId'] as string);
        this.multiplayer!.sendGameState({
            hands: this.hands,
            pile: this.pile,
            lastAction: { player: senderId, ...result },
        });
    }
}
```

### Custom events

For game-specific events beyond state/move/turn, use the `NetworkManager` directly:

```typescript
// Send
this.multiplayer!.networkManager.sendEvent('emoji', { emoji: '😂' });

// Receive
this.multiplayer!.networkManager.events.on('emoji', (senderId, data) => {
    this.showEmojiReaction(senderId, data['emoji'] as string);
});
```

### Accessing player info

```typescript
// Local player
const myId = this.multiplayer!.localPlayerId;
const myName = this.multiplayer!.localPlayerName;

// All connected players (Map<playerId, playerName>)
const players = this.multiplayer!.connectedPlayers;

// Am I the host? (authority for game state)
if (this.multiplayer!.isRoomHost) { ... }
```

### What NOT to do in blanco games

- ❌ Do NOT import `getDefaultCharacterUrl`, `buildAnimationList`, `NetworkCharacterController`
- ❌ Do NOT add `player` spawn points (or legacy `"Multiplayer Spawn Point"` markers) — there is no 3D world
- ❌ Do NOT create a `PlayerController` or `PlayerLoader`
- ❌ Do NOT use `NetworkObject` for board/game state — use `sendGameState()` instead
- ❌ Do NOT use `MultiplayerSetup` — use `BlancoMultiplayerSetup`
- ❌ Do NOT register `onUnknownObject` — there are no remote character meshes

---
