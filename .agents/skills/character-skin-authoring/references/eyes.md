# Optical eyes after reviewed ocular exclusions

This is an independent, opt-in asset revision. A working eye pilot does not certify the
skin maps or body rig. Preserve the source, material revision and existing animation.
The current adapter supports a single, unskinned source mesh and two eyes; it refuses
existing facial morphs and skinned cut edges. Do not silently flatten a rig to bypass it.

## Availability

The [installed exporter runner](exporters.md) now includes the optical-eye builder and
its dependencies. Supply an explicit workspace and independently authored fit; exemplar
textures remain external licensed inputs. The playground browser review harness is still
separate. Confirm the installed engine supports the optical-eye contract before adoption.

## Vision fit

Prepare exact close front and both oblique source views with `skin_views.py prepare`.
Use enough pixels to distinguish the iris, visible eye opening, inner corner and lids.
Record each iris center/radius, an ordered convex opening contour and the lower contour
indices on the original image. Record anatomical left/right explicitly; image orientation
is not a side label. Do not reuse another character's target pixels or eye centers.

Write a profile following `highquality/materials/eyes/b3843.json`. Source and evidence
hashes are mandatory. Globe radius, corneal bulge, pupil ratio, pigment and depth offset
are authored estimates in metres. Verify those estimates against side views and physical
character height. An opening wider than the globe requires corner tissue; moving the
eyeball forward until it fills the hole is not a valid substitute.

Run `python highquality/src/eye_assets.py --profile PROFILE`. The builder ray-fits each
eye against source geometry and writes `characters/ID/high/v1/eyes/v1/`. It clips openings
at the reviewed contour with barycentric attribute interpolation. It creates separate
sclera, recessed iris, pupil, cornea, orbital mucosa, lid contact and tear meniscus surfaces.
It adds actual eyelid position/normal morphs and gaze/blink clips. Inspect the closed lids:
the builder's deformation is a starting fit, not an anatomically validated universal rig.

## Shared rendering and control contract

- Eye nodes have `extras.characterEye=true` and `forwardAxis=+Z`; local +Y is up.
- `CharacterEyeController` applies local yaw/pitch relative to the authored rest fit and
  drives `eyeBlinkLeft`/`eyeBlinkRight`. It never scales the eyeballs or changes body bones.
  Give these channels one owner: either this controller or an AnimationMixer clip.
- Corneal transmission/IOR use standard glTF physical-material extensions on both backends.
  Source ocular textures are not a replacement for a clear cornea and recessed iris.
- The MakeHuman eye source is CC0; retain its license, immutable source hash and adaptation
  record. The current texture uses reviewed planar atlas registration and authored pigment.
  It is not a captured iris of the generated character and has finite source resolution.

## Review gate

Use the viewer's **Optical eyes · fit preview** option; toggling must preserve the camera.
Inspect front, both three-quarter views and profile; then gaze in both directions, half
blink, independent winks and full closure. Play the exported clip as well as testing sliders.
Check upper-lid contact, inner/outer corners, tear edge, iris parallax, refraction, texture
orientation, eyeball penetration and closed-lid normals. Check WebGL and WebGPU.

`highquality/tests/eye_fit_smoke.mjs` exercises the local viewer and writes screenshots.
Read those images: zero renderer errors does not establish good optical fit. Keep
`optical_fit_review_required` until visual checks pass. Next production work includes
regional scleral scattering, richer iris relief, fitting across characters, refined lid shape and composition with a complete facial/body rig. Do not call this MetaHuman
parity based on the presence of corneal transmission alone.

## Separate source defects from optical defects

If a closed eyelid shows bright fragments, hide all generated optical layers temporarily.
If the fragments remain, inspect the original unlit face and material-region evidence.
Do not keep moving the eyeball to compensate for source albedo, normals or incorrect lid
labels. A bright painted streak and a geometric hole require different corrections.

A narrowly authored source-albedo defect can use a separate UV selection and
`texture_repair.py`: harmonic interpolation in linear light changes only selected texels,
with outside pixels byte-identical. Keep that selection separate from anatomical labels,
archive its projection evidence and inspect the repair. It does not reconstruct eyelid
geometry, lashes or missing detail. The djinn trial still requires eyelid surface work.
Eye profiles explicitly choose `skinRevision` so a later skin build cannot silently change
an already-reviewed eye fit. The current adapter accepts v2/v3/v4 and keeps output hashes.


