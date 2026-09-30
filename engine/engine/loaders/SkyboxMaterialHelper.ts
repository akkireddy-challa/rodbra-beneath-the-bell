import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, uniform, texture, vec2, vec3, float,
    cameraPosition, positionWorld,
    sin, cos, atan, acos, smoothstep, mix, fract, PI,
} from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';
import { SkyboxVertexShader } from 'engine/loaders/SkyboxVertexShader.js';
import { SkyboxFragmentShader } from 'engine/loaders/SkyboxFragmentShader.js';
import { attachSkyboxCameraFollow } from 'engine/loaders/SkyboxFollow.js';

// Public uniforms shape — callers mutate `.value`. TSL UniformNode exposes the
// same shape at runtime so we cast through unknown when exposing them.
type Uni<T> = { value: T };

export type SkyboxUniforms = {
    skyboxTexture: Uni<THREE.Texture>;
    texelSize:     Uni<THREE.Vector2>;
    mainRotation:  Uni<number>;
    seamFeather:   Uni<number>;
    seamWidthMin:  Uni<number>;
    seamWidthMax:  Uni<number>;
    contrastLow:   Uni<number>;
    contrastHigh:  Uni<number>;
    screenSize:    Uni<THREE.Vector2>;
    brightness:    Uni<number>;
};

export type SkyboxOptions = {
    texelSize?: THREE.Vector2;
    rotationDeg?: number;
    seamFeather?: number;
    seamWidthMin?: number;
    seamWidthMax?: number;
    contrastLow?: number;
    contrastHigh?: number;
    screenSize?: THREE.Vector2;
    linearTexture?: boolean;
    /** Sky brightness multiplier (worldProfileData.lightingConfig.skyboxIntensity). 1 = authored image brightness. */
    brightness?: number;
};

export class SkyboxMaterialHelper {
    /**
     * Build a skybox MeshBasicNodeMaterial (TSL port of the original equirect
     * sampler with seam blend). Returns the material plus a `Uni<T>`-shaped
     * uniforms object that callers can mutate via `.value = newValue`.
     */
    static createMaterial(tex: THREE.Texture, opts: SkyboxOptions = {}): { material: THREE.Material; uniforms: SkyboxUniforms } {
        const {
            rotationDeg   = 33.3,
            seamFeather   = 0.01,
            seamWidthMin  = 0.01,
            seamWidthMax  = 0.06,
            contrastLow   = 0.05,
            contrastHigh  = 0.85,
            screenSize    = new THREE.Vector2(window.innerWidth, window.innerHeight),
            texelSize     = new THREE.Vector2(1 / (tex.image as HTMLImageElement).width, 1 / (tex.image as HTMLImageElement).height),
            brightness    = 1.0,
        } = opts;

        const params = {
            rotationDeg, seamFeather, seamWidthMin, seamWidthMax,
            contrastLow, contrastHigh, texelSize, screenSize, brightness,
        };
        return isWebGpuActive()
            ? SkyboxMaterialHelper.createNodeMaterial(tex, params)
            : SkyboxMaterialHelper.createShaderMaterial(tex, params);
    }

    private static createNodeMaterial(tex: THREE.Texture, p: Required<Omit<SkyboxOptions, 'linearTexture'>>): { material: THREE.Material; uniforms: SkyboxUniforms } {
        const mainRotationN = uniform(p.rotationDeg);
        const seamFeatherN = uniform(p.seamFeather);
        const seamWidthMinN = uniform(p.seamWidthMin);
        const seamWidthMaxN = uniform(p.seamWidthMax);
        const contrastLowN = uniform(p.contrastLow);
        const contrastHighN = uniform(p.contrastHigh);
        const texelSizeN = uniform(p.texelSize.clone());
        const screenSizeN = uniform(p.screenSize.clone());
        const brightnessN = uniform(p.brightness);

        const material = new MeshBasicNodeMaterial({
            side: THREE.BackSide,
            depthWrite: false,
            // Tone-mapped like the rest of the frame. The WebGPU renderer and every
            // post chain tone-map the whole image regardless of this flag, so
            // `false` only ever took effect on WebGL without post effects — the
            // one path where the sky looked different.
            toneMapped: true,
            fog: false,
        });

        material.colorNode = Fn(() => {
            const dir = cameraPosition.sub(positionWorld).normalize().negate().toVar();

            const yaw = mainRotationN.mul(PI).div(180);
            const s = sin(yaw);
            const c = cos(yaw);
            const rdir = vec3(
                c.mul(dir.x).sub(s.mul(dir.z)),
                dir.y,
                s.mul(dir.x).add(c.mul(dir.z)),
            );

            const phi = atan(rdir.z, rdir.x);
            const u = float(0.5).sub(phi.div(PI.mul(2)));
            const v = acos(rdir.y.clamp(-1, 1)).div(PI);

            const uFrac = fract(u);
            const vSample = v.negate();

            const halfTexel = texelSizeN.x.mul(0.5).max(float(1e-6));
            const uSample = uFrac.clamp(halfTexel, float(1).sub(halfTexel));
            const uOppSample = float(1).sub(uFrac).clamp(halfTexel, float(1).sub(halfTexel));

            const texNode = texture(tex);
            const c0 = texNode.sample(vec2(uSample, vSample)).rgb;
            const c1 = texNode.sample(vec2(uOppSample, vSample)).rgb;

            const lum = vec3(0.2126, 0.7152, 0.0722);
            const l0 = c0.dot(lum);
            const l1 = c1.dot(lum);
            const lumDiff = l1.sub(l0).abs();
            const denom = contrastHighN.sub(contrastLowN).max(float(1e-6));
            const t01 = lumDiff.sub(contrastLowN).div(denom).clamp(0, 1);
            const seamWidth = mix(seamWidthMinN, seamWidthMaxN, t01).max(float(1e-4));

            const w0 = smoothstep(seamWidth, 0, uFrac).toVar();
            const w1 = w0.add(seamFeatherN.mul(w0.mul(w0).sub(w0))).clamp(0, 1).toVar();
            const w = w1.mul(w1).mul(float(3).sub(w1.mul(2)));

            return mix(c0, c1, w).mul(brightnessN);
        })();

        // Stash the texture on the material so disposeSkybox can free it.
        (material as THREE.Material & { userData: Record<string, unknown> }).userData.skyboxTexture = tex;

        const uniforms = {
            skyboxTexture: { value: tex } as Uni<THREE.Texture>,
            texelSize:     texelSizeN as unknown as Uni<THREE.Vector2>,
            mainRotation:  mainRotationN as unknown as Uni<number>,
            seamFeather:   seamFeatherN as unknown as Uni<number>,
            seamWidthMin:  seamWidthMinN as unknown as Uni<number>,
            seamWidthMax:  seamWidthMaxN as unknown as Uni<number>,
            contrastLow:   contrastLowN as unknown as Uni<number>,
            contrastHigh:  contrastHighN as unknown as Uni<number>,
            screenSize:    screenSizeN as unknown as Uni<THREE.Vector2>,
            brightness:    brightnessN as unknown as Uni<number>,
        };

        return { material, uniforms };
    }

