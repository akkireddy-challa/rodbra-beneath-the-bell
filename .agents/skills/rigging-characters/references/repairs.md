# Diagnose before editing

Use the same camera, clip and phases before/after. First inspect the skeleton overlay; then
isolate bone rotations and paint weights to distinguish bad pivots from influence leakage.

| Symptom | Check | Typical bounded repair |
|---|---|---|
| Feet stay wide during walk | Rest ankle spacing, hip socket positions, imported clip rest convention | Narrow/rest-correct and rebind, or retarget to the real target stance; inspect crotch/knee folds |
| Palms face forward at idle | Forearm roll, wrist axes, mesh palm normal, source animation convention | Distribute twist along forearm and hand while preserving their alignment; derive sign/angle from geometry |
| Waist bends as part of thigh | Upper-leg heads too high, pelvis placement, abdomen thigh weights | Lower anatomical leg sockets and move pelvis/garment weights out of the thighs |
| Arms disappear into torso | Shoulder span, elbow positions, chest/back accessories affecting fit | Fit actual arm sockets; separate cape/feathers from anatomy when calculating weights |
| Upper back swings sideways | Opposite-arm weights on chest/back, shoulder hierarchy, cape influence | Remove cross-arm influence from the affected region; retain appropriate spine/shoulder motion |
| Long triangular fans | Sparse topology spanning different moving regions, fused anatomy, sharp weight seam | Smooth a bounded weight transition or separate semantic geometry; do not mask a topological bridge with more weights |
| Bent wrist while presenting fist | Shoulder/elbow path versus hand orientation | Move the upper arm outward for clearance, rotate forearm around its long axis, keep wrist aligned; overlap transitions |

These are diagnoses to test, not fixed prescriptions. A 90-degree palm correction that worked
on one mesh can break another with different bone roll. A shoulder pose that clears a jacket
in one animation is not a structural repair for incorrect jacket weights in every animation.

## Weight edits

Select regions using anatomy plus geometry/material evidence. World-space boxes alone can
accidentally include a touching hand or back accessory. Inspect front/side/back masks. Work on
the actual deforming mesh, not a duplicate displayed only in one scene. Keep unmapped vertices
explicitly flagged. Normalize weights after each change; limit influences to the target engine's
budget (commonly four), without discarding a necessary influence merely to pass a check.

Weight-only edits should leave vertex positions, faces, UVs and material assignments unchanged.
Use spatial correspondence with documented tolerance when export duplicates seam vertices;
vertex indices need not survive GLB re-export. Compare bone influence by name, not numeric joint
index, because exporters can reorder the joint array. Measure the maximum drift, not only means.

If moving a joint in Edit mode, reconcile the rest pose and bind matrices. Existing animation
channels may need retargeting/rebaking. First prove bind-pose equivalence, then verify the clips.
Keep an independent numeric test of regions outside the edit mask. Do not repeatedly widen the
mask until a local symptom disappears at the expense of the rest of the body.

## Choosing when to stop

Retain failed trials and write why each failed. Set a small initial experiment budget, expand it
only when the latest trial demonstrates progress. Fused cape/abdomen-to-thigh bridges, missing
fingers and self-overlapping eye surfaces may require reconstruction beyond a skinning repair.
Explain that distinction. Minor creases may meet the user's tolerance; collapsed anatomy does
not become acceptable because technical checks pass.
