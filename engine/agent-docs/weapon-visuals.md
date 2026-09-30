# Weapon visuals: block and lowpoly

Choose a coherent style for the game before making custom weapons. Both styles
are complete engine meshes, available to players, NPCs, pickups, and first-person
view models. They use the same combat systems and classed material quality ladder.

## Select a built-in

The original ID selects the improved **block** model. Append **`_lowpoly`** to
select the **lowpoly** model. No registration or extra equip step is needed.
For example, `sword` / `sword_lowpoly`, `assault_rifle` /
`assault_rifle_lowpoly`, and `dual_pistols` / `dual_pistols_lowpoly`.

| Family | Base IDs (block) | Lowpoly IDs |
|---|---|---|
| Blades | `sword`, `longsword`, `dagger`, `katana`, `cleaver` | Append `_lowpoly` to any base ID |
| Hafted melee | `axe`, `spear`, `mace`, `hammer`, `staff`, `club` | Append `_lowpoly` |
| Energy melee | `lightsaber` | `lightsaber_lowpoly` |
| Firearms | `pistol`, `assault_rifle`, `shotgun`, `bazooka` | Append `_lowpoly` |
| Archery | `bow`, `crossbow` | `bow_lowpoly`, `crossbow_lowpoly` |
| Energy ranged | `laser_pistol`, `laser_blaster` | Append `_lowpoly` |
| Dual | `dual_pistols`, `dual_assault_rifles`, `dual_bazookas` | Append `_lowpoly` |

Styles change the mesh only: damage, attack range, melee moves, ammunition,
projectiles, recoil, muzzle position, and hand anchors are shared. `WeaponType`
and `RangedWeaponType` enumerate base IDs. Use `weaponStyleId(baseId, style)` from
`engine/WeaponVisualStyle.js` when constructing a loadout programmatically.
Keep the selected full ID when saving or spawning a pickup.

```typescript
import { installRangedWeapon } from 'engine/RangedWeaponSystem.js';
import { weaponStyleId } from 'engine/WeaponVisualStyle.js';

const weapon = installRangedWeapon(playerController,
    weaponStyleId('assault_rifle', 'lowpoly'));
weapon.switchWeapon('shotgun_lowpoly');
```

For melee, pass `sword_lowpoly` to `WeaponMeleeSystem.equipWeaponByType()`;
in first person use `FirstPersonMeleeSystem` with that `weaponType`. Ranged
first-person games use `FirstPersonWeaponSystem`. See `@docs combat-system.md`
and `@docs first-person-weapons.md` for wiring. Use the same IDs in the existing
`world.json` `player.weaponType` field; there is no separate `weaponStyle` field.
Custom registrations still take precedence over a built-in with the exact same ID.
The suffix does not automatically create a second mesh for custom weapons.

## Art direction

| Feature | Block | Lowpoly |
|---|---|---|
| Silhouette | Square sections, purposeful steps, chunky fittings | Tapered sections, shaped outlines, swept curves |
| Blades | Stepped points, separate bright cutting rails, visible fuller | Beveled cross sections, true tips, hard bevels and ridges |
| Grips | Square hafts, spaced wraps, solid collars | Octagonal hafts, tapered grips, shaped pommels |
| Guns | Layered rectangular receiver and handguard, stepped stock | Beveled receiver, shaped stock and swept magazine |
| Bow limbs | Few angular limb sections | More tapered recurved sections with small end horns |
| Detail | Large edge bands, bands around the grip, readable fittings | Facets that catch light, restrained inlays and metal hardware |

Use dark grips, warm wood, cool metal, and small brass accents as material roles.
Energy weapons use pale shells and limited colored emitters. The silhouette must
remain readable without glow, bloom, textures, or outlines. Do not turn every
surface emissive or use random face colors to simulate lowpoly art.

Give details a construction purpose: a collar joins the blade to the haft, a
raised front sight has a tower connected to the barrel, the trigger guard has an
empty interior, and the muzzle has a recessed open bore. Inspect both sides and
the back. Tiny floating boxes, coplanar overlays, detached blade sections, and
closed muzzle caps are defects even when hidden by the initial camera.

## Author or extend a weapon

Compiled examples and reusable model sources:

- `engine/examples/MeleeWeaponGuide.ts`: coordinate contract and a custom sabre
  registered in both styles.
- `engine/examples/RangedWeaponGuide.ts`: equip flow, presets, classed materials,
  both-style custom carbine registration, and dual weapon guidance.
- `engine/weapons/MeleeWeaponModels.ts`: the 12 authored melee designs.
- `engine/weapons/RangedWeaponModels.ts`: ranged silhouettes, archery limbs,
  open barrels, grips, stocks, and sights.
- `engine/weapons/WeaponMeshBuilder.ts`: boxes, outline extrusions, tapered rods,
  beveled blades, and compilation by material. Use `finish(group)` once at the
  end. Parts are static within each weapon; animate the root or dual roots.

Melee uses **+Y from hilt to tip, +Z toward the cutting edge, X through the blade
thickness**. Build relative to `preset.gripOffset`; return the tip Y for hit
detection. Curves belong in the YZ blade plane. Built-ins are authored on this
axis and bypass the heuristic edge normalizer; custom meshes retain correction.

