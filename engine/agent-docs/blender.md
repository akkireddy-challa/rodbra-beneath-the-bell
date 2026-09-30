# blender — edit GLBs, make props and build levels with a Blender script

You write a short Python script; the `blender` tool runs it in headless Blender on the Asset
Forger and applies what it exports to the game. One tool for every mesh job, the way a GDK agent
uses its local Blender (the same `bmedit` / `bmlevel` libraries run there):

- **edit a game GLB** — the low-poly ground snowy / sandy / autumn, trees recoloured, a mesh
  decimated or merged — `load()` it, change it, `export()` it under the same id;
- **make a new low-poly prop** — fence, bridge, lamp post, well, crate stack, pine — build it from
  primitives or bmesh, `export()` it under a new id, then place it like any asset;
- **build a mesh level** for a low-poly 3D game with bmlevel (below).

Prefer this over `generate-glb-asset` for simple geometric props (it is seconds, not minutes, and
exact); use `generate-glb-asset` for organic or detailed things (a character-like statue, a
dragon, an ornate throne).

## The call

```
blender(name="snowy-ground", inputs=["ground"], script="<the whole script>")
blender(name="snowy-ground")     # re-run the saved blender-snowy-ground.py unchanged
```

- `name` names the script: it is saved as `blender-<name>.py` in the game source on success. To
  change it later, read-file that, edit, send the whole script back.
- `inputs`: asset ids the script may `load()`. `"ground"` is the world's mesh-level GLB (the
  template ground, a forged level or a bmlevel level). Only GLB assets load — a `.vxl` voxel asset
  has no mesh.
- `review` (default true): you are SHOWN a contact sheet — each exported asset from two angles, or
  the level's overview, doors and rooms. Look at it before you answer; fix and re-run if it is off.
- A script that is refused or raises returns the reason or the traceback tail. Nothing is applied.
- A script that exports nothing is a **probe**: it changes nothing and returns what it printed as
  `build_log` — e.g. `print(height_at(load('ground'), 4, -6))` before placing a prop on a hill, or
  `palette(load('tree-oak'))` before a recolour.

## What a script may use

`import bpy`, `bmesh`, `mathutils` (`from mathutils import Vector, Matrix, Euler, Quaternion,
Color, noise, geometry`), `math`, `random`, and named imports from `bmedit` / `bmlevel`. Loops,
functions, lambdas, f-strings.

Refused before Blender runs, so do not try: any other import, file or network access, `open`,
`eval`/`exec`, `getattr`, classes, decorators, dunders, `str.format`, `**kwargs` unpacking, and
bpy's I/O and app surface — `bpy.ops` outside `mesh`, `object`, `transform`, `uv`, `material`,
`curve`; `bpy.data.images.load`, `texts`, `libraries`, `bpy.app`, `bpy.utils`, `bpy.path`, drivers,
handlers, preferences, anything named `*filepath*` or `*script*`. `bmedit.load()` / `export()` are
the only way in and out.

## bmedit

Game coordinates, as everywhere in this repo: metres, **Y up, +Z forward**, yaw in radians about
+Y. Colours are sRGB: `'#d8e4ea'`, `(216, 228, 234)` or `(0.85, 0.89, 0.92)`. Painting is per face
(the flat low-poly look) and is what the game draws (glTF `COLOR_0`).

