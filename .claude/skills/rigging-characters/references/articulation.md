# Secondary articulation

## Fingers

Count the actual digits on each hand, including the thumb. Four-digit characters are valid;
never add an invisible fifth finger just to match a human naming convention. Fit a chain inside
each separated digit (usually up to three joints); use fewer for short or rigid digits. Parent
chains to the hand, derive curl axes from the palm plane and each digit's rest direction, and
calibrate left/right signs separately. The thumb needs opposition as well as curl.

Assign weights by connected anatomy/geodesic neighborhood, not nearest bone alone: adjacent
fingers are close in space. Keep palm influence at the knuckles and smooth between phalanges.
Inspect both hands in open, half curl, fist and grip; test punch and walk with fists. Look for
flipped triangles, stretched strips, palm collapse and thumb penetration. Limit range where
appropriate and record it. Fused digits may support a grouped paddle, but label that capability
honestly; independent fingers require geometry that can deform independently.

## Tails and wings

Keep the original appendage as a separate skinned mesh, partitioned at its anatomical root.
Preserve source materials, UVs and rest alignment. Cap the body opening; when hidden there must
not be a long stump, hole or stretched strip. Fit enough segments to represent the appendage's
curvature and intended bend. Parent a tail root to pelvis/hips; wing roots commonly attach to
chest/upper spine. A four-wing character needs four identifiable chains, not two accidental
groups. Do not infer movement behavior from bone count; runtime decides cat-tail versus
crocodile-tail motion. Keep main-body animation from accidentally animating added chains.

Test visible/hidden, root alignment in walking, maximum intended bend/flap and folds. Partition
fused geometry conservatively: if anatomy cannot be separated without damaging body silhouette,
leave it unresolved and explain rather than claiming a finished optional attachment.

## Eyes

Preserve separate original-eye objects for a static alternative. Cut at the actual convex eye
surface/socket boundary, using shape, depth, normals and painted features together. White-only
selection misses pupils that meet the boundary; a bounding ellipse can cut eyelids and cheeks.
Do not include the upper socket wall in the pupil surface. Avoid a visibly protruding spherical
replacement when the original eye is shallow or oval.

An oval fixed eye can move its iris/pupil in surface coordinates or a procedural material while
keeping geometry stationary. Rotating a stretched sphere distorts the fit. Wet reflections need
a suitable glossy/clearcoat material and actual lighting/environment in runtime, not a painted
white dot. Preserve the original pupil style unless asked to change it. Blinking needs eyelid
geometry/morphs or a carefully fitted mask; gaze support does not imply blink support.

## Metadata handoff

Inspect any existing asset metadata and preserve its schema. Do not invent a Bitmagic engine
API or assume support merely because GLB extras can store data. For a new contract, provide a
versioned sidecar manifest and optional mirrored GLB extras with exact object/bone names:
body nodes, static/dynamic eye nodes, gaze mechanism, material parameters, blink availability,
hand digit chains/curl axes/ranges, appendage nodes/chains/root parents and default visibility.
State the coordinate space and angle units. Include a capability as false when unsupported.
Runtime may need code to hide alternatives, drive eyes or animate added bones; a manifest alone
does not implement those controls. Keep a usable neutral appearance without custom shaders.
