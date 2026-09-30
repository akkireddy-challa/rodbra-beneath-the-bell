# Reading Unity scenes and prefabs: the traps, by symptom

Unity's YAML is readable without Unity, but the *meaning* of a scene is spread across prefab
files, `.meta` files, `ProjectSettings/TagManager.asset` and per-instance override lists. Every
entry below was found by a wrong level during the port this skill comes from, in the order the
walkers now handle them.

## Symptom → cause → what the walker does

| Symptom in the port | Cause in the Unity data | Handling |
|---|---|---|
| Walls treated as decoration, or decoration treated as walls | Layer numbers guessed by majority; the repo held two project trees with different `TagManager` numbering | `build_parts.layer_index(name)` resolves `Terrain`, `Shadows`, … by NAME from the tree in `UTOPOS_UNITY_ROOT` |
| A prefab arrives with 6 of its 56 colliders, or a Towers prefab arrives empty | Nested prefab instances (class `1001`) show up in their parent's `m_Children` only as stripped stubs the transform walk cannot follow | Every expanded file is swept for its own `1001` records (`expand_file` / `RendererWalk.expand`); never guard on `(path, transformId)` — that blocked the 2nd..nth instance of the same prefab |
| 167 "walls" that seal a base shut | The same geometry exists twice: the visible copy and a low-poly stand-in on the SHADOWS layer (18), placed with the same transform; the stand-in's layer is a per-instance `m_Layer` override | `go_layer(docs, goid, mods)` honours the override; layer 18 is excluded from visuals and from physics |
| Tower blocks in front of every base exit; a ring of bars that seals the arena when completed | Every `Towers` and `Long Side Wall` instance is **root-inactive** in the scene (`m_IsActive: 0` on the prefab root), so Unity never shows them | `go_active(docs, goid, mods)` honours `m_IsActive` overrides; `prefab()` skips an instance whose root is off |
| A component behaves as if enabled when Unity has it off (or vice versa) | `m_Enabled` overrides target the component; when the component lives inside a *nested* prefab, the target id is `(nestedObjectFileID ^ nestedInstanceFileID) & 0x7FFFFFFFFFFFFFFF` in the outer file's namespace | `instance_mods()` re-keys outer overrides into the nested file's ids as it descends — verified on the Barrier: its override hit a 3D MeshCollider, leaving the 2D strip live |
| A whole wall "parked" at x = −161, or spawners at (50, 1171, 2004) | Scene-level instances sit under parent groups with their own transforms (`WallsLeft`, `Spawners`); the placement is local to the group | Compose the parent chain (`expand` walks `m_Father` up to the root, applying each group's TRS) — and then *believe* the composed position: `WallsLeft` really is parked off-map |
| Corners and the middle of every side empty while Unity shows them | 16 objects named `…_L2` placed by hand under plain groups (`TunnelTop`, `CornerTower*`); the Sci-Fi Base pack ships one FBX per LOD level | `_is_lod_child` only drops a LOD-named object when its parent carries an LODGroup (class 205) |
| A statue 141 units long, or the wrong statue | A multi-mesh FBX (`GatheredStatues.FBX`, 8 meshes); the MeshFilter's `fileID` (`43000xx`) maps to a mesh name through the FBX's `.meta` table | `mesh_index_for(fbx, fileId)` reads the `.meta`; the reader returns meshes in file order |
| The "corner element" that is not in the extracted data | The perimeter ring and corner towers are **plain scene GameObjects**, not prefab instances | Both walkers walk scene-native objects too; a census by prefab name alone never lists them — census renderers by mesh family as well |
| A sealed inner arena after adding the one bar that "should" be there | The scene as checked out really has only three bars; the fourth was never placed | Treat a level that only becomes coherent with a patch as evidence that the extraction, not the scene, is wrong — see the flood in `verification.md` |

## The census (run it before converting anything)

For the scene and every prefab it places, print:

- instances per prefab name, with world positions of the structural ones (bars, towers, crosses,
  bases), and anything beyond the arena limit;
- top-level groups and their transforms (a non-zero group transform moves everything under it);
- objects that are inactive (`m_IsActive: 0`) and instances that override `m_IsActive` /
  `m_Enabled` / `m_Layer`, with what the override targets;
- renderers by mesh family (the `_L2`, `Tunnel`, `Staircase`, `Floor` stems), with counts and
  extents — this is how the missing corners were found;
- the collider inventory of the key prefabs: kind (Box2D/Circle2D/Box3D/Mesh3D), layer, active,
  enabled, trigger.

Compare those counts with the built GLB (Blender can list objects by name and extents) and with
the creator's Unity screenshot. Counts that agree and a picture that does not means a transform
bug; counts that disagree means a walker bug. Both are cheaper to find at this stage than after the
physics is layered on top.

## Which tree, which scene

`ProjectSettings/EditorBuildSettings.asset` lists the scenes a tree builds; Unity Hub's
`projects-v1.json` lists the paths the creator actually opened. `Library/` is created when Unity
opens a project but is often deleted or ignored, so its absence proves nothing. When a pulled
commit changes nothing in the scene yet the creator's screenshot differs, the screenshot is of
another scene or tree — or of this scene with the overrides above honoured.
