---
name: choosing-asset-pipelines
description: Pick the lane that makes a given thing for this Bitmagic game — a whole level, a character, a building, a small prop, a vehicle, a weapon, the sky, block textures, an image or cover, an animation, audio, a cutscene — choosing between the free built-in, bitmagic generate, bitmagic forge, a Blender build, a Unity port and the creator's own files, with approximate sparks and wall-clock minutes per option and the rule for when to ask the creator first. Use before any generation, forge or Blender build, and whenever two routes could make the same thing.
---

# Choosing an asset pipeline

Most things this game needs can be made three or four ways, and the ways differ by a hundred
sparks and by twenty minutes. This file is the routing table: find the need, take the first row
whose conditions hold, say which you took. It names commands without their flags on purpose —
**run `<command> --help` before using one.** Flags move between releases; the help does not lie.
Flags and refusals in prose are in `.agents/skills/generating-assets/SKILL.md`; this file only decides.

Costs are **approximate** — sparks are rounded and times are typical, not promised. `bitmagic
usage` is the truth about what was actually spent.

## Know these four things first

1. **Art style** — `artStyle` in `src/work/game.json`: `voxel` (default) or `low-poly`. A declared
   switch, not a per-asset flag: in a low-poly game models, props, added files and characters keep
   their meshes instead of voxelizing (and a character costs four times more), the Blender level
   route opens, and built-in weapons should use their `_lowpoly` twins. Set it before the first cover.
2. **Your model class** — frontier (Claude Fable / Opus 5, GPT-6 class) or not. Only the Blender
   route depends on it; its §0 says "if you are not sure you are one, you are not".
3. **Local tooling** — Google Chrome (the forge, generated models, props and vehicles, added `.glb`
   files in a voxel game, `verify`); Blender 4.2+ (Blender levels); `ffmpeg` (`trailer`, video
   contact sheets); a Unity project to port. Probe once with the checks each skill gives.
4. **Purpose** — **prototype** (slice 1, prove the loop, the creator will iterate) or **polished**
   ("final", "ship it", "make it look great", publishing). Take it from their words. Unsaid:
   assume prototype for slice 1 and note the upgrade as a backlog item.

## Decide, say so, ask only when it is expensive

**Ask first only when the route is tens of sparks or many minutes AND the purpose is unsaid; everything
else you decide, and say the assumption out loud before running it.**

Default: you decide, and state the assumption in one line before running anything:

> Assuming *prototype*: using `<route>` (~N sparks, ~T). Say "polished" and I will use `<alt>`.

Ask first only when BOTH hold: the recommended option is expensive — tens of sparks or many
minutes (a forge, a low-poly character, a video-to-motion animation, a long music track, a Blender
build) — AND the creator has not said prototype or polished. Recommended option first, answerable
in a word:

> `<need>`: I recommend `<A>` (~N sparks, ~T) because `<why>`; the alternative is `<B>` (~N, ~T).
> Which — or just say prototype / polished and I will pick?

Never ask about a free or seconds-long option, never ask twice for the same need, never run two
paid options to compare. If the allowance is nearly gone
(`.agents/skills/checking-usage/SKILL.md`), say so before an expensive one.

## By need

Rows are in recommended order: take the first whose conditions hold.

### A whole level

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| The baseline's procedural voxel terrain (already there) | prototype, or the terrain is not the mechanic | free, instant | Slice 1's world unless the game cannot be played without its shape (planning skill) |
| `bitmagic forge` — natural terrain by default, or one of its modes: city, dungeon, platformer, freeform, vessel | Chrome; terrain IS the mechanic (skiing, a circuit, open-world driving, an enclosed dungeon) or polished | usage-priced, tens of sparks; many minutes (the bake alone can take twenty) | One forge per game; it can edit a forged level in place and resume a failed job — see its help. AGENTS.md "Forging a whole level" |
| `.agents/skills/building-levels-in-blender/SKILL.md` | frontier model AND Blender 4.2+ AND `artStyle: "low-poly"`; a DESIGNED place (interior, station, set), not natural terrain | free in sparks; an hour or more of your time | Its §0 is the gate; audited with ray casts, loaded by `MeshLevel`. **If the Blender probe fails and you cannot install it, take the forge row** — never hand back a level script nothing here can build |
| `.agents/skills/converting-unity-levels/SKILL.md` | the creator has a Unity scene to bring over | free in sparks; minutes to hours | Reuses their prefabs, FBX, colliders; not a way to make a level from nothing |

