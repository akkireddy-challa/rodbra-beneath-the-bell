# engine-api-persistence

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/persistence/CloudSaveClient.ts
interface ServerSaveIndexEntry
ServerSaveIndexEntry.slot: string
ServerSaveIndexEntry.savedAt: number
ServerSaveIndexEntry.version: number
ServerSaveIndexEntry.deleted: boolean
ServerSaveIndexEntry.size: number
interface ServerSaveIndex
ServerSaveIndex.serverNow: number
ServerSaveIndex.accountKey: string
ServerSaveIndex.saves: ServerSaveIndexEntry[]
interface ServerSave
ServerSave.slot: string
ServerSave.savedAt: number
ServerSave.version: number
ServerSave.deleted: boolean
ServerSave.payload: string | null
interface CloudWriteResult
CloudWriteResult.status: number
CloudWriteResult.stale: boolean
CloudWriteResult.serverSavedAt: number | null
CloudWriteResult.serverNow: number | null
CloudWriteResult.retryAfterSeconds: number | null
interface CloudWriteOptions
CloudWriteOptions.keepalive: boolean
type FetchLike = (input: string, init: RequestInit) => Promise<Response>
class CloudSaveClient
CloudSaveClient.constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init), private readonly baseUrl: string = API_SERVER_BASE_URL, private readonly apiToken: string = API_SERVER_TOKEN)
CloudSaveClient.list(token: string): Promise<ServerSaveIndex | null>
CloudSaveClient.get(token: string, slot: string): Promise<ServerSave | 'missing' | null>
CloudSaveClient.put(token: string, slot: string, body: { savedAt: number; version: number; payload: string }, options: CloudWriteOptions): Promise<CloudWriteResult | null>
CloudSaveClient.del(token: string, slot: string, deletedAt: number, options: CloudWriteOptions): Promise<CloudWriteResult | null>

