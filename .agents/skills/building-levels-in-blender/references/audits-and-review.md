# Audits and review renders

The audit fires rays at the **colliders in the JSON** — the physics the engine will build — never at
the art, because decoration is exactly what must not be solid. The renders show the **art in the
.blend**, so a level can pass the audit and look wrong, or look right and fail. Do both, in that
order: look first (cheap, catches design errors), audit second (catches the errors you cannot see).

Together they are the Blender loop, and they are the whole reason the engine handoff can wait:
between them they answer every geometric question about the level for the cost of a few seconds
and no upload. Go round them until neither has anything to say, and only then register the GLB.

## The checks

| Check | Mode | What it fires | Failure means | Usual fix |
|---|---|---|---|---|
| `floor_continuity` | open, closed | a 0.5 m grid over every `volume()`, one ray down from 1 m above its floor, must hit within 1.5 m | a hole in the floor, a slab that ends short, a volume declared over open air | overlap the slabs by 5 cm; move the volume to the floor's real extent; if the volume is a stairwell, lower it or split it per storey |
| `door_clearance` | open | rays across every `door()` opening at three heights and every 25 cm of its width | something solid in the doorway: a jamb built into the opening, a lintel too low, a wall segment that did not stop at the opening | check the `opening={'at': …}` distance from the wall's START; check the door's `yaw` matches the wall's direction; check `height` against the lintel |
| `link_clearance` | open | a player capsule (radius 0.4 m, 0.5 m and 1.5 m high) marched every 0.5 m from volume A's centre to the door to volume B's centre, plus a floor probe under it | a route the player cannot walk: furniture on the line, a step that ends short of the floor, a doorway narrower than 0.8 m, no floor between the rooms | move the prop off the walk line; overlap the ramp with the landing; widen the door; add the missing floor |
| `sealed_envelope` | closed | from a 1 m grid inside every roofed volume: one ray up and four rays outward, each must hit within the volume plus 1 m | a gap in a roof or wall, a corner where two walls do not meet, a doorway with no door record (nothing to seal it) | extend the wall through the corner; add the door(); mark an open-sided space `roofed=False` |
| `coplanar_overlap` | both (warning) | pairs of unrotated box colliders sharing a face plane, same facing, overlapping extents | two visible faces flicker into each other | offset by 5 cm or change one depth |

"Mode" is `--doors` open (default) or `closed`: the leaves from `<name>.doors.json` are added as
solids in closed mode, which is the only mode in which a room can be sealed. Run both.

Every failure prints its first example with coordinates (game space) and `--json out.json` writes
all of them. Locate a coordinate by asking which `context()` it falls in and subtracting that
context's origin.

## Reading a failure you do not believe

- **A ray at exactly a slab's edge fails.** Rays that graze an edge miss. The fix is the same as
  for a real seam — overlap the slabs — because the player's capsule grazes edges the same way.
- **`link_clearance` fails at the door waypoint.** The march probes for the floor from 0.5 m above
  waist height at the door; a threshold higher than the door's floor point, or a step directly
  under the header, trips it. Put the door's `pos` at the floor of its threshold.
- **`sealed_envelope` fails along a whole wall.** The wall does not reach the roof: `wall(height=…)`
  is measured from `base`, and a ceiling slab's top is at `y` with its underside at `y - thickness`,
  so a 3 m wall under a slab whose top is at 3.2 m and thickness 0.2 m just touches — overlap them.
- **`floor_continuity` fails everywhere in one volume.** The volume's `pos` is its CENTRE, not its
  floor; `(x, height/2, z)` for a room whose floor is at y = 0.

Never make a failure go away by deleting the `volume()` or `link()` that found it. A level with
no volumes passes every check and holds no claim.

## The review set

`review.py` renders, from the JSON: `overview` (top-down, the whole extent), `door-<id>-a` and `-b`
(4 m back from each side of every door, eye height), `stairs-<name>` (from the foot, looking up),
`volume-<name>` (inside every room, from one end looking along it). Then `contact-sheet.png`,
four per row in the order the log prints.

## Aiming the camera, and the two lightings

The standard set is what you read first. After that, ask for what you want to see:

| Flag | Does |
|---|---|
| `--shot 'FROM -> TO'` | one extra frame. Both ends are `landmark:<name>`, `volume:<name>`, `door:<id>` or a raw `x,y,z` (game coordinates). Repeats; each frame is named `shot-1`, `shot-2`, … |
| `--shot 'FROM'` | from that point, looking at the level's centre — enough for "what does it look like from the spawn" |
| `--only` | render just the `--shot`s and skip the standard set and the sheet: one render, one look |
| `--fov <deg>` | horizontal field of view for the perspective shots; default 24 mm ≈ 74° |
| `--lighting review` | default. A camera-mounted fill and a sun, so nothing can hide in shadow |
| `--lighting game` | the engine's `interior` preset — the sun at 8%, the hemisphere at 0.65, your `lamp()`s and `spot()`s as real lights, emissive materials glowing at their `glow` |
| `--engine cycles` | render with Cycles (OptiX or CUDA GPU, else CPU) instead of EEVEE — for a headless Linux box where EEVEE fails with no EGL/GLX context |

Judge geometry under `--lighting review`; judge the lighting pass under `--lighting game`. The
second is close enough to the engine that a room which is black there is black in the game, so
pass 3 no longer needs a verify to find an unlit corner — only to confirm the fixed one.

Where `--lighting game` and the engine still differ: EEVEE is not three.js, so exposure and
falloff are approximate, and the engine pools point lights (a room with eight lamps gets four of
them in game, all eight in the render). Treat "too dark" and "too bright" as real; treat an exact
colour match as a job for the verify screenshot.

What to look for, frame by frame:

- **overview** — the footprint matches the plan; nothing floats outside the walls; corridors meet
  rooms with no wedge of sky beside the doorway.
- **doors** — a wall on both sides and a header above; the sign readable from THIS side; the floor
  continuous through the opening; the far room visible through it (a black doorway is a room with
  no light AND no fill — usually a missing volume light).
- **stairs** — treads reach the landing; the rail follows the slope; nothing pokes through a step.
- **volumes** — a ceiling; walls meeting at the corners; props sitting on the floor, not in it.

## When a render is right and the game is wrong

The two are the same geometry only if the GLB you registered is the one you just built. That is
the whole content of the engine handoff, and it is all-or-nothing: register again (same
`--asset-id`, the entry is replaced), re-run `sync_world.py`, copy the JSON into `src/work/`, and
check `[MeshLevel] loaded` in the verify console reports the new collider count. A verify that
passes on stale files is the trap the station fell into three times — and the reason to hand off
rarely and completely rather than often and in pieces.
