# Persistence System (Save/Load)

`GamePersistence` lets game code save and load player progress (checkpoints, scores, inventory, positions). Saves live in browser localStorage (with automatic incognito detection and version migrations) and, for a signed-in player, are mirrored to their Bitmagic account automatically — see [Account sync](#account-sync-automatic).

## Quick Start

```typescript
// Get persistence from engine
const persistence = this.engine.getGamePersistence?.();

// Save progress (third argument is the notification label)
persistence?.save({ score: 42, checkpoint: 'level-3' }, 'default', 'Checkpoint');

// Load progress (second argument is the notification label)
const result = persistence?.load<{ score: number; checkpoint: string }>('default', 'Checkpoint');
if (result?.data) {
  this.score = result.data.score;
}
```

## Saving Player Position (Checkpoints)

Use `getGroundPosition()` to capture and `teleportTo()` to restore:

```typescript
// Save checkpoint with player position
const pos = this.playerController.getGroundPosition();
persistence?.save({
  checkpoint: 'boss-room',
  position: { x: pos.x, y: pos.y, z: pos.z },
  score: this.score,
}, 'default', 'Boss Room');

// Load and restore position
const result = persistence?.load<{ position: { x: number; y: number; z: number }; score: number }>();
if (result?.data) {
  this.score = result.data.score;
  const p = result.data.position;
  this.playerController.teleportTo(p.x, p.y, p.z);
}
```

**IMPORTANT:** Always use `getGroundPosition()` (feet/ground level from physics capsule), NOT `getPosition()` (visual position with character model offsets). `teleportTo()` expects ground-level coordinates.

`teleportTo(x, y, z, rotationY?)` handles physics body, velocity reset, collider freeze, and terrain chunk activation automatically.

## API Reference

| Method | Description |
|--------|-------------|
| `save(data, slot?, name?)` | Save JSON data. Shows notification with `name`. Returns `{ success, error? }` |
| `load<T>(slot?, name?)` | Load data. Shows notification with `name` if data found. Returns `{ data, version, migrated, error? }` |
| `hasSave(slot?)` | Check if save exists |
| `deleteSave(slot?)` | Delete a save slot |
| `listSlots()` | List all save slots for this game |
| `registerMigrations(map)` | Register version migration functions |
| `setNotification(config)` | Configure or disable auto-notifications |

Default slot is `'default'`. Use named slots for multiple save profiles: `save(data, 'profile-1')`.

## Notifications

Save and load automatically show a brief toast notification. The `name` parameter in `save()`/`load()` replaces `{name}` in the message template.

```typescript
// Custom notification messages using {name} placeholder
persistence?.setNotification({
  saveMessage: '{name} saved!',
  loadMessage: '{name} restored!',
  durationMs: 1500,
});
persistence?.save(data, 'default', 'Level 3');  // Shows "Level 3 saved!"

// Disable notifications entirely
persistence?.setNotification({ enabled: false });
```

Default messages are `"Progress saved"` / `"Progress restored"`. When using `{name}` in custom templates, always pass a name to `save()`/`load()` — otherwise `{name}` appears literally.

## Version Migrations

Games are versioned by publish version. When save data format changes between versions, register migrations:

```typescript
const persistence = this.engine.getGamePersistence?.();
if (persistence) {
  persistence.registerMigrations({
    // v1 → v2: added highScore field
    2: (old) => {
      const d = old as { score: number };
      return { score: d.score, highScore: d.score };
    },
    // v2 → v3: renamed score to points
    3: (old) => {
      const d = old as { score: number; highScore: number };
      return { points: d.score, highScore: d.highScore };
    },
  });
}
```

Migrations chain automatically (v1 save + v3 code runs v1→v2→v3). If migrations are missing, the raw data is returned as-is — the game code should handle what it can.

## Account sync (automatic)

Nothing in game code changes for this: the same `save()`/`load()` calls work for everyone.

- A **signed-in player's** saves are copied to their Bitmagic account in the background and restored on any device they sign in on — a cleared browser or a new computer picks up where they left off. This is what makes a game that is played over weeks or months possible.
- A **guest's** saves stay in the browser only, exactly as before. When a guest signs in, the progress in that browser joins the account; if the account already has a save in the same slot, the account's copy wins (the browser copy is kept as a local backup).
- Between a player's own devices the most recent save wins. A deleted slot stays deleted everywhere.
- On localhost there are no accounts: the game runs as the **local player**, whose saves persist in the browser through the same sync path (a local stand-in for the account store). The creator's Save Data Inspector shows who the saves belong to and has **Reset Local Player**, which forgets every save for the game and reloads it as a brand-new player — the way to test a first visit.
- Keep each slot well under 256 KB and use at most 32 slots per game. A save above the limit stays in the browser only (a console warning says so); a multi-megabyte save is a sign that something that is not progress — a screenshot, a replay, raw world data — is being saved.

## Important Notes

- **Incognito mode**: Automatically detected. A toast warns the player. All operations degrade gracefully (save returns `{ success: false }`, load returns `{ data: null }`).
- **Storage full**: `save()` returns `{ success: false, error: 'localStorage write failed (possibly full)' }`.
- **Data format**: Save anything JSON-serializable. Keep saves small — localStorage has a ~5MB limit and account sync accepts 256 KB per slot.
- **Call `registerMigrations()` before `load()`** so migrations run on first load.
- **Position**: Always use `getGroundPosition()` for save/teleport — it returns physics-accurate feet position. Do NOT use `getPosition()` which includes visual model offsets and will cause the player to float.