Orbital backing must remain behind the recessed iris and pupil at every blink and gaze angle. Do not reuse the corneal-envelope eyelid deformation for backing tissue: even a small inset can still place it ahead of the iris. Validate partial blinks and isolate optical layers when diagnosing occlusion. Current prototype keeps its dense backing head-fixed. Continue its recessed depth envelope beyond the globe at the canthi too; retaining source-surface depth outside the globe can leave a visible triangle ahead of the closing lid.


Before generating blink targets, inspect the neutral lid/globe intersection. The playground
can opt into `conformOpenLids` to push intersecting tissue outside the explicitly fitted
globe. This is geometry fitting around authored landmarks, not automatic anatomical
recognition. Do not pull the surrounding orbital skin inward merely to follow a sphere;
keep a smooth support band and stationary canthi. Inspect partial and full closure anew.


The playground now exports gaze-follow lid targets as well as blink targets. The engine
uses `eyeLidLookUpLeft/Right` and `eyeLidLookDownLeft/Right` at ±0.35 radians pitch;
full closure suppresses gaze follow independently for each eye. Inspect both directions,
partial blinks and winks. A controller test validates channel ownership, not the surface fit.


## Reconstructed lid bands (experimental playground option)

When the source eye margin is damaged, explicitly author a paired `outerLidPx` contour
around the existing `openingPx`. The outer contour must contain the aperture. The builder
ray-samples the original boundary and reconstructs only the intervening strip, preserving
its outer position/normal and following the fitted optical envelope at its inner edge.
This is designed topology and needs neutral, oblique, partial and full-blink inspection.
It does not recover missing anatomy automatically.

Source albedo can contain painted eye shadows or highlights. Stretching those into a
closed lid is a source-color defect. Optional `lidSkinSamplesPx` records at least three
explicitly reviewed clean skin donors in the same exact evidence view. Their linear colors
supply invented inner-lid pigment, blended to the sampled outer edge. Inspect the join;
never label this as scan-derived detail. The djinn trial still has outer-transition and
corner limitations. Keep this feature opt-in until its fit is acceptable.

For geometry diagnostics, hide cornea, sclera, iris, pupil, contact, tear and lashes, but
retain reconstructed `eyelid-skin`. Hiding that skin too produces an intentional hole and
invalidates the closure diagnostic. Inspect unlit albedo separately from geometry normals.
The playground regression now renders front, both obliques, profile, both yaw directions, and an oblique full blink. Eye review receipts must identify the exact selected output hash, including assembled
variants; a previous screenshot cannot validate an output rebuilt afterward.

## Authored brow strands (playground option)

A painted brow can retain its color but still lack visible strand depth. The optional
`browGroom` on each fitted eye accepts an independently reviewed `polygonPx`, at least
two `combGuidesPx` start/end pairs in that same exact view, `strandCount`, `seed`,
`radiusM`, `lengthRangeM` and `colorLinear`. The local `brow_groom.py` ray-projects roots
onto the nearest visible source surface and projects the authored comb directions into
its tangent plane. It constructs tapered short fibers; it performs no hair recognition.
Do not classify a dark supraorbital shadow as a brow without inspecting the source.

Record these as designed hairs, inspect both sides and profile, and preserve the underlying
source. The strands attach to the head; they do not yet follow expressive brow morphs.
Fine strands can alias without temporal antialiasing or a filtered hair LOD. This prototype
is not a replacement for a production groom/simulation system. The b5359 trial uses a
separate medial-corner tissue surface too; review its fit during closure independently.
A reconstructed lid-band trial on b5359 was rejected because its pale angular transition
looked worse. Do not assume that enabling every optional reconstruction improves a fit.

## Corner lining

A deep backing disk can leave a dark gap between the globe and the medial lid opening.
The optional `canthusWalls` profile lists explicit upper/corner/lower `contourIndices`
and a designed `colorLinear`. The narrow lining joins those reviewed source-lid points
to a recessed globe rim. Only the lid edge follows blink/gaze targets; the globe edge stays
fixed, outside the iris envelope over the reviewed ±0.35 radian gaze range. Do not apply
the corneal closure deformation to the whole socket. Inspect partial closure and both
obliques after fitting; source corners and dimensions differ between characters.
This is designed lining, not transferred scan anatomy. The CC0 MakeHuman topology was
visually inspected as an anatomical reference; no donor mesh is embedded by this option.
When a reconstructed lid band replaces the source margin, set its lining's
`contactMethod: "reconstructed-lid-v1"` to use the same aperture depth calculation.
Otherwise the lining can follow a removed source surface and protrude below the new
lid. This joins the support consistently; it does not supply a realistic caruncle or
make an oversized authored corner anatomical. Inspect those separately.