| Call | Does |
|---|---|
| `load(id)` → `[objects]` | import an input GLB; positions are where the game draws them |
| `objects()` | every mesh in the scene |
| `describe(objs)` / `palette(objs)` | print size, triangles / the face colours in use (most used first) — the build log comes back to you |
| `bounds(objs)` → `(min, max)` | game-space corners |
| `height_at(objs, x, z)` | top surface height at (x, z), or None |
| `paint(objs, fn)` | `fn(position, normal, current_hex)` per face → a colour, or None to keep |
| `recolor(objs, colour, where=fn)` | one colour on every face (or those `where(p, n, c)` accepts) |
| `replace_colour(objs, {'#old': '#new'}, tolerance=0.08)` | swap colour families — leaves green → white, bark untouched |
| `mix(a, b, t)` | blend two colours |
| `box(name, (w, h, d), at=, color=, yaw=)` | box standing on `at` (its bottom centre) |
| `cylinder(name, r, h, at=, color=, segments=8, top_radius=)` / `cone(...)` / `sphere(name, r, at=, color=, detail=1)` | low-poly primitives |
| `join(objs, name)` | merge into one mesh (one draw call) |
| `copy(obj, at=, yaw=, scale=)` / `move(obj, at=, yaw=, scale=)` / `remove(objs)` | about the bottom centre |
| `scatter(proto, count, on=ground, area=(x, z, r), seed=, min_spacing=, scale=(lo, hi), avoid=[(x, z, r)], max_slope=)` | copies standing on a surface, random yaw/scale |
| `decimate(objs, ratio)` | fewer triangles |
| `export(id, objs=None)` | write the asset: an EXISTING id replaces it everywhere it is used; a new id adds a GLB asset at the meshes' real height. Up to 8 per script |

A normal's Y (`n[1]`) says how flat a face is: > 0.7 flat ground, < 0.3 steep or a wall. Positions
and normals are tuples `(x, y, z)`.

Anything bmedit lacks, write with bmesh / bpy directly (build a bmesh, `bm.to_mesh(mesh)`,
`bpy.data.objects.new(...)`, link it to `bpy.context.scene.collection`). An object you make that
way needs a colour to show: `recolor(obj, '#hex')` gives it one.

## Recipes

**Snowy ground** (also desert / autumn with other colours):

```python
from bmedit import load, palette, paint, replace_colour, export, mix

ground = load('ground')
palette(ground)                                   # see what greens and browns it uses
SNOW, SHADE = '#eef3f7', '#c9d6e0'
def snow(p, n, c):
    if n[1] > 0.75: return SNOW                   # flat: snow
    if n[1] > 0.45: return mix(SNOW, SHADE, 0.6)  # slopes: shaded snow
    return None                                   # cliffs and trunks keep their colour
paint(ground, snow)
replace_colour(ground, {'#3c7524': '#2f4a3a', '#48922f': '#35523f'}, tolerance=0.12)  # darker winter foliage
export('ground', ground)
```

Use colours `palette()` printed: read the log in the result and re-run with the exact hexes if a
family was missed. Desert: flat → `'#e2c48f'`, slopes → `'#c9a36b'`, foliage → dry olive. Autumn:
leaves → `'#d9822b'`, `'#b5471f'`, `'#e0b13a'`; grass → `'#9a8a3c'`.

**A new prop** (a fence segment; placed later by its id like any asset):

```python
from bmedit import box, join, export
parts = [box(f'post{i}', (0.15, 1.1, 0.15), at=(i * 1.5, 0, 0), color='#6b4a2f') for i in range(2)]
parts += [box(f'rail{k}', (1.65, 0.1, 0.06), at=(0.75, 0.35 + k * 0.45, 0), color='#7d5a38') for k in range(2)]
export('fence-segment', join(parts, 'fence-segment'))
```

**A pine** (tiers of cones on a trunk), **a lamp post** (thin cylinder, a box head with an
`'#ffe7a8'` face), **a bridge** (a row of boxes with a slight arc in `y`) follow the same shape.

**Recolour a generated prop** (`inputs=["tree-oak"]`):

```python
from bmedit import load, palette, replace_colour, export
tree = load('tree-oak')
palette(tree)
replace_colour(tree, {'#3f7d2c': '#d9822b', '#4f8f35': '#b5471f'}, tolerance=0.15)
export('tree-oak', tree)
```

A textured GLB (a generated prop with an image texture) is TINTED by painting — the texture
stays. Flat-colour meshes change fully.

**Scatter on the ground** — for props that should be baked into the ground mesh itself (one draw
call, not placed objects):

