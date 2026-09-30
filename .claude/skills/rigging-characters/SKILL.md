---
name: rigging-characters
description: Rig an unrigged character or diagnose and repair a deforming character in local Blender, including skeletal fit, skin weights, hands and optional appendages. Use for GLB character animation problems, not level construction or paid mesh generation.
---

# Rigging and repairing characters

Produce a reusable animated character whose exported file survives real motion. This is an
agent-guided workflow, not a universal automatic rigger. It requires local Blender and an agent
that can inspect rendered images. It uses no paid service, private asset catalog or hosted tool.
With no visual inspection capability, produce a technical diagnostic and leave visual QA pending.

## Start with a small, explicit workspace

Read the project's AGENTS.md and identify the input GLB or blend file, desired animation clips,
runtime skeleton constraints and output location. Infer these from the project before asking.
Copy the source to a per-character work directory; never overwrite the only original. Record its
SHA-256. Keep the repair profile, scripts, candidate, review images and verdict together there.
Do not put per-character work inside this shipped skill: GDK upgrade refreshes its files.

Find Blender with `blender --version`, BLENDER_BIN, or the installed application executable
(macOS commonly `/Applications/Blender.app/Contents/MacOS/Blender`; Windows installations commonly
live under Program Files/Blender Foundation). Quote paths. The helpers run in Blender's Python;
they need no pip packages. Check operator availability in the installed version instead of
assuming all exporters have identical flags. Do not install or switch an engine as a side effect.

Run the bundled helper using its actual location in this skill:

```sh
blender --background --factory-startup --python-exit-code 1 --python /path/to/rigging-characters/scripts/rig_tool.py -- inspect --input /path/to/source.glb --output /path/to/work/inspect.json
```

The inspection reports Blender-space bounds, rest bones, actions, materials and skin-weight
problems. Its `technical_only` result is not a visual approval. Render a baseline with the same
helper's `render` command; use `--help` for view, frame and named-action options. Inspect front,
side and back views with both mesh and skeleton visible in Blender when diagnosing placement.
The helper's default front is Blender -Y; verify the imported character actually faces it.

## Pick the smallest repair that addresses the observed defect

- **No usable rig:** read [new rigs and animation compatibility](references/new-rig.md).
- **Existing rig, bad motion:** read [diagnosis and targeted repairs](references/repairs.md).
- **Hands, eyes, tails or wings:** use the relevant section of
  [secondary articulation](references/articulation.md), only if the task needs it.

Separate source-anatomy errors from skeleton placement, rest-pose mismatch, weight leakage and
animation/retargeting errors. A good T-pose alone proves none of these. Do not regenerate an
expensive mesh to solve a joint or skinning defect. Do not replace a custom skeleton with a
standard one merely to make a tool accept it. Preserve the game's bone-name and clip contract.

Change one causal variable at a time. Keep bind data and mesh rest pose consistent when changing
bones. For weight-only repairs, preserve positions, topology, UVs, materials and animations;
normalize after editing, and measure displacement of regions that should stay still.

## Review the exported result, then deliver

Read [verification and runtime handoff](references/verification.md). Reimport the candidate GLB
into a fresh Blender process and inspect it under the requested clips. Test both left and right
strides, intermediate phases, idle, and an extreme required motion such as punching or kicking.
Inspect hands close up during open/fist/grip, not only in a full-body render. Check the actual
runtime as well when available: bind matrices, coordinate conversion and clip application can
differ from the authoring scene. Keep numerical and visual verdicts distinct.

Record accepted limitations explicitly. A failed repair remains a candidate; do not relabel a
passing body stage as a fully approved character while eyes or fingers still fail. If meaningful
iterations stop improving the result, explain the remaining defect and recommend reconstruction
or rejection according to the user's tolerance. Do not silently remove defining anatomy.

Report the source and final hashes, skeleton/animation compatibility, changed regions, verified
motions and remaining limitations. Deliver the candidate GLB and reproducible repair files.
Publishing or replacing a catalog entry is a separate action governed by the user's instructions.

## Keep work bounded and context small

Load only the relevant reference. Execute inspection/rendering/validation in scripts and read
compact reports; do not repeatedly paste whole meshes, logs or full project histories. Save the
current finding and next experiment per character so another agent can resume without the chat.
Reuse unchanged hash-bound evidence; rerun affected checks and the final integration check after
a change. Parallel workers need separate outputs and exclusive ownership of each character.
Separate headless Blender processes can coexist; bound them by available memory and CPU.
