import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { CameraMode } from 'engine/ICameraController.js';
import type { VxlEyeLook } from 'engine/loaders/VxlCharacterEyes.js';
import type { VehicleAssetFitment } from 'types/vehicleFitment.js';
import type { SmartObjectFitment } from 'types/smartObject.js';
import ASSET_MAP from 'bundle/BundledAssetData.js';

// In standalone publishes ASSET_MAP holds URL → data URL entries; in dev it's empty.
// Game code (incl. agent-generated) should route external asset URLs through this
// so they resolve to the inlined base64 data in standalone/Poki bundles. The
// DefaultLoadingManager hook only covers Three.js loaders, not CSS/DOM URLs.
export function resolveAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return ASSET_MAP.get(url) ?? url;
}

/**
 * ════════════════════════════════════════════════════════════════════════════════
 * 📝 NOTE: Physics Engine (Rapier)
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * This project uses Rapier physics engine (@dimforge/rapier3d-compat).
 * Import Rapier types from 'engine/physics/index.js' or '@dimforge/rapier3d-compat'.
 * 
 * For physics world access, use engine.physicsWorld which is a PhysicsWorld wrapper.
 * ════════════════════════════════════════════════════════════════════════════════
 */

export type Vector3Like = { x: number; y: number; z: number };
export type StartupUiMode = 'engine' | 'external';

/**
 * Interface for world generators that provide terrain friction.
 * If a world generator implements this, the PlayerController will automatically
 * apply the terrain friction to the movement system when the player is grounded.
 *
 * Example usage in WorldGenerator:
 * ```typescript
 * export class WorldGenerator implements TerrainFrictionProvider {
 *     getTerrainFriction(): number {
 *         return 0.01; // Ice-like slippery surface
 *     }
 * }
 * ```
 */
export interface TerrainFrictionProvider {
  getTerrainFriction(): number;
}

export interface GaussianSplatConfig {
  url: string;
  lowResUrl?: string;
  /** Pre-built LoD .RAD file URL for paged streaming. Built by build-lod from the SPZ. */
  radUrl?: string;
  /** VXL voxel collider URL for this splat. Built by voxelization in the Splats editor. */
  voxelUrl?: string;
  /**
   * Editor-only downsampled point preview (`.points` format, ~5% of the
   * source gaussians rendered as plain `THREE.Points`). Generated at upload
   * time. The renderer prefers this in creator mode so the editor stays
   * responsive on big splats; voxelize / runtime play still read `url`.
   */
  previewUrl?: string;
  /** Floor mesh collision URL for this splat. */
  floorMeshUrl?: string;
  /** Walkable-map JSON URL for this splat — flood-fill reachability bake from the spawn point. Restored visualizer on load. */
  walkableUrl?: string;
  /** PVS binary URL for this splat — per-walkable-cell visible voxel sets. Loaded after walkableUrl when present. */
  pvsUrl?: string;
  /**
   * Triangle-mesh collider GLB URL. Generated server-side by splat-transform
   * with --collision-mesh. When set and `colliderType !== 'voxel'`, the
   * renderer builds a Rapier trimesh from this GLB and skips the voxel
   * collider path entirely.
   */
  colliderUrl?: string;
  /** Runtime override: 'mesh' uses colliderUrl, 'voxel' uses the legacy voxel collider, undefined defaults to 'mesh' if colliderUrl is set. */
  colliderType?: 'mesh' | 'voxel';
  position: Vector3Like;
  /** Rotation in radians (standard engine convention). */
  eulerAngles?: Vector3Like;
  scale?: Vector3Like;
}

export interface AnimationDefinition {
  animationUrl: string;
  motionId: string;
  prompt?: string;
}

export interface BaseAnimationDefinition {
  animationUrl: string;
  motionId: string;
  name: string;
  worksWithAttachedObjects?: boolean; // If true, animation works when object is attached to hand. Defaults to true for backward compatibility.
  source?: 'mixamo'; // If set, uses MixamoAnimationPlayer for bone name remapping during playback.
  /** For in-place animations: the speed (m/s) at which this animation looks natural.
   *  Used as fallback when root motion is absent or too small. */
  designSpeed?: number;
}

/**
 * Custom attack move definition for template-controlled fighting moves.
 * Allows templates to define custom attacks with specific animations and combat properties.
 */
export interface CustomAttackMove {
  /** Unique identifier for this attack move */
  name: string;
  /** Motion ID of the animation to play (from animations array) */
  animationMotionId: string;
  /** Type of attack - affects hit detection (hand vs foot bone) */
  type: 'punch' | 'kick' | 'attack';
  /** Which side the attack comes from - affects which bone is used for hit detection */
  side?: 'left' | 'right';
  /** Damage/impulse strength (default: punch=8, kick=12) */
  damage?: number;
  /** Attack range in meters (default: 2.0) */
  range?: number;
  /** Force multiplier for physics knockback (default: punch=200, kick=300) */
  force?: number;
  /** Animation playback rate (default: 1.0). Combat moves usually feel right at 1.5. */
  speed?: number;
  /** When true, the attack animation is cancelled the moment the player has
   *  movement input and locomotion resumes. Use for moves that should yield
   *  to player control mid-swing (e.g. kicks). */
  interruptOnMovement?: boolean;
  /** When true, during a run the legs keep cycling and only the upper body
   *  plays the attack clip — same effect as a melee-strike during a run.
   *  Use for upper-body attacks (punches, throws, casts) so the player
   *  doesn't visually slide. Has no effect when standing still. */
  splitBodyOnRun?: boolean;
  /** When true, the clip's hips translation track is locked so physics owns
   *  the character's position and the visual rotates in place. Use for
   *  in-place attacks (punches, jabs, idle gestures). Set false when the
   *  translation IS the action — e.g. a soccer kick stepping into the ball. */
  filterRootMotion?: boolean;
}

/**
 * Combat configuration for custom fighting moves
 */
export interface CombatConfig {
  /** Custom attack moves that can be triggered */
  customMoves?: CustomAttackMove[];
  /** If true, only use custom moves (don't include default punch/kick animations) */
  useOnlyCustomMoves?: boolean;
}

/**
 * Game metadata stored in game.json
 * These fields are read-only for AI agents but can be edited by the publishing system.
 * These fields are NOT duplicated in worldProfileData - they only exist in game.json.
 */
export interface GameMetadata {
  gameId: string;
  gameGenre: string;
  gameName: string;
  gameDescription: string;
  characterUrl: string;
  thumbnailUrl: string;
  environmentObjectsGeneratedProcedurally?: boolean; // true = procedural, false = loaded from world.json (immutable, set at game creation)
  gameDimension?: '2d' | '3d'; // the game's declared dimension (World-Forger 2D routing); absent = '3d' (backward compat)
  physicsMode?: '2d' | '3d'; // physics world (Rapier 2D vs 3D); absent = genre default
  /** This game's TEMPLATE CODE targets the 2D physics world. Set by templates that
   *  ship 2D-capable source; absent on every game predating them, which is what
   *  keeps `physicsMode: '2d'` from switching an old game's solver. */
  physics2d?: boolean;
  /**
   * How the 3D game is built: voxels (the default, and every game made before the field
   * existed) or low-poly meshes (a Blender-built `MeshLevel` world). Steers the engine's
   * lighting/bloom presets and, in the CLI, cover/reference prompts and asset defaults.
   * Set once at creation like the other metadata; the literal union is mirrored by
   * `ART_STYLES` in `@bitmagic/asset-core`.
   */
  artStyle?: 'voxel' | 'low-poly';
}

/**
 * One typed spawn point in the unified `worldProfileData.spawnPoints` array —
 * THE place for every "something starts here" position so games don't grow
 * per-category arrays. `type` is open vocabulary: `player` is engine-consumed
 * (first entry = canonical start; all entries feed multiplayer spread via
 * `NetworkManager.getMultiplayerSpawnPoints`); `npc` | `animal` | `vehicle` |
 * anything else is consumed by game code via `engine.getSpawnPoints(type)`.
 */
export interface SpawnPoint {
  id: string;
  type: string;
  position: Vector3Like;
  rotationY: number;
  /** Display name for editors/inspectors. */
  name?: string;
  /** Type-specific payload (e.g. npc: archetype/behavior/count, vehicle: vehicleType). */
  params?: Record<string, unknown>;
}

/**
 * Per-level overrides applied over the game-global WorldProfileData while
 * this level is active. Enumerated subset — adding a field here requires a
 * matching re-apply path in GameEngine.applyLevelAtmosphere().
 */
export interface WorldLevelOverrides {
  skyboxUrl?: string;
  fogConfig?: FogConfig;
  lightingConfig?: LightingConfig;
  /**
   * This level's see-through water plane. `null` means NO water on this level
   * even when the world's own `waterLevelY` has one — a level with no water
   * has to say so, or it inherits whatever another level set as the default.
   */
  waterLevelY?: number | null;
  weatherConfig?: WeatherConfig;
}

/**
 * One entry in the multi-level registry (`worldProfileData.levels`). A level
 * references a baked `.vwld` asset (`assets[]` entry of type 'vwld') and owns
 * its spawn points + atmosphere overrides. Placed instances are tagged to a
 * level via their optional `levelId`; untagged instances are global (load in
 * every level). Legacy mirror invariant: `voxelUrl`, `spawnPoints` and
 * `playerSpawnPosition` always mirror the START level so frozen game code
 * boots correctly.
 */
export interface WorldLevel {
  id: string;
  name: string;
  vwldAssetId: string;
  spawnPoints?: SpawnPoint[];
  overrides?: WorldLevelOverrides;
}

/**
 * One pre-play selection step on the main screen
 * (`worldProfileData.hud.startScreen.selections[]`). Two kinds:
 *
 *   - `type: 'level'` — a level chooser. Options come from the level registry
 *     (`worldProfileData.levels[]`), optionally filtered by `levelIds`. The
 *     pick decides which level BOOTS, so it is presented before the world
 *     loads; skipped when the game has fewer than two offered levels.
 *   - `type: 'choice'` — a free-form choice (difficulty, character, team, …)
 *     presented after loading, before the Play button. The picked option id
 *     is exposed to game code via `engine.getPreGameSelections()[id]`.
 *
 * Steps are presented in array order within each of those two groups. Auto-
 * skipping flows (editor preview, `?autostart=1`) take the defaults instead:
 * the configured start level / each step's first option.
 */
export interface StartScreenSelection {
  /** Stable key the pick is stored under (e.g. `'level'`, `'difficulty'`). */
  id: string;
  type: 'level' | 'choice';
  /** Heading shown above the options; falls back to a generic translated one. */
  title?: string;
  /** type:'level' only — subset of level ids to offer; default: all levels. */
  levelIds?: string[];
  /** type:'choice' only — the options to offer (min 2 to be presented). */
  options?: Array<{ id: string; label: string; imageUrl?: string }>;
}

/**
 * Hotspot — declarative regional structure expanded at world-generation time.
 * Discriminated union on `type`. See `worldProfileData.hotspots` and the
 * registered interpreters under `engine/hotspots/`.
 */
export type Hotspot = VillageHotspot | TowerHotspot | BuildingHotspot;

/**
 * One wall opening of a `BuildingHotspot`. Sides are world-axis-aligned:
 * `north` = the wall at max Z, `south` = min Z, `east` = max X, `west` = min X.
 * `offset` slides the opening along its wall from the wall's center, in meters
 * (positive = toward +X on north/south walls, toward +Z on east/west walls).
 */
export interface BuildingOpening {
  side: 'north' | 'south' | 'east' | 'west';
  /** Offset along the wall from its center, meters. Default 0 (centered). */
  offset?: number;
  /** Opening width in meters. Defaults: doors 2, windows 1.5. */
  width?: number;
  /** Opening height in meters. Defaults: doors 2.5, windows 1. */
  height?: number;
}

/**
 * Parametric ENTERABLE building painted from terrain voxel blocks at
 * world-generation time: hollow interior on a flattened lot, guaranteed
 * doorway(s), optional windows, optional flat roof. THE way to build team
 * bases, spawn rooms, houses, shops — anything players must walk in and out
 * of. Decorative building ASSETS voxelize as closed shells; never place a
 * spawn point inside one of those. Axis-aligned (no rotation).
 */
export interface BuildingHotspot {
  /** Unique id within the world. */
  id: string;
  type: 'building';
  /** Center of the INTERIOR footprint in world-space meters. Y from terrain. */
  center: { x: number; z: number };
  /** INTERIOR clear size in meters (the 1-block walls sit just outside this). */
  size: { x: number; z: number };
  /** Interior clear height in meters. Default 3. */
  wallHeight?: number;
  /** Wall block-type name (e.g. 'STONE', 'BRICK', custom block). Default 'STONE'. */
  wallBlockType?: string;
  /** 'flat' paints a roof slab over walls + interior; 'none' leaves it open to the sky. Default 'flat'. */
  roof?: 'flat' | 'none';
  /** Roof block-type name. Defaults to the wall block. */
  roofBlockType?: string;
  /** Block type for the flattened lot under/around the building. Defaults to `STONE`. */
  foundationBlockType?: string;
  /**
   * Doorways — full openings from the floor up (a lintel remains above).
   * A building with no exit is never built: when this is missing or empty the
   * interpreter adds a centered south door and logs a warning.
   */
  doors?: BuildingOpening[];
  /** Window openings; `sillY` = bottom of the window above the floor, meters (default 1). */
  windows?: Array<BuildingOpening & { sillY?: number }>;
}

/**
 * Cluster of buildings within a circular region. Each building gets its own
 * carved foundation via `flattenArea` before the asset is placed. Building
 * assets are picked round-robin from `buildingAssetIds` (deterministic, seeded
 * from `id`).
 */
export interface VillageHotspot {
  /** Unique id within the world. Used as the seed for building placement. */
  id: string;
  type: 'village';
  /** Center of the village in world-space meters. Y is taken from terrain. */
  center: { x: number; z: number };
  /** Radius of the village footprint in meters. Buildings are placed inside this circle. */
  radius: number;
  /** Asset ids to pick from. Each building uses one of these (round-robin + jitter). MUST be non-empty. */
  buildingAssetIds: string[];
  /**
   * Buildings per square meter inside the radius. Default 0.05 (one building per 20m²
   * — a small village of ~6 houses fills a 20m-radius (≈1257m²) hotspot). Clamped to [0, 1].
   * Typical values: 0.02 (sparse hamlet), 0.05 (default), 0.10 (dense town center).
   */
  density?: number;
  /** Block type used for the carved foundation under each building. Defaults to `STONE`. */
  foundationBlockType?: string;
}

/**
 * Single vertical structure with a carved foundation. Position is `center`;
 * the asset's footprint dictates the lot size.
 */
export interface TowerHotspot {
  /** Unique id. */
  id: string;
  type: 'tower';
  /** Tower base position in world-space meters. */
  center: { x: number; z: number };
  /** Asset id — the tower's mesh. The asset's bbox dictates flatten footprint. */
  assetId: string;
  /** Block type used for the carved foundation under the tower. Defaults to `STONE`. */
  foundationBlockType?: string;
}