If a source has no separately classified ocular material, inspect the exact eye views
and explicitly set `openingAuthority: "reviewed-contours"`. The adapter then uses the
authored contours to remove the source surface. It still verifies source/image hashes
and rejects a cut that removes no interior triangles. Never infer the opening from
skin color or copy another character's contour; narrow hooded lids need their own fit.

Eyelid normal targets transport the imported shading normals with the shortest rotation
between the rest and deformed geometric normals. This preserves the imported normal's
angle to the surface while the lid moves. The neutral mesh retains its authored normals;
unused vertices keep their original normals. Inspect both the neutral and fully closed
pose after changing a fit, since valid normals cannot correct a poor anatomical shape.

Review each eye at eye-sized framing as well as face-sized framing. Inspect a neutral
eye and an oblique fully closed eye separately. A smooth globe can hide a polygonal
opening at face scale; a successful blink protocol does not establish anatomical quality.
In the playground, `CLOSE_EYES=1` adds these views and `REVIEW_SUFFIX` keeps experiments
separate. Use `SELECTED_EYES=1` to compare with the reviewed snapshot, rather than the
latest candidate. Explicitly unset `BACKEND` for a complete two-backend review.

An optional `contourRefinement` with `method: "convex-quadratic-v1"` and
`samplesPerLandmark: 8` rounds the segments between reviewed landmarks, staying inside
the original convex opening and preserving the two shared upper/lower eye corners.
For a reconstructed band, set `outerBoundary: "preserve-authored"` to retain every
segment of the reviewed outer source cut. Rounding that cut inward can leave pieces of
the damaged original eye margin behind. Paired outer points are then subdivided without
changing the cut; only the visible inner aperture is rounded. The older `rounded` outer
mode remains available for reproducibility, and requires its own review.
Indexed tissue chains are refined together. The fitted output
records the original points and maximum inset; it is safe to rebuild without applying
the refinement twice. This is a geometric interpolation of the agent's landmarks, not
an inferred anatomical contour. Inspect the result before selecting it: rounding alone
does not fix tissue depth, color, contact or deformation.

`outerEdgeSampling: "source-intersections-v1"` on an eye adds the original triangle-edge
crossings to the paired lid-band sampling. Its outer rim then follows the piecewise
source surface rather than bridging over small source ridges between uniform samples.
It preserves the authored cut and adds no anatomical selection. Keep checking the
closed pose: normal continuity and an actual eyelid fold need their own review.

If a designed `caruncle` is hidden behind an authored lining, its optional
`support: "corner-lining-v1"` positions it on the corresponding lining depth. It must
reference a corner in exactly one `canthusWalls` chain. The helper rejects centers
outside that lining's supported interval and rejects a tissue footprint that intersects
the iris envelope over the reviewed gaze range. Medial tissue may overlap peripheral
sclera; forcing it behind the entire sphere would hide it again and distort its shape.
The dimensions, placement and color remain explicit authored choices. This construction
is a prototype anatomical insert, not a scanned tear duct or a proof of eye realism.

For a reconstructed band that produces radial fan creases, `fairLidDepth: true`
uses harmonic depth fairing across the whole projected strip mesh. Both authored
rims remain fixed; projected columns interpolate the paired contours directly,
preventing independent Hermite tangents from bunching them at the canthi. The
result is refitted outside the optical envelope before computing normals and
blink targets. This is geometry repair, not a wrinkle texture filter. It does not
resolve an incorrect boundary shape or source pigment automatically. Inspect both
corners, neutral and full closure, obliques and gaze before selecting the asset.

A front silhouette alone cannot establish corner depth. `cornerDepths` optionally
records explicitly reviewed `pixel`, `depthM` (relative to the globe center, positive
forward), and `radiusM` for a corner. Local source support fades toward that depth;
the reconstructed lid and lining share a smooth tangent continuation from 85% of
the globe radius toward the corner. The curve stays outside the globe. Its angular
influence has a full-strength central half-width and smooth outer falloff. Inspect
both close lateral views (`SIDE_EYES=1`) and closure. Never assign these corrections
across characters without independently reviewing their actual depth and silhouette.
