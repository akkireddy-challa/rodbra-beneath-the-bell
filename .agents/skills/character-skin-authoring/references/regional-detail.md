# Regional detail helpers

The shipped `scripts/authored_detail.py` and `scripts/authored_surface_patch.py` are
Blender-independent NumPy/Pillow/SciPy libraries. They evaluate already-authored curves
and roughness patches. They do not recognize anatomy, load a rig, or export materials.
Keep profiles and licensed images in the character workspace, outside the refreshed skill.

Pass the exact evidence manifest and physical character height in metres. Surface points
must use the evidence's Blender world axes, centered on `worldBounds` and scaled by
physical height divided by the source bounds' Z extent. Normals use those same axes.
`visibility` is the dense bake's **geometric `visibilityBits`**, not annotation `viewBits`.
The label array is the reviewed semantic map. Both helpers leave other regions unchanged.

`AuthoredDetail(profile_path, manifest, height_m).evaluate(points, normals, labels,
visibility)` returns signed relief in metres. The profile contains `sourceSha256`,
`evidenceHashes`, `provenance`, and `curves`. Each curve specifies `view`, `region`,
`pointsPx`, `widthM`, and `depthM`. Regions supported here are `skin`, `palm`, `sole`,
and `dorsal_hand`. Coordinates belong to the exact source-view image. Record the curves
as designed enhancements, not measured anatomy.

`AuthoredSurfacePatch(profile_path, manifest, height_m, workspace_root).evaluate(points,
normals, labels, visibility, base_roughness)` returns blended roughness. The profile has
`sourceSha256`, `evidenceHashes`, and `patches`. Each patch contains:

- `view`, `region`, ordered `targetPixels` around the selected polygon.
- `roughnessTexture`, `textureSha256`, `sourceAnnotationImageSize`, and corresponding
  `sourcePixels` from the independently inspected donor image.
- `featherM` and `roughnessRange` as an explicit authored response range.
- `provenance`: `title`, `url`, `licenseFile`, and `licenseSha256`.

Texture and license paths are relative to the supplied workspace root. The helper checks
the current evidence image, texture and license hashes. Retain its `report` and append
all `attributions` to the exported asset's notices. Exemplar roughness is not necessarily
measured: record its origin accurately. This helper transfers neither color nor normals.
Normal-map RGB is not height data; integrating normals requires a declared tangent
convention and surface metric, followed by independent relief review.

An optional `height` record supplies an already prepared signed-height NumPy array:
`path`, `sha256`, `boundsPx` in the donor annotation coordinates, explicit `scale`,
and `provenance`. Values are metres, not RGB channels. The separate
`relief(points, normals, labels, visibility)` method returns the feathered height
contribution, leaving roughness evaluation unchanged. Preserve the method, source
normal convention, assumed metric and any artistic amplitude change in provenance.
Use known or explicitly designed height; this helper does not integrate normal maps.

For a square, locally planar exemplar with a declared isotropic metric,
`scripts/normal_patch_height.py` exposes `normal_patch_height(rgb, width_m, normal_y)`.
RGB is the raw linear normal-map data in [0,1]; `normal_y` must explicitly be `up` or
`down`. It uses [Frankot/Chellappa discrete slope integration](https://doi.org/10.1109/34.3909),
a reflected periodic extension, and physically specified band limiting. Save its output
as a signed-metre NumPy array and inspect the reconstructed folds before transfer. It
does not recover an unknown donor metric, recognize a skin region, or make artist-authored
normal maps into measured scans. The playground's Hafnia palm test explicitly assumes an
80mm planar crop and records that assumption; it is not a universal scale for hand assets.

`sampleResolution` can increase field sampling independently of the annotation image.
Physical feather width stays unchanged. When the project's exporter supports regional
atlas packing, `independentDetail: true` exposes the patch through `independent_planes()`.
The exporter must then exclude it from the coarse body bake (`include_independent=False`)
and register its texture coordinates separately. Do not silently omit it in an exporter
that lacks this path. Overlapping independent bindings require a deliberately combined
patch; there is no automatic regional winner.

Inspect the transferred patch at region-sized framing under side and specular lighting.
A small central-palm experiment is not acceptance of the whole hand, fingers or nails.
If the full-body atlas cannot resolve the patch, address texel density before amplifying it.

For independent atlas slots, keep a transparent margin around the authored patch inside
the evidence view. The playground packer rejects edge-touching patches rather than
clamping visible relief into a seam. Widen/reframe the evidence and review the annotation
again. Packing a patch at higher resolution is not a visual acceptance: inspect its relief
at an ordinary region-sized view and with side light before claiming improved skin.