### A character (player or NPC)

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| A block character built in code (the default) | any; recolours, outfits, a blocky knight/robot/wizard | free, seconds | `character-system.md`, `npc-appearance.md`. Highres and block **never coexist** — going highres means the whole cast goes |
| `bitmagic character search` then `bitmagic character add` | prototype; any plausible ready-made body will do | free, instant | `search` lists the closest library bodies and changes nothing; `add` takes one and never forges. Judge the match yourself — a score says "plausible", not "right" |
| `bitmagic character generate` | the look is genuinely custom; the whole cast will be highres | free and seconds on a library match; else ~15 sparks, ~1.5–4 min (voxel) or ~60 sparks, ~3 min (low-poly) | Library-first by default; a custom head scale or mesh model always forges. It can set the player directly |
| `bitmagic character generate`, forced fresh | polished; exactly this one, no library substitute | ~15 (voxel) / ~60 (low-poly) sparks; minutes | The costly row: ask first if purpose is unknown |
| `.agents/skills/importing-metahumans/SKILL.md` | the creator wants an Epic MetaHuman, an Unreal character, "photoreal" / the highest fidelity | free in sparks; an hour, ~45 MB per character | Not a generator: a prepared export loaded as the high-res player (WebGPU). The whole cast goes highres with it |

### A building or landmark

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| A structure a forge already placed, or a `building` hotspot | the level was forged | free | `environment-objects.md` |
| `bitmagic generate model` | a new named structure the code places | ~3 sparks; ~10 s voxel, minutes for a mesh | Chrome in a voxel game; give it a height — above 6 m stays hollow |
| `bitmagic generate prop` | a placeholder or forge asset is already placed and looks bad | ~3 sparks; ~10 s | REPLACES that asset; every placed instance upgrades. Never for a new object |
| `bitmagic assets add` | the creator has the model | free; seconds to a minute | Chrome to voxelize in a voxel game; can keep the mesh instead |

### A small prop (a crate, a lantern, a pickup)

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| An asset already in `assets[]` (`bitmagic assets list`) | one fits | free | The same object twice is the commonest waste |
| `bitmagic generate model` | a new object the code spawns or places | ~3 sparks; ~10 s voxel | Cheap enough not to ask. `environmentObjects[]` or `engine.spawnAsset()` — `environment-objects.md` |
| `bitmagic assets add` | the creator has a `.glb`/`.vxl` | free | Same voxelize rule as above |
| Plain three.js geometry in code | a marker, trigger or debug prop nobody looks at | free, no browser | Do not hand-build what a 3-spark model makes better |

### A vehicle

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| `bitmagic generate vehicle` from a preset (`--help` names the preset flag; give it `?` to list the names) | no bespoke look needed; prototype | free; ~a minute (Chrome) | Physics, lights, AI built in either way; spawn via `engine.getVehicleSpawner().spawnAndEnterFromAsset(...)` |
| `bitmagic generate vehicle` from a description | the look is the point | usage-priced, several sparks; several minutes | NEW asset each run; ask first when purpose is unknown |

### A weapon

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| A built-in id (`sword`, `assault_rifle`, `bow`…) or its `_lowpoly` twin via `weaponStyleId(base, 'lowpoly')` | any; match the twin to `artStyle` | free, instant | Wired into damage, animations, pickups, NPC use. `weapon-visuals.md`, `combat-system.md` |
| `bitmagic generate model` | a genuinely custom look | ~3 sparks; ~10 s | A mesh only — still wire it to a built-in's combat behaviour |

