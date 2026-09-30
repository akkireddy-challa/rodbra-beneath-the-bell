# Level design in passes

A level that is only walls and floors is walkable and dead. The station that taught this skill
went from boxes to a place people wanted to screenshot in four passes. A pass is many turns of the
Blender loop — edit → build → review → audit — ended by one engine handoff; each pass's "Stop
when" below is the condition for that handoff, not a checkpoint you take on the way. The passes,
what goes in each, and when to stop.

## Pass 1 — structure

Rooms, corridors, doors, stairs, the spawn, every route. Nothing decorative. Stop when: the audit
is clean in both modes, every door opens onto a floor, every stair reaches a landing, and you have
walked every `link()` in the dev browser. Sizes that read well: rooms 6–12 m across, 3–4 m high;
corridors 3–4 m wide (a 2 m corridor is a pipe); doors 1.4–2 m wide and 2.2–2.6 m high; treads
0.28–0.32 m deep and 0.16–0.18 m high. Bigger than a house, smaller than a hangar.

## Pass 2 — detail

Everything the eye reads as "built". All `decor()` unless the player should bump into it.

- **Layered casings around every door**: an outer casing 5 cm proud of the wall, an inner recessed
  band, a crown over the header. Three depths, three widths.
- **Cladding bands** on long walls: panels inset 5 cm every 4–6 m with a thin vertical trim between
  them, a service channel at waist height, a coffer or beam line at the ceiling. A blank wall longer
  than 6 m is the second most common judge finding.
- **Deck plates**: tile the floor slab with plates 4 × 4 m, 1.2 cm high, 6 cm apart, an occasional
  plate in the alternate material; fasteners at the corners; a shallow grate every few plates.
- **Ceiling coffers** or beams on a 3–4 m rhythm, with a recessed light housing in each.
- **Guidance**: a floor strip in the room's accent colour running the route between doors; signs
  on every door header, both faces; a module or room name on the wall you see on entering.
- **Furniture at the walls, not on the line.** The audit will tell you when a prop blocks a route,
  but the rule is simpler: props go against walls and in corners; the middle of a room is for
  walking and fighting.
- **Rails on every stair and gallery edge** (`rail=`), posts every third step.

Stop when: the review sheet shows no blank wall and no floating detail, and the audit is still
clean (detail is the pass that breaks clearances — a casing 20 cm into a doorway is a failed
`door_clearance`).

## Pass 3 — surfaces and light

- **Materials**: six to twelve. A warm neutral for walls, a dark deck, one trim metal, one accent
  per room, one glass, one emissive. Roughness 0.4–0.7 on walls, 0.2–0.35 on deck plates so they
  catch light; metal only on rails and fasteners.
- **Lights**: one warm `lamp()` per room near its centre at ceiling height minus 0.5 m, cool fill in
  corridors, `emissive_*` strips where the eye should travel (door frames, guidance, consoles). One
  or two `spot()`s with shadows over the places that matter (the spawn, the objective). Point lights
  share a small pool in the engine — a room with eight lamps gets four of them; put the count into
  emissive materials instead.
- **The engine's interior preset dims the sun for you**; a level that looks washed out in the game
  after looking fine in the render has an `exterior` mode set, or its own sun in `lightingConfig`.

This is the pass where the default review render lies to you — its fill light makes every room
legible whatever your lamps do. Iterate under `review.py --lighting game`, which runs that same
interior preset and your own `lamp()`s and `spot()`s, and a dark room shows up dark.

Stop when: nothing is unlit or blown out under `--lighting game`, then hand off — `bitmagic judge`
no longer names lighting or flat surfaces, and the level reads the same in the verify screenshot
as in the reference image.

## Pass 4 — the reference image

Only now: put the reference image beside the review sheet and the verify screenshot and list the
five biggest differences. Fix those five, in order. Then stop — a level is done when the next
change would be for you, not the player.

## What not to do

- Do not rebuild the whole script for one room; add a `context()` or edit one.
- Do not make decoration solid "to be safe". Make it `decor()` and keep the clearances.
- Do not add a light per lamp housing. Add the housing as `emissive_*` decor and one real light per room.
- Do not put the whole level in one `context()`. One per room or module: the `.blend` outliner and
  the audit's coordinates both read in room-local metres.
