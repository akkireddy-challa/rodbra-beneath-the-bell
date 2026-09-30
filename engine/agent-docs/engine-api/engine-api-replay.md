# engine-api-replay

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/replay/GhostBoard.ts
function boardCategoryFor(levelId: string): string
const BOARD_MANIFEST_CATEGORY = LEADERBOARD_MANIFEST_CATEGORY
interface BoardEntry
BoardEntry.entryId: string
BoardEntry.playerId: string
BoardEntry.name: string
BoardEntry.timeMs: number
BoardEntry.createdAt: string
BoardEntry.assetId: string | null
interface SubmitRunInput
SubmitRunInput.levelId: string
SubmitRunInput.timeMs: number
SubmitRunInput.name: string
SubmitRunInput.playerId: string
SubmitRunInput.verifier: string
SubmitRunInput.assetId: string | null
SubmitRunInput.run: RunSource
function isBoardServiceUnavailable(): boolean
function resetBoardFailures(): void
function fetchBoard(service: GameDataService, levelId: string, limit: number): Promise<BoardEntry[]>
function mergeBoards(local: BoardEntry[], remote: BoardEntry[]): BoardEntry[]
function dedupeByPlayer(entries: EntryView[]): BoardEntry[]
function submitRun(service: GameDataService, input: SubmitRunInput): Promise<string>
function fetchRunSource(service: GameDataService, levelId: string, entryId: string): Promise<RunSource | null>
interface BoardManifestRow
BoardManifestRow.levelId: string
BoardManifestRow.levelName: string
BoardManifestRow.category: string
function publishBoardManifest(service: GameDataService, row: BoardManifestRow): Promise<void>

## engine/replay/GhostIdentity.ts
const GHOST_IDENTITY_SLOT = 'ghost-identity'
interface GhostCredential
GhostCredential.playerId: string
GhostCredential.verifier: string
interface StoredGhostIdentity
StoredGhostIdentity.linkedFrom: string | null
interface LeaderboardIdentity — Who this device writes leaderboard rows as — the whole answer, in one object.
LeaderboardIdentity.playerId: string
LeaderboardIdentity.verifier: string
LeaderboardIdentity.displayName: string
LeaderboardIdentity.isGuest: boolean
type PlayTokenSource = () => Promise<string | null>
interface GhostIdentityOptions
GhostIdentityOptions.gameDataServiceUrl: string
GhostIdentityOptions.portalApiUrl: string
GhostIdentityOptions.gameId: string
const DEFAULT_GHOST_IDENTITY_OPTIONS: GhostIdentityOptions
class GhostIdentity
GhostIdentity.constructor(private readonly options: GhostIdentityOptions, private readonly persistence: GamePersistence, private readonly playToken: PlayTokenSource)
GhostIdentity.resolve(): Promise<GhostCredential>
GhostIdentity.displayName(): Promise<string>
GhostIdentity.info(): Promise<LeaderboardIdentity>
GhostIdentity.isGuest(): boolean
GhostIdentity.upgradeToAccount(): Promise<GhostCredential | null>

## engine/replay/GhostLocalRuns.ts
interface LocalRun
LocalRun.encodedRun: string
LocalRun.timeMs: number
LocalRun.savedAt: number
LocalRun.assetId: string | null
type LocalRuns = Record<string, LocalRun[]>
const LOCAL_ENTRY_ID = 'local'
function localEntryId(index: number): string
function isLocalEntryId(entryId: string): boolean
function setLocalRunStore(persistence: GamePersistence | null): void
function readLocalRuns(): LocalRuns
function readLocalRunsFor(levelId: string): LocalRun[]
function writeLocalRun(levelId: string, run: LocalRun, keep: number): void
function localBoardRows(levelId: string): BoardEntry[]

## engine/replay/GhostMaterial.ts
interface GhostMaterialOptions
GhostMaterialOptions.opacity: number
GhostMaterialOptions.tint: THREE.ColorRepresentation | null
GhostMaterialOptions.tintStrength: number
GhostMaterialOptions.renderOrder: number
const DEFAULT_GHOST_MATERIAL_OPTIONS: GhostMaterialOptions
function applyGhostMaterial(root: THREE.Object3D, options: GhostMaterialOptions): void
function disposeGhostMaterials(root: THREE.Object3D): void

