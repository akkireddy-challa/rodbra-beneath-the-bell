"""Local Blender inspection/render helper. No edits to input files, no network."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def load_asset(path):
    if path.suffix.lower() == '.blend':
        # Never load startup UI/scripts from an asset file.
        bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False, use_scripts=False)
    elif path.suffix.lower() in ('.glb', '.gltf'):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))
    else:
        raise ValueError('Input must be .blend, .glb or .gltf')


def bounds(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            points.extend(evaluated.matrix_world @ v.co for v in mesh.vertices)
        finally:
            evaluated.to_mesh_clear()
    if not points:
        raise ValueError('No mesh vertices')
    if any(not math.isfinite(x) for p in points for x in p):
        raise ValueError('Nonfinite evaluated vertices')
    return [min(p[i] for p in points) for i in range(3)], [max(p[i] for p in points) for i in range(3)]


def inspect(meshes, armatures, limit):
    result = {'technical_only': True, 'coordinate_space': 'Blender world; Z up',
              'unit_scale': bpy.context.scene.unit_settings.scale_length,
              'bounds': bounds(meshes), 'meshes': [], 'armatures': [],
              'actions': [{'name': a.name, 'frames': list(a.frame_range),
                           'slots': [s.identifier for s in getattr(a, 'slots', [])]}
                          for a in bpy.data.actions]}
    for obj in meshes:
        mesh = obj.data
        mesh.calc_loop_triangles()
        rigs = [m.object for m in obj.modifiers if m.type == 'ARMATURE' and m.object]
        deform = {b.name for rig in rigs for b in rig.data.bones if b.use_deform}
        groups = {g.index for g in obj.vertex_groups if g.name in deform}
        unweighted = nonunit = excessive = invalid = 0
        for v in mesh.vertices:
            weights = [g.weight for g in v.groups if g.group in groups and g.weight > 0]
            unweighted += not weights
            nonunit += bool(weights) and abs(sum(weights) - 1) > 1e-4
            excessive += len(weights) > limit
            invalid += any(not math.isfinite(g.weight) or g.weight < 0 for g in v.groups)
        result['meshes'].append({'name': obj.name, 'vertices': len(mesh.vertices),
                                'triangles': len(mesh.loop_triangles),
                                'armatures': [r.name for r in rigs],
                                'unweighted_vertices': unweighted,
                                'nonunit_weight_vertices': nonunit,
                                'excess_influences_vertices': excessive,
                                'invalid_weight_vertices': invalid,
                                'materials': [m.name if m else None for m in mesh.materials],
                                'uv_layers': [u.name for u in mesh.uv_layers]})
    for rig in armatures:
        result['armatures'].append({'name': rig.name, 'matrix_world': [list(r) for r in rig.matrix_world],
            'bones': [{'name': b.name, 'parent': b.parent.name if b.parent else None,
                       'head_local': list(b.head_local), 'tail_local': list(b.tail_local),
                       'matrix_local': [list(r) for r in b.matrix_local], 'deform': b.use_deform}
                      for b in rig.data.bones]})
    return result


def select_action(args, armatures):
    if not args.action:
        return
    rigs = [a for a in armatures if not args.armature or a.name == args.armature]
    if len(rigs) != 1:
        raise ValueError('Action selection requires exactly one armature; use --armature')
    action = bpy.data.actions.get(args.action)
    if action is None:
        raise ValueError('Unknown action: ' + args.action)
    rig = rigs[0]
    animation = rig.animation_data_create()
    for track in animation.nla_tracks:
        track.mute = True
    animation.action = action
    slots = list(getattr(action, 'slots', []))
    if slots:
        choices = [s for s in slots if s.identifier == args.slot] if args.slot else slots
        if len(choices) != 1:
            raise ValueError('Action has ambiguous slots; use --slot from inspection output')
        animation.action_slot = choices[0]


def render(args, meshes, armatures, output):
    select_action(args, armatures)
    bpy.context.scene.frame_set(args.frame)
    # Remove source cameras/lights from rendering only; never save back to source.
    for obj in list(bpy.context.scene.objects):
        if obj.type in ('LIGHT', 'CAMERA'):
            bpy.data.objects.remove(obj, do_unlink=True)
    lo, hi = bounds(meshes)
    center = (Vector(lo) + Vector(hi)) * .5
    extent = max(hi[i] - lo[i] for i in range(3))
    if extent <= 0:
        raise ValueError('Degenerate bounds')
    front = Vector({'-Y': (0, -1, 0), '+Y': (0, 1, 0), '+X': (1, 0, 0), '-X': (-1, 0, 0)}[args.front])
    direction = {'front': front, 'back': -front, 'side': Vector((-front.y, front.x, 0)),
                 'three-quarter': (front + Vector((-front.y, front.x, .2))).normalized()}[args.view]
    camera_data = bpy.data.cameras.new('ReviewCamera')
    camera = bpy.data.objects.new('ReviewCamera', camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.location = center + direction * extent * 3
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = extent * 1.35
    camera_data.clip_start = max(extent / 10000, .00001)
    camera_data.clip_end = extent * 20
    scene = bpy.context.scene
    scene.camera = camera
    try:
        scene.render.engine = 'BLENDER_EEVEE_NEXT'  # Blender 4.x
    except TypeError:
        scene.render.engine = 'BLENDER_EEVEE'  # Blender 5.x (and 3.x)
    scene.render.resolution_x = scene.render.resolution_y = args.size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(output)
    scene.render.film_transparent = False
    world = bpy.data.worlds.new('ReviewWorld')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (.12, .12, .12, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = .5
    scene.world = world
    for i, offset in enumerate([front * 2 + Vector((0, 0, 3)), -front + Vector((2, 0, 1))]):
        light_data = bpy.data.lights.new('ReviewLight', 'AREA')
        light_data.energy = extent * extent * (180 if i == 0 else 90)
        light_data.shape = 'DISK'
        light_data.size = extent * 2
        light = bpy.data.objects.new('ReviewLight', light_data)
        scene.collection.objects.link(light)
        light.location = center + offset * extent
        light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.ops.render.render(write_still=True)
    return {'visual_review': 'pending', 'action': args.action, 'armature': args.armature,
            'frame': args.frame, 'view': args.view, 'front': args.front,
            'bounds': [lo, hi], 'image': str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['inspect', 'render'])
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--max-influences', type=int, default=4)
    parser.add_argument('--action')
    parser.add_argument('--armature')
    parser.add_argument('--slot')
    parser.add_argument('--frame', type=int, default=1)
    parser.add_argument('--front', choices=['-Y', '+Y', '-X', '+X'], default='-Y')
    parser.add_argument('--view', choices=['front', 'back', 'side', 'three-quarter'], default='front')
    parser.add_argument('--size', type=int, default=768)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    source, output = args.input.resolve(), args.output.resolve()
    sidecar = output.with_suffix(output.suffix + '.json')
    if source in (output, sidecar) or output.exists() or (args.command == 'render' and sidecar.exists()):
        raise ValueError('Use a fresh output path; input and existing results are never overwritten')
    if args.size < 64 or args.max_influences < 1:
        raise ValueError('Invalid render size or influence budget')
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    load_asset(source)
    armatures = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    custom_shapes = {bone.custom_shape for rig in armatures for bone in rig.pose.bones if bone.custom_shape}
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o not in custom_shapes]
    for shape in custom_shapes:
        shape.hide_render = True
    output.parent.mkdir(parents=True, exist_ok=True)
    result = inspect(meshes, armatures, args.max_influences) if args.command == 'inspect' else render(args, meshes, armatures, output)
    result.update(source=str(source), source_sha256=digest, blender=bpy.app.version_string)
    result['excluded_bone_display_shapes'] = sorted(o.name for o in custom_shapes)
    if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
        raise ValueError('Input changed during review')
    target = output if args.command == 'inspect' else sidecar
    with target.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps({'report': str(target), 'source_sha256': digest}))


if __name__ == '__main__':
    main()
