# engine-api-gamedata

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/gamedata/GameDataService.ts
interface GameDataServiceOptions
GameDataServiceOptions.baseUrl: string
GameDataServiceOptions.sessionTokenTTLBufferMs: number
GameDataServiceOptions.defaultListLimit: number
const DEFAULT_GAME_DATA_SERVICE_OPTIONS: GameDataServiceOptions
class GameDataService
static GameDataService.getInstance(): GameDataService
GameDataService.configure(options: GameDataServiceOptions, gameId: string): void
GameDataService.invalidateSessionToken(): void
GameDataService.create(category: string, input: CreateEntryInput): Promise<CreatedEntry>
GameDataService.updateEntry(category: string, id: string, input: UpdateEntryInput): Promise<EntryView>
GameDataService.delete(category: string, id: string, input: DeleteInput = {}): Promise<void>
GameDataService.get(category: string, id: string): Promise<EntryView>
GameDataService.list(category: string, input: ListEntriesInput = {}): Promise<ListResult>
GameDataService.rank(category: string, input: RankInput): Promise<RankResult>
GameDataService.createRunUploadUrl(category: string, sizeBytes: number): Promise<RunUploadTarget>

## engine/gamedata/LeaderboardManifest.ts
const LEADERBOARD_MANIFEST_CATEGORY = 'ghost-boards'
type LeaderboardMetric = 'time' | 'score'
interface LeaderboardDeclaration
LeaderboardDeclaration.category: string
LeaderboardDeclaration.label: string
LeaderboardDeclaration.metric: LeaderboardMetric
LeaderboardDeclaration.field: string
LeaderboardDeclaration.levelId: string | null
LeaderboardDeclaration.ghost: boolean
function resetPublishedLeaderboards(): void
function publishLeaderboard(service: GameDataService, declaration: LeaderboardDeclaration): Promise<void>

## engine/gamedata/types.ts
type ValuePrimitive = string | number
interface EntryMeta
EntryMeta.revision: number
EntryMeta.createdAt: string
EntryMeta.updatedAt: string
EntryMeta.expireAt: string | null
interface EntryView
EntryView.id: string
EntryView.data?: Record<string, unknown>
EntryView.values: Record<string, ValuePrimitive>
EntryView.meta: EntryMeta
EntryView.hasSecret?: boolean
EntryView.createdByUid?: string | null
interface CreatedEntry
CreatedEntry.secret?: string
interface ListResult
ListResult.entries: EntryView[]
ListResult.nextCursor: string | null
interface RankResult
RankResult.rank: number
RankResult.total: number
interface CreateEntryInput
CreateEntryInput.data: Record<string, unknown>
CreateEntryInput.values: Record<string, ValuePrimitive>
CreateEntryInput.withSecret?: boolean
CreateEntryInput.playerId?: string
CreateEntryInput.verifier?: string
interface UpdateEntryInput
UpdateEntryInput.data?: Record<string, unknown>
UpdateEntryInput.values?: Record<string, ValuePrimitive>
UpdateEntryInput.secret?: string
type WhereOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte'
interface WhereFilter
WhereFilter.field: string
WhereFilter.op: WhereOp
WhereFilter.value: string | number
interface ListEntriesInput
ListEntriesInput.where?: WhereFilter[]
ListEntriesInput.orderBy?: string
ListEntriesInput.orderDir?: 'asc' | 'desc'
ListEntriesInput.limit?: number
ListEntriesInput.cursor?: string
ListEntriesInput.fields?: 'all' | 'values'
interface RankInput
RankInput.field: string
RankInput.value: number
RankInput.direction?: 'asc' | 'desc'
interface DeleteInput
DeleteInput.secret?: string
interface RunUploadTarget — Where to PUT a replay run, and where it will read back from.
RunUploadTarget.uploadUrl: string
RunUploadTarget.publicUrl: string
RunUploadTarget.key: string
RunUploadTarget.contentType: string
RunUploadTarget.cacheControl: string
RunUploadTarget.expiresIn: number
interface SessionTokenResponse
SessionTokenResponse.token: string
SessionTokenResponse.expiresAt: number
class GameDataError extends Error — Thrown by GameDataService when the backend returns an error envelope.
GameDataError.constructor(readonly status: number, readonly code: string, message: string, readonly requestId: string | null)
