# Rebuilding Unity art from FBX: the rules that produce Unity's mesh

Unity does not render the FBX as authored. It applies an import pipeline, and the GLB must
reproduce that pipeline, not the file. These are the rules, each learned from a piece that was
"rotated 90 degrees", mirrored, split in half, or a quarter of its size.

## Coordinates

- Unity is left-handed, Y up, camera looking down +Z for this 2D-on-a-plane genre. Blender's FBX
  importer maps Unity (x, y, z) to Blender (x, z, y); glTF export from Blender gives the engine
  (ux, uy, −uz). `Arena.ts` uses that depth convention, so "Unity z" reads as `−z` in the game.
- **Unity negates X on FBX import** (right-handed to left-handed). The reader applies
  `(−x, y, z)` to every vertex (`UNITY_NEGATE_X`), and `blender_build` uses signs `(−1, 1, 1)`.
  This was the residual mirror that split the round end caps: the `Top_1_H` tips only join into a
  half-round with X negated. Do not apply it twice — the collider path once did (reader plus
  `apply_permutation`) and every collider landed mirrored.
- Unity's own glTF exporters (UnityGLTF, glTFast) do the same with scale (−1, 1, 1) and
  quaternion (x, −y, −z, w); that is the cross-check when in doubt.

## Geometric transforms (the 90-degree bug)

3ds Max exports put a **geometric transform** on the Model node — `GeometricRotation`,
`GeometricTranslation`, `GeometricScaling` — that applies to the mesh vertices only, not to
children. Unity bakes it into the mesh asset. The Euler order is XYZ, composed as Rz·Ry·Rx, and
was verified against Unity's own BoxCollider boxes (21 of 30 off-centre boxes match only with that
order). `Wall_7` reproduces Unity's box exactly: lo (−1, −0.003, −0.042), hi (1, 2.597, 0.042).

Blender's importer folds the geometric transform into the **object** matrix. `bake_to_blender`
works from the raw vertices and applies the geometric matrix itself, so it must take only the unit
scale from the object — and divide `GeometricScaling` back out of `matrix_world.to_scale()`,
otherwise that scaling is applied twice. That is exactly why the centre statue (GeometricScaling
0.28) came out at a quarter of its size while the Pack pieces (GeometricScaling 1) hid the bug.

## Axis permutations: do not derive them

An earlier version derived a per-pack axis permutation from collider sizes or from a symmetry
score of the assembled level. Both are blind to a uniform rotation or mirror of every piece, so
they happily chose a "best" permutation that rotated everything 90 degrees. The real causes were
the two rules above. `fbx_axis.py` now returns the identity with X negated
(`DEFAULT_TRANSFORM = ((0,1,2), (−1,1,1))`); `UTOPOS_AXIS_OVERRIDE="Pack=cycYZX:-1,1,1"` exists
for a pack that genuinely needs one, and the test of "needs one" is a Unity BoxCollider box that
does not match — never a picture that "looks more symmetric".

## Units and scale

A mesh asset in Unity is: raw vertices × baked geometric transform × **file unit scale**
(`useFileScale: 1` in the `.meta` times the FBX `UnitScaleFactor` / 100 — `GatheredStatues.FBX` is
in inches, factor 2.54). Nothing from the node's own `Lcl Scaling` reaches a mesh asset; that
lands on the imported GameObject, which a hand-built prefab does not use. `read_fbx` returns the
unit factor alongside the meshes; check `.meta` `globalScale` too.

## Multi-mesh files and ASCII files

- A MeshFilter references a mesh by `fileID` (`43000xx`); the FBX `.meta` maps those to mesh
  names in file order. `mesh_index_for` does the lookup — without it the walker picks the first
  mesh, which is how a 141-unit statue appeared.
- The ship packs are ASCII FBX 6100 from Blender 2.71, which Blender no longer imports;
  `fbx_ascii.py` reads the handful of arrays that matter (vertices, polygon index, one material).

## Materials and textures

The FBX's embedded texture paths point into the vendor's authoring tree. What Unity renders is the
Renderer's `m_Materials` GUID list → `.mat` → texture GUIDs; `unity_assets.py` resolves that
chain. In Blender: textures capped (512 colour / 256 other) and JPEG q80 (a 68 MB GLB became
0.33 MB); emissive only when the material enables it (`_EMISSION` / `_UseEmissiveIntensity`),
preferring `_EmissiveColor` over `_EmissionColor` — otherwise the whole arena whites out; metalness
capped at 0.45 because the arena is lit by the ship's lamp alone and full metal renders black.

## Checking a converted piece

1. Its Unity BoxCollider box (from the prefab) against the mesh bounds the reader produces — the
   only objective test of orientation and scale.
2. One piece with a known shape (an end cap, a cross bar) rendered from above next to the Unity
   editor view.
3. Family extents in the finished GLB (Blender lists objects by name) against the census.