## engine/persistence/CloudSaveSync.ts
type CloudSaveTransport = Pick<CloudSaveClient, 'list' | 'get' | 'put' | 'del'>
interface CloudSaveSyncOptions
CloudSaveSyncOptions.gateMs: number
CloudSaveSyncOptions.debounceMs: number
CloudSaveSyncOptions.keepaliveMaxBytes: number
CloudSaveSyncOptions.guestRetryMs: number
CloudSaveSyncOptions.listTimeoutMs: number
const DEFAULT_CLOUD_SAVE_SYNC_OPTIONS: CloudSaveSyncOptions
const CLOUD_SYNC_EXCLUDED_SLOT_PREFIXES: readonly string[]
function isCloudSyncedSlot(slot: string): boolean
interface SyncedMark — What this device last agreed with the server about a slot.
SyncedMark.raw: number
SyncedMark.server: number
interface SyncJournal
SyncJournal.boundTo: string | null
SyncJournal.synced: Record<string, SyncedMark>
SyncJournal.tombstones: Record<string, number>
SyncJournal.forked: Record<string, true>
interface JournalStore
JournalStore.load(): SyncJournal
JournalStore.store(journal: SyncJournal): void
function emptyJournal(boundTo: string | null = null): SyncJournal
const JOURNAL_KEY_PREFIX = 'bm-cloudsync-'
const BACKUP_KEY_PREFIX = 'bm-cloudsync-backup-'
function createLocalStorageJournalStore(gameId: string): JournalStore
interface BackupStore — Where a displaced local envelope goes when the cloud wins. Never synced, never listed.
BackupStore.write(slot: string, value: string): void
function createLocalStorageBackupStore(gameId: string): BackupStore
interface LocalSlotState
LocalSlotState.slot: string
LocalSlotState.savedAt: number
interface ServerSlotState
ServerSlotState.slot: string
ServerSlotState.savedAt: number
ServerSlotState.deleted: boolean
interface ReconcileInput
ReconcileInput.local: LocalSlotState[]
ReconcileInput.server: ServerSlotState[]
ReconcileInput.journal: SyncJournal
ReconcileInput.touched: ReadonlySet<string>
ReconcileInput.offset: number
interface ReconcilePlan
ReconcilePlan.pulls: string[]
ReconcilePlan.pushes: string[]
ReconcilePlan.deletes: string[]
ReconcilePlan.localRemoves: string[]
ReconcilePlan.forked: string[]
ReconcilePlan.journal: SyncJournal
function planReconcile(input: ReconcileInput): ReconcilePlan
interface CloudSaveSyncDeps
CloudSaveSyncDeps.inner: StorageAdapter
CloudSaveSyncDeps.gameId: string
CloudSaveSyncDeps.client: CloudSaveTransport
CloudSaveSyncDeps.getPlayerToken: () => Promise<string | null>
CloudSaveSyncDeps.hasBridge: boolean
CloudSaveSyncDeps.identity: SyncIdentity
CloudSaveSyncDeps.journal: JournalStore
CloudSaveSyncDeps.backup: BackupStore
CloudSaveSyncDeps.now: () => number
CloudSaveSyncDeps.options: CloudSaveSyncOptions
type SyncIdentity = | { kind: 'account' } | { kind: 'local'; id: string }
interface SyncPlayer — Who the saves belong to, as the creator's Save Data Inspector shows it.
SyncPlayer.kind: 'account' | 'local' | 'guest'
SyncPlayer.id: string | null
interface CloudSaveSyncStatus
CloudSaveSyncStatus.settled: boolean
CloudSaveSyncStatus.mode: 'pending' | 'guest' | 'synced' | 'offline'
CloudSaveSyncStatus.boundTo: string | null
CloudSaveSyncStatus.offset: number
CloudSaveSyncStatus.forked: string[]
CloudSaveSyncStatus.dirty: string[]
CloudSaveSyncStatus.player: SyncPlayer
class CloudSaveSync
CloudSaveSync.adapter: CloudSyncAdapter
CloudSaveSync.constructor(private readonly deps: CloudSaveSyncDeps)
CloudSaveSync.start(): void
CloudSaveSync.whenSettled(capMs: number): Promise<void>
CloudSaveSync.flushNow(options: { keepalive: boolean }): void
CloudSaveSync.dispose(): void
CloudSaveSync.getStatus(): CloudSaveSyncStatus
CloudSaveSync.abandon(): void

## engine/persistence/CloudSyncAdapter.ts
interface CloudSyncHooks — Sync notifications; called AFTER the local write/delete succeeded. Must not throw.
CloudSyncHooks.onWrite(slot: string, value: string): void
CloudSyncHooks.onDelete(slot: string): void
class CloudSyncAdapter implements StorageAdapter
CloudSyncAdapter.constructor(private readonly inner: StorageAdapter, gameId: string, private readonly hooks: CloudSyncHooks)
CloudSyncAdapter.getItem(key: string): string | null
CloudSyncAdapter.setItem(key: string, value: string): void
CloudSyncAdapter.removeItem(key: string): void
CloudSyncAdapter.hasItem(key: string): boolean
CloudSyncAdapter.listKeys(prefix?: string): string[]
CloudSyncAdapter.isAvailable(): boolean
CloudSyncAdapter.hasTouched(slot: string): boolean
CloudSyncAdapter.touchedSlots(): ReadonlySet<string>

## engine/persistence/EngineCloudSaves.ts
function prewarmPlayerToken(): void
function installCloudSaves(gameId: string): CloudSaveSync
function gateCloudSaves(): Promise<void>
function disposeCloudSaves(): void
function getCloudSaveStatus(): CloudSaveSyncStatus | null
function resetPlayerData(): number