## engine/replay/GhostNames.ts
const ANON_PLAYER_PREFIX = 'g_'
const GUEST_ID_V2_PREFIX = 'g_v2_'
function isAnonymousPlayerId(playerId: string): boolean
function generatedNameFor(playerId: string): string

## engine/replay/GhostRacing.ts
const CHALLENGE_PARAM = GHOST_PARAM
interface GhostRacingAttachOptions
GhostRacingAttachOptions.subject: () => ReplayVehicleSubject | null
GhostRacingAttachOptions.input: (() => ReplayInputSnapshot) | null
GhostRacingAttachOptions.descriptor: VehicleDescriptor | null
GhostRacingAttachOptions.assetId: string | null
GhostRacingAttachOptions.levelId: string | null
GhostRacingAttachOptions.levelName: string
GhostRacingAttachOptions.opponents: number
GhostRacingAttachOptions.recorder: ReplayRecorderOptions
const DEFAULT_GHOST_RACING_OPTIONS: GhostRacingAttachOptions
interface FinishRunInput
FinishRunInput.timeMs: number
interface FinishRunResult
FinishRunResult.rank: number | null
FinishRunResult.total: number | null
FinishRunResult.isPersonalBest: boolean
FinishRunResult.challengeUrl: string | null
FinishRunResult.submitted: boolean
interface RecordingStats — Recording diagnostics, for a HUD or a bug report.
RecordingStats.elapsedMs: number
RecordingStats.motionSamples: number
RecordingStats.inputTransitions: number
RecordingStats.truncated: boolean
interface ActiveGhostInfo — One ghost lined up for the next run.
ActiveGhostInfo.entryId: string
ActiveGhostInfo.name: string
ActiveGhostInfo.timeMs: number
ActiveGhostInfo.assetId: string | null
ActiveGhostInfo.isLocal: boolean
class GhostRacing
GhostRacing.constructor(private readonly engine: EngineLike, private readonly service: GameDataService, private readonly persistence: GamePersistence, private readonly identity: GhostIdentity, private readonly gameId: string)
GhostRacing.attach(options: Partial<GhostRacingAttachOptions>): Promise<void>
GhostRacing.isRemoteBoardLoaded(): boolean
GhostRacing.startRun(): void
GhostRacing.updateGhosts(deltaTime: number): void
GhostRacing.abandonRun(): void
GhostRacing.finishRun(input: FinishRunInput): Promise<FinishRunResult>
GhostRacing.getBoard(): readonly BoardEntry[]
GhostRacing.getActiveGhosts(): ActiveGhostInfo[]
GhostRacing.copyChallengeLink(url: string): Promise<boolean>
GhostRacing.getRecordingStats(): RecordingStats
GhostRacing.hasChallenge(): boolean
GhostRacing.detach(): void
GhostRacing.isAttached(): boolean

## engine/replay/GhostRunStorage.ts
type RunSource = | { kind: 'url'; url: string } | { kind: 'inline'; encoded: string }
function uploadRun(service: GameDataService, category: string, bytes: Uint8Array): Promise<string | null>
function loadRun(source: RunSource): Promise<RunRecord>

## engine/replay/GhostVehicle.ts
interface GhostVehicleOptions
GhostVehicleOptions.material: GhostMaterialOptions
GhostVehicleOptions.engine: EngineLike | null
GhostVehicleOptions.bodyTemplate: THREE.Object3D | null
const DEFAULT_GHOST_VEHICLE_OPTIONS: GhostVehicleOptions
class GhostVehicle
GhostVehicle.constructor(private readonly player: ReplayPlayer, descriptor: VehicleDescriptor, options: GhostVehicleOptions)
GhostVehicle.getObject3D(): THREE.Object3D
GhostVehicle.updateAt(elapsedMs: number, deltaTime: number): void
GhostVehicle.isFinished(elapsedMs: number): boolean
GhostVehicle.setVisible(visible: boolean): void
GhostVehicle.dispose(): void