    private static createShaderMaterial(tex: THREE.Texture, p: Required<Omit<SkyboxOptions, 'linearTexture'>>): { material: THREE.Material; uniforms: SkyboxUniforms } {
        const uniforms: SkyboxUniforms = {
            skyboxTexture: { value: tex },
            texelSize:     { value: p.texelSize.clone() },
            mainRotation:  { value: p.rotationDeg },
            seamFeather:   { value: p.seamFeather },
            seamWidthMin:  { value: p.seamWidthMin },
            seamWidthMax:  { value: p.seamWidthMax },
            contrastLow:   { value: p.contrastLow },
            contrastHigh:  { value: p.contrastHigh },
            screenSize:    { value: p.screenSize.clone() },
            brightness:    { value: p.brightness },
        };

        const material = new THREE.ShaderMaterial({
            vertexShader: SkyboxVertexShader,
            fragmentShader: SkyboxFragmentShader,
            uniforms,
            side: THREE.BackSide,
            depthWrite: false,
            // Tone-mapped like the rest of the frame. The WebGPU renderer and every
            // post chain tone-map the whole image regardless of this flag, so
            // `false` only ever took effect on WebGL without post effects — the
            // one path where the sky looked different.
            toneMapped: true,
            fog: false,
        });

        // Stash the texture on the material so disposeSkybox can free it
        // (matches the NodeMaterial path's userData convention).
        (material as THREE.Material & { userData: Record<string, unknown> }).userData.skyboxTexture = tex;

        return { material, uniforms };
    }

    static createMesh(
        tex: THREE.Texture,
        opts: SkyboxOptions = {}
    ): { mesh: THREE.Mesh; material: THREE.Material; uniforms: SkyboxUniforms } {
        const linearTexture = opts.linearTexture ?? true;
        tex.colorSpace = linearTexture ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;

        const { material, uniforms } = this.createMaterial(tex, opts);

        const geometry = new THREE.SphereGeometry(500, 60, 40);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'Skybox';
        mesh.renderOrder = -1;

        // Stash the uniforms on the mesh so scene-level systems (GameEngine's
        // applyLightingConfig) can adjust brightness later without holding a
        // reference to this loader.
        mesh.userData.skyboxUniforms = uniforms;

        // Keep the camera at the sphere's centre even when the world isn't
        // centred at the origin (e.g. world-forger levels) — otherwise the sky
        // skews and breaks once the player passes the sphere radius.
        attachSkyboxCameraFollow(mesh);

        return { mesh, material, uniforms };
    }

    static setRotation(uniforms: SkyboxUniforms, deg: number): void {
        uniforms.mainRotation.value = deg;
    }

    /** Set the sky brightness multiplier (1 = authored image brightness). */
    static setBrightness(uniforms: SkyboxUniforms, brightness: number): void {
        uniforms.brightness.value = brightness;
    }

    /** Read the uniforms stashed on a skybox mesh by createMesh(), if present. */
    static getUniformsFromMesh(mesh: THREE.Object3D | null | undefined): SkyboxUniforms | null {
        const uniforms = mesh?.userData?.skyboxUniforms as SkyboxUniforms | undefined;
        return uniforms ?? null;
    }

    static disposeSkybox(mesh: THREE.Object3D | null | undefined): void {
        if (!mesh || !(mesh instanceof THREE.Mesh)) return;
        if (mesh.geometry) mesh.geometry.dispose();

        const mat = mesh.material as THREE.Material | THREE.Material[] | null | undefined;
        const disposeMat = (m?: THREE.Material | null) => {
            if (!m) return;
            const tex = (m as THREE.Material & { userData: Record<string, unknown> }).userData?.skyboxTexture as THREE.Texture | undefined;
            if (tex) tex.dispose();
            m.dispose();
        };

        if (Array.isArray(mat)) mat.forEach(disposeMat); else disposeMat(mat as THREE.Material | null);
        if (mesh.parent) mesh.parent.remove(mesh);
    }
}
