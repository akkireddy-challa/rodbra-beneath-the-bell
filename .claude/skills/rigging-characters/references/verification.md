# Verification and runtime handoff

## Technical checks

Verify finite vertices and transforms; valid indices; material/texture availability; a usable
armature modifier and deform weights; no unweighted skin vertices; normalized nonnegative
weights; engine influence budget; acyclic bone hierarchy; rest alignment and inverse binds.
The bundled inspection helper reports common Blender-side issues, not an exhaustive glTF
validator. Run a glTF validator when available, particularly after editing GLB bytes directly.
An invalid buffer length must not be ignored just because one viewer tolerates it.

Compare unchanged regions and data against the source. For weight-only work, compare positions,
UVs, triangles and materials; after topology changes, use bidirectional surface distance and
texture correspondence with a stated tolerance. Check every intended clip survives export and
that constraints have been baked when necessary. Never sum cached approvals for different file
hashes as evidence for the current candidate.

## Visual pass

Use a fresh import of the exported file. Render the same source/candidate poses under neutral
lighting with front, side and back views, fit the complete animated bounds, and inspect enlarged
problem areas. Select stages that expose the failure, not only flattering camera angles.
For ordinary locomotion, sample both strides and intermediate frames; 12 evenly spaced walk
phases and 12 run phases are a useful baseline, not a universal success threshold. Add idle,
punch, kick and jump when those clips are actually available/required. Missing clips must be
reported; procedural joint probes are diagnostics, not equivalent animation coverage.

`rig_tool.py render` can select an imported action and frame. Its actions are Blender import
names: inspect first. Multi-armature scenes require explicit armature selection for action
assignment. glTF import may also create NLA tracks; the helper disables these when selecting an
action so two clips do not blend accidentally. If layered-action slot assignment is ambiguous,
it stops; select the slot explicitly rather than rendering the wrong pose.

Load the final file in the target runtime if accessible. Test existing shared animations,
root motion, materials, static/dynamic alternatives, finger controls and hidden appendages.
Record the loaded hash/URL so a stale cached asset cannot pass the new repair. For KTX2 or other
texture conversion, compare decoded appearance and confirm the geometry, skin, clips and extras
remain intact. Texture compression is optional packaging, not a reason to rebuild a passing rig.

## Durable review record

Keep a small JSON or Markdown report alongside the deliverable: input/candidate SHA-256, Blender
version, units/front direction, diagnosed cause, changes, numeric results and tolerances,
reviewed image paths and clip phases, runtime checks, limitations, and verdict. Distinguish
technical_pass, visual_pending, needs_changes and accepted_with_limits. Explicit user rejection
overrides older approval. Do not replace the production asset until the intended scope passes.

Prefer a compact per-character profile and executable repair over a transcript of experiments.
This lets the next agent reproduce the result without loading the entire batch history.