## engine/replay/ReplayBits.ts
class BitWriter
BitWriter.writeBits(value: number, bits: number): void
BitWriter.align(): void
BitWriter.writeUint8(value: number): void
BitWriter.writeUint16(value: number): void
BitWriter.writeUint32(value: number): void
BitWriter.writeFloat32(value: number): void
BitWriter.writeString(value: string): void
BitWriter.toUint8Array(): Uint8Array
class BitReader
BitReader.constructor(private readonly bytes: Uint8Array)
BitReader.readBits(bits: number): number
BitReader.align(): void
BitReader.readUint8(): number
BitReader.readUint16(): number
BitReader.readUint32(): number
BitReader.readFloat32(): number
BitReader.readString(): string

## engine/replay/ReplayChannels.ts
const VEHICLE_MOTION_CHANNELS: readonly ReplayChannel[]
const VEHICLE_WHEEL_SLOTS = 4
const CHARACTER_MOTION_CHANNELS: readonly ReplayChannel[]
const INPUT_CHANNELS: readonly ReplayChannel[]
const MOTION_TRACK = 'motion'
const INPUT_TRACK = 'input'
const DEFAULT_MOTION_HZ = 15

## engine/replay/ReplayCodec.ts
function quantize(value: number, min: number, max: number, bits: number): number
function dequantize(quantized: number, min: number, max: number, bits: number): number
interface PackedQuat
PackedQuat.index: number
PackedQuat.components: [number, number, number]
function packQuat(x: number, y: number, z: number, w: number, componentBits: number): PackedQuat
function unpackQuat(packed: PackedQuat, componentBits: number): [number, number, number, number]
function packRun(run: RunRecord): Uint8Array
function unpackRun(bytes: Uint8Array): RunRecord
function trackPayloadBits(track: ReplayTrack): number
function trackStoredBytes(track: ReplayTrack): number
function packedSizeBytes(run: RunRecord): number
function bytesToBase64(bytes: Uint8Array): string
function base64ToBytes(text: string): Uint8Array
function encodeRunBytes(run: RunRecord): Promise<Uint8Array>
function decodeRunBytes(bytes: Uint8Array): Promise<RunRecord>
function encodeRun(run: RunRecord): Promise<string>
function decodeRun(encoded: string): Promise<RunRecord>

## engine/replay/ReplayPlayer.ts
class ReplayTrackReader
ReplayTrackReader.constructor(readonly track: ReplayTrack)
ReplayTrackReader.indexOf(key: string): number
ReplayTrackReader.get sampleCount(): number
ReplayTrackReader.isExhausted(): boolean
ReplayTrackReader.seek(elapsedMs: number): void
ReplayTrackReader.scalar(channelIndex: number): number
ReplayTrackReader.exact(channelIndex: number): number
ReplayTrackReader.quaternion(channelIndex: number, out: THREE.Quaternion): THREE.Quaternion
ReplayTrackReader.vector3(xIndex: number, yIndex: number, zIndex: number, out: THREE.Vector3): THREE.Vector3
class ReplayPlayer
ReplayPlayer.constructor(private readonly run: RunRecord)
ReplayPlayer.getTrack(name: string): ReplayTrackReader | null
ReplayPlayer.seek(elapsedMs: number): void
ReplayPlayer.isFinished(elapsedMs: number): boolean

## engine/replay/ReplayRecorder.ts
type ReplaySampleFn = (out: number[], deltaTime: number) => void
interface ReplayRecorderOptions
ReplayRecorderOptions.motionChannels: readonly ReplayChannel[]
ReplayRecorderOptions.motionHz: number
ReplayRecorderOptions.inputChannels: readonly ReplayChannel[] | null
ReplayRecorderOptions.inputHz: number
ReplayRecorderOptions.maxDurationMs: number
const DEFAULT_REPLAY_RECORDER_OPTIONS: ReplayRecorderOptions
class ReplayRecorder
ReplayRecorder.constructor(options: ReplayRecorderOptions, motionSampler: ReplaySampleFn, inputSampler: ReplaySampleFn | null)
ReplayRecorder.start(): void
ReplayRecorder.update(deltaTime: number): void
ReplayRecorder.stop(): RunRecord
ReplayRecorder.isRecording(): boolean
ReplayRecorder.isTruncated(): boolean
ReplayRecorder.getElapsedMs(): number
ReplayRecorder.getMotionSampleCount(): number
ReplayRecorder.getInputTransitionCount(): number