## engine/persistence/GamePersistence.ts
interface SaveEnvelope — Data envelope stored in the adapter.
SaveEnvelope.gameId: string
SaveEnvelope.version: number
SaveEnvelope.savedAt: number
SaveEnvelope.slot: string
SaveEnvelope.data: unknown
type MigrationFn = (oldData: unknown) => unknown
type MigrationMap = Record<number, MigrationFn>
interface SaveResult
SaveResult.success: boolean
SaveResult.error?: string
interface LoadResult<T = unknown>
LoadResult.data: T | null
LoadResult.version: number | null
LoadResult.migrated: boolean
LoadResult.error?: string
interface PersistenceNotificationConfig — Configuration for automatic save/load notifications.
PersistenceNotificationConfig.enabled: boolean
PersistenceNotificationConfig.saveMessage: string
PersistenceNotificationConfig.loadMessage: string
PersistenceNotificationConfig.durationMs: number
class GamePersistence
GamePersistence.constructor(adapter: StorageAdapter, gameId: string, version: number)
GamePersistence.setNotification(config: Partial<PersistenceNotificationConfig>): void
GamePersistence.registerMigrations(migrations: MigrationMap): void
GamePersistence.save(data: unknown, slot: string = 'default', name?: string): SaveResult
GamePersistence.load<T = unknown>(slot: string = 'default', name?: string): LoadResult<T>
GamePersistence.loadRaw(slot: string = 'default'): SaveEnvelope | null
GamePersistence.deleteSave(slot: string = 'default'): void
GamePersistence.hasSave(slot: string = 'default'): boolean
GamePersistence.listSlots(): string[]

## engine/persistence/LocalAccountTransport.ts
interface StorageLike — The subset of the DOM `Storage` interface the local-player helpers use (injectable for tests).
StorageLike.readonly length: number
StorageLike.key(index: number): string | null
StorageLike.getItem(key: string): string | null
StorageLike.setItem(key: string, value: string): void
StorageLike.removeItem(key: string): void
const LOCAL_ACCOUNT_KEY_PREFIX = 'bm-local-account-'
const LOCAL_ACCOUNT_MAX_PAYLOAD_BYTES = 256 * 1024
class LocalAccountTransport implements CloudSaveTransport
LocalAccountTransport.constructor(gameId: string, private readonly accountKey: string, private readonly storage: StorageLike | null, private readonly now: () => number)
LocalAccountTransport.list(): Promise<ServerSaveIndex | null>
LocalAccountTransport.get(_token: string, slot: string): Promise<ServerSave | 'missing' | null>
LocalAccountTransport.put(_token: string, slot: string, body: { savedAt: number; version: number; payload: string }): Promise<CloudWriteResult | null>
LocalAccountTransport.del(_token: string, slot: string, deletedAt: number): Promise<CloudWriteResult | null>

## engine/persistence/LocalPlayer.ts
interface LocalPlayer
LocalPlayer.id: string
LocalPlayer.createdAt: number
const LOCAL_PLAYER_KEY = 'bm-local-player'
function localStorageOrNull(): StorageLike | null
function getLocalPlayer(storage: StorageLike | null = localStorageOrNull()): LocalPlayer
function resetLocalPlayer(storage: StorageLike | null = localStorageOrNull()): LocalPlayer
function playerDataKeyPrefixes(gameId: string): string[]
function wipePlayerData(gameId: string, storage: StorageLike | null = localStorageOrNull()): number

## engine/persistence/StorageAdapter.ts
interface StorageAdapter — Abstract storage contract for game persistence.
StorageAdapter.getItem(key: string): string | null
StorageAdapter.setItem(key: string, value: string): void
StorageAdapter.removeItem(key: string): void
StorageAdapter.hasItem(key: string): boolean
StorageAdapter.listKeys(prefix?: string): string[]
StorageAdapter.isAvailable(): boolean
class StorageError extends Error
StorageError.constructor(message: string, public readonly cause?: unknown)
const SAVE_KEY_PREFIX = 'bm-save-'
class LocalStorageAdapter implements StorageAdapter
LocalStorageAdapter.getItem(key: string): string | null
LocalStorageAdapter.setItem(key: string, value: string): void
LocalStorageAdapter.removeItem(key: string): void
LocalStorageAdapter.hasItem(key: string): boolean
LocalStorageAdapter.listKeys(prefix?: string): string[]
LocalStorageAdapter.isAvailable(): boolean