export interface CustomBlockType {
  /** Stable identifier referenced by `terrain.groundBlockType` and `create-voxel-asset`. Lowercase snake_case. */
  name: string;
  /** Human-friendly label for UI. Optional — defaults to a title-cased `name`. */
  displayName?: string;
  /** Free-form description; carried for documentation only, not used at runtime. */
  description?: string;
  /** URL of the top-face texture. May be a remote URL or a `data:` URL (e.g., flat-color synthesis). */
  textureUrl: string;
  /** Optional side-face texture URL. `null`/omitted = use top texture for all faces. */
  sideTextureUrl?: string | null;
  /** Source texture size in pixels (e.g., 16, 32, 64). Atlas downsamples/upsamples as needed. */
  textureSize: number;
  /** If true, the block is treated as fluid (e.g., flow rules, no collision). Voxel-only. */
  isFluid?: boolean;
  /** Render opacity 0-1; <1 enables transparency. */
  opacity?: number;
  /** ISO-8601 timestamp recorded by the agent tool when the block was generated. */
  createdAt?: string;
}

/**
 * A single viewport edge inset for top-down fit-world UI reservation. Specify in
 * CSS pixels (`px`) OR as a fraction (0..1) of the viewport dimension
 * (`fraction`). If both are set, `px` takes precedence.
 */
export interface FitWorldInset {
  px?: number;
  fraction?: number;
}

/**
 * Viewport edges to reserve for in-game UI so the fitted top-down map fills the
 * remaining space. Omitted sides reserve nothing. `left`/`right` are fractions of
 * width; `top`/`bottom` of height.
 */
export interface FitWorldRegion {
  left?: FitWorldInset;
  right?: FitWorldInset;
  top?: FitWorldInset;
  bottom?: FitWorldInset;
}

/**
 * A player-progression achievement definition (umbrella P6). Authored by the
 * agent's `manage-achievements` tool into `world.json` (the single
 * engine-readable + publish source). The engine reads these only to resolve the
 * display name for the unlock toast; the api-server is authoritative for XP and
 * unlock persistence, and re-validates the definition on every unlock.
 */
export interface AchievementDefinition {
  /** Stable slug (`[a-z0-9_]`) game code passes to `engine.unlockAchievement()`. */
  achievementId: string;
  /** Display name shown in the unlock toast and portal listings. */
  name: string;
  /** Optional longer description for portal listings. */
  description?: string;
  /** AI-generated badge icon URL (rehosted to the game bucket); null/absent = not generated. */
  imageUrl?: string | null;
  /** XP awarded on first unlock (server clamps to the configured maximum). */
  xp?: number;
  /** When true, masked in public listings until the viewer has unlocked it. */
  hidden?: boolean;
}

/**
 * A door definition for the data-driven dungeon door system
 * (`worldProfileData.doors`). Interpreted by `DoorSystem`/`DungeonDoor` (see
 * `engine/doors/`) into a kinematic door entity with optional locking,
 * proximity auto-open, and one of three leaf animations. `levelId` scopes
 * the door to one level in a multi-level world; omitted = global (present in
 * every level).
 */
export interface DoorDefinition {
  /** Unique id within the world; used by `DoorSystem`'s open/close/lock/unlock API. */
  id: string;
  /** Level this door belongs to (see `WorldLevel`). Omitted = global. */
  levelId?: string;
  /** World-space center of the door when closed. */
  position: Vector3Like;
  /** Yaw rotation in radians around the Y axis. */
  rotationY: number;
  /** Door width (door-local X) in meters. */
  width: number;
  /** Door height (door-local Y) in meters. */
  height: number;
  /** Door thickness (door-local Z) in meters. */
  thickness: number;
  /**
   * `'plain'` auto-opens on proximity for anyone. `'locked'` stays shut (and
   * blocks pathing) until `keyId` is granted or `DoorSystem.unlockDoor()` is
   * called.
   */
  kind: 'plain' | 'locked';
  /** Key id required to unlock, when `kind === 'locked'`. Matches a `KeyItemDefinition.keyId`. */
  keyId?: string;
  /** How the door leaf moves when opening. */
  animation: 'hinge' | 'slide' | 'dissolve';
  /**
   * Maximum hinge opening angle in degrees. Omitted preserves the published
   * legacy 100-degree swing.
   */
  maxOpenAngleDeg?: number;
  /** VXL/GLB asset id for the door leaf. Absent = engine box mesh fallback. */
  assetId?: string;
  /** Fallback box mesh tint (hex string) when `assetId` is absent. */
  color?: string;
  /** Proximity radius (meters) that auto-opens an unlocked door. Default `DEFAULT_DOOR_AUTO_OPEN_RADIUS` (2.5) — see `engine/doors/DungeonDoor.ts`. */
  autoOpenRadius?: number;
}

/**
 * A key pickup definition for the data-driven dungeon door system
 * (`worldProfileData.keyItems`). Spawned by `DoorSystem` as a `KeyPickup`
 * (see `engine/doors/`); collecting it grants `keyId` on the shared
 * `Keyring`, unlocking any `DoorDefinition` that requires it. `levelId`
 * scopes the pickup to one level; omitted = global.
 */
export interface KeyItemDefinition {
  /** Unique id within the world. */
  id: string;
  /** Key id granted on collection — matches a `DoorDefinition.keyId`. */
  keyId: string;
  /** Level this pickup belongs to (see `WorldLevel`). Omitted = global. */
  levelId?: string;
  /** Display name shown in the pickup notification. */
  name: string;
  /** World-space position of the pickup. */
  position: Vector3Like;
  /** VXL/GLB asset id for the pickup visual. Absent = engine box mesh fallback. */
  assetId?: string;
  /** Fallback box mesh tint (hex string) when `assetId` is absent. */
  color?: string;
}

/**
 * World profile data stored in world.json
 * These fields are AI-editable runtime configuration.
 * Metadata fields (gameGenre, characterUrl, gameName, etc.) are in game.json only.
 */
export interface WorldProfileData {
  skyboxUrl?: string;
  /**
   * Optional override for the published link-preview / listing thumbnail (the
   * Open Graph image). When set to an uploaded image URL (e.g. a webp cover),
   * publish/export uses it instead of capturing a screenshot. Must be https.
   *
   * Deliberately named distinctly from the metadata `thumbnailUrl` (which lives
   * in game.json and holds the auto-captured screenshot) so the world.json split
   * migration never strips it from worldProfileData. The override always wins
   * over the auto thumbnail at publish time.
   */
  thumbnailUrlOverride?: string;
  /**
   * Optional override for the published game description (the Open Graph
   * description + stored gameDescription). When set, publish uses it instead of
   * auto-generating one. Named distinctly from the legacy `description` key so the
   * split migration leaves it in worldProfileData.
   */
  descriptionOverride?: string;
  /**
   * Optional override for the published game's browser-tab icon. When set, publish
   * derives the favicon from THIS image; when unset it derives one from the game's
   * cover art, and falls back to the Bitmagic mark only when the game has no art at
   * all. Must be https; any size is fine, publish normalises it to a 64x64 PNG.
   *
   * Named distinctly from `thumbnailUrlOverride` because a tab icon and a link-preview
   * card want different crops — a 16px-wide square cannot carry what an OG banner does.
   * Carries the same `Override` suffix so the split migration leaves it in
   * worldProfileData.
   */
  faviconUrlOverride?: string;
  heightmapUrl?: string;
  characterHeight?: number;
  playerSpawnPosition?: Vector3Like;
  playerSpawnRotationY?: number;
  spawnPoints?: SpawnPoint[];
  worldSeed?: number;
  /**
   * On-demand highres character toggle. The DEFAULT player look is the clean
   * BoxGeometry block mascot; the loaded GLB serves only as the hidden animation
   * rig. Set `true` (done automatically by `generate_character` when applyToPlayer)
   * to instead render the loaded `characterUrl` as a real skinned highres mesh.
   *
   * Render rule (PlayerLoader): highres requires an actual custom `characterUrl` GLB —
   * `renderSkinned = hasCustomCharacterUrl && (useHighResCharacter ?? true)`. With a custom
   * URL, render skinned unless this flag is explicitly `false`; with no custom URL there is
   * no highres asset, so the clean block is always shown (even if this flag is `true`).
   */
  useHighResCharacter?: boolean;
  /**
   * @deprecated Superseded by `useHighResCharacter` (block is now the default).
   * Legacy inverse toggle: `true` forced the block character, `false` forced the
   * skinned mesh. Still honoured for back-compat — when set, it overrides the
   * `useHighResCharacter` inference (`useBlockCharacter:true` → block,
   * `useBlockCharacter:false` → skinned).
   */
  useBlockCharacter?: boolean;
  /**
   * Editable override for the player's character model GLB. When set, PlayerLoader
   * loads this instead of the built-in default (AnimationAssets.characterUrls.default).
   * Typically a rigged voxel GLB from Asset Forger via the `generate_character` tool
   * (rerigTarget:'default', Mixamo Y-up). Empty/undefined → built-in default rig.
   * Used both as the animation rig (always) and, when highres is requested, as the
   * visible skinned mesh.
   */
  characterUrl?: string;
  /**
   * Optional yaw correction (radians) applied to a custom character's visible
   * skinned mesh at load time. Use when a custom `characterUrl` GLB is authored
   * facing the wrong way and renders backward (movement stays correct, only the
   * mesh faces away from travel). `Math.PI` (≈ 3.14159) turns a back-to-front
   * asset around. Applied only on the skinned-render path (the block character is
   * hidden there); unset/undefined leaves the asset's authored orientation as-is.
   */
  characterModelRotationY?: number;
  /**
   * Eye colours for every NPC of this type — the manual override of the look a
   * rigged voxel character's eye record implies. `EVIL_VXL_EYE_LOOK` (black eyes,
   * glowing red pupils) marks a monster; build your own from `DEFAULT_VXL_EYE_LOOK`.
   * No effect on a character without eye metadata.
   */
  eyeLook?: VxlEyeLook;
  /**
   * Block-character pose-convention version (default `1`). Controls how
   * `BlockCharacterRenderer` orients the torso group:
   * - `1` (legacy): torso local +Z faces BACKWARD; factories compensate by flipping
   *   the torso body mesh 180° (`torsoBodyMesh.rotation.y = Math.PI`). The behaviour
   *   hundreds of existing games were authored against — do not change it.
   * - `2`: the engine flips the torso group so its local +Z faces FRONT, matching the
   *   head and the documented "+Z = front" convention. Factories then place all
   *   torso details at +Z (and back details like a tail at −Z) directly, with no
   *   per-mesh flip. New games opt in via their template world.json.
   *
   * Only `1` and `2` are defined; unset/undefined ⇒ `1`.
   */
  characterPoseVersion?: number;
  /**
   * Player movement mode installed at spawn when genre code passes no
   * explicit movement system: 'ski' (engine/ski/) or 'boat' (engine/boat/).
   * The optional `ski` / `boat` objects hold Partial<SkiConfig> /
   * Partial<BoatConfig> overrides (plain numbers/booleans; unknown keys
   * ignored). Editable via the agent's edit-world-config path-based
   * modifications.
   *
   * A 'boat' installed this way starts on FLAT water at y = 0. Game code must
   * hand it the live ocean — `boatMovement.setWaterSurface(ocean)` — for it to
   * ride actual waves; see `agent-docs/mechanic-boat-racing.md`.
   */
  playerMovement?: {
    mode: 'ski' | 'boat';
    ski?: Record<string, number | boolean>;
    boat?: Record<string, number | boolean>;
  };
  /**
   * Persistent shared world. When true, mining/placing voxels at runtime is
   * captured by the WorldShardSync system (`game/src/engine/networking/`) and
   * streamed to game-server's `world-shards` Firestore collection — every
   * subsequent session restores the cumulative diff on top of procedural
   * terrain. Toggle by editing world.json via the agent's edit-world-config
   * endpoint. See `game/agent-docs/world-persistence.md`.
   * Off by default.
   */
  persistentWorld?: boolean;
  /**
   * Build and bake the level's vehicle nav grid (`getGlobalVehicleNav()`, what
   * `VehiclePathDrivingComponent` plans against). Default: true. Set false in a
   * game with no AI-driven vehicles: the bake is a time-sliced collider raycast
   * over every drivable cell, run TWICE (a revalidation sweep follows the first),
   * and on a forged city it steps ~4 ms of most frames for minutes after load —
   * measured 16% of the main thread in a game that never spawns a vehicle.
   */
  vehicleNavGrid?: boolean;
  // Bloom post-processing configuration (AI agents can adjust these values)
  bloomConfig?: BloomConfig;

  // Renderer color pipeline (tone mapping + exposure). AI agents author via
  // the configure-game tool (configType="render"). Defaults: ACESFilmic, 1.0.
  renderConfig?: RenderConfig;

  // Scene fog + sky fallback color. AI agents author via the configure-game
  // tool (configType="fog"). Default: enabled, sky-blue, near=10, far=500.
  fogConfig?: FogConfig;

  // Scene lighting (sun / ambient / sky brightness multipliers). AI agents
  // author via the configure-game tool (configType="lighting"). Defaults keep
  // the classic full-daylight look; lower them for dark interiors and night.
  lightingConfig?: LightingConfig;

  // Depth-of-field post effect (BokehPass). AI agents author via
  // configure-game tool (configType="dof"). Disabled by default.
  dofConfig?: DofConfig;

  // Screen-space ambient occlusion post effect (GTAOPass). AI agents author
  // via configure-game tool (configType="ao"). Disabled by default.
  aoConfig?: AoConfig;

  // Grass/pebble ground cover grown from a forged level's ground mask. AI agents
  // author via the configure-game tool (configType="groundCover"). Defaults to a
  // light sprinkle; raise density for a thick, mowable field.
  groundCoverConfig?: GroundCoverConfig;

  // Weather: precipitation + wet-surface response (rain, wet asphalt, puddles,
  // reflections). AI agents author via the configure-game tool
  // (configType="weather"). Off by default; per-level override available.
  weatherConfig?: WeatherConfig;

  // ════════════════════════════════════════════════════════════════════════════════
  // 🎬 ANIMATION SYSTEM - Code-Driven Loading
  // ════════════════════════════════════════════════════════════════════════════════
  // 
  // Core animations (Walk, Run, Jump, Idle) are loaded automatically.
  // Combat/weapon animations are loaded by Game templates when they use those features.
  // 
  // Unarmed punch/kick combat uses the core Punching/Kicking clips directly —
  // `UnarmedMeleeSystem` auto-registers them, no extra pack required.
  //
  // Game templates call animController.loadAnimationPack() to load additional packs:
  // - MELEE_WEAPON_ANIMATIONS for sword/axe combat
  //
  // LEGACY: baseAnimations still supported for backward compatibility.
  // ════════════════════════════════════════════════════════════════════════════════
  
  /**
   * Custom animations specific to this game.
   * Loaded lazily when first requested via animation controller.
   */
  animations?: AnimationDefinition[];
  
  /**
   * @deprecated Core animations are now loaded automatically from predefined packs.
   * Legacy: Full list of base animations. If provided, used instead of animation packs.
   */
  baseAnimations?: BaseAnimationDefinition[];
  
  /**
   * @deprecated Weapon animations are loaded by Game templates via loadAnimationPack().
   * Legacy: Weapon-specific animations for melee combat.
   */
  meleeWeaponAnimations?: BaseAnimationDefinition[];
  
  /**
   * Combat configuration for custom fighting moves.
   * Allows templates to define custom attack animations with specific damage/range properties.
   */
  combat?: CombatConfig;
  
