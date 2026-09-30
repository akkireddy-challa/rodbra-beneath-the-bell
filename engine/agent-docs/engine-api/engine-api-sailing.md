# engine-api-sailing

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/sailing/Sailing.ts
interface RenderRegionTarget — Anything that can draw only part of a baked level — `VxlSceneTerrainSystem` does.
RenderRegionTarget.setRenderRegion(region: THREE.Box3 | null): void
interface SailingOptions
SailingOptions.speed: number
SailingOptions.seaLevelY: number
SailingOptions.helm: ShipHelmOptions
SailingOptions.wake: SailingWakeOptions | null
SailingOptions.sway: SwellSwayOptions | null
SailingOptions.scenery: VoyageSceneryOptions | null
SailingOptions.renderRegionTarget: RenderRegionTarget | null
SailingOptions.renderRegionPadding: number
SailingOptions.moveOcean: boolean
const DEFAULT_SAILING_OPTIONS: SailingOptions
class Sailing
Sailing.frame: VesselFrame
Sailing.voyage: SeaVoyage
Sailing.helm: ShipHelm
Sailing.wake: SailingWake | null
Sailing.sway: SwellSway | null
Sailing.scenery: VoyageScenery | null
Sailing.constructor(engine: EngineLike, frame: VesselFrame, options: SailingOptions)
Sailing.setSpeed(metresPerSecond: number): void
Sailing.getSpeed(): number
Sailing.update(deltaTime: number, helmCommand: number): void
Sailing.applyCamera(camera: THREE.Camera | null): void
Sailing.dispose(): void
function createSailing(engine: EngineLike, gameData: GameData | null | undefined, options: Partial<SailingOptions>): Sailing | null

## engine/sailing/SailingWake.ts
interface SailingWakeOptions — Foam that reads the ship as under way, when the ship itself cannot move.
SailingWakeOptions.streakCount: number
SailingWakeOptions.fieldForward: number
SailingWakeOptions.fieldAft: number
SailingWakeOptions.fieldHalfWidth: number
SailingWakeOptions.hullClearance: number
SailingWakeOptions.surfaceClearance: number
SailingWakeOptions.opacityRange: readonly [number, number]
SailingWakeOptions.foamColor: THREE.ColorRepresentation
SailingWakeOptions.wakeColor: THREE.ColorRepresentation
SailingWakeOptions.seed: number
const DEFAULT_SAILING_WAKE_OPTIONS: SailingWakeOptions
const SAILING_WAKE_STREAK_NAME = 'SailingWakeStreak'
const SAILING_WAKE_STANDING_NAME = 'SailingWakeStanding'
class SailingWake
SailingWake.group: THREE.Group
SailingWake.constructor(frame: VesselFrame, surface: WaterSurfaceQuery, options: SailingWakeOptions)
SailingWake.update(deltaTime: number, speed: number, turnRate: number): void
SailingWake.dispose(): void

## engine/sailing/ShipHelm.ts
interface ShipHelmOptions — How a big ship answers her helm. Input, HUD, sound and the wheel's mesh are
ShipHelmOptions.hardOverSeconds: number
ShipHelmOptions.maxTurnRate: number
ShipHelmOptions.turnLagSeconds: number
ShipHelmOptions.maxHeel: number
ShipHelmOptions.heelResponse: number
const DEFAULT_SHIP_HELM_OPTIONS: ShipHelmOptions
class ShipHelm
ShipHelm.constructor(initialHeading: number, options: ShipHelmOptions)
ShipHelm.update(deltaTime: number, command: number): void
ShipHelm.getHeading(): number
ShipHelm.getRudder(): number
ShipHelm.getTurnRate(): number
ShipHelm.getHeel(): number

## engine/sailing/SwellSway.ts
interface SwellSwayOptions — The camera rides the swell: a slow roll and heave on top of whatever the
SwellSwayOptions.rollAmplitudes: readonly [number, number]
SwellSwayOptions.rollRates: readonly [number, number]
SwellSwayOptions.heaveAmplitudes: readonly [number, number]
SwellSwayOptions.heaveRates: readonly [number, number]
SwellSwayOptions.amplitudeScale: number
const DEFAULT_SWELL_SWAY_OPTIONS: SwellSwayOptions
class SwellSway
SwellSway.constructor(options: SwellSwayOptions)
SwellSway.update(deltaTime: number): void
SwellSway.getRoll(): number
SwellSway.getHeave(): number
SwellSway.apply(camera: THREE.Camera | null, heel: number): void

## engine/sailing/VesselFrame.ts
interface VesselFrame — Where a ship stands in the world, and which way its geometry points.
VesselFrame.centre: THREE.Vector3
VesselFrame.bow: THREE.Vector3
VesselFrame.stern: THREE.Vector3
VesselFrame.heading: number
VesselFrame.length: number
VesselFrame.beam: number
VesselFrame.deckY: number
function vesselFrameFromBowStern(bow: THREE.Vector3, stern: THREE.Vector3, beam: number, deckY: number): VesselFrame
function forgedVesselFrame(gameData: GameData | null | undefined): VesselFrame | null

## engine/sailing/VoyageScenery.ts
interface VoyageSceneryOptions — Land the ship passes on her way somewhere else — and the land she is making for.
VoyageSceneryOptions.assets: readonly string[]
VoyageSceneryOptions.count: number
VoyageSceneryOptions.scaleRange: readonly [number, number]
VoyageSceneryOptions.sinkPerScale: number
VoyageSceneryOptions.seedMinDistance: number
VoyageSceneryOptions.spawnDistance: number
VoyageSceneryOptions.recycleDistance: number
VoyageSceneryOptions.avoidRadius: number
VoyageSceneryOptions.nearLimit: number
VoyageSceneryOptions.spawnArc: number
VoyageSceneryOptions.seed: number
const DEFAULT_VOYAGE_SCENERY_OPTIONS: VoyageSceneryOptions
function voyageSceneryDistancesForFog(fogFar: number): Pick<VoyageSceneryOptions, 'spawnDistance' | 'recycleDistance'>
interface VoyageLandmarkOptions — A fixed place in voyage space — a destination. Never recycled, never pushed aside.
VoyageLandmarkOptions.scale: number
VoyageLandmarkOptions.spin: number
VoyageLandmarkOptions.sink: number
const DEFAULT_VOYAGE_LANDMARK_OPTIONS: VoyageLandmarkOptions
class VoyageScenery
VoyageScenery.ready: Promise<void>
VoyageScenery.constructor(engine: EngineLike, voyage: SeaVoyage, seaLevelY: number, options: VoyageSceneryOptions)
VoyageScenery.addLandmark(asset: string, position: THREE.Vector2, options: VoyageLandmarkOptions): Promise<SpawnedAsset | null>
VoyageScenery.update(): void
VoyageScenery.dispose(): void

## engine/sailing/VoyageSpace.ts
class SeaVoyage — The frame the ship actually sails in.
SeaVoyage.position
SeaVoyage.constructor(frame: VesselFrame)
SeaVoyage.getHeading(): number
SeaVoyage.advance(deltaTime: number, speed: number, heading: number): void
SeaVoyage.swing(): number
SeaVoyage.projectToWorld(point: THREE.Vector2, y: number, out: THREE.Vector3): number
SeaVoyage.worldToVoyage(x: number, z: number, out: THREE.Vector2): THREE.Vector2
SeaVoyage.rangeAndBearingTo(point: THREE.Vector2, out: { range: number; bearing: number }): { range: number; bearing: number }
SeaVoyage.waveFrame(out: OceanWaveFrame): OceanWaveFrame
