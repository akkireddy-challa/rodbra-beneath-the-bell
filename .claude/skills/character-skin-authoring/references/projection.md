# Projection contract

The portable helper produces evidence and UV labels. It does not fit a detail exemplar,
change a GLB, or claim a sparse projected label map is a production-ready skin mask.
Use its coverage report to drive further agent inspection.

Run with a local Python containing NumPy and Pillow. Blender supplies its own NumPy.
The lab uses `lowpoly/.venv/bin/python`; elsewhere choose the project's environment.

```sh
python <skill>/scripts/skin_views.py prepare --source character.glb --views views.json --output evidence-v1 --size 1024 --blender /path/to/blender
python <skill>/scripts/skin_views.py bake --evidence evidence-v1 --annotations annotations.json --output masks-v1 --resolution 4096 --dense --blender /path/to/blender
```

Omit `--blender` when available on PATH. `prepare` uses Blender's imported mesh and
world transform, BVH visibility, interpolated UVs and unlit base-color image. It currently
supports directly linked Principled base-color textures and the active UV set. Complex
material graphs must first receive a faithful albedo bake; the helper fails instead of
guessing. Animated models are inspected in the imported pose. Validate orientation and
texture appearance against the original before annotating.

Evidence PNGs preserve sRGB byte textures as encoded values. Blender's non-float
`Image.pixels` exposes those byte values normalized to 0–1; applying an additional
linear-to-sRGB transfer would brighten the evidence incorrectly. Constant Principled
base colors are linear and receive exactly one transfer. Float images are rejected
until a faithful sRGB albedo bake is supplied. New manifests explicitly record
`evidenceColorSpace` and `byteImageTransfer`. The playground's known-color Blender
regression verifies both byte-texture and constant-color paths within one byte value.

Older evidence made before this correction may be too bright. Preserve those immutable
revisions and annotations, prepare a new color-correct revision, and visually review it.
Identical camera/UV correspondence can justify transferring polygon coordinates, but
never claim a new visual review merely because the geometry stayed unchanged. This
helper correction does not alter the runtime GLB texture color pipeline.

`views.json` is a list. `direction` points **from camera into the scene** in Blender world
coordinates, `up` defaults to +Z. `span` is square orthographic width divided by model
height. `targetOffset` is relative to bounding-box center, also in model-height units.
Directions are geometric, not assumptions about front/back or left/right anatomy.

```json
[
  {"name":"minus-y","direction":[0,1,0],"span":1.45},
  {"name":"plus-y","direction":[0,-1,0],"span":1.45}
]
```

After the survey, choose offsets and tighter spans by inspecting the actual character.
For a top view, supply an up vector perpendicular to its direction. Each view yields a
PNG and NPZ containing material index, UV and viewing-angle confidence for every visible
pixel. Manifest records source hash, cameras, dimensions, material names and world bounds.
Rasterized sample coordinates refer to pixel centers; polygon coordinates are image
pixels from top-left, x right and y down. Use precisely the named image dimensions.

```json
{
  "sourceSha256":"copy the manifest hash",
  "views":{
    "minus-y":[
      {"label":"skin","polygon":[[100,100],[140,100],[140,160],[100,160]]},
      {"label":"eyes","polygon":[[110,110],[120,110],[120,120],[110,120]]}
    ]
  }
}
```

These coordinates are format examples, not annotations for any character. Later polygons
overwrite earlier ones within a view. Across views, contradictory labels become unknown
and appear in the conflict map. Grazing samples are excluded deterministically. UVs outside
0–1 remain unclassified rather than being wrapped into a different region.

Outputs: per-material label, observed and conflict PNGs; per-view annotation overlays,
reprojected atlas overlays and raw reprojected labels; archived annotations; and a JSON report. Label IDs: unknown 0, skin 1, palm 2, sole 3, lips 4, eyes 5, hair 6, nails 7,
non_skin 8, dorsal_hand 9. Material ordering belongs to this evidence manifest, not a promised GLB index.
UV labels use top-left image rows (Blender UV V is inverted during baking).

The bake does not interpolate unknown texels or decide by majority vote: conflicting
observations require review. Low-resolution survey rays are insufficient to cover a 4K UV
atlas; use region close-ups and appropriate resolution for final maps. Do not count unknown
background texels as missed skin without examining the UV occupancy of the actual model.


## Dense bake and review (tested on three additional characters)

Use `--dense` for reviewed deliverables. The default sparse mode remains useful as a small
projection diagnostic. Dense mode rasterizes the source UV triangles, finds the 3D point
for each occupied texel, projects it into annotated cameras and ray-tests visibility against
the exact mesh. It does not interpolate semantic labels across unseen geometry. Distinct
surfaces sharing UV texels are reported as overlaps and remain unknown. Increasing atlas
resolution cannot add semantic accuracy beyond the annotation images.

Prepare hashes the PNG/NPZ evidence. Bake checks these hashes and the source mesh hash;
editing an image after annotation invalidates that evidence. Legacy manifests without
image hashes remain readable; prepare fresh evidence for new work. Preserve the original
manifest with its camera definitions. Evidence must not be resized or relit for annotation.

Review BOTH `<view>-overlay.png` (your polygons) and `<view>-reprojected.png` (the actual
baked atlas). All prepared views are reprojected, including views without annotations.
Palette: green skin, mint dorsal hand, cyan palm, blue eyes, purple hair, pink lips, pale
yellow nails, gray non-skin. Red means unknown; orange means conflict. Unknown clothing
is not missing skin. The raw `*-reprojected-labels.png` images retain categorical IDs.