  // Ground type settings (stored directly in worldProfileData)
  groundRenderingType?: 'smooth' | 'polygonal';
  groundPolygonSize?: number;
  groundWorldSizeX?: number;
  groundWorldSizeZ?: number;
  groundYGranularity?: number;
  /**
   * Data-driven terrain shape + ground-block override. Lets `world.json` express
   * coarse level mode without forcing the agent to hand-edit `WorldGenerator.ts`.
   *   - `shape: 'flat'` skips procedural noise and emits a constant-Y plane.
   *     Pairs naturally with `cameraMode: 'top-down'` (cities, racetracks,
   *     dungeons, plazas, board games). The engine also treats top-down as
   *     flat-by-default when `terrain` is omitted.
   *   - `shape: 'default'` (or omitted, when not top-down) keeps the existing
   *     per-genre procedural terrain. Forests, islands, wilderness paths.
   *   - `shape: 'none'` builds NO voxel ground and no safety plane: the level's
   *     own geometry (a `MeshLevel` loaded from a GLB, placed objects) IS the
   *     world. Pair it with a `MeshLevel` — or every body falls forever.
   *   - `groundBlockType` (e.g., `'asphalt'`, `'sand'`, `'stone'`, `'grass'`,
   *     or any registered custom block name) overrides the surface block. Falls
   *     back to the genre default when omitted/unrecognized.
   * For PER-AREA material painting (e.g., asphalt circle inside grass), keep
   * editing `generateVoxelTerrain()` directly — see `voxel-terrain-foliage.md`.
   */
  terrain?: {
    shape?: 'flat' | 'default' | 'none';
    groundBlockType?: string;
    /**
     * How many BLOCKS of sub-surface fill below a flat plane's surface block
     * (default 3). The fill is clamped to the world's own floor, so a large
     * value simply means "solid to the bottom". Side-on 2D games set this
     * high: their side camera looks AT the terrain's cross-section, and a
     * three-block band with open sky underneath reads as a floating texture
     * strip rather than ground.
     */
    fillDepthBlocks?: number;
  };
  /**
   * A mesh level the ENGINE loads by itself, the declared counterpart of a game constructing
   * `MeshLevel` in its own code. Read only with `terrain.shape: 'none'`: the world generator loads
   * it before placing environment objects, so they and the spawn land on its colliders. Written
   * for low-poly games (a template's ready-made ground at creation).
   *   - `glbAssetId` — the level GLB, an `assets[]` id of type `glb`.
   *   - `levelAssetId` — a `bitmagic-mesh-level` JSON asset (colliders, landmarks, lights).
   *     Omitted: one trimesh collider per top-level GLB node.
   *   - `spawnLandmark` — put the player at that landmark of the level JSON instead of
   *     `playerSpawnPosition`. Needs `levelAssetId`.
   *   - `lighting` — `MeshLevel`'s lighting mode. `exterior` (the default) leaves the sun and
   *     sky alone, which suits outdoor grounds and forged landscapes; `interior` dims the sun and
   *     lifts the ambient floor for an enclosed level; `none` touches nothing.
   */
  meshLevel?: {
    glbAssetId: string;
    levelAssetId?: string;
    spawnLandmark?: string;
    lighting?: 'interior' | 'exterior' | 'none';
  };
  /**
   * Layered material defaults for flat / lazy-filled terrain. Used by the
   * `setChunkFlat` path in `VoxelWorld` so world generators don't have to
   * call `setBlock` once per voxel for a uniform ground plane.
   *
   *   surfaceBlockType — top voxel material (name from `customBlockTypes`
   *     or a built-in block). Falls back to `terrain.groundBlockType`,
   *     then to the genre default, if omitted.
   *   subLayers        — optional list of materials going downward from
   *     one voxel below the surface. The last entry repeats indefinitely.
   *     If omitted, sub-surface defaults to `surfaceBlockType`.
   */
  groundConfig?: {
    surfaceBlockType?: string;
    subLayers?: string[];
  };
  /**
   * Custom block types persisted by the AI agent (`generateBlockTypeTool`)
   * and loaded into the voxel atlas at world generation. Each entry pairs a
   * stable `name` with a texture URL the engine fetches and packs into the
   * atlas; `terrain.groundBlockType` and `create-voxel-asset` reference the
   * same `name`.
   *
   * Written by the agent tool; read by `BlockRegistry` / template
   * WorldGenerators. Do NOT add `id` here — block IDs are assigned at
   * registration time and not part of the on-disk contract.
   */
  customBlockTypes?: CustomBlockType[];
  /**
   * Declarative regional structures the engine expands at world-generation time.
   * Each hotspot is interpreted by a registered `HotspotInterpreter` (see
   * `engine/hotspots/`); interpreters carve flat foundations into the local
   * terrain via `flattenArea` and inject `environmentObject` entries that the
   * standard scenery loader picks up. Hotspots run in BOTH flat and procedural
   * terrain modes — `flattenArea` is a no-op on already-flat ground.
   *
   * Discriminated union on `type`. Adding a new shape means registering a new
   * interpreter and extending the union here. The validator in
   * `validate-world-json-tool` schema-checks each entry per its `type`.
   */
  hotspots?: Hotspot[];
  // Voxel terrain settings
  voxelBlockSize?: number; // Size of voxel blocks in meters (e.g., 0.25, 0.5, 1, 2)
  // Visibility culling settings
  renderDistance?: number; // Max render distance in meters (default: 150). Affects terrain, foliage, and objects.
  vegetationRenderDistance?: number; // Max render distance for environment objects (trees/bushes). Defaults to max(50, renderDistance * 0.6) so dense vegetation culls closer than terrain to cut draw calls.
  // Camera settings
  cameraMode?: CameraMode; // Camera mode: 'first-person', 'third-person', or 'top-down' (default: 'third-person')
  /**
   * Top-down only: when true, the camera switches to a fixed orthographic view
   * sized so the entire world (groundWorldSizeX/Z) is visible with no empty
   * borders. The camera is centered on the world, looks straight down, does not
   * follow the player, and re-fits on window resize. Ignored unless
   * `cameraMode === 'top-down'`. Note: Gaussian splats and depth-of-field do not
   * render in this view (orthographic projection has no focal length).
   */
  topDownFitWorld?: boolean;
  /**
   * Fit margin for `topDownFitWorld`. 1.0 (default) = the limiting world
   * dimension touches the viewport edges exactly; > 1 adds breathing room.
   */
  topDownFitWorldMargin?: number;
  /**
   * Reserve viewport edges for in-game UI when `topDownFitWorld` is on, so the
   * fitted map fills only the remaining area (e.g. a HUD panel on the right).
   * Each side is optional and specified in CSS pixels or a viewport fraction.
   */
  topDownFitWorldRegion?: FitWorldRegion;
  /**
   * Margin background for `topDownFitWorld`. A straight-down view only shows the
   * skybox as ugly margins around the map, so by default it's replaced with a
   * solid color. Values: a hex color (e.g. `"#d8cfc0"` to match the ground for a
   * seamless look), `"auto"` (default — use the sky/fog color), or `"keep"` (keep
   * the skybox).
   */
  topDownFitWorldBackground?: string;
  /**
   * Whether this game has a visible player character. Default: `true`.
   *
   * When `false`, `PlayerLoader.loadPlayer()` short-circuits to
   * `loadHeadlessPlayer()` — an empty Group + physics capsule, no GLB load,
   * no animations, no block character. Use for first-person bodies, top-down
   * board games, strategy games, or anything where the player isn't a
   * visible humanoid in the scene. The physics body, camera target, and
   * PlayerController still work; nothing visible is built that would later
   * have to be hidden.
   *
   * Also the declaration for a POINTER-DRIVEN game (board, city builder,
   * strategy — played by tapping the scene): when the game is neither
   * first-person nor driving, the engine hides the mobile joystick and
   * jump/crouch, and `bitmagic verify --platform mobile` reads that back
   * (`PlayerController.getMobileMovementControlsAvailable()`) to treat a phone
   * run with no touch controls as the declared state rather than a gap. See
   * `agent-docs/control-system.md` → Movement Controls Availability.
   */
  hasPlayerCharacter?: boolean;
  // Mouse pointer settings
  useFreeMouse?: boolean; // If true, mouse pointer is not locked during gameplay (for point-and-click, strategy games)
  // Mobile orientation lock — on published mobile games, locks screen to this orientation (no effect on desktop)
  mobileOrientation?: 'portrait' | 'landscape';
  // Environment objects generation mode
  /** @deprecated Use GameData.environmentObjectsGeneratedProcedurally (from game.json). Kept for backward compat with old templates. */
  environmentObjectsGeneratedProcedurally?: boolean;
  // Markers array for AI agent reference
  markers?: Array<{
    id: string;
    name: string;
    color: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
  }>;
  // S3 URLs for generated collider assets
  voxelUrl?: string;
  voxelTimestamp?: number;
  /**
   * Multi-level registry. When non-empty the game is in "levels mode":
   * the engine boots the start level, `loadLevel()` switches at runtime,
   * and instances/spawns are filtered by level. See WorldLevel.
   */
  levels?: WorldLevel[];
  /** Level loaded at boot; defaults to levels[0]. Must exist in levels[]. */
  startLevelId?: string;
  floorMeshUrl?: string;
  colliderUrl?: string;
  // Scene-wide baked visibility (PVS) for splat-less voxel/GLB levels — loaded
  // at runtime into GameEngine.pvsController. Per-splat scenes use the matching
  // fields on the env-object instead.
  walkableUrl?: string;
  walkableFileSize?: number;
  pvsUrl?: string;
  pvsFileSize?: number;
  cameraPathUrl?: string;

  /**
   * Sea level (world Y) for coastal levels. When set, the engine renders ONE transparent
   * animated water-surface plane spanning the level at this Y: the higher land terrain
   * occludes it and the carved water basins below it reveal it (so no per-zone clipping is
   * needed). The forger sets this when a city has water zones and voxelizes the basin floor
   * as the visible seafloor seen through the see-through surface.
   */
  waterLevelY?: number;

  /**
   * Open-water world (boat racing and anything else played on the open sea):
   * an engine-owned animated ocean, no terrain. See {@link OpenWaterConfig} —
   * and note it is mutually exclusive with `waterLevelY` above.
   */
  openWater?: OpenWaterConfig;

  /**
   * HUD visual theme + screen content for this game.
   *   - theme: name of a built-in preset (`'rift-raider'`, `'village-keep'`,
   *     `'nexus'`, `'simulator'`, `'racing'`) OR an inline theme tokens object.
   *     See `engine/hud/presets.ts`. Omit it for the engine's default look;
   *     unknown or invalid themes fall back to that default with a console warning.
   *   - startScreen: per-game overrides for the engine start screen. Title
   *     falls back to `gameData.gameName` when omitted; image and play label
   *     are optional. `selections` adds pre-play choices to the main screen
   *     (level chooser, character/difficulty/etc.) — see StartScreenSelection.
   * `theme` is authored via the `write_hud_theme` agent tool; `startScreen`
   * is edited directly in `world.json` (no dedicated tool).
   */
  hud?: {
    theme?: string | Record<string, unknown>;
    /**
     * The engine's touch pause button (top-right corner on phones; desktop uses
     * Escape and never shows it). `'auto'` (default) shows it; `'hidden'` removes
     * it and frees the `top-right` mobile button slot for the game's own actions.
     *
     * Hiding it removes the ONLY built-in way a phone reaches the pause card, and
     * with it Resume, the mute toggle and the graphics-quality row — so hide it
     * only in a game that opens the card itself:
     * `getGameStateManager().setPaused(true, 'manual')`.
     */
    pauseButton?: 'auto' | 'hidden';
    startScreen?: {
      /** Absolute or root-relative URL of the background image. */
      imageUrl?: string;
      /** Title override; falls back to `gameData.gameName`. */
      title?: string;
      /** Play-button label override; falls back to `t('game.menu.play')`. */
      playLabel?: string;
      /** When true, hide the title (keeping its space so the Play button stays put) — for cover images that already include the game name. */
      hideTitle?: boolean;
      /** Card placement: 'center' (default), 'start' (top in portrait / left in landscape) or 'end' (bottom / right). */
      cardPlacement?: 'center' | 'start' | 'end';
      /**
       * Pre-play selection steps shown on the main screen. Absent/empty =
       * no selections (the default for every existing game). Order matters:
       * a 'level' step is presented BEFORE the world loads (it decides what
       * to load); 'choice' steps are presented after loading, before Play.
       */
      selections?: StartScreenSelection[];
      /**
       * Where `imageUrl` came from — provenance for the share-link cover gate
       * (spec 2026-08-04). Stamped automatically by the creator's own write
       * path (`edit-world-config`); nothing else in the codebase sets it today,
       * so it can be absent or stale. The gate treats `'template'` as a hint,
       * not a veto — it re-checks the URL against the starter-template
       * defaults rather than trusting the flag, so staleness can't cause a
       * false block.
       */
      imageSource?: 'template' | 'generated' | 'uploaded';
    };
  };
  
  // Decal system configuration (for projectile impacts, tire marks, paint splatters)
  decalSystem?: {
    /** Maximum number of decals before recycling oldest (default: 1000) */
    maxDecals?: number;
    /** Default decal size in meters (default: 0.15) */
    decalSize?: number;
    /** Default color when not specified by projectile (hex, default: 0x111111 near-black) */
    defaultColor?: number;
    /** Whether decals are enabled (default: true) */
    enabled?: boolean;
  };

  /**
   * Character movement configuration
   * Allows customization of walk/run/fast run speed thresholds
   */
  characterConfig?: CharacterConfig;

  /**
   * Death behaviour (ragdoll vs explode) shared across damageable entities (player, NPCs,
   * animals). Creator-facing; set via the AI editor's `configure-game` tool.
   */
  combatConfig?: DeathCombatConfig;

  /**
   * Runtime AI configuration for in-game AI model calls.
   * Controls defaults for AIService.callModel() behaviour.
   */
  runtimeAI?: RuntimeAIConfig;

  /**
   * Multiplayer network send rate in Hz (messages per second).
   * Controls how often batched messages are flushed to the server.
   * Higher values = lower latency but more bandwidth. Default: 25.
   * Valid range: 5–60.
   */
  networkSendRate?: number;

  /**
   * Asset ID of the VXL asset used as the game map (set by set-map-asset tool).
   * When set, foliage generation is skipped since the map asset defines the full terrain.
   * The terrain itself is loaded via voxelUrl.
   */
  mapAssetId?: string;

  /**
   * Player-progression achievement definitions (umbrella P6). Authored via the
   * agent's `manage-achievements` tool; the engine reads them only for the
   * unlock-toast name lookup (`engine.unlockAchievement(id)`). Absent on games
   * that declare no achievements.
   */
  achievements?: AchievementDefinition[];

  /**
   * Dungeon door definitions for the data-driven door system. Interpreted by
   * `DoorSystem`/`DungeonDoor` (see `engine/doors/`). Absent on games that
   * declare no doors.
   */
  doors?: DoorDefinition[];

  /**
   * Key pickup definitions paired with `doors[].keyId` for the data-driven
   * door system. Spawned by `DoorSystem` as `KeyPickup`s (see
   * `engine/doors/`). Absent on games that declare no key pickups.
   */
  keyItems?: KeyItemDefinition[];
}

/**
 * Configuration for the runtime AI service (used by AIService in game code).
 * All fields are optional — sensible defaults are used when omitted.
 */
export interface RuntimeAIConfig {
  /** Default system prompt prepended to every AI call (can be overridden per call). */
  defaultSystemPrompt?: string;
  /** Default sampling temperature 0-2 (default: 0.7). */
  defaultTemperature?: number;
  /** Default max tokens to generate (default: 150). */
  defaultMaxTokens?: number;
  /** Client-side timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Enable model thinking/reasoning before responding — slower but higher quality (default: false). */
  think?: boolean;
  /** Use streaming on proxy→model connection — keeps connection alive during long generations (default: true). */
  stream?: boolean;
}