```python
from bmedit import load, cone, cylinder, join, scatter, export
ground = load('ground')
pine = join([cylinder('trunk', 0.15, 1.0, color='#5a3b22', segments=6),
             cone('tier', 1.1, 2.2, at=(0, 0.8, 0), color='#2f5d3a', segments=7)], 'pine')
pines = scatter(pine, 25, on=ground, area=(0, 0, 30), avoid=[(0, 0, 5)], seed=3)
export('ground', ground + pines)             # the prototype at the origin is left out
```

Placed objects (`environmentObjects`) stay the normal route for things the player interacts with.

## Moving props: smart objects

Anything that MOVES or GLOWS — a windmill, a ferris wheel, a carousel, a drawbridge, a swinging
sign, a ceiling fan, a lamp post — is a smart object: the engine turns its parts and lights its
lamps with **no game code** (`@docs smart-objects.md` is the runtime). One pattern for all of them:

1. **Every moving piece is ONE object**: build it, `join()` its pieces, mark it `part(obj, name)`.
   Everything left unmarked is the static body.
2. **Declare the motion** in `export(..., smart={'parts': [...]})`: `spin` (`axis`, `rpm`),
   `upright` (hangs from a hinge on its `parent` and stays level while it turns — cabins,
   gondolas, swings), `pendulum` (`axis`, `amplitudeDeg`, `periodS` — a sign, a bell), `none`.
   Nest with `parent`: a carousel horse on the turntable, a cabin on the wheel.
