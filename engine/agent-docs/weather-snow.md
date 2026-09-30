# Ambient Weather: Rain (weatherConfig) and Falling Snow (AmbientSnowVFX)

## Rain — config, not code

Rain is a CONFIG, not a VFX to build: `configure_game(configType="weather",
precipitation="rain", ...)`. That one config drives the falling rain, the
impact splashes on real surfaces, AND the wet-asphalt response of a forged
level's ride surface (darkened glossy road, rippling puddles, scene
reflections). Never hand-roll rain particles or a wet road material — the
engine's weather system keeps drops and surfaces in sync and scales quality
with the player's renderer (WebGPU: GPU-compute rain + screen-space
reflections; WebGL: cheaper instanced rain automatically). Vehicles leave
fading wet tyre trails automatically — never build those either. Knobs: intensity,
windX/windZ, puddles, wetness override, reflections — see the configure-game
tool. Pair with a dark `lighting` preset for storm mood. Per-level rain (one
stormy track in a multi-level game) goes in that level's
`overrides.weatherConfig`.

## Snow — AmbientSnowVFX

Engine-provided falling-snow effect that works on BOTH renderer backends
(WebGPU and WebGL). Use it for snowfall, and — via the wind/speed/sprite
options — for other ambient falls: drifting ash, falling leaves/petals. (For
rain, use the weather config above, not this sprite fall.)

**Do NOT hand-roll a `THREE.Points` particle cloud for weather** — `THREE.Points`
renders as fixed 1-pixel dots on the WebGPU backend (the default renderer), so
the effect is invisible for most players. `AmbientSnowVFX` renders billboarded
soft sprites through an `InstancedMesh`, which draws identically on both
backends.

## Basic usage

```typescript
import { AmbientSnowVFX } from 'engine/effects/index.js';

// In your Game class setup:
this.snow = new AmbientSnowVFX(this.engine.scene);

// In update(deltaTime) — recenter on the player every frame so it snows
// everywhere the player goes:
this.player.getWorldPosition(this.snowCenterScratch);
this.snow.update(deltaTime, this.snowCenterScratch);

// On cleanup:
this.snow.dispose();
```

## Options (constructor takes a Partial — spread over defaults)

```typescript
new AmbientSnowVFX(scene, {
    density: 0.5,                        // 0..1 fraction of the particle pool (1 = heaviest)
    maxParticles: 1400,                  // pool cap; keep <= ~3000 for perf
    fallSpeed: 3.0,                      // average downward m/s
    wind: new THREE.Vector3(4, 0, 0),    // constant m/s push — slants the fall direction
    driftSpeed: 1.2,                     // random per-flake horizontal wander (m/s)
    flakeSize: 0.35,                     // sprite size in meters
    color: 0xffffff,                     // tint (multiplies the sprite)
    opacity: 0.85,
    texture: null,                       // null = built-in soft round flake;
                                         // or a URL string ('assets/images/petal.png',
                                         // transparent PNG — alpha shapes the flake);
                                         // or a ready THREE.Texture
    radius: 45,                          // column radius around the player (m)
    columnHeight: 35,                    // column height above the player (m)
    groundDrop: 6,                       // recycle distance below the player (m)
});
```

## Runtime weather changes

```typescript
snow.setDensity(0.15);                       // calm flurry … 1.0 = blizzard; 0 stops it
snow.setWind(new THREE.Vector3(8, 0, 2));    // storm gust — strong sideways slant
snow.setFallSpeed(6);                        // heavier, faster fall
snow.setTexture('assets/images/leaf.png');   // swap the sprite live
```

## Recipes

- **Gentle snowfall:** defaults.
- **Blizzard:** `density: 1, fallSpeed: 6, wind: new THREE.Vector3(9, 0, 0), opacity: 0.95`.
- **Falling autumn leaves:** `texture: '<leaf png>', flakeSize: 0.5, fallSpeed: 1.2, driftSpeed: 2, color: 0xffffff`.
- **Drifting ash/embers:** `texture: null, flakeSize: 0.15, fallSpeed: 0.8, color: 0x999999, wind` for updrafts use `wind.y > 0`.

Related: `SnowSprayVFX` (`engine/ski/index.js`) is the separate lit powder-spray
effect for ski/snowboard carving — see the `mechanic-skiing` doc.