The report distinguishes total visible pixels from annotated visible pixels. Use
`unresolvedAnnotatedPixels` and `disagreeingAnnotatedPixels` to detect projection losses;
these are NOT whole-character skin coverage or semantic accuracy scores. Low-resolution
atlases lose samples near small islands and seams even in dense mode. Match the source
atlas resolution, inspect the result, and keep unresolved seams visible. Do not hide them
with unrestricted dilation. A synthetic Blender regression exercises dense coverage,
occluded back surfaces and overlapping UVs.

Trials found source albedo spill on soldier b3843's palms, pale hair/ear ambiguity on b5588,
and missing side scalp coverage on b3658. These require different responses: record a
source-texture defect separately; correct hair/skin boundaries from multiple views; add
views/annotations for exposed surfaces. Indistinct nails require closer views. Do not
claim a material or skin-detail improvement from a semantic mask alone.

## Runtime packaging evidence

For the full-UV material adapter, add `--surface-data --triangle-labels` to the dense bake.

To investigate a seam or conflict, use `scripts/inspect_skin_point.py --evidence <folder>
--masks <dense-bake> --view <name> --x <pixel-x> --y <pixel-y>`. Coordinates belong to the
original evidence image. The read-only helper reports the UV texel and every visible
contributing view, its source pixel, authored label and geometric facing. It checks the
source, annotations and archived camera contract; it does not resolve the labels.

Add `--height-m <known-character-height>` to report surface distances to adjacent
occupied atlas texels in metres. Inspect individual neighbours: crossing a UV discontinuity
can produce a large distance. This diagnoses texture density, not anatomy or recovered
detail. If a face uses half-millimetre texels, increasing bump strength cannot recover
sub-texel pores. Preserve the registered detail in its own atlas instead of increasing
coverage or exaggerating relief to hide lost resolution.

Inspect the reported image pixels. A one-pixel garment-boundary mistake in a grazing
view can project into a much wider strip on the model. If that source boundary is
ambiguous and another view clearly shows the anatomy, explicitly mark the narrow
uncertain region in the ambiguous view as unknown and retain the reviewed clear view.
Do not automatically select a label by facing score or shrink all boundaries globally.
The first writes occupied texel positions, normals and geometric visibility bits in
Blender world space. The second classifies actual triangle centers with the same camera
annotations and exact visibility tests. Packaging matches those centers bijectively to the
GLB scene transform and fails if they differ; never assume Blender and GLB vertex ordering
match. This avoids assigning a whole triangle by a sparsely sampled UV center.

`triangles.npz` contains centers, labels and conflicts. `material-N-surface.npz` contains
position, normal, occupied, viewBits and visibilityBits. `viewBits` records views supporting
an annotation; `visibilityBits` independently records geometric visibility, including
unannotated views and unlabelled visible texels. Use the latter for projecting registered
detail, never an annotation's polygon boundary. Neither field assigns an anatomical label.
Older bakes without `visibilityBits` must be regenerated, not silently substituted.
Before consuming visibility bits, compare the archived `dense-request.json` source,
ordered cameras, image size, material ordering and world bounds against the supplied
manifest. A source hash alone cannot detect reordered camera bits. A color-only evidence
revision may preserve that geometric contract; changed cameras require a new bake.
These are build intermediates, not game textures.
The current visibility bit field supports up to 32 views in one revision. Blender workers
return a nonzero exit code on Python errors. Keep output revisions separate when changing
annotations; do not overwrite evidence to bypass a hash check.

Generic `skin` agrees with an observed `palm`, `sole` or `dorsal_hand` label. Two distinct
specific labels still conflict. This hierarchy combines semantic observations; it does not
recognize anatomy. A hard material boundary magnifies small polygon gaps: overlap enclosing
skin and its explicit hair/lip exclusions within the same view instead of leaving a narrow
unlabelled strip between them. Never fill an unseen nail or a contradictory observation.

### Thin unresolved folds

A closer view in the same direction does not necessarily resolve visibility gaps. The
b3658 rear-neck test retained a thin unobserved strip in a shallow fold until an oblique
view showed the recessed surface. Inspect source, coverage and shaded images separately.
Add that new view and annotate actual anatomy; never increase ray tolerance or fill unknown
regions merely to remove a line. Sample-level coverage improvements do not prove that all
residual albedo or filtering seams have disappeared. Keep those review results distinct.


### Source-color repair across UV islands

A harmonic image fill assumes the selected patch has clean boundaries. UV seams can split one anatomical patch into many islands whose boundaries remain contaminated. If a reviewed color repair remains unchanged, inspect the repaired albedo reprojected onto the exact mesh before extending semantic labels. For such defects, author clean color swatches on the same visible anatomical surface and interpolate in surface space, keeping the repair selection separate from anatomy. Check every donor against source hashes and independently reviewed skin. Record the swatch coordinates and inspect the final render. This is texture reconstruction, not segmentation or recovered source detail.

Designed features such as a nail plate absent from the source must be explicitly recorded as authored additions. They must not silently override contradictory anatomical observations; reconcile the views or keep the design unaccepted.

## Occluding silhouettes need precise annotations

A bottom-foot view may show the shin or clothing immediately beyond the heel and
between toes. A polygon around the apparent foot outline must exclude those visible
surfaces too; they are not necessarily empty background. In the b3662 trial, a few pixels
of excess sole annotation produced a curved sole-detail strip on the shin. The ray test
correctly saw that shin surface—the semantic polygon was wrong. Trace a bad rendered
point with `scripts/inspect_skin_point.py`, inspect the contributing source pixel, correct
that specific polygon, and reproject. Do not move a shader cutoff to conceal the artifact.
