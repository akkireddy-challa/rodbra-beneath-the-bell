# Agent skills for this Bitmagic game

This directory is `.claude/skills/` — where Claude Code looks.

See `AGENTS.md` at the project root for the guidance an agent should read before editing this game.

Agents do not agree on where project skills live, so the shipped set below is written into
every directory this project's agents read — this one, and:

- `.agents/skills/`

They hold the same guidance, and `bitmagic upgrade` refreshes every copy.

## Which of these are yours

`planning-a-game/`, `finding-engine-apis/`, `generating-assets/`, `choosing-asset-pipelines/`,
`checking-usage/`, `judging-quality/`, `theming-the-hud/`, `making-a-trailer/`,
`publishing-a-game/`, `publishing-to-poki/`, `publishing-to-roblox/`, `working-with-the-creator/`, `deciding-with-a-model/`, `converting-unity-levels/`,
`building-levels-in-blender/`, `rigging-characters/`, `character-skin-authoring/`, `importing-metahumans/` — and this README — are shipped by the Bitmagic CLI and **re-rendered by `bitmagic upgrade`**. They
describe what the CLI and the engine can do, so they have to stay current with both; edits to them
are lost on the next upgrade.

| Skill | Use it when |
|---|---|
| `planning-a-game/` | starting a game, a genre, or anything touching more than one gameplay feature — scoping the first playable slice and writing `mechanics-plan.md` |
| `finding-engine-apis/` | you need an engine API and do not know its name or signature, or `bitmagic check` cannot resolve a symbol |
| `rigging-characters/` | rigging or repairing a character in local Blender, including skin weights, fingers and optional appendages |
| `character-skin-authoring/` | mapping exposed skin on a generated or imported character with local-agent vision, reviewing face and body detail, or diagnosing skin material boundaries before optical eye work |
| `generating-assets/` | the game needs a skybox, a background, a custom block type, sound, music, image, character, animation or vehicle |
| `choosing-asset-pipelines/` | deciding HOW to make something — which command, skill, file or free built-in fits a level, character, prop, vehicle, weapon, sky, block, image, animation, audio or cutscene need, roughly what it costs in sparks and minutes, and when to ask the creator before an expensive one |
| `checking-usage/` | asked what sparks were spent on, how much Pro allowance is left, or whether there is enough left to keep generating |
| `judging-quality/` | a milestone is done and the game deserves an independent quality verdict — `bitmagic judge` |
| `theming-the-hud/` | any ask about the game's LOOK — colors, fonts, rounder/sharper, outlines, glow, glossy, mobile-button styling |
| `making-a-trailer/` | asked for a trailer, a highlight reel, a gameplay video, or to record gameplay — `bitmagic trailer` from recording to a CDN link, and how to tune the cut from prompts |
| `publishing-to-poki/` | preparing a Poki ZIP, integrating its SDK, or diagnosing Poki export; SDK inclusion is automatic |
| `publishing-a-game/` | shipping the game to bitmagic.ai — the verify gate, public vs private, thumbnails, category tags, and every way `bitmagic publish` can refuse |
| `publishing-to-roblox/` | bringing this game into Roblox Studio, preserving original assets, safely updating an existing port, verifying it, and saving through MCP when supported; the creator publishes from Studio |
| `deciding-with-a-model/` | the game wants NPCs that JUDGE rather than follow a rule — a guard deciding whether to raise the alarm, a referee, a trader weighing an offer, "NPCs that actually think" — or you are about to add any per-tick AI call and need to know what it costs |
| `working-with-the-creator/` | they are editing alongside you — gizmo drags into `world.json`, a pasted frame from their game, `.bitmagic/edit/events.jsonl`, their phone |
| `converting-unity-levels/` | a creator wants a Unity scene or game ported, replicated or "brought over" — reusing its prefabs, FBX models and colliders — or a converted level has pieces rotated, mis-scaled, walls that do not collide, an empty corner |
| `building-levels-in-blender/` | a hand-designed low-poly world — an interior, a station, a stylised set, "not voxels", "in Blender" — for a frontier model (Claude Opus/Fable, GPT-6 class) with Blender 4.2+, any other model forges instead; built from a Python script into one GLB the engine's MeshLevel loads, and the `artStyle: "low-poly"` switch in game.json that makes the cover, asset and judge defaults follow; or such a level has walls you fall through, doors that do not open, z-fighting, an empty world after publish. Its first section says when the path is yours |
| `importing-metahumans/` | a creator wants an Epic MetaHuman, an Unreal character, a "photoreal" or "highest fidelity" character brought in as the playable high-res player — the GLB preparation (`bitmagic tools install metahuman`), the retarget / helper-joint / hair fixes, materials, lip-sync — or such a character has floating hair, crossed arms, split legs, a torn shirt, tinted skin, black eyes, slumped shoulders |

Every other directory here is yours. `upgrade` never opens a skill it does not ship, and never
deletes anything under a skills directory. Put project-specific guidance in a skill of your own, or
in `AGENTS.md` — both are left alone.
