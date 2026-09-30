# First-person weapons

Everything a first-person weapon needs ships with the engine. Do not hand-roll a
view model, a camera-follow loop, recoil, or weapon visibility.

## Pick the right system

| Camera mode | Melee | Ranged |
|---|---|---|
| `first-person` | `FirstPersonMeleeSystem` | `FirstPersonWeaponSystem` |
| third-person / top-down | `WeaponMeleeSystem` | `RangedWeaponSystem` |

Choosing wrong fails **silently or invisibly**, not loudly:

- `RangedWeaponSystem` parents the gun to the player root, and the engine hides
  that root in first person. The weapon exists, aims and fires — and cannot be
  seen. It logs an error when it detects first person.
- `WeaponMeleeSystem` is animation-driven and needs a visible, skinned character,
  so it does nothing at all for a headless player.

Both first-person systems implement `IPlayerAttack`. Install one with
`playerController.setAttackSystem(...)`, which also wires left click, the Enter
action key and the mobile action button.

## What you get without writing any of it

Constructing `FirstPersonWeaponSystem` gives the weapon look-sway, stride-cadence
bob, idle breathing, landing punch, spring recoil, a camera kick, aim down
sights, a muzzle flash that lights the gun, ejected casings, a crosshair that
opens with real accuracy, and the engine ammo counter. Firing, ammo, reloads and
projectiles run through the same `ShootableComponent`, `IWeaponMagazine` and
`Projectile` stack the third-person system uses, so pickups, custom magazines and
projectile behaviour all work unchanged.

The weapon is drawn in a separate view-model layer with its own depth buffer and
field of view. It therefore cannot clip into walls, is not blurred by depth of
field or tinted by fog, and does not need the player body to be visible.
In portrait viewports the layer preserves its horizontal framing so the grip
stays on-screen. Both melee and ranged weapons resolve reflective classed parts
to direct lighting, since this layer has no environment map.

## Things that are already handled

- **Weapon visibility.** Do not clear the engine's `first-person-mode` hide
  reason or re-apply body-part hiding to make a weapon appear. The view model is
  independent of the player body; leave the engine's visibility alone.
- **Camera following.** The view-model camera never moves and weapons are placed
  in camera-local space. There is nothing to sync per frame.
- **Aim.** Shots converge on the crosshair, which is raycast into the world, so
  bullets hit what the reticle covers in every camera mode.

## Per-weapon tuning

Built-in melee and ranged weapons come in **block** and **lowpoly** styles.
Existing IDs select block; append `_lowpoly` for the faceted mesh, for example
`sword_lowpoly`, `pistol_lowpoly`, or `shotgun_lowpoly`. Pass the ID through the
same `weaponType` / equip API. Both styles retain the same recoil, muzzle and hand
anchors, and their geometry facets survive the view-model material clamp.
See `@docs weapon-visuals.md` for the catalog and authoring examples.

Recoil is a per-weapon profile, and `recenter` is its one gameplay decision: the
fraction of each kick that springs back. `1.0` means firing is purely cosmetic
and provably never moves the player's aim — the right choice for bows, energy
weapons, mobile-first games and anything aimed at casual players. Lower values
leave the remainder as a real aim change, so sustained fire climbs and the player
pulls down against it. Built-in weapons ship with sensible defaults; set it
explicitly when a game wants a different feel.

Sight pose, field-of-view narrowing, look sensitivity, muzzle flash, shell
ejection and the crosshair can each be configured or switched off through the
system's options.

## Shotguns, infinite ammo, bob

A preset with `pelletCount` above 1 fires a volley: one round of ammunition,
several pellets scattered across `pelletSpreadRad`. The built-in `shotgun`
preset does this. `magazineSize: 0` is an infinite magazine — no count, no
reload. `viewBobScale` on a preset scales that weapon's movement bob.

## Bullet holes

Bullets carve real holes. The struck voxel is subdivided down to hole size,
the cube at the impact is removed, and that cube detaches and flies off as a
physical piece in its own colour. This needs no game code: it works on any
voxel object that owns its geometry, and a plain batched prop is lifted out of
its batch on the first hit. Pre-fragmented objects and terrain get a decal
instead. There is no separate impact particle from the engine — the flying
voxel is the effect.

## Camera mode

`cameraMode` lives in `world.json` and is not settable through a tool. Start from
the first-person template, which already sets it along with
`hasPlayerCharacter: false`, and already wires a working weapon.

@docs combat-system.md for the shared weapon, ammo and projectile APIs.
