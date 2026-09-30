# Applying the reviewed maps in the character-forger playground

The maintained helpers are in `highquality/src/` at the character-forger repository root.
They are not standalone engine binaries. Use the project's Python with NumPy, Pillow and
SciPy, and Blender for projection. Keep this adapter's single mesh/primitive limitation
explicit; do not silently flatten a rigged or instanced scene to make it pass.

1. Prepare and annotate exact views; dense-bake with `--surface-data --triangle-labels`.
2. Author `highquality/materials/faces/ID.json` from this character's face view. The target
   bounds describe normalized body X/Z in Blender world space. Pixel dimensions belong to
   their respective source and target views. Reusing donor correspondence is valid; reusing
   another character's target landmarks is not. Hair surrounding a face is an enclosure,
   not one filled exclusion polygon covering the face.
3. Run `python highquality/src/build_face_detail.py --id ID`. It registers band-limited
   licensed scan relief and emits attribution. The amplitude is an authoring estimate,
   not measured displacement. Empty coverage is an error requiring a profile correction.
4. Run `python highquality/src/vision_materials.py --id ID --masks MASK_REVISION --evidence EVIDENCE`.
   The adapter writes `characters/ID/high/v1/materials/v2/character.glb` and a report. It
   preserves source geometry/buffer bytes, nodes, existing skin data and animation data.
   This does not add a missing body rig. Inputs are currently the immutable HY source.
5. Rebuild the viewer with `node hero/viewer/build.mjs`. Run
   `CHARACTER_ID=ID node highquality/tests/vision_skin_smoke.mjs` on both renderers, then
   inspect the screenshots. Tests check loading and camera stability, not anatomical truth.

The detail atlas uses source UVs and includes all explicitly observed skin. Face detail is
registered from a licensed scan; other follicular skin currently uses reduced scan relief.
Palms/soles use authored nonfollicular ridges. This is not a library of captured regional
hand/foot exemplars. Source geometry retains its existing larger creases. The report keeps
unresolved labels and texture defects visible.

Engine contract: explicitly tagged skin/hair materials opt into `createCharacterSurfaceMaterial`.
RGBA detail stores signed height around .5, roughness, chromatic residual and coverage.
`_FACE_UV` supplies coordinates, `_FACE_WEIGHT` coverage, `_SCATTER` the fallback transmission
attribute. Atlas data is linear; albedo is sRGB. The helper excludes defective HY normals on
labelled skin, keeps native materials elsewhere, and performs geometry-corresponding skin
UV seam colour equalization. It cannot remove arbitrary baked lighting or interior texture
stitches merely by correcting normal maps.

Material reports remain `shaded_review_required` until actual exposed regions and rendered
maps have been reviewed. Do not convert low conflict counts into a whole-character quality
claim. The b3658 scalp albedo stitch, ambiguous nails and b3843 palm colour spill are examples
of asset defects that require separate correction.

## Per-pixel material boundaries

After the v2 evidence build, `python highquality/src/vision_blend_materials.py --id ID`
creates an opt-in v3 revision. `--all-surfaces` creates v4 with hair/lip/nail PBR maps
as well. Both preserve geometry. They currently require one shared source material/UV
layout; unsupported native specular or fiber maps fail rather than being overwritten.

`skinSurfaceBlend: true` makes the engine use atlas alpha for skin response, including
diffusion and thin-skin transmission. Zero coverage retains the native response. Coverage
must have UV gutters: copy nearest occupied texels into unused atlas space, never into
unobserved surface regions. This distinction fixes false seams without inventing anatomy.
At skin/hair/lip boundaries, known material weights must sum to one. Independently fading
both sides to zero exposes the source material as a bright halo.

V4 expresses fiber and lip response through standard glTF ORM/specular/anisotropy/sheen
maps. The current fiber direction is provisional; author a comb-flow field before calling
hair finished. Its skin inspector shows actual skin coverage (white), not an entire mixed
primitive falsely labelled as skin. `viewerReady` only selects a tested local preview;
it is not the region-level semantic or final character quality approval.

## Runtime adoption

The engine now provides `RealisticCharacter.create(root, options)` for the loaded GLTF.
Use the engine's `createGltfLoader()` and resolve embedded atlas indices through its parser.
The adapter validates UV attributes, retains native untagged materials, preserves coverage
when detail is disabled, and exposes independent eye controls. It commits material changes
only after texture resolution succeeds. Scene postprocessing and the body mixer remain
caller-owned. See the GDK engine document `agent-docs/character-surfaces.md` for ownership
and pass ordering; do not copy the lab's former material-loading loops into each game.

For a rigged playground derivative, use `highquality/src/assemble_character.py` after
shared Blender binding. It converts refined geometry to canonical bind coordinates and
keeps canonical inverse-bind matrices; exercise pose reset and body motion, not only a
rest-position comparison. Unrigged material/eye previews can coexist with a rigged body
variant. Determine normalization from the loaded asset, not a catalog-wide rigging flag.
