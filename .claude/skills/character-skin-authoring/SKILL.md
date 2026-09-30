---
name: character-skin-authoring
description: Use vision to author and review exposed-skin maps on textured 3D characters, including faces, hands and bodies. Prepare exact model views, annotate visible anatomy, project evidence into UV space, and review skin detail placement. Eye construction is a separate workflow.
---

# Vision-led character skin authoring

The local agent makes anatomical/material decisions from images. Do not replace those decisions with RGB thresholds, world-height cutoffs, race/name rules, or another automated classifier. Deterministic tools handle projection and bookkeeping. The creator's existing agent subscription supplies vision; this workflow requires no hosted segmentation service.

## Establish evidence

Locate the model, its physical height, materials, texture resolution and rig. Keep the original immutable and write a separate material revision. Inspect the original generated image when available, but make the **actual mesh and its textures** authoritative: the generated mesh may differ from that image.

Use the local `scripts/skin_views.py` helper to create unlit, occlusion-correct views with their UV correspondences. Read [the projection contract](references/projection.md) for commands and formats. It requires local Blender and a Python environment with NumPy/Pillow. The helper performs no semantic recognition. Verify orientation from the resulting images; its axes are not anatomical labels.

Start with a full-body survey from opposite directions. Then frame each exposed region closely enough to see its boundaries. Inspect the face from front and both sides; inspect both hands from palm and dorsal sides and oblique angles showing finger webs. Inspect ears, neck, chest, arms, legs, feet or any other exposed region actually present. Add cameras when existing views cannot show a surface. Do not infer a hidden palm from a dorsal hand image or project a front silhouette through to the back.

## Author the maps using vision

For each viewed surface, annotate pixel polygons as `skin`, `dorsal_hand`, `palm`, `sole`, `lips`, `eyes`, `hair`, `nails`, or `non_skin`. `unknown` is explicit unresolved evidence. Use separate polygons for exclusions, ordered after enclosing polygons. Do not give an indistinct nail facial pores merely because the rest of the hand is clear. Record why a boundary is ambiguous; obtain a closer/different view before resolving it. Scars, freckles, tattoos and makeup usually remain skin with appearance annotations, not separate non-skin regions. Tight cloth is still cloth; green skin is still skin. If garment colour spills onto anatomically visible skin in the source albedo, record a texture defect separately from the semantic mask. A correct skin label cannot repair that colour.

Review the colored annotation overlay on the **same source image**, then review the **baked atlas reprojected onto every prepared view**, including unannotated side views. Use the dense visibility bake at a resolution appropriate to the source atlas; sparse splatting is a diagnostic, not a finished mask. Include the filename, image dimensions and source hash with every annotation set. If a tool displays a resized image, convert coordinates back to the recorded dimensions. Never claim to have visually reviewed an image you have not opened.

The helper deliberately leaves unobserved UV texels unknown and reports contradictory labels. Do not grow a skin mask across unknown areas to make a coverage statistic look good. Get additional views, increase sampling resolution, or use a reviewed Blender texture-paint correction. Mirrored/overlapping UVs can make conflicting anatomical labels impossible in one atlas: document that and create separate material/UV regions rather than average the labels.

## Apply region-appropriate detail

For material application and engine integration, read [material application](references/materials.md). The [installed exporters](references/exporters.md) assemble reviewed inputs in an explicit external workspace. After coverage passes review, register landmarks and surface scale for each detail patch. Use licensed exemplars and retain attribution and modification provenance. The b3662 face pilot in this repository demonstrates registered scan detail; its coordinates are **not** a universal face template.

- Face: region-specific pores, fine relief, oiliness and pigment. Exclude eye surfaces, lashes, brows, lips and facial hair from the ordinary pore layer; preserve actual folds and identity.
- Dorsal hands/fingers: knuckle folds, tendons and finer hand texture. Nails receive their own response.
- Palms/soles: glabrous skin with appropriate creases/ridges and roughness; do not stamp facial follicles onto it.
- Neck, torso, limbs, ears: use suitable regional detail and scale. Preserve the character's natural variation; do not transplant a donor's beard, identity marks or complexion.

Blend patch boundaries in surface space and check physical scale. A silhouette or clothing boundary needs a coverage edge; two adjacent skin patches need a continuous transition. Keep skin nonmetallic and preserve clothing/armor materials. Use the existing registered detail/SSS renderer where available; do not invent new renderer hooks or claim the projection helper installs materials by itself.

## Review and handoff

Inspect colored material regions and final shaded results separately. Use fixed cameras under diffuse, specular, side, studio and back lighting. Check full-body, face-sized and close detail views, plus a representative pose when the model is rigged. Confirm both hands, finger webs, nails, ears and every other exposed area; inspect clothing edges without revisiting unrelated deferred edits.

Record results per character and region: `reviewed`, `needs_view`, `conflict`, or `needs_detail_asset`. Archive source hashes, views, annotations, projected labels, atlas registration, licenses and review images together. Only call a character complete when its exposed regions are reviewed and the **applied** maps have been inspected. A parseable annotation file or a successful bake is not semantic validation.

Review the face and ocular exclusion before eye geometry/shading work; use the separate [optical-eye workflow](references/eyes.md) when that work is requested. Eye progress does not mark unresolved body skin as complete. This workflow is maintained in the GDK CLI assets and installed into supported agent skill directories from the same source. Keep per-character evidence and candidates outside those refreshed directories.
