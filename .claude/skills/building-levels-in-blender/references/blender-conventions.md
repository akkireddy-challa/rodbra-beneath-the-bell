# Blender conventions the library relies on

Every rule here is one the space-station level broke first and paid for in a rebuild.

## Coordinates: you write game space, the library flips once

| You write | Meaning |
|---|---|
| positions `(x, y, z)` | metres, **Y up, +Z forward**, in the current `context()` frame |
| `yaw` | radians about +Y; an entity's forward at yaw θ is `(sin θ, 0, cos θ)` (`engine/agent-docs/coordinate-system.md`) |
| `size` | full extents `(width, height, depth)` — the engine halves them |

Blender is Z up. `bmlevel` places a game point at Blender `(x, -z, y)`. That map is a 90° rotation
about X (determinant +1), not a mirror, so a yaw about game +Y is the **same angle** about Blender
+Z, and `export_yup=True` on the glTF exporter undoes the placement exactly: what the script said
is what the engine reads. The collider JSON is written in game coordinates untouched, which is why
art and physics line up without a single correction on the TypeScript side.

Do not "fix" a piece that looks mirrored by negating an axis in the script. Something else is
wrong — usually yaw applied to the wrong frame, or a `context(yaw=…)` you forgot you were inside.

## The .blend is named parts; the GLB is one mesh per material

`export()` saves the `.blend` **before** it joins anything, so every `box()` you named is a separate
object in a collection named after its `context()`. Then it duplicates every mesh, joins the
copies per material and exports only those — one draw call per material, the GLB the engine wants.
Consequences:

- Edit the script, not the `.blend`. A hand edit in Blender is lost on the next build. The `.blend`
  is for LOOKING: open it when a render shows something you cannot place from the script.
- Reuse identical materials so export can batch them. Keep distinct materials the visual design
  needs; measure the assembled scene before optimizing, and ask before simplifying its look.
- A material name is a contract with the engine: `glass*` renders as a thin transparent pane and
  casts no shadow, `emissive*` is guaranteed to glow (`glow=` sets the exported emission strength;
  the engine's bloom picks it up). Name a window material `glass_pane`, a light strip `emissive_strip`.
- `alpha < 1` exports blended transparency; the engine only treats it as glass when the name says so.

## Text without fonts

`text()` uses Blender's bundled font, extrudes it and converts it to a mesh, so signage needs no
font file and survives the per-material join. Text reads from local −Z at yaw 0, i.e. it faces a
player approaching along +Z. `both_faces=True` adds a mirrored copy for the other approach — do
that for any sign on a header seen from both sides; a sign that reads backwards from one side is
the single most common review-sheet finding.

## Solids, decoration, and the two failures in between

- `box`, `wall`, `slab`, `prism`, `stairs` are solid: a collider record each. `decor`, `text` are
  not. `glazing()` is both — a non-solid pane you can see through and a solid collider you cannot
  walk through.
- A decoration that should have been solid: the player walks through a pillar. A solid that should
  have been decoration: a 5 mm deck plate becomes a step, `link_clearance` fails, and walking
  stutters. The default is solid because the second failure is loud and the first is not.
- `prism()` colliders are convex hulls. A concave outline raises rather than silently becoming its
  hull (which would fill the concavity with invisible wall). Split it: an L is two rectangles, a
  mitred corridor end is a triangle plus a rectangle.
- `stairs()` makes visual treads and ONE ramp hull, so walking up is smooth; `treads_solid=True`
  when the player must be able to stand on an individual step (a dropped item, an NPC post).

## Overlap, offset, depth: the three z-fighting rules

1. **Overlap, never abut.** Two slabs meeting edge to edge leave a hairline a ray falls through
   and a capsule catches on. Overlap by 5 cm. The audit's `floor_continuity` finds the seam.
2. **Offset coplanar faces by 5 cm.** A cladding panel flush with the wall it decorates flickers.
   Push it out 5 cm (or in 5 cm, as an inset). `coplanar_overlap` warns about the ones on solids.
3. **Give layered parts distinct depths.** Casing 0.30 m, header 0.34 m, trim 0.26 m: no two
   layers share a face plane. The door helper does this for its own jambs and header.

Bevels (`bevel=`) catch light on edges and read as "made", not "boxed"; 1–5 cm on furniture and
casings, none on walls.

## Mitred junctions

Where a corridor meets a room at an angle, a square corridor end leaves a wedge of open air beside
the doorway and a rectangular wall cutout leaves a slot above it. Build both ends on the same
mitre plane: the corridor floor, walls and roof as `prism()`s whose end edge lies on the angled
plane, and the room wall as two `prism()`s flanking the same plane. The station's ten junctions were
rebuilt this way after a player reported "gaps and pillars" that the centre-line audit had not
caught — which is why `door_clearance` now samples the full width of every opening.

## What the exporter does, and why each flag

| Flag | Why |
|---|---|
| `export_format='GLB'` | one binary file for `bitmagic assets add` |
| `use_selection=True` | only the per-material joins, not the named parts |
| `export_apply=True` | bakes object transforms so the engine gets world-space vertices |
| `export_yup=True` | the coordinate round trip above |
| `export_lights=False`, `export_cameras=False` | lights come from the JSON, cameras are review-only |
