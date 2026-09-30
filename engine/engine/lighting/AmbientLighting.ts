import * as THREE from 'three';
import { PMREMGenerator as PMREMGeneratorWebGPU } from 'three/webgpu';
// `three` resolves to the WEBGPU build (see index.html's import map), so
// THREE.PMREMGenerator is the WebGPU one — it calls renderer.hasInitialized(),
// which a classic WebGLRenderer doesn't have. Same reason GameEngine.ts pulls
// WebGLRenderer from its own module: the classic PMREM comes from src.
import { PMREMGenerator as PMREMGeneratorWebGL } from 'three/src/extras/PMREMGenerator.js';
import { isWebGpuActive } from 'engine/RendererType.js';
import { SkyboxLoader } from 'engine/loaders/SkyboxLoader.js';
import { neutralEnvironmentGradient } from 'engine/lighting/NeutralEnvironmentGradient.js';

type EngineLike = {
    scene: THREE.Scene | null;
    renderer: THREE.WebGLRenderer | null;
};

// PMREMGenerator from 'three' and from 'three/webgpu' share the methods we use
// (fromEquirectangular, dispose); pick the right one per backend.
type AnyPMREM = {
    fromEquirectangular(tex: THREE.Texture): THREE.RenderTarget;
    dispose(): void;
};

export class AmbientLighting {
    private engine: EngineLike;
    private envMap: AnyPMREM | null = null;
    private currentEnvMapTarget: THREE.RenderTarget | null = null;
    private unsubscribe?: () => void;

    constructor(engine: EngineLike, skyboxLoader: SkyboxLoader) {
        this.engine = engine;
        // updateFromScene handles ensureEnvMap and the WebGPU-backend-ready gate.
        this.updateFromScene();
        this.unsubscribe = skyboxLoader.on('loaded', () => {
            this.updateFromScene();
        });
    }

    private ensureEnvMap(): void {
        if (!this.envMap && this.engine.renderer) {
            this.envMap = isWebGpuActive()
                ? new PMREMGeneratorWebGPU(this.engine.renderer as unknown as ConstructorParameters<typeof PMREMGeneratorWebGPU>[0])
                : new PMREMGeneratorWebGL(this.engine.renderer);
        }
    }

    public updateFromScene(): void {
        const scene = this.engine.scene;
        if (!scene || !this.engine.renderer) {
            console.warn('AmbientLighting: scene/renderer not available');
            return;
        }

        // Under WebGPU, PMREMGenerator.fromEquirectangular() requires the
        // renderer backend to be initialized (init() is async). The engine
        // fires init() without awaiting, so the genre may construct
        // AmbientLighting before the backend is ready. Defer until then to
        // avoid the "called before the backend is initialized" warning and a
        // dropped first env-map build. WebGLRenderer has no hasInitialized().
        const r = this.engine.renderer as unknown as { hasInitialized?: () => boolean; init?: () => Promise<unknown> };
        if (typeof r.hasInitialized === 'function' && !r.hasInitialized()) {
            r.init?.().then(() => this.updateFromScene()).catch(() => { /* init error already logged by engine */ });
            return;
        }

        this.ensureEnvMap();
        if (!this.envMap) {
            console.warn('AmbientLighting: envMap not available');
            return;
        }

        const tex = AmbientLighting.detectEnvironmentTexture(scene);
        if (!tex) {
            const newTarget = AmbientLighting.applyNeutralFallback(scene, this.envMap);
            if (this.currentEnvMapTarget) this.currentEnvMapTarget.dispose();
            this.currentEnvMapTarget = newTarget;
            return;
        }

        const newTarget = this.envMap.fromEquirectangular(tex);
        if (this.currentEnvMapTarget) this.currentEnvMapTarget.dispose();
        this.currentEnvMapTarget = newTarget;
        scene.environment = newTarget.texture;
    }

    private static detectEnvironmentTexture(scene: THREE.Scene): THREE.Texture | null {
        const skyboxMesh = scene.getObjectByName(SkyboxLoader.SKYBOX_NAME) as THREE.Mesh | null; // Prefer a skybox mesh named "Skybox"
        if (skyboxMesh) {
            const materials = Array.isArray((skyboxMesh as any).material)
                ? (skyboxMesh as any).material
                : [(skyboxMesh as any).material];

            for (const mat of materials) {
                if (!mat) continue;
                // Check standard material.map property
                if (mat.map && (mat.map as any).isTexture) {
                    return mat.map as THREE.Texture;
                }
                // SkyboxMaterialHelper stashes the equirect texture on userData.
                const stashed = (mat as any).userData?.skyboxTexture;
                if (stashed && stashed.isTexture) {
                    return stashed as THREE.Texture;
                }
            }
        }

        const bg = scene.background as any;
        if (bg && bg.isTexture) return bg as THREE.Texture;

        return null;
    }

    /**
     * Fallback IBL for a scene with no skybox, so PBR never goes black and a
     * reflective surface still has a horizon to catch — see
     * `NeutralEnvironmentGradient.ts` for why a flat grey was not enough.
     */
    private static applyNeutralFallback(scene: THREE.Scene, envMap: AnyPMREM): THREE.RenderTarget {
        const background = scene.background instanceof THREE.Color ? scene.background : null;
        const gradient = neutralEnvironmentGradient(background);
        const tex = new THREE.DataTexture(gradient.data, gradient.width, gradient.height, THREE.RGBAFormat);
        tex.needsUpdate = true;

        const target = envMap.fromEquirectangular(tex);
        tex.dispose(); // dispose temporary dataTex
        scene.environment = target.texture;
        return target;
    }

    dispose(): void {
        const scene = this.engine.scene;

        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = undefined;
        }

        if (scene && this.currentEnvMapTarget && scene.environment === this.currentEnvMapTarget.texture) {
            scene.environment = null;
        }

        if (this.currentEnvMapTarget) {
            this.currentEnvMapTarget.dispose();
            this.currentEnvMapTarget = null;
        }
        if (this.envMap) {
            this.envMap.dispose();
            this.envMap = null;
        }
    }
}
