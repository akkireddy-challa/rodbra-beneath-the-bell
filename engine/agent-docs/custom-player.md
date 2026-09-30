# Custom Player — non-humanoid games

For games where the player is not a humanoid (spacecraft, mech, vehicle-only, top-down avatar, invisible), the template owns this. None of it needs engine changes.

## Hide the default character

Override `shouldShowPlayer()` to return `false` in your `IPlayerMovement` implementation. The engine reads it each frame in `PlayerController.updatePlayerVisibility()` and hides the block-character renderer accordingly. `PlayerDrivingVehicleMovement` is the reference example.

## Replace the controller or movement

Both are template-owned:
- Subclass `PlayerController` and construct it in the template's `setupPlayerController()`. `VoxelPlayerController` is the reference.
- Or keep `PlayerController` and supply a custom `IPlayerMovement` via `playerController.setMovementSystem(...)`. `WalkingAndJumpingMovement` and `PlayerDrivingVehicleMovement` are reference shapes.

**Wire inputs through the engine's action framework — read `@docs control-system.md` first.** Even for a custom controller, bind keys + mobile buttons via `registerCustomAction()` / `setActionHandler()` and read movement from the joystick, not raw `pointer`/`keydown`/`mousedown` listeners. Hand-rolled input breaks desktop↔mobile parity and causes move-and-fire-on-the-same-touch bugs. The exception is a pointer-driven game with no player to move (board, builder, strategy — the player taps the scene): build no player controller (the `no-character` template) or declare `hasPlayerCharacter: false` and listen for pointer events on the canvas; see control-system.md → Movement Controls Availability.

## Visible mesh that IS the player

Add your mesh to the scene and copy `playerController.player.position` (and the rotation source from your movement system) into it each frame.

## Headless player

`playerLoader.loadHeadlessPlayer()` skips GLTF, animations, and the block character. Returns a `playerGroup` driven by a physics body. PlayerController, vehicles, and ThirdPersonCamera all still work.

## Custom physics body

Both `loadPlayer` and `loadHeadlessPlayer` accept a `LoadPlayerOptions` argument with `customPhysicsBody`. Build your own Rapier rigid body and colliders (cuboid from an asset's bounding box, trimesh from a collider GLB, or per-voxel boxes) and pass it. PlayerLoader registers it with projectile detection but does not create a capsule or reposition the body. Caller owns shape, position, mass, collision groups, and gravity scale.
