# Custom Shaders & Visual Effects

## Before you reach for a custom shader

A custom shader is the most expensive way to make something look special — both in GPU cost and in the maintenance cost of supporting two renderer backends (see below). Try the cheaper alternatives first:

| Goal | Cheaper than a shader |
|---|---|
| Make the player / important NPC stand out | Set `material.emissive` to a fraction of the diffuse color (e.g. `material.emissive.copy(material.color).multiplyScalar(0.35)`) — the engine's full-scene bloom amplifies it into a halo. |
| Soft edge highlight on a hovered/selected object | Use the engine's `setOutlineSelectedObjects([obj])` — it's already dual-renderer. |
| Object on fire / glowing power-up | `emissive` (above) + a small particle system or animated billboard sprite. |
| Damage flash / hit reaction | Tween `material.emissive` toward red for 100 ms and back. No shader needed. |
| Ground marker / range indicator | A `THREE.PlaneGeometry` with a transparent PNG decal, billboarded or laid flat. |
| Distortion / ripple / scrolling pattern | Often achievable by animating a texture's `offset` / `rotation` on a regular `MeshStandardMaterial` — no custom GLSL. |

Reach for a custom shader only when the effect specifically needs per-fragment math that none of the above can produce — animated vertex deformation (water, banner wave, curved-world tunnel), screen-space distortion, custom lighting, procedural patterns, or stylized post-effects.

If you're sure you need a custom shader, read on.

---

## The dual-renderer constraint

The engine ships **two renderer backends** and the user picks between them in the creator's Dev Tools tab. The default is set via `VITE_DEFAULT_RENDERER` (defaults to `webgpu`).

- **WebGPU mode** uses `WebGPURenderer` and the TSL (Three Shading Language) node pipeline. Custom shaders are built with `MeshBasicNodeMaterial` / `MeshStandardNodeMaterial` and TSL nodes from `three/tsl`.
- **WebGL mode** uses `THREE.WebGLRenderer` and classic shader pipelines. Custom shaders are built with `THREE.ShaderMaterial` + GLSL strings or `material.onBeforeCompile` patches.

**The two pipelines are not interchangeable.** A TSL `NodeMaterial` throws shader-compile errors on WebGLRenderer. A classic `ShaderMaterial` throws on WebGPURenderer. Every material the engine builds has to ship both paths.

---

## The pattern: one factory, two branches

Put both paths inside a single material-factory function. Branch on `isWebGpuActive()` at construction time. After the factory returns a `THREE.Material`, the rest of the code uses it identically — no `isWebGpuActive()` checks at use sites.

```ts
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, uniform, vec3, vec4, positionLocal, modelViewMatrix, cameraProjectionMatrix } from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';

// Single public entry point. Returns THREE.Material so callers don't care which backend built it.
export function createMyEffectMaterial(color: THREE.Color, intensity: number): THREE.Material {
    if (isWebGpuActive()) {
        // WebGPU path: TSL nodes
        const colorU = uniform(color);
        const intensityU = uniform(intensity);

        const mat = new MeshBasicNodeMaterial();
        mat.vertexNode = Fn(() => {
            const vp = modelViewMatrix.mul(vec4(positionLocal, 1.0));
            // ... vertex-space math using TSL ops (.mul, .add, .sub, ...) ...
            return cameraProjectionMatrix.mul(vp);
        })();
        mat.colorNode = Fn(() => colorU.mul(intensityU))();
        return mat;
    }

    // WebGL path: classic ShaderMaterial with GLSL strings
    return new THREE.ShaderMaterial({
        uniforms: {
            color:     { value: color },
            intensity: { value: intensity },
        },
        vertexShader: `
            void main() {
                vec4 vp = modelViewMatrix * vec4(position, 1.0);
                // ... same math, GLSL syntax ...
                gl_Position = projectionMatrix * vp;
            }
        `,
        fragmentShader: `
            uniform vec3 color;
            uniform float intensity;
            void main() {
                gl_FragColor = vec4(color * intensity, 1.0);
            }
        `,
    });
}
```

The two branches must produce the same visual result. Write both at the same time; don't ship just one path.

### Mutable uniforms shared by both paths

If the shader needs to read a per-frame value (a time uniform, a position array, etc.), both backends can hold a reference to the same JS-side variable:

- WebGL: `uniforms.myValue = { value: jsArray }` — Three.js sends `jsArray` to the GPU every render.
- WebGPU: `uniformArray(jsArray, 'float')` / `uniform(jsObject)` — TSL captures the reference and re-uploads on change.

Mutate the JS array in place (`arr[i] = x`, don't reassign `arr = newArray`) and both backends see the new value next frame. `VoxelShadowSystem.generateLightReceiverMesh()` in the engine is the canonical example.

---

## Don'ts

- **Don't ship a material with only one path.** A `three/tsl` or `three/webgpu` import without a matching WebGL fallback is a bug — it will throw on whichever backend wasn't supported. Same the other way for `ShaderMaterial` / `onBeforeCompile`.
- **Don't add `if (isWebGpuActive())` outside the material factory.** The split is "pick the right material at construction time" — once a material is built, every render call and update site treats it identically.
- **Don't call WebGL-only APIs without a TSL equivalent.** `renderer.readRenderTargetPixels()` → use `renderer.readRenderTargetPixelsAsync()` (works on both). `EffectComposer` / `UnrealBloomPass` / `GTAOPass` / `BokehPass` / `OutlinePass` → engine handles these via the TSL post-FX pipeline; don't add your own. For a colour grade or vignette use `renderConfig.colorGrading` / `renderConfig.vignette` and `engine.setColorGrading()` / `engine.setVignette()` (see `lighting-best-practices.md`).
- **Don't write your shader files into `game/src/engine/`.** That directory is read-only for agent code. Put new material factories in `game/src/work/`.

---

## Existing engine examples to pattern-match against

When implementing a new effect, find the closest example in the engine and copy its structure. All are at `game/src/engine/`:

| Effect type | File | What to crib |
|---|---|---|
| Per-instance vertex deformation | `VoxelWorld.ts` (reveal effect, ~line 1010) | `MeshStandardNodeMaterial` + TSL `positionNode` vs `MeshStandardMaterial` + `onBeforeCompile` |
| Per-vertex world-space deformation + custom color | `shaders/CurvedGroundShader.ts` | Cleanest end-to-end small example with both branches inline |
| Fullscreen / fullsphere fragment shader sampling a texture | `loaders/SkyboxMaterialHelper.ts` | Both branches extracted to private `createNodeMaterial` / `createShaderMaterial` — use this pattern when each branch is long |
| Per-frame mutable uniform arrays (lights, ribbon points, etc.) | `VoxelShadowSystem.ts` light receiver | Shared JS-side arrays referenced by both `uniformArray` (TSL) and `ShaderMaterial.uniforms` (GLSL) |

After writing your material, test in **both** modes: load the game with `?renderer=webgl` and again with `?renderer=webgpu` and verify the effect renders correctly each time.