Ranged uses **+Z down the bore, +Y up, X across the receiver**. Both style factories
must end the muzzle at `preset.muzzleOffset` and agree with `preset.foregrip`.
Return an optional `grip` from the mesh creator for the actual rear handle center;
older creators fall back to `preset.gripOffset`. Both grip points are unscaled,
weapon-local coordinates: right hand at the rear/trigger, left hand at the front.
For skinned characters, use `createSkinnedRangedGrip` from
`engine/weapons/RangedWeaponGrip.js` before calling `setSkinnedArmGrip`, as the
ranged NPC example does. It seats the trigger wrist beside the handle and wraps
the support palm diagonally forward around the foregrip. The wrist and hand
orientation move together, keeping the palm on the physical handle. It also
enables fitting the gun within the gripping arms' reach after animation.
Pass the intended world weapon scale once; do not add the block-hand offsets or
multiply by the character root scale. This applies to either weapon art style.
Use the preset's `weaponScale` for held world models, including NPCs and remote
players. Built-in pistols use a compact scale; rifles, shotguns and blasters use
a moderate scale, and launchers retain their larger silhouette. The authored
mesh coordinates and muzzle point stay together under that scale. If you resize
a dual pair, compensate `dualSpacing` for the new X scale so resizing the models
does not also move the hands. First-person view models have their own camera rig
and scale in `FirstPersonWeaponSystem`.
Tune a weapon's held height through its preset's `heightOffset`; it is used at
equip time and while following the animated shoulder. Pistols and dual pairs
use lower offsets, and the bazooka has its own offset for the large tube.
Keep these separate from the shared two-handed rifle hold correction.
For a low dual hold, start within arm reach using `forwardOffset`; an excessively
forward starting point can make fitting pull the guns down out of reach when
aiming upward. Validate the fitted position and hand contact across aim angles.
Never adjust an anchor solely to make a screenshot look better. Dual weapons
use `createDualWeapon()` or `RangedWeaponRegistry.registerDual()`, preserving
independent left and right roots, mirroring and alternating fire.
The dual helper preserves the single creator's authored rear handle on each
child, falling back to `preset.gripOffset` for older creators. On a skinned
player, single pistols and dual guns use their own lower hold; each dual gun
moves inward together with its handle and muzzle. Both dual hands use a trigger
grip (`createSkinnedRangedGrip(..., 'trigger')`), so the left wrist does not get
the two-handed rifle's support-palm offset. The historical dual mesh names put
`rightWeaponMesh` at +X; the character's anatomical right hand is on −X.

Rifles use a compact physical foregrip so reach fitting can retain their forward
placement at the lower hold. Check the final fitted position when tuning a hold:
increasing `forwardOffset` alone may be cancelled by the support arm's reach.

The melee NPC example corrects blade facing for both block and skinned hands.
Block hand groups inherit Mixamo wrist rotations too; a fixed local rotation can
point the blade sideways or down. `INpcBehavior.onPoseUpdated()` is an optional
hook for correcting custom attachments after the controller poses the live hand.
Use it for visual alignment, not AI or physics. The example's block chop runs in
the character's facing frame and returns to a forward, slightly raised hold.

The ranged NPC example follows the posed shoulder using the shared skinned-player
hold settings, or a closer hold for the shorter block arms. Its offsets and weapon
size are world metres, compensated for the NPC
root's scale in both render modes. `weaponScale` multiplies the preset's size.
Block hands follow the actual grip after feet alignment; skinned hands use arm
reach fitting. Dual weapons give each hand its own trigger grip and fire from
alternating authored muzzles. Subclasses overriding `onPoseUpdated()` should call
`super.onPoseUpdated()` to retain block gun alignment.

On death it transfers a single gun to the right hand, or each dual gun to its
own hand, preserving the world transforms, then clears the aiming grips. The
skinned ragdoll drives
that hand bone; the block ragdoll includes the attached gun in its hand limb.
Keep corpse weapons under the hand so they tumble and clean up with the body,
rather than leaving them on the stationary character root. Stop delayed equip
retries when the NPC is already dead.

Use `createWeaponPartMaterial()` for individual parts, or the builder's semantic
surfaces. Hard facets are baked into geometry normals, so first-person materials
can clamp from Physical to Phong without losing the silhouette or facet shading.
Materials and geometry belong to each created weapon; never share disposable
resources globally between equipped weapons or pickups.

## Reproduce the visual check

From `game/`, run:

```bash
node scripts/preview-weapons.mjs /tmp/weapon-preview
node scripts/preview-weapons.mjs /tmp/weapon-preview webgpu
pnpm exec jest --runInBand WeaponVisualStyles WeaponStyleLifecycle WeaponPartMaterial InstallRangedWeapon NpcWeaponComponent
pnpm run check
```

The script uses installed Playwright Chromium (full Chromium headless mode, since
the macOS headless shell can capture blank WebGPU canvases) and bundles the real registry
factories into a self-contained `weapons.html`. Open that file to compare styles,
orbit, change distance and material quality, inspect normals/wireframe/silhouette,
or display muzzle/hilt/foregrip anchors. It also writes PNG comparisons and JSON
metrics. A pixel check rejects empty model panels. It closes its browser in
`finally` and starts no listening server.

Captures use 1440×960, DPR 1, deterministic geometry and fixed camera parameters.
The default comparison uses medium materials with key/fill lighting and no image
effects. WebGL high uses a generated room environment; WebGPU high is a direct
light diagnostic without that environment. Compare geometry at medium/low;
the two backends' stock lighting responses need not be pixel-identical.
The first-person lighting toggle tests the material clamp without an environment;
it is a model inspection view, not a full gameplay/ADS simulation.

Acceptance: inspect every base ID and dual variant in both styles; verify pointed
and stepped tips, continuous handles, open bores and unchanged hand anchors.
Check the close and far views plus an orbit sweep for floating parts and flicker.
Geometry tests reject non-finite or degenerate triangles and enforce at most eight
surface draws per single weapon (sixteen for dual), with fewer than 12,000 triangles
per complete weapon. JSON timings are CPU render submission times, not GPU times.
