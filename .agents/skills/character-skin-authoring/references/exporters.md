# Installed character exporters

The skill now includes the tested offline skin, optical-eye and rig-assembly helpers.
Run `scripts/character_build.py` with an explicit `--workspace`; character assets live
outside the skill so refreshes do not erase them. Python needs NumPy, Pillow and SciPy.
Exact visibility recovery also needs Blender on PATH or `BITMAGIC_BLENDER`. These tools
perform deterministic assembly of the agent's reviewed inputs, never semantic recognition.

The retained workspace convention is:

```text
characters/ID/high/v1/
  source/hy31pro.glb                    immutable source (name is a convention)
  output/viewer-profile.json            {"height": physical height in metres}
  materials/body-detail-profile.json    optional designed regional creases
  materials/surface-patch-profile.json  optional licensed regional patches
  materials/repair-profile.json        optional separately reviewed source defects
  materials/v2/                        registered face inputs and intermediate maps
  materials/v4/                        mixed-surface GLB and report
  eyes/v1/                             independent fitted optical-eye revision
  output/character.glb                  optional existing bound body mesh
  rig-report.json                      optional validated rig provenance
  runtime/v1/                          combined surface/eye/body variants
highquality/materials/faces/ID.json      character-specific landmark registration
highquality/references/                 licensed immutable exemplar files
```

Evidence/masks/eye profiles can be anywhere supplied explicitly. Relative command paths
are workspace-relative. Keep their source/image hashes and projection receipts intact.
Paths inside authored JSON retain their documented conventions; relocating evidence may
require updating its source path without changing source bytes or camera contracts.

## Commands

Use [the profile schemas](profiles.md) for independently authored landmarks, exclusions,
scale and optical dimensions. After preparing the facial profile:

```sh
python scripts/character_build.py --workspace /path/to/assets --id CHARACTER --stage face
```

The current face adapter uses the Lee Perry-Smith reference: `LeePerrySmith.glb`,
`Infinite-Level_02_Disp_NoSmoothUV-4096.jpg` and `Map-COL.jpg` in
`highquality/references/lee-perry-smith/`. Obtain the licensed originals explicitly and
retain CC BY 3.0 attribution; the skill does not download them. The adapter writes its
modification notice and hashes. Its calibrated relief amplitude is an authoring estimate,
not measured capture scale. It does not transfer donor face geometry.

After reviewing the dense semantic bake:

```sh
python scripts/character_build.py --workspace /path/to/assets --id CHARACTER \
  --evidence evidence/CHARACTER --masks masks/CHARACTER
```

This preserves source geometry and writes mixed skin/hair/lip/nail materials plus the
registered detail binding. The adapter currently requires one source mesh primitive,
embedded textures, normals and non-overlapping anatomical UV ownership. It fails unsupported
layouts rather than flattening them automatically. Multiple-material adapters remain work.
`--check` validates required input presence without building; full geometry/hash contracts
are checked by the exporters themselves. Neither check is visual acceptance.

For eyes, first follow [the eye fitting workflow](eyes.md), then:

```sh
python scripts/character_build.py --workspace /path/to/assets --id CHARACTER \
  --stage eyes --eyes-profile profiles/CHARACTER-eyes.json
```

The current optical texture adapter uses `blue_eye.png` and `LICENSE.md` from the CC0
MakeHuman eye reference in `highquality/references/makehuman-eyes/`. Its source registration
is specific to that donor atlas. Character opening contours, dimensions and fitting remain
individually authored. Existing skinned cut edges/full facial rigs are not supported by
this prototype; preserve them and use a suitable topology adapter.

For a previously validated body binding:

```sh
python scripts/character_build.py --workspace /path/to/assets --id CHARACTER \
  --stage assemble --input eyes/v1/character.glb --variant eyes
```

The assembler consumes the existing bound mesh and `rig-report.json`, verifies the output
hash and negligible geometry displacement, then retains materials and eye layers while
adding the body skin. It does not invent bones, fit a skeleton or simulate cloth. The
playground's shared Blender rig fitting remains separate from this installed exporter.
Use the project's existing rigging workflow to produce compatible inputs.

A surfaces run can also take `--eyes-profile` and `--assemble` to execute the same stages
in order. Each stage stops on failure and leaves a review candidate, never `viewerReady`.
Review every changed region and both rendering backends before selecting a local preview.

## Detail-binding seams

Unused UV texels are not reliable vertex visibility samples at split seams. The exporter
uses exact source-geometry rays for those vertices, then samples the same reviewed image
annotations. It leaves occupied unknown/conflicted samples untouched and never changes
fragment coverage. Geometric caches include source, cameras, positions, normals and
algorithm version; annotation labels are re-read. Adjacent zero-weight triangle corners
still receive coherent patch coordinates so interpolation cannot sample another atlas
region. If an artifact persists, inspect coverage, geometry normals and source color
separately before changing skin strength.

Eye rest fitting retains `_BIND_SOURCE_POSITION` before moving source eyelid vertices.
The assembly exporter consumes this authoring attribute for weight correspondence and
removes it from the runtime attributes. Original vertices use their exact bound match;
clipped vertices use a verified rigid-head field or closest-triangle barycentric weights.
Points outside the bound surface tolerance fail rather than inheriting a nearby limb.
The rendered fitted positions and morphs retain their shape during this transfer.

Local preview selection now copies the exact reviewed GLB, render receipt, visual
verdict and inspected images into a content-addressed `.previews` snapshot beside
the candidate. An atomic `*.selected.json` pointer names that snapshot. Rebuilding
the candidate or its review images does not mutate the selected preview. A failed
review leaves the previous pointer intact. Engine consumers should resolve the
selected snapshot for ordinary preview and use explicit candidate paths for QA.
These snapshots remain local previews with recorded issues, not whole-character
acceptance or a publication step.

An explicitly authored `materials/geometry-repair-profile.json` can correct a local
source defect during the mixed surface build. Select the defect center and clean
support annulus from the exact evidence view; supply a bounded depth interval and
maximum displacement. The quadratic patch follows surrounding curvature and feathers
into unchanged geometry. Never infer that a painted marking should be removed:
record the user's intent and preserve the source. Optional clean skin color donors
and a painted dot replace the source's baked bump shading. Evidence UVs use Blender's
bottom-left convention; decoded texture rows use top-left. The exporter converts
this explicitly and pads only adjacent unused UV gutters.

The repair keeps topology, UVs and `_BIND_SOURCE_POSITION`; subsequent eye fitting
must preserve that attribute, and assembly uses it for the original rig weights.
Rebuild both eyes and runtime assemblies after a repair. Inspect front and oblique
views and both renderer backends before selecting the new snapshots. A displacement
receipt alone does not prove that old normal-map or pigment shading is gone.