// Asset definition in assets array
/**
 * Light emission for placed instances of an asset (torches, braziers, lamps,
 * crystals). Rendered through the engine's constant-count PointLightPool —
 * place as many emitting props as the scene needs; only the nearest few carry
 * a real light at any moment. Positions come from world.json instance
 * placements and refresh on game reload.
 */
export interface AssetLightEmitter {
  /** Light color as hex string. Default: "#ffa040" (warm torch). */
  color?: string;
  /** Light intensity (candela — three.js physical units). Default: 12. Only reads as a visible pool of light in dark scenes (see LightingConfig). */
  intensity?: number;
  /** Falloff cutoff distance in meters. Default: 10. */
  distance?: number;
  /** Emitter offset from the instance origin in the asset's local space (e.g. the flame position). Default: {x:0, y:asset bbox top, z:0}. */
  offset?: Vector3Like;
  /** Organic torch-style intensity flicker. Default: false. */
  flicker?: boolean;
  /**
   * Name of a smart-object part this light rides (a lantern hanging from a
   * ferris-wheel cabin). `offset` stays in the asset frame — where the light
   * sits at rest — and the engine re-bases it onto the part's pivot every
   * frame, so the light moves with the part. Absent: fixed to the instance.
   */
  part?: string;
}

/** How an asset came into being. */
export type AssetProductionMethod = 'procedural' | 'generated' | 'uploaded';

/**
 * An asset's production record: the method, and enough input to re-run it.
 *
 * Every field beyond `method` is the re-run input for one method, so a
 * regeneration never has to guess: `parts`/`voxelSize` replay a procedural
 * build, `prompt` re-drives generation, `sourceUrl` points at the uploaded
 * original.
 */
export interface AssetProduction {
  method: AssetProductionMethod;
  /** ISO timestamp of the run that produced the CURRENT bytes. */
  at?: string;
  /**
   * `procedural`: the exact `create_voxel_asset` payload, replayable as-is.
   * Kept verbatim rather than typed here so the builder can grow part fields
   * (it already gained `emissive`/`material`) without a schema migration.
   */
  spec?: Record<string, unknown>;
  /** `generated`: the prompt that produced it. */
  prompt?: string;
  /** `uploaded`: the original file, so a re-import needs no second upload. */
  sourceUrl?: string;
  sourceName?: string;
}

/** Who decided what an asset's voxels are made of. */
export type MaterialClassifier = 'agent' | 'ai' | 'manual' | 'heuristic';

/**
 * An asset's material-class provenance.
 *
 * Provenance, not configuration: the classes are stored in the `.vxl`, and this
 * says where they came from. Kept deliberately thin — enough to answer "has this
 * been classified, and by whom" in a list or a dialog, and no more, because
 * anything else here would be a second copy of what the file already holds.
 */
export interface AssetMaterials {
  classifier: MaterialClassifier;
  /** The material classes now on the asset, e.g. `['metal', 'leather']`. */
  slots: string[];
  /** ISO timestamp of the run that decided. */
  at?: string;
  /** The model that decided, when one did. */
  model?: string;
}

export interface Asset {
  id: string;
  name: string;
  url: string;
  type: string; // 'polygon-mesh', 'voxels', 'animation', etc.
  screenshotUrl?: string;
  size?: number;
  /**
   * Coarser pre-baked variants of a `.vwld` level, composed from the SAME bake as `url`.
   * `drop` is how many of the finest quad LOD levels the variant left out.
   *
   * A phone fetches the variant it will actually draw instead of downloading the full
   * container, inflating it and shedding most of the quads — on a forged circuit that was
   * 2.9M quads decoded to keep 318k, with ~35 MB inflated and resident while it happened.
   * Absent on levels baked before variants existed, which fall back to the full file plus
   * the runtime shed, so this stays optional forever.
   */
  lodVariants?: Array<{ drop: number; url: string; size?: number; rawSize?: number }>;
  voxelSize?: number; // Size of each voxel in meters
  /**
   * Per-splat voxelisation settings remembered across sessions so the side
   * panel can pre-populate inputs with the values last used. None of these
   * affect runtime rendering — they're authoring-tool defaults.
   */
  opacityThreshold?: number; // Voxelisation opacity cutoff (0..1)
  voxelizeMode?: 'center' | 'coverage';
  /** Creator voxelize-dialog settings persisted on the asset record. */
  voxelizeSettings?: { roundedEdges?: boolean };
  /**
   * When true, an invisible horizontal plane is added at the bottom of the
   * splat's subject bounds and configured to receive shadows. Lets dynamic
   * casters (player, voxel objects) leave shadows on what would otherwise
   * be a perfectly flat splat ground. Off by default — opt in per splat
   * (typically the environment splat, not props).
   */
  shadowCatcher?: boolean;
  /**
   * Vertical offset (metres) applied to the shadow-catcher plane on top of
   * its default placement at the bottom of the splat's bounds. Positive
   * raises the plane (closer to the player), negative lowers it. Lets the
   * user nudge the catcher onto the visual floor when bounds.min.y doesn't
   * coincide with the captured ground.
   */
  shadowCatcherYOffset?: number;
  boundingBoxInMeters?: boolean; // If true, boundingBox is in world units (meters). Missing/false = legacy grid units for CREATE_VOXEL_ASSET assets.
  flattenTerrain?: boolean; // If true, terrain will be flattened under objects using this asset
  flattenMargin?: number; // Margin in meters around the object for flattening (default: 2)
  /**
   * Whether placed instances of this asset get a physics collider. Defaults to
   * true when omitted. Set false for purely decorative props (vegetation, etc.)
   * the player and NPCs should walk straight through. Per-instance `collision`
   * on an environment object / PlacedObjectData overrides this asset-level value.
   */
  collision?: boolean;
  /**
   * Physics collider shape for dynamic instances of this asset. Omitted/'box'
   * = cuboid colliders from the voxel grid. 'sphere' = a single ball collider
   * sized to the asset bounds so the object rolls (soccer balls, boulders).
   * Only affects instances placed with `dynamic: true`.
   */
  colliderShape?: 'box' | 'sphere';
  /**
   * Placed instances of this asset emit light (torches, braziers, lamps).
   * Pooled point lights — safe to place dozens of instances. See
   * AssetLightEmitter for fields and defaults.
   */
  light?: AssetLightEmitter;
  /**
   * Further emitters beyond `light`, for an asset with several bulbs (a
   * candelabra, a ferris wheel's cabins). `light` stays the first so every
   * reader of the single field keeps working; the light system reads both.
   */
  lights?: AssetLightEmitter[];
  boundingBox?: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  voxelCount?: number; // Total non-empty voxels (for vxl assets)
  /**
   * The box (meters) the World-Forger allocated for this object, recorded when the level is
   * imported/voxelized — x = width, z = depth, plus height. When present, a regenerated GLB
   * (generate-glb-asset under the same id) is voxelized to FIT within this box on every axis
   * instead of scaling to the GLB's arbitrary natural size, so the new model stays inside the
   * laid-out space. Stable across regenerations (never re-derived from the drifting voxel
   * boundingBox). Optional — non-forger assets omit it and voxelize as before. Fed straight to
   * the voxelizer's `fitBox` option (ExtractGlbForVoxelization derives the fitting targetHeight).
   */
  fitBox?: { x: number; z: number; height: number };
  /**
   * What this object should LOOK like, in words — set when a World-Forger level is imported (read
   * from the placeholder GLB's scene extras). Since the forger only bakes coarse placeholders, this
   * carries the real character (e.g. "Helsinki Jugendstil mid-rise: ochre plaster, bay windows…",
   * or an invented landmark's appearance) so regenerating a high-quality version under the same id
   * is prompted to look like THIS city/world, not a generic building. Optional — non-forger assets omit it.
   */
  description?: string;
  /**
   * True while this asset is still the World-Forger's coarse stand-in, so the editor offers
   * "Generate high-quality version". Set by the forger's own bakes; every regeneration rebuilds
   * the entry through the same voxelize handler WITHOUT the flag, so it lands `false` and the
   * offer stops. `description` may be absent even on a placeholder (it is optional in the forger
   * spec) — the regeneration dialog collects one from the user in that case, which is why the
   * offer must never be gated on the description.
   */
  placeholder?: boolean;
  sourceGlbUrl?: string; // Original textured GLB this vxl asset was voxelised from (used by the Gaussian Splat export to render high-detail meshes instead of voxels)
  sourceModelUrl?: string; // Original .vox/.qb file this vxl asset was imported from (drives the creator's Re-import dialog)
  /**
   * High-resolution `.vxl` master this asset was resampled from — the third
   * kind of source, alongside a GLB and an imported `.vox`.
   *
   * Set when the asset was forged straight to voxels (no mesh ever existed), in
   * which case it is what Re-voxelize reads instead of `sourceGlbUrl`. Worth the
   * field because it replaces a 50-100 MB GLB kept solely to be re-voxelized:
   * measured masters are 0.4-0.9 MB and resample losslessly.
   *
   * Mutually exclusive with `sourceGlbUrl` in practice, but not enforced — an
   * asset forged locally and later re-forged through Asset Forger would
   * legitimately carry both for one write.
   */
  sourceVxlMasterUrl?: string;
  /** Grid resolution of `sourceVxlMasterUrl`, so the UI can show what detail is on hand. */
  sourceVxlMasterResolution?: number;
  /**
   * True once the voxel editor mutated this asset's baked voxels after
   * voxelization/import. Drives the bidirectional loss warnings: the edit
   * session shows a persistent notice on source-retained assets, and the
   * creator's Re-voxelize / Re-import flows require a blocking confirmation
   * before discarding the manual edits (cleared again by a successful
   * re-bake). See docs/voxel-editor-design.md §3.1.
   */
  voxelEdited?: boolean;
  /**
   * HOW this asset was produced, and the inputs needed to produce it again.
   *
   * Written by every creation path so the answer is never inferred from
   * leftovers. Legacy records predate it — `describeAssetProduction` fills the
   * gap from `sourceGlbUrl` / `sourceVxlMasterUrl` / `sourceModelUrl`.
   *
   * The point is regeneration, not a label: a procedural asset used to throw
   * its parts spec away the moment it was built, so "make this again" had
   * nothing to re-run and the only route back was asking the agent.
   */
  production?: AssetProduction;
  /**
   * WHAT this asset's voxels are made of, and who decided.
   *
   * Provenance only — the material classes themselves live in the `.vxl` (see
   * `engine/VoxelMaterialClass.ts`), which is where the renderer reads them and
   * which is what travels with a published game. This record is what lets a
   * creator see that an asset has been classified, and by whom, without opening
   * the file: whether the shine on a sword was the creator's decision, an agent's,
   * or a colour heuristic's is exactly the question someone asks when it looks
   * wrong.
   */
  materials?: AssetMaterials;
  /**
   * Parked voxel representation while the asset renders as GLB
   * (type 'glb'/'gltf'/'polygon-mesh'). Moves back into `url` on "Use VXL".
   */
  vxlUrl?: string;
  /**
   * The GLB-family type string this asset had before switching to VXL mode,
   * so "Use GLB" can restore it exactly ('glb' | 'gltf' | 'polygon-mesh').
   */
  sourceGlbType?: string;
  /**
   * Uniform world height (meters) GLB-mode instances scale to at load.
   * Written by keep-as-GLB imports and the dimension editor; the runtime
   * defaults to 2.0 when absent.
   */
  targetHeight?: number;
  /** Native GLB dimensions measured by the runtime at load (display only). */
  glbDimensions?: { width: number; height: number; depth: number };
  /**
   * Triangle-mesh collider GLB URL. For GLB-mode env-object assets this is
   * generated by the creator's precise-collision action (GENERATE_GLB_COLLIDER)
   * in the asset's NATIVE units. When set and `colliderType !== 'voxel'`,
   * static instances build a Rapier trimesh from this GLB instead of
   * per-mesh box colliders.
   */
  colliderUrl?: string;
  /**
   * User override for which collider to use at runtime when both are
   * available. Defaults to `'mesh'` once `colliderUrl` is set; switch to
   * `'voxel'` to fall back to the legacy collider path without removing
   * the generated GLB.
   */
  colliderType?: 'mesh' | 'voxel';
  /**
   * Derived vehicle data when the source GLB carries `bmVehicle` scene
   * extras: axles, platform dims, collision boxes (asset frame, y=0 =
   * ground plane). Written at import by the voxelize/register handlers;
   * consumed by VehicleSpawner.spawnFromAsset. See types/vehicleFitment.ts.
   */
  vehicleFitment?: VehicleAssetFitment;
  /**
   * Derived smart-object data: the moving parts (blades, cabins) baked into the
   * `.vxl` as its v12 part channel, with pivots and motions in the asset frame.
   * Written by the master bake from the Forger's analysis; consumed by
   * SmartObjectSystem. See types/smartObject.ts.
   */
  smartObject?: SmartObjectFitment;
  /**
   * The raw HFVX master the asset was forged from, kept beside
   * `sourceVxlMasterUrl` (which becomes the compiled `.vxl`) because the
   * Forger's smart-object analysis reads HFVX only.
   */
  sourceHfvxUrl?: string;
  splatCount?: number; // Total gaussian splats (for gaussian-splat/spz assets)
  denormScale?: number; // Nerfstudio denormalization scale (for gaussian-splat assets)
  centerY?: number; // Nerfstudio camera center Y offset (for gaussian-splat assets)
  // Animation-specific fields (when type === 'animation')
  /** `'library'` marks a character taken from the Asset Forger's ready-made corpus
   *  rather than forged for this game — see `librarySid`. */
  source?: 'generated' | 'uploaded' | 'library';
  /** Corpus id of the library body this asset came from (`source: 'library'` only).
   *  The one field that makes the pick auditable and reproducible; everything else
   *  about the row is recoverable from it. */
  librarySid?: string;
  duration?: number; // Duration in seconds
  prompt?: string; // Prompt used to generate the animation
  /**
   * How a generated clip came to be. `'video'` = Uthana video-to-motion from
   * a creator's webcam recording or uploaded clip; absent for authored clips.
   */
  origin?: 'video';
  /**
   * Persisted locomotion assignment: when set, `loadAllAnimationAssets`
   * routes this clip to the engine state (`setAnimationOverride`) for every
   * skinned character that loads the pack — the player and all NPCs alike.
   * Last asset wins per state. The data-driven form of the call documented
   * in `game/agent-docs/locomotion-assignment.md`.
   */
  locomotionState?: 'idle' | 'walk' | 'run';
  /**
   * The uploaded video a video-to-motion clip was generated from, plus the
   * seconds auto-trim removed from each end of it before Uthana saw it. Editing
   * surfaces use these to show the source footage with the cuts marked. They
   * exist only in the work copy: the publish pipelines strip them so a
   * creator's webcam recording never ships inside published game data.
   */
  sourceVideoUrl?: string;
  trimmedStartSeconds?: number;
  trimmedEndSeconds?: number;
  /**
   * Metres/second the clip's stride was built for. The engine speed-matches
   * locomotion playback (timeScale = actual speed / native speed); for clips
   * with baked root motion the native speed is measured from the hips track,
   * and this field is the fallback for in-place clips where there is nothing
   * to measure. Written by the agent's authored `gait` clips.
   */
  designSpeed?: number;
  // Gaussian-splat collider crop box (untransformed/SPZ-local coords).
  // Voxelisation only places voxels for gaussians whose centre is inside this
  // box — i.e. the region where colliders should exist (typically a subset of
  // cleanupBounds, e.g. the ground around the subject the player walks on).
  cropBounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  // Outer "what counts as part of the splat" box (untransformed/SPZ-local).
  // Used by the gaussian cleanup operation: any gaussian whose 3-σ ellipsoid
  // is fully outside this box is permanently removed. Distinct from cropBounds
  // because the cleanup region typically covers the whole subject (car + the
  // captured ground around it) while colliders only cover walkable surfaces.
  cleanupBounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  /**
   * Serialized VoxelNavMesh sidecar for a `type: 'vwld'` level asset —
   * installed at level load (boot + level switch). Absent = no prebuilt
   * navmesh (legacy behavior unchanged).
   */
  navUrl?: string;
  /**
   * World-space gameplay anchors the World-Forger's designer placed on a forged
   * level (`type: 'vwld'`). **An OBJECT, not an array** — and each named marker
   * carries its coordinates FLAT (`{ name, x, y, z }`), not under a `position`.
   * Both are easy to guess wrong, and guessing wrong is a runtime `TypeError`
   * the type checker cannot see if game code re-declares the shape locally, so
   * read the anchors through this field rather than a hand-rolled cast.
   * Written by `place-and-persist-level.ts`; absent on every non-forged asset.
   */
  worldForgerMarkers?: ForgedLevelMarkers;
  /**
   * Declared gameplay features on a forged level — the route polyline, the
   * coarse spine, ski lifts, doors, gates, traversal challenges. An ARRAY,
   * ordered as the designer emitted it; select by `kind`/`name`, never index.
   */
  worldForgerFeatures?: ForgedLevelFeature[];
  /**
   * The movement contract a forged platformer journey was validated against.
   * The ENGINE adopts `effective` automatically (`PlayerController`) — game
   * code reads it to report, never to re-apply.
   */
  worldForgerMovement?: { effective?: Record<string, unknown> };
  /**
   * A forged city's street network in WORLD space: junction nodes and the road
   * segments between them, with each road's width. Drive lanes `width/4` either
   * side of a segment's centreline; a node with three or more segments is an
   * intersection. Written by `place-and-persist-level.ts` for city levels only;
   * read it through `forgedStreetGraph()` in `engine/ForgedLevelData.ts`.
   */
  worldForgerStreetGraph?: ForgedStreetGraph;
  /** The user's request in their own words, kept for re-forges. */
  worldForgerUserPrompt?: string;
  /** The full validated scene design, so a later request can adjust it. */
  worldForgerSpec?: Record<string, unknown>;
  /** The forge job that built this level — an edit of the level starts from its artifacts. */
  worldForgerJobId?: string;
}

