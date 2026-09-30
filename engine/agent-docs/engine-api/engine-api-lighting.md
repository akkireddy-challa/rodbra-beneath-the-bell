# engine-api-lighting

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/lighting/AmbientLighting.ts
class AmbientLighting
AmbientLighting.constructor(engine: EngineLike, skyboxLoader: SkyboxLoader)
AmbientLighting.updateFromScene(): void
AmbientLighting.dispose(): void

## engine/lighting/NeutralEnvironmentGradient.ts
const NEUTRAL_ENV_WIDTH = 256
const NEUTRAL_ENV_HEIGHT = 128
interface NeutralEnvironmentGradient
NeutralEnvironmentGradient.data: Uint8Array
NeutralEnvironmentGradient.width: number
NeutralEnvironmentGradient.height: number
function gradientRowColor(t: number, sky: THREE.Color): THREE.Color
function neutralEnvironmentGradient(background: THREE.Color | null, width: number = NEUTRAL_ENV_WIDTH, height: number = NEUTRAL_ENV_HEIGHT): NeutralEnvironmentGradient
