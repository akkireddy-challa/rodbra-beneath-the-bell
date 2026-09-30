# Authored character skin and optical eyes

This is an opt-in path; untagged materials and existing character types are unchanged.
Select the active renderer and load GLTF with `createGltfLoader()`.
`RealisticCharacter.create(root, options)` resolves embedded atlas indices, validates geometry
attributes, adapts each source material once, and exposes `eyes`. It commits replacements
only after dependencies succeed. Disposal restores source materials, resets eye controls
and releases adapted materials. Loader textures/geometry, body mixer, scene and passes are
caller-owned. `detailTextures` identifies extra embedded textures for asset disposal.

Required options: `resolveTexture`, `environment`, `environmentIntensity`, `detailEnabled`,
`transmission` (pass or undefined), and `appearance` (SkinAppearanceState). GLTFLoader's
resolver is `index => gltf.parser.getDependency('texture', index)`. Create before swapping a
visible model; dispose stale async results after a newer load. The adapter does not change
model scale or install postprocessing globally into GameEngine.

## Asset contract

The local vision agent authors anatomy from exact model views; runtime uses no skin-color,
height or anatomical classifier. The canonical projection skill is staged in
`cli/assets/character-skin-authoring` and installed by the GDK scaffolder; the character-forger
playground references that same source. Publication and full-character visual acceptance
remain separate from these local files. Unknown regions remain native rather than being silently inferred.

Materials opt in with `extras.characterSurface` (`skin`, `hair`, `fur`). Mixed surfaces also
set `skinSurfaceBlend:true`. `skinAtlasTexture` and `skinExpressionTexture` refer to embedded
GLTF texture indices. `_FACE_UV`/`_FACE_WEIGHT` become lowercase geometry attributes in Three.
Atlas R is signed relief around .5, G roughness, B pigment residual, A skin coverage;
`skinAtlasHeightRangeM` supplies metre scale. Expression RGB is signed regional relief, A a
pigment modulation mask. These are authored maps, not measured dynamic tissue properties.
Albedo is sRGB; atlas, normal, ORM and flow textures are linear data.

Optional `skinFacialAtlasTexture` keeps registered face detail independent of full-body
texel density. Its required layout tag is `skinFacialAtlasLayout: "detail-expression-halves-v1"`:
detail occupies the left half and expression the right half, using the same physical
height range. `_FACIAL_DETAIL` packs authored UV registration in XY and verified projection
visibility in Z, retaining the WebGPU vertex-buffer budget on skinned meshes. Coverage still comes exclusively from the body atlas. This layout
requires neutral body expression and replaces that sampler, staying within WebGL's budget.
Old single-atlas assets remain supported. Check physical texel spacing and fixed-camera
results before changing detail amplitude or claiming additional captured detail.

`detailEnabled:false` disables relief while retaining coverage and loader-owned metadata.
The v4 packager normalizes known skin/hair/lip/nail weights jointly and pads unused UV
gutters separately from anatomy. Hair has provisional tangent flow, not strands or grooms.

## Rendering and ownership

CharacterSurfaceMaterials supports WebGPU TSL and guarded WebGL shader replacements. Skin
uses two GGX reflection lobes and an environment correction. SkinAtlasDetail adds registered
relief through surface gradients and coordinates roughness/pigment. Zero coverage preserves
native normal, metal, specular and roughness response. The anisotropy frame is orthogonal
to the perturbed normal; a zero-flow texture must not change the material. WebGL retains
the PHYSICAL define after standard-material copy. Guards reject incompatible shader chunks.

SkinDiffusionPass extracts HDR beauty, diffuse and albedo, applies a 25-tap separable RGB
profile, and composites beauty + strength*(scatteredDiffuse - diffuse). Pigmentation is
factored out before filtering and restored afterward; specular stays sharp. The kernel
adapts the licensed 2012 Separable SSS demo, with its notice in SkinDiffusionKernel.ts.
Default support radius is 3 mm, strength .75. Coverage and depth reject cross-surface samples.
World units must be metres. This review pass currently uses one profile per instance,
not a per-material profile buffer for a mixed-character scene. Fantasy falloff ratios are artistic, not measured blue/green skin.