/**
 * The `worldForgerMarkers` payload persisted on a forged level asset.
 *
 * Shape mirrors `shared/world-forger/src/pipeline/place-and-persist-level.ts`
 * exactly. `named` holds every marker the designer placed BY NAME (FinishLine,
 * Checkpoint_1, SummitStation, …); `playerStart` is the spawn, already applied
 * to `playerSpawnPosition`, and is NOT repeated in `named`.
 */
/** The `worldForgerStreetGraph` payload persisted on a forged city level asset. */
export interface ForgedStreetGraph {
  nodes: Array<{ id: number; x: number; z: number }>;
  segments: Array<{ a: number; b: number; width: number; kind: 'avenue' | 'street' | 'diagonal' | 'bridge' }>;
}

export interface ForgedLevelMarkers {
  playerStart?: { x: number; y: number; z: number };
  named?: Array<{ name?: string; x: number; y: number; z: number }>;
}

/**
 * One entry of `worldForgerFeatures`. Deliberately loose: `kind` is an open
 * vocabulary that grows with the forger's plan types (`path`, `spine`,
 * `traversalChallenge`, `collectibleSpawns`, `skiLift`, `door`, …), and each
 * kind puts its own keys in `params`. `points` is world-space with the ground
 * y already resolved; feature kinds that describe a site rather than a route
 * carry an empty `points` and locate themselves through `anchors`/`params`.
 */
export interface ForgedLevelFeature {
  kind?: string;
  name?: string;
  description?: string;
  points?: Array<{ x: number; y: number; z: number }>;
  params?: Record<string, unknown>;
  /** Named world-space sites for a feature that marks places rather than a route. */
  anchors?: Array<{ name?: string; x: number; y: number; z: number }>;
  /**
   * Instanced sets the feature is about — a scatter archetype or a city building type, where
   * the intent is EVERY instance. Per-instance positions are deliberately NOT inlined (a level
   * places up to ~640 of one archetype): resolve `name` to an asset id, then read the matching
   * `environmentObjects`.
   */
  archetypeAnchors?: Array<{ name?: string; instances: number; centroid: { x: number; y: number; z: number } }>;
  // ── `kind: 'path'` only ──
  /** Ribbon width in meters (world space). */
  widthM?: number;
  /** 3D arc length of the control polyline (m). */
  lengthM?: number;
  /** True for circuits: the last point connects back to the first. */
  closed?: boolean;
  /** First control point — the intended start of travel. Prefer this over `points[0]`. */
  start?: { x: number; y: number; z: number };
  /** Last control point (the lap point itself for closed circuits). */
  finish?: { x: number; y: number; z: number };
  /** Evenly spaced along the route, strictly between `start` and `finish`. `t` is the
   *  arc-length fraction (0 = start, 1 = finish/lap). */
  checkpoints?: Array<{ x: number; y: number; z: number; t: number }>;
  /** Ribbon node name when its surface is queryable via the named-trimesh API. */
  surfaceObjectName?: string;
}

// Generic game data interface for all genres
export interface GameData {
  gameId?: string; // Game identifier (from game.json)
  // Metadata fields from game.json (set by mergeGameData) - all required after merge
  gameGenre: string;
  characterUrl: string;
  gameName: string;
  gameDescription: string;
  thumbnailUrl: string;
  environmentObjectsGeneratedProcedurally?: boolean; // true = procedural, false = loaded from world.json (immutable, from game.json)
  gameDimension?: '2d' | '3d'; // the game's declared dimension from game.json; absent = '3d'
  physicsMode?: '2d' | '3d'; // physics world from game.json; absent = genre default
  /** Template code targets the 2D physics world — see GameMetadata.physics2d. */
  physics2d?: boolean;
  artStyle?: 'voxel' | 'low-poly'; // art style from game.json; absent = 'voxel'
  // Runtime configuration from world.json
  worldProfileData?: WorldProfileData;
  assets?: Asset[]; // Asset library
  environmentObjects?: any[]; // Environment objects referencing assets by assetName
  /**
   * Data-driven moving hazards/platforms (spinner, movingPlatform, pendulum,
   * crusher, conveyor, crumbling) — spawned by the engine's MechanismSystem,
   * editable in the creator editor, persisted here. See MechanismSystem.ts.
   */
  mechanisms?: Array<Record<string, unknown>>;
  [key: string]: any; // Allow for genre-specific data
}

/**
 * Merge game.json metadata with world.json data into a single GameData object.
 * Metadata fields are set at the top level of GameData (not in worldProfileData).
 *
 * @param metadata - Metadata from game.json (contains gameName)
 * @param worldData - Data from world.json (doesn't have gameName, hence Partial)
 * @returns Complete GameData with gameName from metadata
 */
export function mergeGameData(metadata: GameMetadata | null, worldData: Partial<GameData>): GameData {
  // Start with world data, gameName will be set from metadata
  const merged = { ...worldData } as GameData;

  if (metadata) {
    // Set metadata fields at top level (gameName is required and comes from game.json)
    merged.gameId = metadata.gameId;
    merged.gameGenre = metadata.gameGenre;
    merged.characterUrl = metadata.characterUrl;
    merged.gameName = metadata.gameName;
    merged.gameDescription = metadata.gameDescription;
    merged.thumbnailUrl = metadata.thumbnailUrl;
    merged.gameDimension = metadata.gameDimension;
    merged.physicsMode = metadata.physicsMode;
    // MUST travel with physicsMode. The publish lane reads `physics2d` straight
    // from game.json to pick the Rapier flavor, while the engine reads it off
    // the MERGED data — so dropping it here makes the bundle ship one flavor
    // while the engine boots the other, and the stubbed package is null at
    // `RAPIER.init()`. That is a black screen, not a degraded game.
    merged.physics2d = metadata.physics2d;
    merged.artStyle = metadata.artStyle;

    // environmentObjectsGeneratedProcedurally comes from game.json (immutable).
    // Backward compat: pre-migration games may still carry it in worldProfileData.
    // Left untouched when neither declares it, so the key never appears as undefined.
    const proceduralObjects = metadata.environmentObjectsGeneratedProcedurally
      ?? merged.worldProfileData?.environmentObjectsGeneratedProcedurally;
    if (proceduralObjects !== undefined) {
      merged.environmentObjectsGeneratedProcedurally = proceduralObjects;
    }

    // Ensure worldProfileData exists with default spawn position
    if (!merged.worldProfileData) {
      merged.worldProfileData = {
        playerSpawnPosition: { x: 0, y: 0, z: 0 }
      };
    }
  }

  // Derive worldProfileData.animations from assets[] for backward compatibility.
  // Game templates read worldProfileData.animations — this ensures they work unchanged.
  if (merged.assets && merged.worldProfileData) {
    const animationAssets = merged.assets.filter(a => a.type === 'animation');
    const migratedIds = new Set(animationAssets.map(a => a.id));

    // Migrate any legacy animations not already in assets[] in-memory
    for (const la of merged.worldProfileData.animations ?? []) {
      if (migratedIds.has(la.motionId)) continue;
      const asset: Asset = {
        id: la.motionId,
        name: la.prompt || 'Animation',
        url: la.animationUrl,
        type: 'animation',
        prompt: la.prompt,
        size: 0,
      };
      merged.assets.push(asset);
      animationAssets.push(asset);
    }

    merged.worldProfileData.animations = animationAssets.map(a => ({
      animationUrl: a.url,
      motionId: a.id,
      prompt: a.prompt,
      source: a.source,
      designSpeed: a.designSpeed,
    }));
  }

  return merged;
}

/**
 * Extract metadata from GameData.
 * Reads from top-level fields which are set by mergeGameData().
 */
export function extractMetadataFromWorldData(gameData: GameData): GameMetadata | null {
  if (!gameData.gameGenre && !gameData.characterUrl) return null;

  return {
    gameId: gameData.gameId || '',
    gameGenre: gameData.gameGenre || '',
    gameName: gameData.gameName,
    gameDescription: gameData.gameDescription,
    characterUrl: gameData.characterUrl || '',
    thumbnailUrl: gameData.thumbnailUrl,
    environmentObjectsGeneratedProcedurally: gameData.environmentObjectsGeneratedProcedurally
  };
}

/**
 * Look up asset URL by name from assets array
 */
export function getAssetUrlByName(gameData: GameData | null, assetName: string): string | null {
  return resolveAssetUrl(gameData?.assets?.find(a => a.name === assetName)?.url);
}

/**
 * Look up asset URL by ID from assets array (preferred method)
 */
export function getAssetUrlById(gameData: GameData | null, assetId: string): string | null {
  return resolveAssetUrl(gameData?.assets?.find(a => a.id === assetId)?.url);
}

/**
 * Resolve the character GLB url for engine.registerNpc(): an explicit
 * characterUrl wins; otherwise characterAssetId is looked up in assets[].
 */
export function resolveNpcCharacterUrl(
  options: { characterUrl?: string; characterAssetId?: string } | undefined,
  gameData: GameData | null,
): string | null {
  if (options?.characterUrl) return options.characterUrl;
  if (options?.characterAssetId) return getAssetUrlById(gameData, options.characterAssetId);
  return null;
}

/**
 * Look up asset URL - tries by ID first, then by name
 */
export function getAssetUrl(gameData: GameData | null, assetId?: string, assetName?: string): string | null {
  const byId = assetId ? getAssetUrlById(gameData, assetId) : null;
  return byId ?? (assetName ? getAssetUrlByName(gameData, assetName) : null);
}

/**
 * Load and parse a JSON asset by name. Returns the parsed object, or null if
 * the asset is not found or the fetch/parse fails.
 */
