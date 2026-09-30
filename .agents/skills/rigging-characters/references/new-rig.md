# New rigs and animation compatibility

## Establish coordinates and anatomy first

glTF uses Y-up; Blender imports into Z-up. Measure in one named space and transform explicitly.
Report units and the asset's front direction. Do not infer hips from half of the total bounding
height: hats, antennae, capes and tails distort it. Locate pelvis, leg sockets, knees, ankles,
shoulder sockets, elbows and wrists from front AND side images. Put joints inside the limb volume.
Use asymmetric coordinates if the source is asymmetric; do not mirror a bad fit blindly.

Choose an existing compatible project rig/animation as the reference when available. There is
no skeleton bundled here and no assumed private Mixamo file. Without a reference, construct a
simple anatomical rig using Blender edit bones: root/hips, spine/chest, neck/head, bilateral
upper/lower arms/hands and upper/lower legs/feet. Add toes or fingers only when needed. Record
each bone's parent, head, tail and roll in a JSON profile, in armature-local Blender coordinates.
Create bones with `armature.edit_bones.new`, assign head/tail, then parents in a second pass.
Use connected bones only where heads really coincide with parent tails.

For a fresh rig, identity object transforms in a common coordinate space simplify binding. If
transforms are applied, apply them before binding and verify the visible shape is unchanged.
Never blindly apply transforms to an already animated skeleton or copy its rest matrices into a
different coordinate space. Preserve the input and build a new candidate.

Automatic weights (`bpy.ops.object.parent_set(type='ARMATURE_AUTO')`, mesh selected and armature
active in Object mode) are a starting point. They can fail or leak across touching garments,
fingers and appendages. Check the armature modifier, actual deform groups, unweighted vertices,
weight sums and influence count. Diagnose failures rather than exporting an unbound mesh.
Split semantic accessories before weighting when their topology confuses the body solution.

## Shared clips with per-character skeletons

Custom bone lengths and joint positions can share animation semantics, but identical names are
not sufficient. Retarget rotations relative to each source and target rest orientation, mapping
parents in hierarchy order. Keep target rest translations for limb lengths. Treat root motion
and scale separately; scaling all local bone translations is not a safe retargeting method.
Validate mapping, missing bones, handedness and rotation order with one diagnostic pose before
baking a clip. If using world-space rotation deltas, solve each target local rotation from the
already evaluated target parent; do not apply the source world rotation as a local quaternion.

Do not copy raw quaternion channels between different rest rolls. Bake an evaluated compatible
action when the target engine cannot reproduce constraints or retargeting. The GLB must carry
the correct inverse bind matrices for the final rest skeleton. Reimport it and check the same
poses; Blender constraints and drivers are not an engine contract.

## Rest-pose correction

Wide stance often needs narrower hip-to-ankle placement and rebinding, or a mesh rest correction
baked with an Armature modifier followed by a new matching rest skeleton. Keep the original
surface intact as far as possible and inspect the crotch and knees after the change. Moving
only pose bones does not fix the underlying bind pose. Likewise, an A-pose mesh cannot be bound
as if it were a T-pose without reconciling the two.