### The sky

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| The engine's default sky | prototype; no strong setting | free | |
| `bitmagic generate skybox` | a free-look or third-person camera | ~5 sparks; ~a minute | Usually earns its place in slice 1 |
| `bitmagic generate background` | a fixed sidescroller or top-down camera | ~5 sparks; ~a minute | SAME field as skybox; the second run silently replaces the first |

### Block textures

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| A built-in block name (`stone`, `grass`, `sand`, `marble`…) | one fits | free | `custom-block-types.md` |
| A plain-colour `customBlockTypes[]` entry by hand | prototype; a colour is enough | free | snake_case, never a built-in's name |
| `bitmagic generate block-type` | the surface needs a real texture (a second one for the sides is optional) | ~3 sparks (~6 with sides); seconds to a minute | The same name replaces the entry |

### Images, cover, reference

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| `bitmagic assets add` | the creator has the picture | free | |
| `bitmagic generate image` | a portrait, icon, poster, HUD art | ~3 sparks; ~30 s | |
| `bitmagic cover` | always, early — after `artStyle` is set, before `verify` | ~6 sparks; minutes | Prompt comes from `GAME-DESIGN.md`; an unchanged design regenerates nothing |
| `bitmagic reference make`, then the HUMAN accepts | the idea names a place or a look | ~6 sparks per candidate; ~a minute | Steers every later skybox, block, cover and forge |

### Animation

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| A built-in clip (`mGenIdle01`, `mGenWalk01`, `mKicking01`, `mPunching01`…) | one fits | free, instant | `animation-assets.md`; locomotion auto-plays |
| `bitmagic generate animation` from an authored spec (gait, melee, one-shot) | a gait variant, a melee move, a key-pose one-shot | ~1 spark; ~1 s | Solved locally; the cheapest generator |
| `bitmagic generate animation` from a video | a motion only footage captures | ~15 sparks (plus video seconds if it generates the clip); minutes | Ask first when purpose is unknown |

### Audio

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| None | the creator has not asked for sound | free | Audio is added only on request — never by default |
| Web Audio synthesis in code | ordinary SFX: a beep, a hit, a pickup | free | `audio-system.md` |
| `bitmagic assets add` | the creator has the track | free | |
| `bitmagic generate sound` | they asked for a premium or generated effect | ~12 sparks; ~30 s | One prompt, one effect |
| `bitmagic generate music` | they asked for original music | ~0.25 sparks/s (30 s ≈ 8, 120 s ≈ 30); ~a minute | Ask first for a long track when purpose is unknown; it can write a file instead of a world asset, for a trailer bed |
| `bitmagic generate speech` | they asked for a spoken line: NPC dialogue, narration | ~0.25 sparks/s (a sentence ≈ 1 spark); a few seconds | A one-shot, not a loop; pick a voice or bring a cloned one. Like music it can write a file instead of a world asset — that file is what the lip-sync tool takes |

### A cutscene or video

| Route | Conditions | ~Cost | Notes |
|---|---|---|---|
| `bitmagic generate video` from a prompt | a story beat played by `engine.playVideo()` | ~2 sparks/s (5 s ≈ 10); ~20 s | Read the frame sheet before wiring; needs a user gesture to play. `video-cutscenes.md` |
| `bitmagic generate video` from a still | animate a picture you have (cover, reference) | same sparks; ~30 s | Comes back in the image's shape, not 16:9 |
| `bitmagic trailer` (`.agents/skills/making-a-trailer/SKILL.md`) | a trailer or highlight reel of real gameplay | free apart from an optional music bed; `ffmpeg` | Cut from a recording, not generated |

## After you have chosen

- `<command> --help` first, then pass the creator's request verbatim the way AGENTS.md says.
- Each generation writes `src/work/world.json`; re-read it if you hold a copy.
- One generation per decision. Decide the prompt, run it once, use what comes back.
- Flags in prose, reference-image rules, refusals: `.agents/skills/generating-assets/SKILL.md`.
  What it cost: `bitmagic usage`.