## engine/replay/ReplaySubjects.ts
interface ReplayVehicleSubject — The slice of a vehicle the motion template needs.
ReplayVehicleSubject.getPosition(): THREE.Vector3
ReplayVehicleSubject.getChassisObject(): THREE.Object3D
ReplayVehicleSubject.getForwardSpeed(): number
ReplayVehicleSubject.getSteeringAngle(): number
ReplayVehicleSubject.getWheelCount(): number
ReplayVehicleSubject.getWheelRotation(wheelIndex: number): number
ReplayVehicleSubject.getFootprint(): { width: number; height: number; length: number }
ReplayVehicleSubject.getWheelConfigs(): ReadonlyArray<{ position: { x: number; y: number; z: number }; radius: number; width: number; suspensionRestLength: number; isSteering: boolean; color?: number; }>
function describeVehicleForGhost(vehicle: ReplayVehicleSubject, assetId?: string): VehicleDescriptor
function createVehicleMotionSampler(vehicle: ReplayVehicleSubject): ReplaySampleFn
interface ReplayCharacterState — One frame of character state, for `CHARACTER_MOTION_CHANNELS`.
ReplayCharacterState.position: THREE.Vector3
ReplayCharacterState.yaw: number
ReplayCharacterState.speed: number
ReplayCharacterState.animId: number
function createCharacterMotionSampler(read: () => ReplayCharacterState): ReplaySampleFn
interface ReplayInputSnapshot — One poll of player input.
ReplayInputSnapshot.steer: number
ReplayInputSnapshot.throttle: number
ReplayInputSnapshot.brake: number
ReplayInputSnapshot.buttons: number
function createInputSampler(read: () => ReplayInputSnapshot): ReplaySampleFn

## engine/replay/ReplayTypes.ts
const REPLAY_FORMAT_VERSION = 1
const REPLAY_MAGIC = 0x424d5250
interface ReplayScalarChannel — A continuous value, quantized into `bits` across `[min, max]`.
ReplayScalarChannel.kind: 'scalar'
ReplayScalarChannel.key: string
ReplayScalarChannel.bits: number
ReplayScalarChannel.min: number
ReplayScalarChannel.max: number
ReplayScalarChannel.autoRange: boolean
interface ReplayBitsChannel — An unsigned integer stored verbatim in `bits`, with no quantization.
ReplayBitsChannel.kind: 'bits'
ReplayBitsChannel.key: string
ReplayBitsChannel.bits: number
interface ReplayQuatChannel — A unit quaternion, stored smallest-three: the largest-magnitude component is
ReplayQuatChannel.kind: 'quat'
ReplayQuatChannel.key: string
ReplayQuatChannel.componentBits: number
type ReplayChannel = ReplayScalarChannel | ReplayBitsChannel | ReplayQuatChannel
function channelStride(channel: ReplayChannel): number
function channelBits(channel: ReplayChannel): number
function trackBitsPerSample(channels: readonly ReplayChannel[]): number
function trackStride(channels: readonly ReplayChannel[]): number
interface ReplayTrack
ReplayTrack.name: string
ReplayTrack.sampleRateHz: number
ReplayTrack.channels: ReplayChannel[]
ReplayTrack.frames: number[] | null
ReplayTrack.values: number[][]
ReplayTrack.sampleCount: number
interface RunRecord
RunRecord.formatVersion: number
RunRecord.durationMs: number
RunRecord.tracks: ReplayTrack[]
class ReplayFormatError extends Error — Thrown for any malformed or unsupported encoded run.
ReplayFormatError.constructor(message: string)

## engine/replay/installGhostRacing.ts
interface PlayerIdentitySetup — The identity and the private store it lives in, built together.
PlayerIdentitySetup.identity: GhostIdentity
PlayerIdentitySetup.store: GamePersistence
function createPlayerIdentity(gameId: string): PlayerIdentitySetup
function installGhostRacing(engine: EngineLike, service: GameDataService, gameId: string, player: PlayerIdentitySetup): GhostRacing
