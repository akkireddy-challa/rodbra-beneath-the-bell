/**
 * Mesh level: an authored GLB (built in Blender, or any DCC tool) as the whole
 * world — see mesh-level.md. The GLB is an `assets[]` entry registered with
 * `bitmagic assets add level.glb --keep-glb`; the companion JSON is a static
 * import so the bundler inlines it and nothing can 404 after publish.
 *
 * world.json must carry `terrain: { shape: 'none' }` or the voxel ground plane
 * is built underneath the level as well.
 *
 * Referenced from agent docs (read-docs name: `samples/mesh-level-setup`).
 * Compiled against the live engine by game's `pnpm run check`.
 */
import * as THREE from 'three';
import { MeshLevel, DEFAULT_MESH_LEVEL_OPTIONS } from 'engine/meshlevel/MeshLevel.js';
import { DEFAULT_FALL_RESCUE_OPTIONS } from 'engine/FallRescue.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import type { EngineLike } from 'types/game.js';

// In a real game this is `import stationJson from './station.mesh-level.json';`
// (the file the Blender exporter wrote, copied into src/work/). Typed as
// `unknown` here because the sample has no JSON beside it.
declare const stationJson: unknown;

export class StationGame {
    private level: MeshLevel | null = null;

    constructor(private readonly engine: EngineLike) {}

    /** Call after the engine has physics and the player controller exists. */
    async loadStation(player: PlayerController, guardBehavior: INpcBehavior): Promise<void> {
        const level = new MeshLevel(
            this.engine,
            { glb: { assetId: 'level-station' }, level: { data: stationJson } },
            // Spread the defaults and change only what this game needs.
            { ...DEFAULT_MESH_LEVEL_OPTIONS, friction: 0.9 },
        );
        const result = await level.load();
        this.level = level;

        // No ground plane: anything that falls out of the level should respawn,
        // not fall for ever. Put the kill plane well under the lowest floor.
        player.configureFallRescue({ ...DEFAULT_FALL_RESCUE_OPTIONS, killPlaneY: result.bounds.minY - 50 });

        // Landmarks are authored points. `landmark()` throws with the known
        // names when one is missing — a typo must not spawn the boss at (0,0,0).
        const spawn = level.landmark('spawn');
        player.teleportTo(spawn.position[0], spawn.position[1], spawn.position[2], spawn.yaw);

        // One NPC per landmark tagged `security`. Interior spawns pass Y so the
        // floor of THAT storey is used, not the roof above it.
        const guards = this.engine.registerNpc('station_security', guardBehavior, { autoRespawn: false });
        for (const post of level.landmarksTagged('security')) {
            await guards.spawn(post.position[0], post.position[2], post.position[1]);
        }
    }

    /** Volumes are authored regions: which room is the player in, is this an airlock, is it pressurised. */
    update(playerPosition: THREE.Vector3): void {
        if (!this.level) return;
        const volumes = this.level.volumesAt(playerPosition);
        const pressurised = volumes.some((v) => v.tags.includes('pressure'));
        if (!pressurised) {
            // switch to zero-g movement, drain oxygen, ...
        }
    }

    dispose(): void {
        this.level?.dispose();
        this.level = null;
    }
}