3. **Name the places code will want** with `anchor(obj, name, at)`: the floor a rider stands on, a
   seat, a door, the top of a platform, a hook. On a part an anchor rides with it, and every part
   may reuse the same names (`floor`, `seat`, …); on the static body (a windmill's door, a
   station's platform edge) it stays put, and its name must be unique within the prop. This is what makes the prop EASY TO MAKE INTERACTIVE
   later — riding, sitting, boarding — without anyone re-deriving where the parts are.
4. **Make interactive spaces real**: a cabin or a seat gets an actual floor to stand on and an open
   side to step in through, sized for a person (a floor ≥ 1.2 m across, ≥ 2 m headroom), and enough
   clearance that no moving part meets the ground or the body.
5. **No flush surfaces.** Two faces in one plane flicker between their colours in the game
   (z-fighting): a rim whose top is level with the platform, a wall starting at the floor's bottom,
   a stripe laid exactly on a wall. Stand pieces ON a surface, inset trim, or lift it 1–2 cm.
   `export()` reports every such pair it finds as a WARNING in the build log — fix them before
   answering; a still review render does not show the flicker.

The placed prop's static collider is the BODY only: moving parts are not solid, so nothing stays
behind at the rest pose. Code that makes the prop rideable adds its own moving colliders on the
anchors (`@docs smart-objects.md`, "Riding a part").

Pivots default to the part's box centre (the top centre for `upright` / `pendulum`); give
`'pivot': (x, y, z)` where it matters — a cabin's hinge is where it hangs from the rim. Axes are in
game coordinates: a wheel or a windmill facing +Z turns about `(0, 0, 1)`, a carousel or a fan
lying flat about `(0, 1, 0)`. `turn(obj, angle, axis, about)` rotates while you build (a spoke about
the hub, a leaning leg about its foot; right-handed: about +Z, +Y turns toward -X). Lights
(`color`, `position` or `part`, `intensity`, `distance`) with a `part` ride it.

**A ferris wheel** (cabins stay level, each with a floor, an open side and anchors):

```python
import math
from bmedit import box, cylinder, join, turn, part, anchor, export

R, HUB_Y, N = 5.0, 8.0, 8                  # the hub high enough that the lowest cabin clears the ground
L = HUB_Y / math.cos(0.3)                  # a leg long enough to reach the hub when leaning 0.3 rad
legs = []
for side in (-1, 1):
    for lean in (-1, 1):
        leg = box(f'leg{side}{lean}', (0.3, L, 0.3), at=(0, HUB_Y - L, side * 1.1), color='#c0392b')
        turn(leg, lean * 0.3, axis=(0, 0, 1), about=(0, HUB_Y, side * 1.1))   # A-frame: top at the hub, foot out
        legs.append(leg)
axle = cylinder('axle', 0.2, 2.6, at=(0, HUB_Y - 1.3, 0), color='#555555')
turn(axle, math.pi / 2, axis=(1, 0, 0), about=(0, HUB_Y, 0))                 # upright → along Z
frame = join(legs + [axle, box('base', (6, 0.3, 3.2), color='#8a8f99')], 'frame')

hub = cylinder('hub', 0.5, 0.5, at=(0, HUB_Y - 0.25, 0), color='#f1c40f')
turn(hub, math.pi / 2, axis=(1, 0, 0), about=(0, HUB_Y, 0))
rim, spokes = [], []
for i in range(24):
    a = i * math.tau / 24
    seg = box(f'rim{i}', (2 * R * math.sin(math.pi / 24) * 1.05, 0.25, 0.25), at=(0, HUB_Y + R - 0.125, 0), color='#e74c3c')
    turn(seg, -a, axis=(0, 0, 1), about=(0, HUB_Y, 0))
    rim.append(seg)
for i in range(N * 2):
    spoke = box(f'spoke{i}', (0.1, R, 0.1), at=(0, HUB_Y, 0), color='#ecf0f1')
    turn(spoke, -i * math.tau / (N * 2), axis=(0, 0, 1), about=(0, HUB_Y, 0))
    spokes.append(spoke)
wheel = part(join([hub] + rim + spokes, 'wheel'), 'wheel')

parts = [{'name': 'wheel', 'motion': {'kind': 'spin', 'axis': (0, 0, 1), 'rpm': 1.5}}]
cabins = []
for i in range(N):
    x, y = R * math.sin(i * math.tau / N), HUB_Y + R * math.cos(i * math.tau / N)   # the hinge on the rim
    fy, c = y - 2.3, ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db'][i % 4]
    top = fy + 0.12                                  # walls STAND ON the floor, inside its edge (no flush faces)
    cabin = part(join([
        box(f'floor{i}', (1.7, 0.12, 1.5), at=(x, fy, 0), color='#7f8c8d'),
        box(f'back{i}', (1.6, 0.9, 0.08), at=(x, top, -0.66), color=c),      # low walls on three sides,
        box(f'left{i}', (0.08, 0.9, 1.4), at=(x - 0.76, top, 0), color=c),   # +Z left open to step in
        box(f'right{i}', (0.08, 0.9, 1.4), at=(x + 0.76, top, 0), color=c),
        box(f'roof{i}', (1.7, 0.1, 1.5), at=(x, y - 0.35, 0), color=c),
        box(f'hanger{i}', (0.08, 0.23, 0.08), at=(x, y - 0.25, 0), color='#555555'),   # stops short of the rim
    ], f'cabin{i}'), f'cabin_{i + 1}')
    anchor(cabin, 'floor', (x, top, 0))             # where a rider stands
    anchor(cabin, 'door', (x, top, 0.7))            # the open side
    cabins.append(cabin)
    parts.append({'name': f'cabin_{i + 1}', 'parent': 'wheel', 'motion': {'kind': 'upright'}, 'pivot': (x, y, 0)})

export('ferris-wheel', [frame, wheel] + cabins, smart={'parts': parts})
```

**A windmill** — one part, spinning about the axis it faces:

```python
from bmedit import box, cone, cylinder, join, turn, part, export
tower = join([cylinder('tower', 1.6, 7, color='#d9c8a9', segments=8, top_radius=1.1),
              cone('cap', 1.4, 1.6, at=(0, 7, 0), color='#8e3b2e', segments=8)], 'tower')
blades = [box(f'blade{i}', (0.5, 3.5, 0.08), at=(0, 6.5, 1.3), color='#f4f1ea') for i in range(4)]
for i, b in enumerate(blades):
    turn(b, i * 1.5708, axis=(0, 0, 1), about=(0, 6.5, 1.3))
sails = part(join(blades, 'sails'), 'sails')
export('windmill', [tower, sails], smart={'parts': [
    {'name': 'sails', 'motion': {'kind': 'spin', 'axis': (0, 0, 1), 'rpm': 8}, 'pivot': (0, 6.5, 1.3)}]})
```

A **swinging sign** is a `pendulum` part hanging from its bracket (`axis` along the bracket); a
**carousel** is a turntable part spinning about `(0, 1, 0)` with seats as `none` children carrying
`seat` anchors.

**Keep a script and bmlevel apart when you can.** A script that imports both takes the LAST
`export` it imported; write `from bmedit import export as export_asset` to keep both.

## Levels: bmlevel

A **low-poly 3D game's whole world** built out of rooms, walls and floors — a hut and its yard, a
temple, a station, a dungeon, a shop interior, an arena with stands. The level becomes the world:
one GLB plus a collider/door/light JSON declared as `worldProfileData.meshLevel` on
`terrain: { shape: 'none' }` (`mesh-level.md` is the engine side). A natural landscape (hills, a
forest, a coast) is the World-Forger or the template ground, not this.

Call bmlevel's `export()` exactly once, at the end; its directory and name are ignored (the level
takes the tool's `name`: `name="temple"` makes assets `level-temple` / `level-temple-json`).
`lighting="interior"` dims the sun for an enclosed level. Every level is audited; a failing audit
applies nothing — not the level, not the assets the same script exported.

```python
from bmlevel import *

mat('plaster', (0.82, 0.78, 0.7))          # rgb 0..1, roughness=, metal=, alpha=, glow=
mat('timber', (0.45, 0.3, 0.16), roughness=0.7)
mat('glass_pane', (0.7, 0.85, 0.9), alpha=0.3)   # glass*: a see-through pane in the engine
with context('hall', origin=(0, 0, 0), yaw=0):   # a named part with its own local frame; nests
    slab('floor', (0, 0), (12, 8), 'plaster')                        # top surface at y=0
    wall('north', (-6, -4), (6, -4), 3.5, 'plaster', opening={'at': 6, 'width': 1.6, 'height': 2.4})
    door('north door', (0, 0, -4), yaw=0, width=1.6, height=2.4, jamb='timber')
    stairs('up', (4, 0, 0), rise=3, run=5, material='plaster', rail='timber')
    box('table', (-3, 0.4, 2), (1.6, 0.8, 0.9), 'timber', bevel=0.02)  # solid prop
    decor('cornice', (0, 3.3, -3.85), (12, 0.2, 0.3), 'plaster')     # never collides
    prism('bay', [(-2, 4), (2, 4), (0, 6)], 0, 3.5, 'plaster')        # convex outline, extruded
    glazing('window', (2, 4.01), (5, 4.01), 3.5, 'glass_pane', 'plaster')
    text('sign', 'HALL', (0, 2.9, -4.2), 'timber', size=0.4, both_faces=True)
    lamp('centre', (0, 3.2, 0), '#ffd9a0', intensity=10, distance=14)
    spot('altar light', (0, 3.4, 4), (0, 0, 5), '#fff0d0', intensity=20)
    volume('hall', (0, 1.75, 0), (12, 3.5, 8), tags=['indoors'])      # a room the audit checks
    volume('yard', (0, 1.5, -10), (14, 3, 10), roofed=False)        # OPEN-AIR: yards, courtyards, plazas
    landmark('altar', (0, 0.1, 5), tags=['objective'])                # a named point the game asks for
    spawn((0, 0.1, 2), yaw=3.14159)
link('hall', 'yard', door='north door')                              # a route the player must walk
export('build/level', 'temple')
```

**Coordinates** are game space: metres, **Y up, +Z forward**, `yaw` in radians about +Y (forward at
yaw θ is `(sin θ, 0, cos θ)`), sizes are full extents `(width, height, depth)`. The library flips to
Blender once; never negate an axis to "fix" a mirrored piece — look for a `context(yaw=…)` you
forgot you were inside. A `volume()` position is its CENTRE: `(x, height / 2, z)` for a room whose
floor is at y = 0.

**Material names are a contract with the engine:** `glass*` renders as a thin transparent pane that
casts no shadow, `emissive*` always glows (`glow=` sets the strength). Reuse materials — the GLB
has one mesh per material.

## Rules the audit enforces

- **Everything is solid by default.** `box`, `wall`, `slab`, `prism`, `stairs` become colliders;
  `decor` and `text` never do; `glazing` is a see-through pane with a solid collider. Trim, rugs,
  lamp housings and fasteners are `decor()` — a collider on a 5 mm strip is a step the player trips on.
- **Overlap, never abut.** Two slabs meeting edge to edge leave a seam a capsule slips through;
  overlap them by 5 cm. A wall under a ceiling slab must reach into it, not just touch.
- **Offset coplanar faces by 5 cm** or give layered parts different depths — two faces on one plane
  flicker.
- **Convex prisms only.** A concave outline raises; an L is two rectangles.
- **Doors are records.** `door()` writes the door; the engine builds and animates the leaf. `jamb=`
  adds jambs and a header. The wall needs an `opening={'at': <metres from the wall's START>, …}`
  where the door stands, and the opening must fit INSIDE the wall with wall left on both sides
  (`at - width/2 > 0` and `at + width/2 < length`) — a gate in a 2 m wall stub raises.
- **Every volume is roofed unless you say `roofed=False`.** A roofed volume must be sealed (walls
  all round, a ceiling slab over it), and the closed-doors audit checks exactly that. A courtyard,
  a yard, a plaza — anything under the sky — is `volume(..., roofed=False)`, or it fails
  `sealed_envelope` hundreds of times.
- **Declare what must work**: every room a `volume()`, every route a `link()`, the `spawn()`. The
  audit checks exactly those — a room you did not declare is a room nothing checks. Never delete a
  `volume()` or `link()` to make a failure go away.
- **Name everything uniquely**; the audit's messages use the names.

| Failing check | Means | Usual fix |
|---|---|---|
| `floor_continuity` | a hole under a room: a slab that ends short, a volume over open air | overlap the slabs 5 cm; move the volume to the floor's real extent |
| `door_clearance` | something solid in a doorway | check `opening={'at': …}` from the wall's START, the door's `yaw` against the wall's direction, `height` against the lintel |
| `link_clearance` | a route a player cannot walk: a prop on the line, a step ending short, a door under 0.8 m | move the prop to a wall; overlap the ramp with the landing; widen the door |
| `sealed_envelope` (doors closed) | a gap in a roofed room's walls or roof — or an open-air space declared without `roofed=False` | open air: `roofed=False` on its `volume()`; a room: extend walls through corners and into the ceiling, add the missing `door()` |

Failures print game-space coordinates: find the `context()` they fall in and subtract its origin.

## Sizes and passes

Rooms 6–12 m across and 3–4 m high; corridors 3–4 m wide; doors 1.4–2 m wide, 2.2–2.6 m high;
stair treads 0.28–0.32 m deep, 0.16–0.18 m high. Build in passes: **structure** first (rooms,
doors, stairs, spawn, every link — audit clean), then **detail** (all `decor()`: casings around
doors, trim bands on long walls, furniture against walls and never on a route, rails on stairs),
then **surfaces and light** (six to twelve materials; one warm `lamp()` per room near the ceiling,
`emissive_*` strips where the eye should travel — the engine pools point lights, so a room with
eight lamps gets four). One `context()` per room, not the whole level in one.

## After a level build

- The engine loads the level on reload; the player spawns at `spawn()`. Doors land in
  `worldProfileData.doors[]` by id.
- `landmark()`s are for game code: the declared level is `WorldGenerator.getMeshLevel()`, and the
  coding subagent reads its points with `.landmark('altar')` / `.landmarksTagged('guard')`
  (`mesh-level.md`).
- Place props, NPCs and pickups on the level's floors as usual — they land on its colliders.
