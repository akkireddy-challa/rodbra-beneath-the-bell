import * as THREE from 'three';
import type { WorldProfileData, EngineLike } from 'types/game.js';
import { SkyboxMaterialHelper } from 'engine/loaders/SkyboxMaterialHelper.js';

type SkyboxLoaderEvents = {
    loaded: (texture: THREE.Texture) => void;
    error: (err: unknown) => void;
};

export class SkyboxLoader {
    public static readonly SKYBOX_NAME = 'Skybox';

    private engine: EngineLike;
    private worldProfileData: WorldProfileData;

    private listeners: { [K in keyof SkyboxLoaderEvents]: Set<SkyboxLoaderEvents[K]> } = {
        loaded: new Set(),
        error: new Set(),
    };
    
    constructor(engine: EngineLike, worldProfileData: WorldProfileData) {
        this.engine = engine;
        this.worldProfileData = worldProfileData;
    }

    public on<K extends keyof SkyboxLoaderEvents>(type: K, cb: SkyboxLoaderEvents[K]): () => void {
        this.listeners[type].add(cb);
        return () => this.off(type, cb);
    }

    public off<K extends keyof SkyboxLoaderEvents>(type: K, cb: SkyboxLoaderEvents[K]): void {
        this.listeners[type].delete(cb);
    }

    private emitLoaded(texture: THREE.Texture): void {
        for (const cb of this.listeners.loaded) cb(texture);
    }

    private emitError(err: unknown): void {
        for (const cb of this.listeners.error) cb(err);
    }

    updateWorldProfileData(worldProfileData: WorldProfileData): void {
        this.worldProfileData = worldProfileData;
    }

    async loadSkybox(worldProfileData?: WorldProfileData): Promise<void> {
        const profileData = worldProfileData || this.worldProfileData;
        const skyboxUrl = profileData.skyboxUrl;
        if (!skyboxUrl) {
            console.log('No skybox URL provided, using default sky');
            return;
        }

        // Remove existing skybox if it exists
        if (this.engine.scene) {
            const existingSkybox = this.engine.scene.getObjectByName(SkyboxLoader.SKYBOX_NAME);
            SkyboxMaterialHelper.disposeSkybox(existingSkybox);
        }

        console.log(`Loading skybox from: ${skyboxUrl}`);

        const texture = await new Promise<THREE.Texture>((resolve, reject) => {
            new THREE.TextureLoader().load(
                skyboxUrl,
                (t) => resolve(t),
                undefined,
                (err) => { this.emitError(err); reject(err); }
            );
        });
        
        // The skybox may load after loadGame applied the lighting config, so
        // bake the configured sky brightness in at creation time. Later config
        // changes reach the mesh via GameEngine.applyLightingConfig().
        const skyboxIntensity = this.engine.getLightingConfig?.()?.skyboxIntensity ?? 1.0;
        const { mesh } = SkyboxMaterialHelper.createMesh(texture, { brightness: skyboxIntensity });

        mesh.name = SkyboxLoader.SKYBOX_NAME;

        if (this.engine.scene) {
            // A fit-world top-down view replaces the skybox with a solid margin
            // color; the skybox loads async, so honor an active override instead
            // of popping back in over the margins.
            if (this.engine.isSolidBackgroundActive()) {
                mesh.visible = false; // keep the solid scene.background visible
            } else {
                this.engine.scene.background = null;
            }
            this.engine.scene.add(mesh);
        }

        console.log('Skybox loaded and applied successfully');
        this.emitLoaded(texture);
    }
}