SkinTransmissionPass supplies directional key-light entry depth. Other geometry occludes
but does not transmit as skin. Render it before beauty/diffusion. Release cached pass
materials before replacing assets; dispose passes with the view. These passes rerender
geometry. Production should share MRT attachments and address screen-space visibility and
temporal limitations. This is not a volumetric tissue solver.

## Eyes and body animation

Optical assets declare `characterEye:true`, `forwardAxis:'+Z'`, local +Y up. The eye controller
rotates those nodes and drives `eyeBlinkLeft/Right`. Use either controller or mixer tracks
for those same channels, while body animation continues independently. It neither scales
eyeballs nor infers lids. Head-fixed orbital backing stays behind recessed optics; contact
and tear surfaces may have authored lid morphs. Inspect partial blinks and oblique gaze.
Current prototypes include authored lashes and gaze-following lids, but still have
generated-lid defects and finite-resolution CC0 MakeHuman detail rather than captured
character irises. Lash roots follow lid motion; this is not a strand simulation system. Optional short
brow strands are head-attached and use independently authored comb guides. A canthus
lining may move only its lid edge while keeping its globe edge behind the swept iris;
these designed tissues still require per-character angle and blink review.

The offline assembler reuses the shared Blender body binder, converts surfaces rigidly to
canonical bind coordinates, keeps canonical inverse bind matrices and attaches eyes to the
head. Test Skeleton.pose() plus real clips; rest-position agreement alone is insufficient.
The soldier has 22 body bones without independent fingers.

## Validation and limits

Tests cover atomic adoption/failure cleanup, native-material preservation, eye ownership
and kernel behavior. Run `pnpm run check` in game. Character-forger also exercises actual
WebGL/WebGPU endpoint pixels, diffusion, material switches and body/eye playback. Inspect
face, hands/palms, ears, neck and all exposed regions at fixed cameras under varied lighting.
Technical success is not visual acceptance or MetaHuman-equivalent production quality.


The optional authored `eyeLidLookUpLeft`, `eyeLidLookDownLeft`,
`eyeLidLookUpRight` and `eyeLidLookDownRight` morphs follow vertical gaze.
`CharacterEyeController` maps local pitch ±0.35 radians to these targets and fades
follow by `(1 - blink)` independently per eye. Positive local X pitch looks down
for +Z-forward eyes. These are lid corrections, not eye rotation replacements.
Existing assets without these targets retain their previous behavior. Keep one
animation owner for both the gaze and blink channels.

The beauty, diffuse and albedo geometry targets in `SkinDiffusionPass` use matching
four-sample MSAA. Postprocess targets remain single-sample. This preserves geometry-edge
coverage through the diffusion path; it does not supply temporal antialiasing for subpixel
hair. Keep scene shadows and their physical bias under visual review at the intended scale.


### Regional height composition

Independently registered body patches may declare `skinRegionalAtlasHeightMode: "additive-v1"` with `skinFacialAtlasRegion: [0, 0, 1, faceEndV]`, where `0 < faceEndV < 1`. The face occupies the atlas's top rows; body patches occupy rows below it. In those body rows, patch relief adds to the underlying body height rather than replacing authored palm creases or other regional folds. Facial relief retains replacement behavior, and body coverage is unchanged. Roughness still blends to the authored patch value. Assets without this explicit mode retain their previous replacement behavior.

This uses the existing packed texture and VEC3 binding on WebGL and WebGPU; it adds no sampler or vertex attribute. Do not compensate for erased crease layers by increasing microdetail strength. Check the composition with the patch enabled and disabled at the same camera, and retain the physical amplitude of each layer.


Regional bindings need coherent UV coordinates at every corner of a triangle touching the patch, including corners with zero detail weight. A zero-weight corner still participates in UV interpolation. Leaving its old facial coordinates in place can make the triangle sample unrelated atlas texels. Extend coordinate support by adjacent triangles while keeping their detail weight zero and semantic coverage unchanged; reject overlapping active patch bindings or split the geometry explicitly.
