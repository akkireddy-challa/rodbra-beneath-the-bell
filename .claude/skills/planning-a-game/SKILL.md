---
name: planning-a-game
description: Use before writing code for a new Bitmagic game, a new genre, or any change touching more than one gameplay feature — scoping the first playable slice, deciding what to defer, choosing which engine systems to use, or routing a genre (racing, shooter, tower defense, platformer, combat, driving, soccer, skiing) to its mechanic recipe. Produces mechanics-plan.md.
---

# Planning a Bitmagic game

Two rules govern everything below. **Build the smallest playable thing first, then iterate with the
human.** And **plan on paper before you touch `Game.ts`** — planning after the code is written is
worthless.

Scope the playable slice without lowering the requested visual ambition. Build the look first,
keep efficient implementation habits, then profile the assembled scene. There is no default
60 FPS gate. Report poor FPS/stutter and test limits; ask before any visual sacrifice, even when
asked to optimize. See `engine/agent-docs/performance-best-practices.md`.

Skip the plan for a single-mechanic edit ("raise jump height", "make the enemies faster", "add a
sword"), or when the human says it is just one thing. In doubt, write it.

## Step 1 — read the design, then the recipe

`GAME-DESIGN.md` says what the game is. Read it first; if it is empty, write it (or ask), because
`bitmagic cover` generates the cover art from it and that art is the only thing the human has to
look at while you build.

If the idea describes a **place** — an island, a city, a specific look — offer a reference image
before anything else is generated: `bitmagic reference make`, show the human the file it prints,
iterate with `--from <id>`, and run `accept` only when they choose one. Every skybox, block,
cover and forge after that inherits the accepted image, so it is worth settling first — and worth
skipping when the idea has no visual identity yet.

If the idea names a genre, read its recipe **before you decide anything else**:

| The idea mentions… | Read |
|---|---|
| race, racing, lap, drift, circuit, derby, kart, F1, rally | `engine/agent-docs/mechanic-racing.md` |
| combat, fight, battle, arena, deathmatch, royale, gladiator, boss | `engine/agent-docs/mechanic-combat.md` |
| tower defense, TD, waves, defend, base | `engine/agent-docs/mechanic-tower-defense.md` |
| platformer, parkour, jumping, platforms | `engine/agent-docs/mechanic-platformer.md` |
| shooter, FPS, top-down shooter, twin-stick, guns | `engine/agent-docs/mechanic-shooter.md` |
| driving, GTA, open-world driving, traffic, cars | `engine/agent-docs/mechanic-driving.md` |
| soccer, football, kick a ball, penalty shootout, free kick | `engine/agent-docs/mechanic-soccer.md` |
| ski, skiing, snowboard, downhill, slope, piste, slalom, carve | `engine/agent-docs/mechanic-skiing.md` |
| boat race, jet ski, wave race, speedboat, powerboat, watercraft, regatta | `engine/agent-docs/mechanic-boat-racing.md` |
| galleon, pirate ship, sailing ship, longship, voyage, at the helm, steer the ship | `engine/agent-docs/mechanic-sailing.md` |

For the shape of the PLACE the game happens in, also read the matching
`engine/agent-docs/archetype-*.md` — `arena`, `castle`, `city`, `dungeon`, `racetrack`,
`ruins`, `soccer`, `village`, `wilderness`.

**The recipe's contract is binding** unless the human explicitly asked for something else: camera
mode, whether the player is an embodied walking character at all, the core systems, the win/lose
shape. First-person phrasing in a request ("I defend my castle", "I place towers") is how everyone
describes a game — it is NOT a request for a walking avatar with weapons.

If no recipe matches — survival, sandbox, a puzzle, something new — that is normal. Do not force the
nearest one; plan from the design doc.

## Step 2 — do not build what the engine already ships

Check this before you plan a single system. Almost everything a first slice needs is **already in
the engine, already wired** — and hand-building a worse version of it is the most common way a slice
1 goes wrong.

| The idea needs… | The engine already has | Read |
|---|---|---|
| A melee weapon — sword, axe, katana, spear, staff, lightsaber | 12 built-in procedural weapons | `combat-system.md` |
| A ranged weapon — pistol, rifle, bow, crossbow, bazooka, laser | Built-in set; aiming adapts to the camera mode | `combat-system.md` |
| Punching, kicking, martial arts | `UnarmedMeleeSystem`, animations pre-loaded | `combat-system.md` |
| Enemies that patrol, chase, attack, follow, flee, trade | NPC behaviours; NPCs use the built-in weapons too | `npc-system.md` |
| Animals, snakes, fish, birds, dragons | Procedural creature systems | `animal-instructions.md`, `snake-instructions.md` |
| Score, timers, health bars, game-over and win screens | HUD + end-game systems | `HUD_ELEMENTS.md`, `end-game.md` |
| A start screen — cover image, title, Play-button label | Start-screen system | `START_SCREEN.md` |
| An opening cutscene or any full-screen video | `engine.playVideo()` fullscreen overlay | `video-cutscenes.md` |
| Collectibles, pickups, checkpoints, markers | Dedicated systems | `collectible-objects.md`, `markers-system.md` |
| Doors, locked doors and their keys | `worldProfileData.doors[]` + `keyItems[]` | `doors-and-locks.md` |
| Moving platforms, elevators, crushers, conveyors, spinners | `mechanisms[]` in world.json | `moving-platforms.md` |
| Enterable buildings — bases, spawn rooms, shops | `building` hotspots, built at load time on any terrain | `environment-objects.md` |
| Achievements and XP | Real per-game achievements; never hand-build a tracker | `achievements.md` |
| Mining, chopping, digging | `PlayerToolSystem` + auto-wired block mining | `voxel-mining.md` |
| Skiing or snowboarding | A full descent motor, enabled by one world.json flag | `mechanic-skiing.md` |
| Boat racing on open water | An animated stylized ocean, a hull that rides it, AI rivals and buoy gates | `mechanic-boat-racing.md` |
| A ship that sails while the player walks its deck | `engine/sailing/`: a moving sea, wake, swell, a heavy-ship helm and a horizon that swings with it — the forged hull never moves | `mechanic-sailing.md` |
| Save points, checkpoints, persistence | Persistence system | `persistence-system.md` |
| Multiple levels or arenas | `levels[]` registry + `engine.loadLevel()` | `level-system.md` |
| Voice input, speaking to NPCs | `engine.enablePushToTalk()` | `voice-input.md` |
| A key for a new action — shoot, reload, boost, throw | `registerCustomAction()` / `declareMobileActions()` — one call binds the desktop key AND the phone button | `control-system.md` |
| A game played by tapping the scene — board, builder, strategy, no player to move | No player controller (the `no-character` template) or `hasPlayerCharacter: false` in `worldProfileData` — the engine builds no joystick and verify treats the missing touch controls as declared | `control-system.md` |
| The default player and its animation set | Already there | — |

A built-in still covers the request when the human names a style ("a katana" → the built-in katana).
This is about wiring, not thrift: a built-in weapon is already hooked into the combat system, damage,
animations and NPC use, while a generated mesh is a mesh. Generate when the look is genuinely custom
("a flaming katana with a skull hilt") — that is what the `generating-assets` skill is for.

Drivable vehicles are the one exception worth knowing: the physics and AI are built in, but a
good-looking car comes from `bitmagic generate vehicle`: `--preset ?` lists the free presets and
`--preset VAN` builds one without calling the designer when the request needs no bespoke look. Spawn it with
`engine.getVehicleSpawner().spawnAndEnterFromAsset(...)`.

## Step 3 — write `mechanics-plan.md`

At the project root, before you edit `Game.ts`, HUD code or engine wiring. Copy this and fill it in:

```markdown
# Build plan — <game name>

## Genre / archetype
1–2 sentences: the loop. Recipe read: `engine/agent-docs/mechanic-<genre>.md` (or "none — planned
from GAME-DESIGN.md").

## Contract from the recipe
Camera mode. Is the player an embodied walking character? Terrain form. Anything the recipe fixes
that I would otherwise have defaulted differently.

## Platform
`primaryPlatform` in `game.json` — `desktop` or `mobile`. Plus `worldProfileData.mobileOrientation`
in `world.json` when the game only works one way up. If `mobile`: every action needs a touch
button, and `bitmagic verify` fails the run otherwise. A game played by tapping the scene (no
player to move) either builds no player controller (the `no-character` template) or declares
`hasPlayerCharacter: false`, so the engine and verify know there is no joystick to build.

## Slice 1 — the smallest playable thing
- Core verb:          the ONE thing the player does
- Win:                fires, even if the number is wrong
- Lose:
- On-screen feedback: score / timer / health
- Controls:           every action as desktop key + phone button, bound in one call
- Engine systems:     one line each, naming the doc — `engine/agent-docs/…`
- Assets to generate: name them. A skybox and the cover usually earn their place in slice 1.
- Art style:          voxel (the default) or low-poly — `artStyle` in `src/work/game.json`; decided before the first cover
- Level:              procedural baseline terrain, unless the terrain IS the mechanic (forge — or Blender, if that skill's gate passes)

## Deferred — the backlog
Numbered, roughly best-first. Everything the design implies that slice 1 does not do.
1.
2.
3.

## Open questions
Anything I had to guess. Ask after they have played slice 1, not before.
```

Keep it current: after each slice, move what shipped out of the backlog and re-rank the rest. The
file is excluded from the publish fingerprint, so rewriting it never invalidates a passing verify.

## Step 4 — build slice 1, in this order

1. `bitmagic dev`, **in the background, before anything else.** It never exits, so it has to be a
   background task — and everything below is worth more when they can watch it happen. Last in this
   list it is just a server; first, it is the whole reason the rest is visible.
2. `GAME-DESIGN.md` written or confirmed.
3. `bitmagic reference make` / `accept` — only when the human wants one; it lands BEFORE
   `bitmagic cover` and any forge, since both use the accepted image.
4. `bitmagic cover` — **now**, not later. It takes minutes, and it is what the human looks at
   while you work; generated at the end it is the same picture with none of that value. It writes
   `world.json`, so it must come before any `bitmagic verify`.
5. `mechanics-plan.md`.
6. Write the code. Look up APIs with the `finding-engine-apis` skill; do not read engine source to
   find out what exists.
7. `bitmagic check` until green.
8. `bitmagic reload` (in Claude Code the Stop hook in `.claude/settings.json` does this for you).
9. `bitmagic verify` — it boots the game in a real browser and clicks Play. A clean `check` is
   not evidence the game runs.
10. Report (below). Publish only if they ask.

**One forge, and only when the terrain IS the mechanic.** `bitmagic forge` runs for many minutes,
so it sets how long the human waits for slice 1. It belongs in slice 1 for a game that cannot be
played without its shape — skiing, racing on a real circuit, open-world driving, an enclosed dungeon
interior. Those are forged (`bitmagic forge`, tens of sparks — ask first when the purpose is unsaid),
never painted onto the baseline terrain in code. For everything else the baseline's procedural voxel
terrain is a fine slice-1 world and the forge is backlog item 1, run once the loop is proven. A designed place — an interior, a station, a
stylised set the creator has a picture of — has a second route, building it in Blender from a
script (`.agents/skills/building-levels-in-blender/SKILL.md`, gated on a frontier model —
Claude Opus/Fable, GPT-6 class — and on Blender 4.2+ being installed; any other model takes the forge). That route is a low-poly game: set `artStyle: "low-poly"` in game.json first.
The level lanes and every other asset lane side by side, with costs and when to ask the creator:
`.agents/skills/choosing-asset-pipelines/SKILL.md`.

## Step 5 — hand it back

Short, concrete, and honest. Three parts:

- **Playable now** — one sentence, plus the literal control on both platforms. "You can drive the
  kart and complete a lap. It is already reloaded in your browser — W to accelerate, A/D to steer,
  and the same on a phone from the joystick and the GAS button."
- **Not in yet, on purpose** — three to five items from the backlog, so they know it is a choice and
  not a bug.
- **Next I would do** — two or three, numbered, in order. Then ask which.

Name every downgrade in the same breath: a generation that failed and left a placeholder, a forge
you skipped, a mechanic the recipe wanted that you deferred. They waited for it and cannot tell a
fallback from the real thing by looking.

Claim only what you actually built. A passing `check` is not a working feature, and a class you
constructed but never called is not wired. Trace each new behaviour from a live entry point —
`load()`, the update loop, an event handler — before you call it done.

## After slice 1

Same loop, smaller: pick ONE backlog item (theirs if they chose, otherwise the top of your list),
build it, `check`, `reload`, `verify`, report. Re-rank the backlog each time. Resist bundling
three items into one pass — you lose the ability to tell them which change caused what they see.

**Green means stop.** Once the slice does what it said and `check` passes, write the report and
end. No renaming, restyling or unrequested polish: every edit after green risks breaking working
code.
