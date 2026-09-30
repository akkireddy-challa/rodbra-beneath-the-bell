# engine-api-sky

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/sky/StylizedSkyDome.ts
interface StylizedSkyDomeOptions
StylizedSkyDomeOptions.horizon: THREE.ColorRepresentation
StylizedSkyDomeOptions.zenith: THREE.ColorRepresentation
StylizedSkyDomeOptions.cloud: THREE.ColorRepresentation
StylizedSkyDomeOptions.radius: number
StylizedSkyDomeOptions.cloudCount: number
StylizedSkyDomeOptions.cloudMinElevationDeg: number
StylizedSkyDomeOptions.cloudMaxElevationDeg: number
StylizedSkyDomeOptions.cloudDriftDegPerSec: number
StylizedSkyDomeOptions.gradientBias: number
StylizedSkyDomeOptions.seed: number
const DEFAULT_STYLIZED_SKY_OPTIONS: StylizedSkyDomeOptions
interface StylizedSkyDome
StylizedSkyDome.readonly group: THREE.Group
StylizedSkyDome.update(camera: THREE.Object3D, elapsedSeconds: number): void
StylizedSkyDome.dispose(): void
function createStylizedSkyDome(options: Partial<StylizedSkyDomeOptions> = {}): StylizedSkyDome
