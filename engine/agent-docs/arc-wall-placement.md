# Wall + fence placement (curves, perimeters, racetracks, arenas, yards)

> **Coordinate convention:** See `@docs coordinate-system.md`. Walls are gameplay objects — local **+Z** is the segment's long axis / "front" under the engine's +Z gameplay convention. The atan2 / Y-rotation derivations in this doc compute the segment yaw directly from the path tangent and are correct under that convention; positive Y-rotation rotates the local +Z axis toward +X (right-handed Three.js Y-rotation).

Procedural wall / fence placement has to solve **two** jobs:

1. **Align the segment's long axis** to the path direction (curve tangent, or the side of a rectangular perimeter).
2. **Aim the segment's front face** at the side where the play area / interior sits.

Job 1 is universal. Job 2 is asset-dependent — symmetric primitives (`THREE.BoxGeometry`) don't care which way they face, but **asymmetric VXL / GLB assets** (jersey walls, fences, hedges, painted barriers, signage walls, picket fences, chain-link fences, …) have a clearly visible "front" and the wrong rotation makes every segment 180° off.

## STEP 0 — Empirical asset-front-axis check (MANDATORY before bulk placement)

**This step is the single most common reason every wall/fence ends up 180° off.** Do it BEFORE writing any placement loop, BEFORE figuring out the math.

1. Place a SINGLE asset at world origin `(0, 0, 0)` with `--ry 0` via the voxel CLI (`node bin/voxel.mjs place ...` — see `@docs voxel-cli.md`).
2. Look at it from the **+Z side** (positive-Z is "south" / "toward the camera" in standard top-down).
3. Which side of the asset do you see?
   - **Visible / painted / "front" side facing +Z (toward you)** → asset's front IS along local +Z. The math below works as written.
   - **Back side facing +Z (you see the back; flat or rough)** → asset's front is along local **-Z**. **Add `π` to every rotation in this doc's recipes.** Or rotate the source asset 180° at creation time.
   - **Long axis facing +Z (you see the side, asset is "edge-on")** → asset's long axis is +Z (not +X). Subtract `π/2` from every rotation, OR re-author the asset with long axis along +X.

When **every** placed segment is 180° off (not half), the asset is -Z front and step 3b applies. Use `rotation.y = (math result) + π` everywhere.

When **half** the segments are 180° off (e.g., a figure-8 has good outer walls but bad inner walls, or vice versa), the asset's front is correct but the placement formula needs a per-segment direction flip — see "Two wall categories, two formulas" below.

## The math

For a wall placed on a circle of radius `r` centered at `(cx, cz)`, parametric angle `t` (`0 → 2π`):

| Quantity | Vector |
|---|---|
| Position | `(cx + r·cos t, cz + r·sin t)` |
| Tangent | `(-sin t, cos t)` (in (X, Z) form) |
| Radial outward (center → point) | `(cos t, sin t)` |

**THREE.js Y-rotation convention** (verify yourself: `obj.rotation.y = π/2` puts local +Z at world `(1, 0, 0) = +X`, NOT `(-1, 0, 0)`). With rotation `R`:
- Wall's local **+X** (long axis) in world → `(cos R, -sin R)` — i.e., positive R rotates +X toward **-Z**.
- Wall's local **+Z** (front face) in world → `(sin R, cos R)`.

So to make the wall's front (local +Z) point in some target direction `(fx, fz)`, set **`R = atan2(fx, fz)`**.

The cleanest way to think about wall placement: pick the desired **front direction** (where the painted face should look), then compute `R = atan2(front.x, front.z)`. Long-axis alignment to the tangent comes "for free" because front is perpendicular to long axis.

All `rotY` values are in **radians** (engine convention).

## Two wall categories, two formulas

For walls on a circle centered at `(cx, cz)`:

| Wall category | Track is | Front should face | Formula |
|---|---|---|---|
| **Inner-island** (wall surrounds the dot inside a loop) | OUTSIDE the wall | radial OUTWARD `(cos t, sin t)` | `R = atan2(cos t, sin t)` = **`π/2 - t`** |
| **Outer-envelope** (wall surrounds the whole arena) | INSIDE the wall | radial INWARD `(-cos t, -sin t)` | `R = atan2(-cos t, -sin t)` = **`-π/2 - t`** |

The two formulas differ by exactly **π (180°)**. Only the front-vs-back flips.

> ⚠️ Earlier versions of this doc used `R = t ± π/2`. That was wrong — it only happens to be correct at t = π/2 and t = 3π/2 (north/south points of the circle), and is 180° off at t = 0 and t = π (east/west points). If you see fences correct on two sides of a circle and flipped on the other two, you're using the old formula.

## The figure-8 trap

Figure-8 tracks have BOTH inner-island walls AND outer-envelope walls in the same scene. **Using one rotation formula for both is the most common mistake** — half the walls end up 180° off (the asymmetric asset shows its back to the track on whichever half doesn't match).

For symmetric `BoxGeometry` walls, the bug is invisible (a box rotated 180° around Y looks identical) — the bug only surfaces when those boxes get replaced with asymmetric VXL/GLB asset pieces.

## Recipe

```ts
// ✅ Pass "track is on the inside" as a parameter — picks the right rotation per arc.
const placeArc = (
  cx: number, cz: number, r: number,
  startAngle: number, endAngle: number,
  segments: number,
  trackInside: boolean,            // ← key flag
) => {
  for (let i = 0; i < segments; i++) {
    const t = startAngle + (endAngle - startAngle) * (i + 0.5) / segments;
    const x = cx + r * Math.cos(t);
    const z = cz + r * Math.sin(t);
    const arcLen = Math.abs(endAngle - startAngle) * r;
    const segLen = (arcLen / segments) * 1.02; // 2% overlap hides seams
    // Compute the desired front-facing direction at this point, then atan2 to rotation.
    //   trackInside  → outer-envelope, front faces center: (-cos t, -sin t)
    //   !trackInside → inner-island,   front faces away:  ( cos t,  sin t)
    const sign = trackInside ? -1 : 1;
    const rotY = Math.atan2(sign * Math.cos(t), sign * Math.sin(t));
    placeWall(x, z, rotY, segLen);
  }
};

// Figure-8 example
placeArc(-LOOP_CX, 0, INNER_R, 0,             2 * Math.PI,           32, /* trackInside */ false);
placeArc( LOOP_CX, 0, INNER_R, 0,             2 * Math.PI,           32, /* trackInside */ false);
placeArc(-LOOP_CX, 0, OUTER_R, alpha,         2 * Math.PI - alpha,   40, /* trackInside */ true);
placeArc( LOOP_CX, 0, OUTER_R, Math.PI+alpha, 3 * Math.PI - alpha,   40, /* trackInside */ true);
```

## Figure-8 crossover gap — segments that block the OTHER loop

Rotation isn't the only figure-8 trap. Every loop's inner-island ring spans the full `0 → 2π`, but the angular wedge near the crossover lands inside the OTHER loop's racing surface. Place those segments and you've built a wall *across the racing line* of the loop they're not labeled for. Symptom: the player drives one loop fine, then T-bones a wall on the second loop near where the loops meet.

The fix is to skip every segment whose position falls inside the other loop's asphalt ring. A short helper, applied as a per-segment filter inside `placeArc`:

```ts
// Asphalt of the OTHER loop spans [otherR - halfTrackW, otherR + halfTrackW].
// Skip segments that land in that ring (with a small margin so the wall corner
// doesn't poke into the racing line either).
const insideOtherTrackRing = (
  x: number, z: number,
  otherCx: number, otherCz: number,
  otherR: number, halfTrackW: number,
  margin = 0.5,
): boolean => {
  const d = Math.hypot(x - otherCx, z - otherCz);
  return d >= otherR - halfTrackW - margin && d <= otherR + halfTrackW + margin;
};

const placeArcWithCrossoverGap = (
  cx: number, cz: number, r: number,
  startAngle: number, endAngle: number, segments: number,
  trackInside: boolean,
  // Other loop, used only for the gap test:
  otherCx: number, otherCz: number, otherR: number, otherHalfW: number,
) => {
  for (let i = 0; i < segments; i++) {
    const t = startAngle + (endAngle - startAngle) * (i + 0.5) / segments;
    const x = cx + r * Math.cos(t);
    const z = cz + r * Math.sin(t);
    if (insideOtherTrackRing(x, z, otherCx, otherCz, otherR, otherHalfW)) continue; // ← gap
    const arcLen = Math.abs(endAngle - startAngle) * r;
    const segLen = (arcLen / segments) * 1.02;
    const sign = trackInside ? -1 : 1;
    const rotY = Math.atan2(sign * Math.cos(t), sign * Math.sin(t));
    placeWall(x, z, rotY, segLen);
  }
};

// For a figure-8 with loop centers at (±LOOP_CX, 0), painted-track radius R and
// half-width halfW (asphalt = [R - halfW, R + halfW]):
placeArcWithCrossoverGap( LOOP_CX, 0, INNER_R, 0, 2 * Math.PI, 32, false,
                          -LOOP_CX, 0, R, halfW);  // skip segments inside left loop's track
placeArcWithCrossoverGap(-LOOP_CX, 0, INNER_R, 0, 2 * Math.PI, 32, false,
                           LOOP_CX, 0, R, halfW);  // skip segments inside right loop's track
```

**Verification before bulk placement:** apply the filter in isolation and log how many segments survive. For a loop with `LOOP_CX = 26`, `INNER_R = 22`, `R = 30`, `halfW = 6`, the inner-island ring should lose ~4–6 segments out of 32 (the wedge facing the other loop). If the count drops to 0 or stays at 32, the filter is wrong.

The same filter works for outer-envelope walls — they also need a gap where the two outer envelopes meet at the crossover, otherwise the envelope wall blocks both loops as the cars transition through the X.

## Asset "front" axis — empirical check

The recipe assumes the asset's painted/visible front is along its local **+Z**. Most VXL / GLB wall assets follow this convention. **If every wall in your scene is 180° off after applying the recipe, the asset's front is along -Z instead** — add `Math.PI` to every rotation, or rotate the source asset 180° at creation time.

To check empirically before doing the procedural placement: place one wall via the voxel CLI (`node bin/voxel.mjs place --asset … --x 0 --z 0 --ry 0`) at world origin. The face visible from the +Z side of origin is the "+Z front." Confirm it matches the painted/intended face before generalising.

## Non-circular curves

For paths that aren't circles (splines, ellipses, hand-authored chains of waypoints), use the general "front direction → atan2" approach. Don't try to manipulate angles; compute the target direction directly.

```ts
// Wall placed between sample points P[i] and P[i+1], with track at known point T (for that segment).
const wallPos  = P[i].clone().add(P[i + 1]).multiplyScalar(0.5);
// Front-facing direction = from wall toward track, projected to XZ:
const fx = T.x - wallPos.x;
const fz = T.z - wallPos.z;
const rotY = Math.atan2(fx, fz);
```

If you don't have a single "track point" (e.g., the track is a strip alongside the wall), use the perpendicular to the local tangent:

- **Tangent at sample `i`**: `tangent = normalize(P[i+1] - P[i-1])` (central difference).
- **Front direction** is one of the two tangent perpendiculars: `(tangent.z, -tangent.x)` or `(-tangent.z, tangent.x)`. Pick whichever points toward the track at that sample. For self-intersecting curves (figure-8 crossover), the correct side can FLIP at the crossover; emit segments per-side rather than parametrically.
- **Rotation**: `R = atan2(front.x, front.z)`.

## Fences and walls along rectangular perimeters (NOT a curve)

For a yard / property / building fence going around a RECTANGLE (not a circle), each side has a fixed rotation. Convention used here: **+Z is "north"** (the rectangle's `+halfD` edge), -Z is south. The engine has no enforced compass; this doc just uses +Z=north consistently.

**Math derivation** (so you can verify): a +Z-front asset placed at `rotation.y = R` has its visible front pointing in world direction `(sin R, cos R)`. For each edge, "interior" is the direction from the fence back toward the rectangle's center. The front needs to face that direction — i.e. `R = atan2(interior.x, interior.z)`.

| Side of rectangle | Fence sits at | Interior direction | `rotation.y` (+Z-front asset) | After flip (+π for -Z-front asset) |
|---|---|---|---|---|
| North edge (`+halfD`) | `z = +halfD` | toward `-Z` | **`Math.PI`** | `0` |
| East edge (`+halfW`)  | `x = +halfW` | toward `-X` | **`-Math.PI / 2`** | `Math.PI / 2` |
| South edge (`-halfD`) | `z = -halfD` | toward `+Z` | **`0`** | `Math.PI` |
| West edge (`-halfW`)  | `x = -halfW` | toward `+X` | **`Math.PI / 2`** | `-Math.PI / 2` |

(Verify any row: at the north edge, the fence sits on the +Z side of the rectangle. Looking back toward the interior means looking in the -Z direction. To make the asset's local +Z point in world -Z: `R = atan2(0, -1) = π`. ✓)

**Recipe:**

```ts
function placeRectangularFence(
  centerX: number, centerZ: number,
  width: number, depth: number,    // rectangle dims, in meters
  segmentLength: number,           // length of one fence asset, in meters
  assetFrontIsNegativeZ: boolean,  // ← determined by STEP 0
) {
  const halfW = width / 2;
  const halfD = depth / 2;
  const flip = assetFrontIsNegativeZ ? Math.PI : 0;
  const segments: { x: number; z: number; rotY: number }[] = [];

  // North edge — segments run along +X. Front needs to face -Z (toward interior). For +Z-front asset: rotY = π.
  for (let x = -halfW + segmentLength / 2; x < halfW; x += segmentLength) {
    segments.push({ x: centerX + x, z: centerZ + halfD, rotY: Math.PI + flip });
  }
  // South edge — segments run along +X. Front needs to face +Z (toward interior). For +Z-front asset: rotY = 0.
  for (let x = -halfW + segmentLength / 2; x < halfW; x += segmentLength) {
    segments.push({ x: centerX + x, z: centerZ - halfD, rotY: 0 + flip });
  }
  // East edge — segments run along +Z. Front needs to face -X (toward interior). For +Z-front asset: rotY = -π/2.
  for (let z = -halfD + segmentLength / 2; z < halfD; z += segmentLength) {
    segments.push({ x: centerX + halfW, z: centerZ + z, rotY: -Math.PI / 2 + flip });
  }
  // West edge — segments run along +Z. Front needs to face +X (toward interior). For +Z-front asset: rotY = π/2.
  for (let z = -halfD + segmentLength / 2; z < halfD; z += segmentLength) {
    segments.push({ x: centerX - halfW, z: centerZ + z, rotY: Math.PI / 2 + flip });
  }

  return segments;
}
```

**The "interior is inside the rectangle" assumption** matches the most common case (fence around a yard, fence around a building, perimeter wall around a castle inner courtyard). For a rectangle where the interior is OUTSIDE (e.g., a fence around a pit / pool that you stand outside of), add `Math.PI` to every rotation — the front now needs to face outward instead of inward.

## Symmetric walls — when none of this matters

If using `THREE.BoxGeometry` (or any wall/fence asset whose front and back are visually identical — pure unpainted boxes, simple cylinders), pick either formula and stop worrying. The `trackInside` parameter has no visible effect.
