# Applying reviewed skin maps

The projection helper creates evidence and labels. It does not generate a body rig or
reconstruct missing anatomical detail. Keep source models immutable and store character
work outside this shipped skill, because GDK upgrades refresh the skill files.

## Prepare the material revision

Use the project's existing character loader and material pipeline. In the Bitmagic engine,
read `agent-docs/character-surfaces.md` and use `RealisticCharacter.create(root, options)`
when that API is available. Do not assume a published engine version already contains it:
inspect the installed engine declarations first. Preserve working standard glTF materials
when the specialized adapter is unavailable and report that rendering integration remains.
Do not silently upgrade the engine or edit unrelated existing character types.

Author maps from licensed skin exemplars or the creator's own assets. Register the exemplar
to this character's reviewed facial landmarks and physical scale; never reuse another
character's target coordinates. Keep donor identity, tattoos, beard and complexion out of
relief transfer. Use anatomically appropriate detail for hands, palms, feet and body areas.
A generic repeated face tile is a preview fallback, not a finished regional detail library.
Retain attribution, source hashes, transformations and the authored physical amplitude.
For visible regional creases, the agent may author curves in exact evidence-image
coordinates and bake physically scaled relief onto independently labelled visible skin.
Record these as designed enhancements, not captured measurements. Keep glabrous palm
detail separate from facial follicles, and inspect the result at hand-sized framing.
The [regional detail helpers](regional-detail.md) evaluate authored crease curves and
licensed roughness patches without making anatomical decisions.

The source UV label map is top-left image data. Convert to the exporter/runtime's UV
convention exactly once. Bake source albedo as sRGB; roughness, metalness, masks, normals
and packed detail as linear data. Confirm with a known neutral patch and a source-material
comparison under identical lighting. A global saturation adjustment cannot diagnose a
color-space conversion bug.

## Specialized engine contract

Explicit material extras opt into the character adapter. Untagged materials remain native.
For mixed skin/clothing primitives, `skinSurfaceBlend: true` uses atlas alpha as per-pixel
skin coverage. The packed linear RGBA atlas stores signed height around .5, roughness,
chromatic residual around .5 and coverage. `skinAtlasHeightRangeM` sets physical height.
`skinAtlasTexture` and optional `skinExpressionTexture` refer to embedded glTF texture
indices. `_FACE_UV` supplies atlas coordinates; `_FACE_WEIGHT` supplies coverage weighting.
`_SCATTER` is a fallback transmission attribute. Read the installed engine contract for
exact current fields rather than guessing their implementation.

Check physical texel density before increasing relief strength: a 4K full-body texture
can still sample the face at roughly half a millimetre per texel. In engines supporting
`skinFacialAtlasTexture`, retain the registered facial detail separately from body coverage.
The `skinFacialAtlasLayout: "detail-expression-halves-v1"` contract packs facial detail in
the left half and facial expression in the right half of one linear texture; its detail
height uses the same physical range as the body atlas. `_FACIAL_DETAIL` packs independently registered UV in XY and geometry-verified projection
visibility in Z, retaining the WebGPU vertex-buffer budget on skinned meshes.
This layer replaces facial detail baked into the body atlas, not skin coverage. Body
expression must be neutral for this layout. Packing replaces its shader sampler rather
than adding samplers beyond WebGL's budget. Compare the actual backends, preserve physical
filter widths when changing resolution, and check that coverage remains byte-identical.

The same packed texture can reserve additional rows for independently reviewed body
patches while keeping the original face texels. `skinFacialAtlasRegion` then records the
face rectangle within the detail half, and each vertex's `_FACIAL_DETAIL` coordinates
already address its assigned region. Reconstructed eyelids must use that rectangle too.
Keep patch alpha as detail blending only: the body atlas still owns skin coverage. This
retains the sampler and vertex-buffer budget instead of adding one material per patch.

Resolve embedded textures through the engine GLTF loader parser. Keep the scene diffusion
and transmission passes and the body AnimationMixer caller-owned. The adapter exposes
independent eye controls, preserves source materials on disposal, and does not create a
missing skeleton. Keep specular reflection outside diffuse scattering. A blurred beauty
image is not subsurface diffusion. Author channel diffusion ratios in asset metadata;
never infer skin type from character ID, race, height or RGB thresholds.

At a known skin/hair/lip boundary, material weights must sum to one; independent fades
expose the native response as a glossy line. Fill filtering gutters in UNUSED UV atlas
space from the nearest occupied texel, but never grow labels into unseen surface regions.
Check the actual zero-coverage and full-coverage endpoints against the native and skin
materials. Preserve armor, cloth, hair and optical surfaces during skin changes.

## Source defects and acceptance

Separate source pigment spill, baked lighting, UV seams, normal errors, geometric creases
and missing coverage. Inspect unlit source, material labels and shaded results independently.
Color repair needs a separate authored selection. When a defect crosses UV islands, use
reviewed clean swatches in surface space; atlas-space harmonic fill may retain contaminated
island boundaries. A color repair cannot reconstruct missing hand geometry or eyelids.

Review all exposed regions and fixed-camera detail on both supported rendering backends.
Store region verdicts, current output hashes and review images beside the character. A
successful export or low conflict count is not visual acceptance. Keep incomplete regions
explicit and continue gathering views or authoring detail rather than calling a face-only
pass a complete character.

When a project uses the `viewerReady` metadata convention, `scripts/select_preview.py`
can validate the mechanical handoff. Supply `--asset`, `--metadata`, `--render-report`
and `--visual-verdict`. The render report is an array containing both `webgl` and
`webgpu` receipts with matching `actual`, empty `errors`, and the current `outputSha256`.
For combined runtime reports use `--variant eyes` or `--variant surfaces` to read
`assetHashes` instead. The agent-written verdict must identify the same output hash,
use `status: "local_preview_with_known_issues"` and `wholeCharacterAccepted: false`,
and list actually inspected images as `visuallyInspected: [{file, sha256}]`, relative
to that verdict. The helper checks current image bytes before selecting the preview.
It does not inspect those images, publish an asset, or declare the character finished.

Use the [installed exporters](exporters.md) to build these authored inputs into GLBs.
[The playground example](playground.md) records the tested asset layout and review harness;
its browser review commands still require that separate checkout.


### Regional height composition

Independently registered body patches may declare `skinRegionalAtlasHeightMode: "additive-v1"` with `skinFacialAtlasRegion: [0, 0, 1, faceEndV]`, where `0 < faceEndV < 1`. The face occupies the atlas's top rows; body patches occupy rows below it. In those body rows, patch relief adds to the underlying body height rather than replacing authored palm creases or other regional folds. Facial relief retains replacement behavior, and body coverage is unchanged. Roughness still blends to the authored patch value. Assets without this explicit mode retain their previous replacement behavior.

This uses the existing packed texture and VEC3 binding on WebGL and WebGPU; it adds no sampler or vertex attribute. Do not compensate for erased crease layers by increasing microdetail strength. Check the composition with the patch enabled and disabled at the same camera, and retain the physical amplitude of each layer.


Regional bindings need coherent UV coordinates at every corner of a triangle touching the patch, including corners with zero detail weight. A zero-weight corner still participates in UV interpolation. Leaving its old facial coordinates in place can make the triangle sample unrelated atlas texels. Extend coordinate support by adjacent triangles while keeping their detail weight zero and semantic coverage unchanged; reject overlapping active patch bindings or split the geometry explicitly.
