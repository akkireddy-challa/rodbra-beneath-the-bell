# Face and eye profile authoring

These schemas describe authored inputs to the installed exporters. Values that locate
anatomy must come from images of this character. Keep the physical dimensions and source
hashes beside the profile; never copy another character's target coordinates.

## Facial detail registration

Write `highquality/materials/faces/ID.json` with:

- `version: 2`, `id`, `sourceSha256`, `evidenceImage` (workspace-relative), and
  `evidenceImageSha256` identifying the exact source and reviewed frontal image.
- `annotationImageSize`: the square target image's actual pixel dimension.
- `bounds: [minX, minZ, maxX, maxZ]`: the target image rectangle in normalized body
  coordinates. The current adapter requires a frontal view with direction `[0,1,0]`
  and up `[0,0,1]`; align an arbitrarily oriented source explicitly before preparing
  evidence. Normalized X is `(worldX - boundsCenterX) / bodyHeight`; normalized Z is
  `(worldZ - boundsCenterZ) / bodyHeight + .5`. For a frontal evidence camera, its
  `targetOffset` and `span` give this rectangle directly:
  `[offsetX-span/2, .5+offsetZ-span/2, offsetX+span/2, .5+offsetZ+span/2]`.
- `sourceBounds` and `sourceAnnotationImageSize`: the donor registration view's
  rectangle and pixel size. Generate and inspect it with the helper below.
- `landmarkNames`, `sourcePixels`, `targetPixels`: equal-length ordered arrays of
  corresponding points. Use a well-spread non-collinear set spanning forehead,
  temples, cheek/jaw/chin boundary, eye corners, nose and mouth. These define the
  correspondence and its supported hull; points outside the hull receive no face detail.
- `regions: {"eyes": [...], "brows": [...], "lips": [...]}`: each list contains polygons
  of target image pixels. These exclude those regions from ordinary facial detail.
  Include facial-hair exclusions in the exclusion polygons too. Empty lists are valid
  only when that exclusion is actually absent in the selected patch.
- `atlasSize`: 2048 or 4096. `independentFacialDetail: true` retains the full facial
  resolution in the packed runtime atlas.
- `detailHeightRangeM`: full signed encoding range in metres (zero is .5).
  `detailAmplitudeM`: authored donor-band calibration, not measured scan amplitude.
  Compare the resulting relief at face-sized framing under side light; do not compensate
  for missing texel density by increasing amplitude.
- `diffusionProfile`: three positive authored channel falloff ratios, such as the
  renderer's human-skin default `[1,.55,.3]`. Fantasy skin ratios are appearance choices.

Generate the fixed licensed donor's reference image without a playground checkout:

```sh
python scripts/prepare_face_reference.py --workspace /path/to/assets \
  --out /path/to/assets/evidence/donor --size 900
```

Use `donor-front.png` and `registration-view.json` to author `sourcePixels`. Pixel origin
is top-left for both source and target. The helper uses the same donor projection and
UV convention as the atlas builder; choosing points from a differently framed photo
will misregister the relief. It renders the existing licensed files and downloads nothing.

## Optical eye fit

An eye profile has `id`, `sourceSha256`, `evidence` (absolute prepared-view folder),
`skinRevision: "v4"`, and exactly two entries in `eyes`. Each entry requires:

- `name`, `anatomicalSide: "left" | "right"`, and `view`, matching a manifest view.
- `irisCenterPx: [x,y]`, `irisRadiusPx`, and `openingPx`: an ordered convex aperture
  polygon in that exact view. Inspect both obliques before choosing the final depth.
- `upperContourIndices` and `lowerContourIndices`: ordered indices along the corresponding
  aperture edges, including their corners. These guide contacts, lashes and closure.
- `globeRadiusM`, `corneaBulgeM`, `frontOffsetM`, `pupilRatio`, `irisColorLinear` (RGB).
  These are designed optical dimensions and pigment. The iris must fit inside the globe;
  confirm against the character's physical height and side views.

Use `openingAuthority: "reviewed-contours"` only after explicitly inspecting the aperture
when the source has no separately classified ocular primitive. `conformOpenLids: true`
pushes intersecting source lid tissue outside the fitted globe; inspect its effect.
Optional `lashes` uses `upperCount`, `lowerCount`, `upperLengthM`, `lowerLengthM`,
`radiusM` and an authoring note. Reconstructed bands (`outerLidPx`, `lidSkinSamplesPx`),
corner lining (`canthusWalls`), medial tissue (`caruncle`) and brow strands (`browGroom`)
are described in [eyes.md](eyes.md). Start with the source-preserving fit; optional
reconstruction is not automatically an improvement, as the rejected elf trial showed.

The current blink is a fitted geometric morph, not a biomechanical eyelid simulation.
Preserve source folds unless an independently reviewed correction improves the result.
Simple smoothing of the closed support band was rejected because it created visible
rings. Treat any future smoothing as a new fit experiment requiring matched neutral
and closed-eye review.

### Several independent source-color repairs

`materials/repair-profile.json` may retain the single-operation form or contain
`{"repairs": [operation, ...]}`. Each operation has its own `mask`, `purpose`,
optional `cleanSwatches`, `blendWidthM` and optional `evidence` workspace path.
The latter permits fresh, color-faithful swatch views without invalidating a
separate anatomical bake whose camera/geometry evidence is unchanged. Source,
image and correspondence hashes are checked. Every donor must still land on
independently classified skin. Operations run in order and report separately;
use disjoint selections unless the overlap is explicitly intentional.

Baked illumination in a generated albedo can make a correctly lit surface dark
or plastic. Inspect the unlit runtime albedo and color-faithful evidence first.
A swatch-based correction is an art-directed reconstruction, not measured
reflectance recovery. Do not globally brighten skin or infer defects from RGB.
Review the selected region, donor color, transitions and the final relit result;
retain the original and the rejected candidates.