export async function loadJsonAsset<T = unknown>(gameData: GameData | null, assetName: string): Promise<T | null> {
  const url = getAssetUrlByName(gameData, assetName);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// Collider editor types
export interface BoxColliderData {
  id: string;
  position: Vector3Like;
  scale: Vector3Like;
  rotation: number; // Y-axis rotation in radians
  color?: number; // Optional color (hex value)
}

export interface HeightmapData {
  width: number; // Number of samples in X direction
  height: number; // Number of samples in Z direction
  minX: number; // World space bounds
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number; // Min height value
  maxY: number; // Max height value
  heights: number[]; // Flattened 2D array of heights (row-major: z * width + x)
}

export interface ProjectileLike {
  getRigidBody: () => RAPIER.RigidBody | null;
  getPosition?: () => THREE.Vector3; // Optional, for distance-based detection
  getDirection?: () => THREE.Vector3; // Direction the projectile is traveling
  getDamage?: () => number; // Damage this projectile deals (default: 25 if not specified)
  getKnockback?: () => number; // Ragdoll knockback speed (m/s) along travel dir on a lethal hit (default: 6)
}

export interface PlayerControllerLike {
  /**
   * Engine-owned player↔NPC capsule separation, run by the engine loop after
   * all character updates. Optional: custom controller-likes (headless,
   * vehicle, board games) have no capsule to separate. See
   * PlayerController.enforceCharacterSeparation.
   */
  enforceCharacterSeparation?(): void;
  /**
   * Enter a body posture — 'stand' | 'crouch' | 'prone' | 'sit' | 'kneel' |
   * 'climb' ('swim' is applied automatically with SwimmingMovement). Swaps
   * the animation set, shrinks the physics capsule, scales move speed.
   * Returns false when standing up is refused for lack of headroom.
   * See PlayerController.setPosture.
   */
  setPosture?(posture: string): boolean;
  getPosture?(): string;
  /** Cover peek toggle (in 'cover' posture); ledge grab / mantle / vault / get-up / slide one-shots. */
  setCoverPeek?(peek: boolean): void;
  tryGrabLedge?(): boolean;
  mantle?(): boolean;
  vault?(): boolean;
  getUp?(): boolean;
  slide?(): boolean;
  getProjectiles: () => ProjectileLike[];
  removeProjectile: (projectile: ProjectileLike) => void;
  getActiveVehicle?: () => any | null; // Get the vehicle the player is currently driving
  isPlayerInVehicle?: () => boolean; // True while the player occupies a vehicle
  exitVehicle?: () => boolean; // Full exit: restores walking movement + camera and re-enables the capsule
  getPosition?: () => THREE.Vector3; // Get player visual position for NPC behaviors
  getCurrentSpeed?: () => number; // Player's current horizontal speed (m/s); NPC/animal avoidance uses this to ignore a stationary player
  getGroundPosition?: () => THREE.Vector3; // Get feet/ground position from physics capsule (use for save/teleport)
  getCapsuleRadius?: () => number; // Physics capsule radius (m) — NPC melee uses this to size the player hit volume
  getCapsuleHeight?: () => number; // Physics capsule total height (m) — NPC melee uses this to size the player hit volume
  teleportTo?: (x: number, y: number, z: number, rotationY?: number) => void; // Teleport player to a ground-level position (use positions from getGroundPosition)
  reassertMovementContract?: () => void; // Re-apply a forged level's movement contract after genre build (engine calls this at the end of loadGame)
  getPlayerObject?: () => THREE.Object3D | null; // Get the player object (THREE.Object3D) for NPC following behaviors
  syncVisibleBody?: () => void; // Pose the visible character onto the player now (the per-frame update only does it while the player runs)
  takeDamage?: (amount: number, source?: string) => void; // Apply damage to player (for NPC attacks)
  setCameraController?: (controller: { getForwardVector: () => THREE.Vector3; getRightVector: () => THREE.Vector3; getCamera: () => THREE.PerspectiveCamera }) => void;
  setPlayerEnabled?: (enabled: boolean) => void; // Freeze physics capsule + skip update loop; pair with engine.getPlayerVisibility().hide() to also hide
  isPlayerEnabled?: () => boolean; // Inverse of setPlayerEnabled(false)
  setMobilePreviewMode?: (enabled: boolean, config?: Record<string, unknown>) => void; // Force-enable/disable mobile controls from creator preview
  getMobilePreviewMode?: () => boolean; // True while creator mobile simulation preview is active
  isMiningActive?: () => boolean; // Returns true while the mine/action key is held (used by VoxelMiningSystem)
  setLidControlEnabled?: (enabled: boolean) => void; // Toggle the experimental localhost-only MacBook-lid controller
}

// Bloom effect configuration
export interface BloomConfig {
  enabled: boolean;
  strength?: number;
  radius?: number;
  threshold?: number;
}

// Tone-mapping operator name; mapped to the matching THREE.*ToneMapping constant.
export type ToneMappingMode = 'aces' | 'neutral' | 'reinhard' | 'linear' | 'cineon';

/**
 * How voxel vehicle bodywork responds to light.
 * 'flat'  — faceted, purely diffuse. The historical look.
 * 'paint' — glossy car paint: a specular sheen from the scene's own lights,
 *           with shading normals smoothed across the voxel steps so the
 *           highlight rolls along a panel instead of banding at every step.
 *
 * Tone-preserving by design: the geometry is identical either way, and 'paint'
 * is lit by the scene's real lights only, so a car keeps the colour and
 * brightness it had under the flat look and still matches the world around it.
 * No exposure or lighting compensation is needed.
 */
export type VehicleFinishMode = 'flat' | 'paint';

/**
 * Scene-wide black "ink" outline — the load-bearing half of the Borderlands look
 * on voxels. A post-process depth+normal edge detector that darkens silhouettes
 * and interior creases; distinct from the cyan editor-selection outline. Opt-in
 * via `renderConfig.inkOutline`; runs on both renderer backends.
 */
export interface InkOutlineConfig {
  /** Master switch. Default (field absent): off. */
  enabled: boolean;
  /** Line color as hex string ("#000000"). Default: "#000000". */
  color?: string;
  /** Line thickness in pixels (edge-sample offset). Default: 1.5. */
  thickness?: number;
  /** Normal-discontinuity sensitivity 0..8 (lower = more interior creases). Default: 0.6. */
  normalThreshold?: number;
  /** Depth-discontinuity sensitivity (angle-robust curvature/slope ratio; lower = more silhouettes). Default: 0.5. */
  depthThreshold?: number;
  /** Line opacity 0..1. Default: 1. */
  strength?: number;
}

/**
 * Final-image posterize — the tonal half of the comic look, companion to
 * {@link InkOutlineConfig}. Quantizes the composited image's luminance into flat
 * bands (hue preserved), so continuous shading reads as cel-style tonal regions
 * across the whole scene. Opt-in via `renderConfig.posterize`.
 */
export interface PosterizeConfig {
  /** Master switch. Default (field absent): off. */
  enabled: boolean;
  /** Number of flat tonal bands. 3–6 reads comic; higher dissolves toward smooth. Default: 5. */
  levels?: number;
  /** Blend 0..1 between the original and fully-posterized image. Default: 1. */
  strength?: number;
}

// Renderer-level color pipeline configuration.
export interface RenderConfig {
  /** Tone mapping operator applied to HDR scene values. Default: 'aces' (ACESFilmic). */
  toneMapping?: ToneMappingMode;
  /** Exposure multiplier (renderer.toneMappingExposure). Typical range 0.5–2.5. Default: 1.0. */
  exposure?: number;
  /**
   * Directional-shadow coverage radius in meters — the shadow map covers a
   * 2×radius square centred on the view. Larger = shadows stay visible farther
   * out, but softer/blockier up close (one shadow map spread over more ground,
   * no cascades). Default: 200, auto-shrunk to the world's footprint on small
   * levels (the shadow-map resolution scales with the radius, so small worlds
   * allocate small maps). Setting an explicit value disables the auto-fit.
   * Push toward the fog distance for open vistas; 150–250 keeps near shadows
   * crisp.
   */
  shadowDistance?: number;
  /**
   * Explicit shadow-map resolution (one square texture, e.g. 1024, 2048,
   * 4096). Snapped to a power of two and clamped to the device budget: 4096
   * on desktop, 2048 on mobile — larger maps often fail to allocate on phones,
   * which silently kills all sun shadows. Default: unset — the engine derives
   * the size from the shadow coverage radius (and with it the world size).
   * Set only to deliberately trade shadow crispness against GPU memory;
   * shadowDistance stays independent.
   */
  shadowMapSize?: number;
  /** Bodywork shading for voxel vehicles — see {@link VehicleFinishMode}. Default: 'flat'. */
  vehicleFinish?: VehicleFinishMode;
  /** Scene-wide black ink outline — see {@link InkOutlineConfig}. Default: off. */
  inkOutline?: InkOutlineConfig;
  /** Final-image posterize / tonal banding — see {@link PosterizeConfig}. Default: off. */
  posterize?: PosterizeConfig;
  /** Final-image color grade (saturation, contrast, white balance…) — see {@link ColorGradingConfig}. Default: off. */
  colorGrading?: ColorGradingConfig;
  /** Darkened screen edges — see {@link VignetteConfig}. Default: off. */
  vignette?: VignetteConfig;
}

/**
 * Final-image color grade, applied AFTER tone mapping on the displayed 0..1
 * image (so it behaves like a photo editor's sliders). Every field defaults to
 * neutral, so set only what you want to change. Runtime: `engine.setColorGrading()`.
 */
export interface ColorGradingConfig {
  /** Master switch. Default (field absent): off. */
  enabled: boolean;
  /** Additive brightness offset, -1..1. Default: 0. */
  brightness?: number;
  /** Contrast around mid-grey, 0..3 (1 = unchanged, 0 = flat grey). Default: 1. */
  contrast?: number;
  /** Saturation, 0..3 (0 = greyscale, 1 = unchanged, >1 = vivid). Default: 1. */
  saturation?: number;
  /** White balance, -1..1: negative = cooler/bluer, positive = warmer/orange. Default: 0. */
  temperature?: number;
  /** Green↔magenta shift, -1..1: negative = greener, positive = magenta. Default: 0. */
  tint?: number;
  /** Per-channel [r,g,b] shadow lift, -1..1 (raises/tints the blacks, white stays put). Default: [0,0,0]. */
  lift?: [number, number, number];
  /** Per-channel [r,g,b] midtone gamma, 0.1..5 (>1 brightens mids). Default: [1,1,1]. */
  gamma?: [number, number, number];
  /** Per-channel [r,g,b] highlight gain multiplier, 0..4. Default: [1,1,1]. */
  gain?: [number, number, number];
}

/** Darkened (or tinted) screen edges. Runtime: `engine.setVignette()`. */
export interface VignetteConfig {
  /** Master switch. Default (field absent): off. */
  enabled: boolean;
  /** How strongly the corners reach `color`, 0..1. Default: 0.5. */
  intensity?: number;
  /** Where darkening starts, as a fraction of the centre→corner distance (0 = centre, 1 = corner). Default: 0.55. */
  radius?: number;
  /** Width of the fade beyond `radius`, same units. Default: 0.45. */
  softness?: number;
  /** Edge color as hex. Red for a damage flash, black for cinematic. Default: "#000000". */
  color?: string;
}

// Scene-level fog + sky fallback configuration.
export interface FogConfig {
  /** Master switch. When false, fog is disabled and `scene.fog` is set to null. Default: true. */
  enabled?: boolean;
  /** Fog color as hex string ("#87CEEB"). Also used as the sky fallback background when no skybox texture loads. Default: "#87CEEB". */
  color?: string;
  /** Distance at which fog begins to take effect (meters). Default: 10. */
  near?: number;
  /** Distance at which fog reaches full opacity (meters). Default: 500. */
  far?: number;
}

// Scene lighting configuration — sun, image-based ambient, and visible sky
// brightness. All intensity fields are MULTIPLIERS on the engine daylight
// defaults: 1 = normal daylight, 0 = off. This is what makes dark interiors,
// night scenes and dungeons possible — without it the hardcoded sun and the
// skybox-derived ambient keep every scene at full daylight.
export interface LightingConfig {
  /** Coordinated sun, ambient and fog defaults. Explicit fields override the preset; absent preserves the classic daylight. */
  preset?: 'stylized-day' | 'golden-hour' | 'overcast-forest' | 'moonlit-street';
  /** Colour of the sky-independent ambient floor. Default: white. */
  ambientColor?: string;
  /** Sun (directional light) intensity multiplier. 1 = default daylight, 0 = no sun. Dark interiors: 0–0.1. Default: 1. */
  sunIntensity?: number;
  /** Sun color as hex string. Default: "#ffeece" (warm daylight). Moonlight: "#8899cc". */
  sunColor?: string;
  /**
   * Sun height above the horizon in degrees (90 = straight overhead). This is
   * what makes shadows long: dusk/dawn sit at 8–15, a low afternoon sun at 25–35.
   * Clamped to a couple of degrees above the horizon so shadows stay finite.
   * Default: DEFAULT_SUN_ELEVATION_DEG (≈55, the classic noon-ish sun).
   */
  sunElevationDeg?: number;
  /**
   * Compass bearing the sunlight comes FROM, degrees clockwise from +Z seen from
   * above (0 = from +Z, 90 = from +X, 180 = from −Z). Pair it with the skybox so
   * the bright side of the sky is where the shadows point away from.
   * Default: DEFAULT_SUN_AZIMUTH_DEG (45).
   */
  sunAzimuthDeg?: number;
  /** Ambient image-based light multiplier — how strongly the sky image lights every surface (scene.environmentIntensity). Dark interiors: 0.02–0.15. Default: 1. */
  environmentIntensity?: number;
  /** Visible skybox brightness multiplier. Night/dark scenes: 0.05–0.3. Default: 1. */
  skyboxIntensity?: number;
  /**
   * Minimum light every surface receives, from all directions, regardless of the
   * sky image or where lamps are placed (a plain AmbientLight). The FLOOR under a
   * dark scene: it decides what "unlit" looks like, so geometry out of every
   * lamp's reach reads as dark-but-navigable instead of pure black.
   *
   * Unlike `environmentIntensity` this does not depend on the skybox — a black
   * sky multiplied by any intensity is still black, which is why an enclosed
   * level cannot be brightened with that knob at all, however high it goes.
   * Set 0 for true blackness (horror, deep caves).
   *
   * Enclosed levels that should stay navigable: 0.5–1.5 (measured in a torchlit
   * dungeon: 0.5 is a visible lift, 1.5 reads as dim-but-clear). The default is
   * deliberately far below that so no existing outdoor game changes appearance.
   * Default: DEFAULT_AMBIENT_FLOOR.
   */
  ambientFloor?: number;
}

/**
 * Open-water world: the whole playable surface is an animated stylized ocean,
 * and there is NO terrain at all. Set this and the engine builds the sea (and
 * optionally the matching painted sky) at load, drives it every frame, and
 * hands it to any `BoatMovement` on the player — game code wires nothing.
 *
 * It also tells the voxel WorldGenerator to skip terrain generation entirely.
 * That part matters more than it sounds: without it a boat game still gets a
 * procedural grass island under the sea, complete with its own voxel water in a
 * low channel, which reads to a player as "the water level is wrong". A BAKED
 * level (`voxelUrl`) is still loaded: a forged vessel is the ship itself, and it
 * sails on this ocean.
 *
 * Distinct from `waterLevelY`, which is the see-through COASTAL plane for voxel
 * levels that have a seafloor to look at. Never set both.
 *
 * See `game/agent-docs/mechanic-boat-racing.md`, and for a ship that is the
 * level `game/agent-docs/mechanic-sailing.md`.
 */
export interface OpenWaterConfig {
  /** Mean sea level in world Y. Waves oscillate around it. Default 0. */
  seaLevelY?: number;
  /** Sea state. Default `ocean`. */
  preset?: 'calm' | 'ocean' | 'storm';
  /** Multiplies the preset's wave height. Default 1. */
  amplitudeScale?: number;
  /** Rotates the swell, degrees clockwise from +Z. Default 0. */
  windDirectionDeg?: number;
  /**
   * Also build the stylized sky dome. Default true — an open-water game is half
   * sky, and a photo skybox behind a cel-shaded sea reads as two different games.
   */
  sky?: boolean;
  /** Sky colours (hex). Defaults are tuned to the ocean palette. */
  skyHorizon?: number;
  skyZenith?: number;
  /**
   * Ocean palette overrides (hex). Keys: `deep`, `mid`, `bright`, `shallow`,
   * `foam`, `horizon`. Keep `horizon` near the sky's low band or the seam shows.
   */
  palette?: Record<string, number>;
}

/**
 * Weather — precipitation and the surface response it drives. One config feeds
 * BOTH the falling rain and the wet-asphalt material so they always agree
 * (shared intensity/wind; surfaces soak and dry from the same envelope).
 * Rendering scales with the backend: WebGPU runs a GPU-compute rain with
 * impact-coupled splashes and optional screen-space reflections; WebGL runs a
 * cheaper instanced rain and environment-map reflections only.
 */
export interface WeatherConfig {
  /** Precipitation type. 'none' disables the whole system. Default: 'none'. */
  precipitation?: 'none' | 'rain';
  /** Rainfall strength 0..1 — drop density, splash rate, and how wet surfaces get. Default: 1. */
  intensity?: number;
  /** Horizontal wind (m/s) slanting the falling rain. Default: {x: 1.5, z: 0.5}. */
  wind?: { x: number; z: number };
  /**
   * Surface wetness override 0..1. Omit to derive from intensity: surfaces
   * soak toward the rain intensity while it rains and dry slowly after.
   */
  wetness?: number;
  /** Puddle coverage on the ride surface 0..1 (0 = film of water only). Default: 0.5. */
  puddles?: number;
  /**
   * Wet-surface reflections. 'ssr' = screen-space reflections of the actual
   * scene (WebGPU only — WebGL silently falls back to 'env');
   * 'env' = environment-map reflections only. Default: 'ssr'.
   */
  reflections?: 'ssr' | 'env';

  // ── Look dials ────────────────────────────────────────────────────────────
  // Everything below shapes how the wet surface READS. Defaults are the tuned
  // racing-game look; games only set what they want to differ.

  /**
   * Master strength of the road's scene reflections, 0–2. Default: 0.55.
   * THE dial for "I can barely see the reflections" / "too mirror-like" — it
   * scales the whole reflection, ordinary scenery included. Values below ~0.2
   * make reflections technically present but visually absent.
   */
  reflectionStrength?: number;
  /**
   * Extra reflection strength for BRIGHT sources (lights, bright paint, sky),
   * 0–3. Default: 1. Raise for a night/neon look where headlights should
   * streak hard while dark bodywork stays subdued.
   */
  reflectionHighlight?: number;
  /**
   * Vertical smear of reflections, 0–8. Default: 3. Wet asphalt is not a
   * mirror: micro-bumps stretch a reflection into a vertical streak, so a
   * brake light reads as a line, never a dot. 0 = mirror-sharp (ice-like).
   */
  reflectionStreak?: number;
  /** How far a reflection may travel across the scene, meters. Default: 25. */
  reflectionDistance?: number;
  /**
   * Glossiness of the WHOLE wet surface between puddles, 0–1. Default: 0.7.
   * This is the film of water on the asphalt — the main wet look. Lower =
   * duller/damper, higher = glassier.
   */
  filmGloss?: number;
  /** How much darker asphalt goes when wet, 0–1. Default: 0.28. */
  surfaceDarkening?: number;
  /** Sky/environment sheen on the wet surface, 0–1. Default: 0.25. Raising
   *  this too far is what makes a road read as a blue river rather than tarmac. */
  envSheen?: number;
  /** Rain-impact ripple strength in standing water, 0–2. Default: 1. */
  rippleStrength?: number;
  /**
   * Tyre spray thrown by vehicles. Default: false. ⚠ Spray is transparent
   * geometry in the same pass the reflection data is built from, so switching
   * it on measurably weakens road reflections — a look trade-off, not a bug.
   */
  spray?: boolean;
  /** Darkness of the wet tyre trails vehicles leave, 0–1. Default: 0.3. */
  trailStrength?: number;
}

// Depth-of-field post-process configuration. Renders via three's BokehPass.
// The shader applies `dofblur = clamp((focus + viewZ) * aperture, -maxblur,
// maxblur)`, so for a meter-scale scene `aperture` belongs in roughly
// `1e-4 .. 1e-3` — using the three.js example default of 0.025 puts the entire
// scene at max blur. Defaults below give a gentle cinematic look.
export interface DofConfig {
  /** Master switch. When false the pass is skipped entirely. Default: false. */
  enabled?: boolean;
  /** Distance in meters at which the image is sharp. Default: 15. */
  focus?: number;
  /** Aperture — higher values shorten the in-focus range. Typical 0.0001-0.001 for meter-scale games. Default: 0.0003. */
  aperture?: number;
  /** Maximum blur radius in screen-space units (0-1). Typical 0.002-0.01. Default: 0.005. */
  maxblur?: number;
}

/**
 * Runtime ground cover on a FORGED (.vwld) level — the grass/pebbles the engine
 * grows from the level's ground mask. This is the ONLY way to author grass on a
 * baked level: never scatter grass as environment objects, which costs thousands
 * of instances and still reads as scattered props rather than a field.
 */
export interface GroundCoverConfig {
  /**
   * How thick the cover is, relative to the default sprinkle. 1 = default
   * (~2 tufts/m², suits a city park); 4-6 = a thick meadow with real volume,
   * which is what mowing/trampling gameplay needs. Default: 1.
   */
  density?: number;
  /** Tuft size multiplier — the other half of volume. Default: 1. */
  scale?: number;
  /** Camera radius (m) within which cover is built. Default: 60. */
  distance?: number;
}

// Screen-space ambient occlusion configuration. Renders via three's GTAOPass.
export interface AoConfig {
  /** Master switch. When false the pass is skipped entirely. Default: false. */
  enabled?: boolean;
  /** AO blend intensity (0-1). Higher = darker crevices. Default: 1.0. */
  intensity?: number;
  /** Sample radius in world units. Larger values capture larger-scale occlusion. Default: 0.5. */
  radius?: number;
  /** Output scale multiplier applied after blending. Default: 1.0. */
  scale?: number;
}

/**
 * Character configuration
 * Allows customization of character height and movement speeds via world.json
 */
export interface CharacterConfig {
  /** Character height in meters, default: 1.75 */
  height?: number;
  /** Movement speed used for the run animation's native speed sync (m/s), default: 5.0 */
  runSpeed?: number;
}

/** Death behaviour (ragdoll vs explode), read where damageable entities are set up. */
export interface DeathCombatConfig {
  /** Collapse into a limp jointed ragdoll on death instead of exploding. Default: false. */
  ragdollOnDeath?: boolean;
  /** Hinge elbows/knees (vs free ball joints) so the corpse keeps shape. Default: true. */
  ragdollJointLimits?: boolean;
  /** Let limbs collide so the body heaps in a pile; turn off if jittery. Default: true. */
  ragdollSelfCollision?: boolean;
}

// Block character factory interface (re-exported for convenience)
export type BlockCharacterFactoryType = import('../engine/IBlockCharacterFactory.js').IBlockCharacterFactory;

// Character modifications callback type
export type CharacterModificationsFunction = (
  player: THREE.Object3D,
  playerController: PlayerControllerLike,
  playerLoader: import('../engine/loaders/PlayerLoader.js').PlayerLoader,
  blockCharacterRenderer: import('../engine/BlockCharacterRenderer.js').BlockCharacterRenderer
) => void;

// Camera controller interface for ThirdPersonCamera methods used by templates
export interface CameraControllerLike {
  disableBuiltInTouchControls?: boolean;
  disableBuiltInMouseControls?: boolean;
  applyExternalDelta?: (deltaX: number, deltaY: number) => void;
  setAutoFollow?: (enabled: boolean, speed?: number) => void;
  setTargetForwardDirection?: (direction: THREE.Vector3 | null) => void;
  /** Hand the orbit to an external driver (ski chase cam): manual input ignored. */
  setExternalOrbitDrive?: (enabled: boolean) => void;
  /** Set orbit targets directly while externally driven (snap = hard cut). */
  driveOrbit?: (theta: number, phi: number, radius?: number, snap?: boolean) => void;
  setTarget?: (target: THREE.Object3D) => void;
  setEnabled?: (enabled: boolean) => void;
}

// Environment object userData stored on THREE.js meshes
export interface EnvironmentMeshUserData {
  environmentInstanceId?: number;
  isEnvironmentInstance?: boolean;
  environmentType?: string;
  scale?: { width: number; height: number; depth: number };
}

// Rock geometry userData for storing scale info
export interface RockGeometryUserData {
  rockScale?: { width: number; height: number; depth: number };
}

export interface EngineLike {
  container: HTMLElement;
  scene: THREE.Scene | null;
  /** Active render camera — perspective by default, orthographic while the
   *  top-down "fit whole world" mode is active. Use getDefaultCamera() when you
   *  specifically need the perspective camera (editor/debug/export tools). */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null;
  /** The default perspective camera created at boot (never the swapped ortho). */
  getDefaultCamera(): THREE.PerspectiveCamera;
  /** Swap the active render camera and rebind post-processing passes. */
  setRenderCamera(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera): void;
  /** Replace the skybox with a solid background color, or restore it with null. */
  setSolidBackground(color: string | null): void;
  /** Whether a solid background override is active (skybox should stay hidden). */
  isSolidBackgroundActive(): boolean;
  /** Current sky/fog fallback color as a hex string. */
  getSkyColorHex(): string;
  /** Current scene lighting config (world.json `lightingConfig`), or null for daylight defaults. */
  getLightingConfig?: () => LightingConfig | null;
  /**
   * Re-apply scene lighting from a `lightingConfig` block (sun, ambient floor,
   * environment and skybox intensity). Passing a config replaces the current
   * one; `undefined` re-applies the current config. Replayable at any time.
   */
  applyLightingConfig?: (config?: LightingConfig | null) => void;
  /**
   * Re-apply scene fog + sky fallback from a `fogConfig` block. Passing a config
   * replaces the current one; `undefined` re-applies the current config (a lighting
   * preset's own fog still fills whatever the config leaves unset). Replayable.
   */
  applyFogConfig?: (config?: FogConfig | null) => void;
  /** Current renderer config (world.json `renderConfig`), or null for defaults. */
  getRenderConfig?: () => RenderConfig | null;
  /**
   * Change the color grade at runtime (low-health desaturate, night tint…).
   * Merges `config` over the current `renderConfig.colorGrading`; include
   * `enabled: true` to switch it on. Value changes are free — no pipeline rebuild.
   */
  setColorGrading?: (config: Partial<ColorGradingConfig>) => void;
  /** Change the vignette at runtime (damage flash, focus). Same merge rules as `setColorGrading`. */
  setVignette?: (config: Partial<VignetteConfig>) => void;
  renderer: (THREE.WebGLRenderer & { domElement: HTMLElement }) | null;
  physicsWorld: import('../engine/physics/PhysicsWorld.js').PhysicsWorld | null;
  /**
   * The Z of the locked gameplay plane in a side-on 2D game, or null when the
   * game has no such plane (3D games, top-down 2D). NPC controllers
   * self-constrain to it — see `engine/GameplayPlane.ts` for the rule.
   * Optional for backward compat: older fakes and embedders simply have no
   * plane, and callers feature-detect with `?.()`.
   */
  getGameplayPlaneZ?(): number | null;
  /**
   * 2D-physics games: the Rapier 2D world behind the 3D `PhysicsWorld` surface
   * the character pipeline is written against (see
   * `engine/physics/PlaneLockedPhysics.ts`); null on the 3D lane. Optional for
   * the same backward-compat reason as `getGameplayPlaneZ`.
   */
  getPlaneLockedPhysics?(): import('../engine/physics/PlaneLockedPhysics.js').PlaneLockedPhysics | null;
  /**
   * Data-driven mechanism registry (world.json `mechanisms[]`). Custom
   * game-code mechanisms read their config with getSpec(id) and bind for
   * editor editability with registerCustom(id, object3D, editable).
   */
  getMechanismSystem?(): import('../engine/MechanismSystem.js').MechanismSystem | null;
  /**
   * Smart-object runtime: placed props whose asset carries moving parts
   * (windmill blades, ferris-wheel cabins, swinging signs). Parts animate on
   * their own; use this to change a part's speed or stop it:
   *
   * @example
   * const smart = this.engine.getSmartObjectSystem?.();
   * smart?.setPartSpeed('windmill_1', 'blades', 0);   // becalmed
   * smart?.setPartSpeed('windmill_1', 'blades', 3);   // storm
   */
  getSmartObjectSystem?(): import('../engine/SmartObjectSystem.js').SmartObjectSystem | null;
  /** Typed entries from the unified `worldProfileData.spawnPoints` array (open `type` vocabulary). */
  getSpawnPoints?(type?: string): SpawnPoint[];
  /**
   * The engine-owned open-water ocean (`worldProfileData.openWater`), or null
   * when this level is not open water. `BoatMovement` picks it up from here, so
   * a boat game never has to hand the surface around; anything else that floats
   * (custom buoys, jetties, a fishing bobber) should read it from here too.
   */
  getOceanSurface?(): import('../engine/water/OceanSurface.js').OceanSurface | null;
  physicsWorld2D?: import('../engine/physics/PhysicsWorld2D.js').PhysicsWorld2D | null;
  genreModule: import('../engine/GenreRegistry.js').GenreGameInterface | null;
  loader: any; // GLTFLoader but keeping as any for now
  /**
   * Compatibility only — the engine no longer reads this clock. Both
   * `getDelta()` and `getElapsedTime()` MUTATE it (getElapsedTime calls
   * getDelta internally), so calling either mid-frame used to steal the frame
   * delta from the engine's own loop and starve physics. Prefer
   * `getDeltaTime()` (this frame), `getElapsedTime()` (gameplay time, stops on
   * pause) or `getAmbienceTime()` (clock time, keeps running on pause).
   * Structurally identical to the now-deprecated THREE.Clock.
   */
  clock: import('../engine/FrameTimer.js').LegacyClock;
  editorManager: any; // EditorManager but avoiding circular dependency
  gameStateManager?: any; // GameStateManager but avoiding circular dependency
  isWindowFocused: boolean;
  isGaussianSplatMode: boolean; // Special mode for Gaussian splat rendering
  gaussianSplatRenderer?: any; // GaussianSplatRenderer but avoiding circular dependency
  gaussianSplatRenderers?: any[]; // All loaded splat renderers
  getWorldHeightAt?: (x: number, z: number) => number; // Raycast to find world height including colliders
  getWorldCenter?: () => THREE.Vector3; // World-space centre of the active level — corner-origin aware; use instead of a hardcoded (0,0)
  /** Standable point at (x, z) in the ACTIVE world: X/Z checked against the real terrain bounds
   *  (forged levels are corner-origin and need not start at 0), Y resolved through the live baked or
   *  procedural terrain. Returns a discriminated 'out-of-bounds' / 'no-ground' instead of Y = 0 —
   *  use it rather than assuming the map is centred or as large as its configured ground size. */
  resolveGroundPlacement: (
    x: number,
    z: number,
    options?: Partial<import('../engine/GroundPlacement.js').GroundPlacementOptions>,
  ) => import('../engine/GroundPlacement.js').GroundPlacement;
  /** Voxel-aware spawn position (set by voxel template). Optional fromY makes the
   *  spawn INTERIOR-aware: the floor is resolved by scanning down from that height
   *  (inside a roofed room → the room floor), instead of the topmost surface (the
   *  roof). Installers that ignore fromY keep the legacy topmost behaviour. */
  findValidVoxelSpawnPosition?: (x: number, z: number, fromY?: number) => THREE.Vector3 | null;
  recreateRenderer?: (antialias: boolean, type?: 'webgl' | 'webgpu') => void; // Allow templates to configure antialiasing and pin a renderer backend
  registerPlayerController: (playerController: PlayerControllerLike) => void; // Register player controller for access by debug systems
  getPlayerController: () => PlayerControllerLike | null; // Get the registered player controller
  /** Register a callback fired each frame AFTER all updates (camera included) and just BEFORE render.
   *  Pin a camera-attached visual (first-person view-model) here so it doesn't trail the camera by a
   *  frame and twitch. Returns an unregister fn. Optional: older engine builds may not provide it. */
  registerBeforeRender?: (callback: () => void) => () => void;
  /**
   * The first-person weapon view-model layer — a separate scene drawn in front
   * of the camera with its own depth buffer, so a weapon in it cannot clip into
   * the world. Optional because this interface is implemented by test doubles
   * and by engine builds that predate the layer.
   */
  getViewModelLayer?: () => import('engine/ViewModelLayer.js').ViewModelLayer | null;
  getActiveVehicle?: () => any | null; // Get the vehicle the player is currently driving
  enableBloomOnObject?: (object: THREE.Object3D) => void; // Enable bloom effect on specific objects

  // Level preloading / GPU warmup — move shader-compile + asset-decode cost in
  // front of the Play button so the player reveal (UFO beam-down) and the first
  // NPC/sound don't hitch on mobile. loadGame() calls preloadLevel() by default
  // (idempotent); a genre may call these directly for custom timing or to
  // preload specific audio. See GameEngine for behaviour.
  preloadLevel?: (opts?: { audioAssetIds?: string[] }) => Promise<void>;
  preloadPlayerCharacter?: () => Promise<void>;
  preloadNpcSkeleton?: () => Promise<void>;
  preloadAudio?: (idsOrUrls: string[]) => Promise<void>;
  /** Resolves true when the warmup render actually ran (see GameEngine). */
  warmUpScene?: (reveal?: THREE.Object3D[]) => Promise<boolean>;
  /** Run `cb` once the scene-wide warmup render has uploaded everything to the
   *  GPU (immediately if it already has). Systems use it to release CPU-side
   *  buffer copies. Never fires if the warmup render failed. */
  onSceneWarmedUp?: (cb: () => void) => void;

  // Vehicle Manager access (centralized vehicle registry)
  getVehicleManager?: () => import('../engine/VehicleManager.js').VehicleManager | null;
  setVehicleManager?: (manager: import('../engine/VehicleManager.js').VehicleManager) => void;

  // Vehicle Spawner access
  getVehicleSpawner?: () => import('../engine/VehicleSpawner.js').VehicleSpawner | null;
  setVehicleSpawner?: (spawner: import('../engine/VehicleSpawner.js').VehicleSpawner) => void;

  // Spawner access
  getSpawner?: () => import('../engine/Spawner.js').Spawner | null;
  setSpawner?: (spawner: import('../engine/Spawner.js').Spawner) => void;

  // PlayerLoader access (for debug tools)
  getPlayerLoader?: () => import('../engine/loaders/PlayerLoader.js').PlayerLoader | null;
  setPlayerLoader?: (loader: import('../engine/loaders/PlayerLoader.js').PlayerLoader) => void;

  // PlayerVisibility — single owner of the character's root visibility. Subsystems
  // contribute hide reasons; the controller composes them. Always present on
  // GameEngine (constructed eagerly), so the getter is required — callers can
  // do `engine.getPlayerVisibility().hide()` without optional chaining on the
  // method. See PlayerVisibility.ts.
  getPlayerVisibility: () => import('../engine/PlayerVisibility.js').PlayerVisibility;

  // Block character factory (template-specific character creation)
  blockCharacterFactory?: BlockCharacterFactoryType;

  // Character modifications callback (template-specific post-creation modifications)
  /**
   * Template hook run after the DEFAULT block character is built (the Bitmagic
   * mascot's rescale + re-ground). Not run for a per-game character body
   * (`characterUrl` GLB or `.vxl`): those are sized by their own measurements
   * and `characterConfig.height`.
   */
  applyCharacterModifications?: CharacterModificationsFunction;
  
  // Game data access (for environmentObjects serialization)
  getGameData?: () => GameData | null;

  // Animal registry access (for auto-updating animals)
  getAnimalRegistry?: () => import('../engine/animal/AnimalRegistry.js').AnimalRegistry;
  
  // Dynamic object manager for chunk-based hibernation (animals, NPCs, vehicles)
  getDynamicObjectManager?: () => import('../engine/DynamicObjectManager.js').DynamicObjectManager;

  // NPC Registry access (centralized NPC management for combat systems, etc.)
  getNpcRegistry?: () => import('../engine/npc/core/NpcRegistry.js').NpcRegistry | null;
  setNpcRegistry?: (registry: import('../engine/npc/core/NpcRegistry.js').NpcRegistry) => void;

  // Simplified NPC registration — the only NPC API templates and agents should use
  registerNpc: (
      name: string,
      behavior: import('../engine/npc/INpcBehavior.js').INpcBehavior,
      options?: import('../engine/npc/core/NpcRegistry.js').RegisterNpcOptions,
  ) => import('../engine/npc/core/NpcHandle.js').NpcHandle;

  // Template startup flow control
  /** Start the game programmatically (same as clicking Play). Fires analytics, transitions to PLAYING state, enables controls. */
  startGame?: () => void;
  /**
   * End the current game session. Transitions to `GameState.END` (freezing
   * physics, NPCs, and genre `update()` via the same gating as PAUSED),
   * releases pointer lock, renders a themed default overlay with a "Replay"
   * button (full page reload — deterministic via `worldSeed`), and fires
   * PokiSDK `gameplayStop()` automatically.
   *
   * Call this from genre code on ANY win/lose/draw/time-up/last-one-standing
   * condition. NEVER hand-roll a game-over screen with `hud.showToast`,
   * `hud.createCustomElement`, or a local `gameOver = true` flag — those skip
   * the simulation freeze and PokiSDK reporting, and leave the player without
   * a Replay path. Outcome shapes the title color: `'win'` → success green,
   * `'lose'` → danger red, `'draw'`/`'neutral'` → primary.
   *
   * @example
   * this.engine.endGame({ outcome: 'lose', title: 'You Died' });
   * this.engine.endGame({ outcome: 'win', title: 'Victory!', stats: [{label:'Kills', value:18}] });
   *
   * See `@docs end-game.md` for the full `EndGameOptions` shape.
   */
  endGame: (options?: Partial<import('../engine/ui/EndScreen.js').EndGameOptions>) => void;
  /** Show or hide the engine's Play button. Before first start, hiding it falls back to a safe Start control unless the template provides its own replacement start UI. */
  setPlayButtonVisible?: (visible: boolean) => void;
  /** Select which system owns the pre-start UI. Use `external` when another in-iframe UI replaces the default engine start menu. */
  setStartupUiMode?: (mode: StartupUiMode) => void;
  /**
   * The player's main-screen pre-play picks, keyed by
   * `hud.startScreen.selections[].id` (value = picked option id; for a
   * 'level' step, the picked level id). Empty when the game configures no
   * selections. Read at startGame() time or later — e.g.
   * `const difficulty = this.engine.getPreGameSelections?.()['difficulty'];`
   */
  getPreGameSelections?: () => Record<string, string>;

  // Video playback
  /** Play a video cutscene as a fullscreen overlay. Resolves when the video ends or is skipped. fadeIn/fadeOut in seconds (default 0.5, 0 to disable). */
  playVideo?: (assetId: string, options?: { skippable?: boolean; fadeIn?: number; fadeOut?: number }) => Promise<void>;

  /** Whether the screen recorder is actively capturing frames (templates should disable culling). */
  isRecordingFrames?: () => boolean;

  // Trailer timeline logging (always safe to call — no-ops unless an F9 frame
  // recording session is active; entries land in the recording's timeline.json)
  /**
   * Record a gameplay moment on the trailer timeline. Call it wherever the
   * game updates a score/lap/goal HUD counter or something exciting happens
   * that the engine can't see itself (e.g. `{ type: 'lap', data: { lap: 2 } }`,
   * `{ type: 'score', intensity: 0.9 }`).
   */
  logGameEvent(event: import('../engine/recording/GameEventLog.js').GameEventInput): void;
  /**
   * Record a synthesized SFX on the trailer timeline — call right where the
   * Web Audio nodes are built ("play it AND log it"), passing the recipe so
   * the sound can be re-rendered into the trailer offline.
   */
  logSoundEvent(name: string, recipe?: import('../engine/recording/GameEventLog.js').SynthSoundRecipe): void;

  // Audio playback (asset files, e.g. .opus)
  /** Play a one-shot sound effect. Fire-and-forget; multiple SFX can overlap. */
  playSound(assetId: string, opts?: { volume?: number }): void;
  /** Play a background music track. Only one music track at a time — cross-fades if another is playing. Defaults: loop=true, fadeIn=0.5s, volume=1. */
  playMusic(assetId: string, opts?: { loop?: boolean; fadeIn?: number; volume?: number }): Promise<void>;
  /** Fade out and stop the current music track. Default fadeOut=0.5s. */
  stopMusic(opts?: { fadeOut?: number }): Promise<void>;
  /** Set audio volumes. 0=silent, 1=full. `master` affects everything. */
  setAudioVolume(opts: { master?: number; sfx?: number; music?: number }): void;
  /**
   * Return the shared Web Audio API AudioContext used by the engine.
   * Use this instead of `new AudioContext()` so the mute button and
   * engine.setAudioVolume() take effect on your audio nodes.
   * Connect nodes to engine.getAudioDestination() to route through master volume.
   */
  getAudioContext?(): AudioContext | null;
  /**
   * Return the master gain input node (THREE.AudioListener's gain).
   * Connect Web Audio API source nodes here to have them controlled by
   * engine.setAudioVolume({ master: N }) and the mute button.
   */
  getAudioDestination?(): AudioNode | null;
  /**
   * Enable the engine's HUD mute button for this game.
   * Opt-in — call in `Game.load()` only when the user has asked for an on-screen mute button.
   * Not needed for muting itself: the pause menu's Mute toggle and the `M` key work without it.
   */
  enableMuteControl?(): void;

  /** True once the game has used audio (played a sound/music or grabbed the shared audio context/destination). */
  isAudioUsed?(): boolean;
  /** Current global mute state. */
  isAudioMuted?(): boolean;
  /** Set the global mute state (silences master gain + shared AudioContext, persists per-game, notifies listeners). */
  setAudioMuted?(muted: boolean): void;
  /** Subscribe to mute-state changes (keeps multiple mute controls in sync). Returns an unsubscribe function. */
  onAudioMuteChange?(cb: (muted: boolean) => void): () => void;
  /** Enable/disable the default M-key mute shortcut (on by default). Games using M for something else opt out. */
  setMuteHotkeyEnabled?(enabled: boolean): void;

  // Frame timing
  /** Get the current frame's delta time in seconds (time since last frame) */
  getDeltaTime?: () => number;
  /**
   * Total clock time in seconds — advances every rendered frame, including
   * while paused and in the editor. The time base for ambience (weather,
   * flicker, animated materials). Use this instead of `clock.getElapsedTime()`,
   * which is destructive and starves the engine's frame delta.
   */
  getAmbienceTime?: () => number;

  // Pointer lock manager access (for templates that need custom input modes)
  getPointerLockManager?: () => import('../engine/PointerLockManager.js').PointerLockManager | null;
  setPointerLockManager?: (manager: import('../engine/PointerLockManager.js').PointerLockManager) => void;

  // Interactive UI mode — release cursor without blur overlay (for dialogues, shops, menus)
  /** Release mouse cursor and disable controls for in-game UI. Call exitInteractiveUI() when done. */
  enterInteractiveUI?: () => void;
  /** Re-lock cursor and restore controls after enterInteractiveUI(). */
  exitInteractiveUI?: () => void;

  /** Get the runtime AI service for calling AI models from game code. */
  getAIService?: () => import('../engine/AIService.js').AIService;

  /**
   * Get the voice input service — microphone capture + speech-to-text.
   * `startListening()` / `stopListening()` for custom flows; for plain
   * hold-to-talk use `enablePushToTalk()` instead.
   */
  getVoiceInput?: () => import('../engine/VoiceInput.js').VoiceInput;

  /**
   * One-call push-to-talk: hold `V` (desktop) or the TALK button (mobile) to
   * speak; the transcript arrives in `onTranscript`. Call in `Game.load()`;
   * resets on each `loadGame()` like `enableMuteControl()`.
   */
  enablePushToTalk?: (
    onTranscript: (text: string) => void,
    options?: Partial<import('../engine/PushToTalk.js').PushToTalkOptions>,
  ) => void;

  /** Get the runtime screenshot service for capturing the canvas and uploading to cloud storage. */
  getScreenshotService?: () => import('../engine/ScreenshotService.js').ScreenshotService;

  /** Get the game persistence service for saving/loading player progress. */
  getGamePersistence?: () => import('../engine/persistence/GamePersistence.js').GamePersistence;

  /**
   * Get the game data service for storing arbitrary per-game JSON
   * (leaderboards, custom levels, shared world state). Distinct from
   * `getGamePersistence`, which is per-player browser-local save data.
   */
  getGameDataService?: () => import('../engine/gamedata/GameDataService.js').GameDataService;
  /** Ghost recording and replay. See docs/ghost-racing-design.md. */
  getGhostRacing?: () => import('../engine/replay/GhostRacing.js').GhostRacing;

  /**
   * Who this player is on a leaderboard — id, credential, and display name.
   *
   * Pass `playerId` and `verifier` to every `GameDataService.create()` that
   * writes a board row, and take the shown name from `displayName` rather than
   * asking the player to type one. A row written without the credential is
   * stamped with no owner, and the website renders it as a generated guest
   * name with no avatar and no profile link even for a signed-in player.
   *
   * ⚠ `verifier` is a bearer credential — it belongs in the `create()` call and
   * nowhere else. Never write it into `data` or `values`; reads are public.
   *
   * @example
   * const me = await this.engine.getLeaderboardIdentity?.();
   */
  getLeaderboardIdentity?: () => Promise<import('../engine/replay/GhostIdentity.js').LeaderboardIdentity>;

  /**
   * Tell the website this game has a leaderboard, so it can show it.
   *
   * The website cannot find a board on its own — it can neither list a game's
   * categories nor guess which way one sorts — so an undeclared board is
   * invisible there no matter how many rows it has. Safe to call on every
   * submit; repeats within a session are dropped and it never throws.
   */
  publishLeaderboard?: (
    declaration: import('../engine/gamedata/LeaderboardManifest.js').LeaderboardDeclaration,
  ) => Promise<void>;

  /**
   * Unlock a player achievement by its authored slug (umbrella P6).
   * Fire-and-forget: dedups per play session, shows a HUD toast (guests
   * included), and posts the unlock to the backend only when PlayerIdentity
   * yields a play token. Never throws and never blocks gameplay.
   *
   * Optional for frozen-published-game backward compatibility — the method is
   * installed by the current engine, so game code written after P6 can call it;
   * older published bundles simply never do. Definitions live in game data
   * (`worldProfileData.achievements`), authored by the agent, not in code.
   *
   * @example
   * this.engine.unlockAchievement?.('first_blood');
   */
  unlockAchievement?(id: string): void;

  /**
   * The data-driven dungeon door system, or null when the world declares no
   * `worldProfileData.doors` / `keyItems` (the engine only builds it when it
   * has something to build). Use it to script gates: `lockDoor`/`unlockDoor`
   * on a boss fight, `openDoor`/`closeDoor` on a puzzle, `getDoorState` to
   * read one, `getKeyring().has(keyId)` to check what the player carries.
   * Doors auto-open on proximity and unlock from the keyring on their own —
   * only scripted gates need this API.
   *
   * Optional for frozen-published-game backward compatibility — the method is
   * installed by the current engine, so game code written after the dungeon
   * door system can call it; older published bundles simply never do.
   *
   * @example
   * this.engine.getDoorSystem?.()?.lockDoor('boss_gate');
   */
  getDoorSystem?(): import('../engine/doors/DoorSystem.js').DoorSystem | null;

  /**
   * Engine-owned registry for `worldProfileData.customBlockTypes`. Loaded
   * before the genre's WorldGenerator runs so terrain.groundBlockType and
   * other name-based block lookups resolve consistently across genres.
   */
  blocks: import('../engine/BlockRegistry.js').BlockRegistry;

  /**
   * Get the world group (lazily created on first access).
   * All world objects (terrain, VoxelObjects, scenery) should be children of this group.
   * Guaranteed to exist before world generation runs.
   */
  getWorldGroup(): THREE.Object3D;

  /**
   * Add static objects to the world group (terrain, buildings, props).
   * Use this instead of scene.add() for anything that belongs to the
   * game world and should be hidden when toggling display modes.
   */
  addToWorld?: (...objects: THREE.Object3D[]) => void;

  /**
   * Spawn a library asset (world.json `assets[]` entry) into the scene at
   * runtime, by asset id or name — the code-side counterpart of declarative
   * `environmentObjects[]` placement. Use it for placements computed at
   * runtime (procedural levels, pickups, drops). Fetches each asset once and
   * clones per spawn; handles VXL metadata, physics, scene registration, and
   * optional collectible wiring (sensor + InteractionManager).
   *
   * @example
   * const coin = await this.engine.spawnAsset?.('golden_coin', {
   *     position: { x: 4, y: 2.5, z: 0 },
   *     collectible: { radius: 1.5, onCollect: () => this.addCoin() },
   * });
   */
  spawnAsset?: (
    assetIdOrName: string,
    options?: Partial<import('../engine/AssetSpawner.js').SpawnAssetOptions>,
  ) => Promise<import('../engine/AssetSpawner.js').SpawnedAsset | null>;

  /**
   * Load a Gaussian Splat (.spz) at runtime.
   * Templates use this to load splat assets by URL (looked up from gameData.assets).
   *
   * Scale is auto-computed from worldProfileData (groundWorldSizeX/Z) to match
   * the nerfstudio normalization used during export. No manual sizing needed.
   * Explicit position/eulerAngles/scale overrides are available for advanced use.
   *
   * Returns the renderer instance for visibility control.
   */
  loadGaussianSplat?: (url: string, config?: {
      position?: Vector3Like;
      eulerAngles?: Vector3Like;
      scale?: Vector3Like;
  }) => Promise<any>;
}
