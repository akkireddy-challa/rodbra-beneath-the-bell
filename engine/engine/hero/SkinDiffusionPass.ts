import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, float, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { configureSkinAtlasPigment, configureSkinCoveragePass, copySkinAtlasBinding } from 'engine/hero/SkinAtlasDetail.js';
import { createSkinDiffusionKernel } from 'engine/hero/SkinDiffusionKernel.js';
import { isWebGpuActive } from 'engine/RendererType.js';

/** Screen-space, depth-gated separable diffuse transport. World units are metres.
 * Filters diffuse / albedo, then reapplies albedo to preserve pigment detail.
 * Keeps specular by compositing beauty + scatteredDiffuse - diffuse.
 * This isolated review pass rerenders geometry; production should use an MRT path.
 */
export class SkinDiffusionPass {
    radiusMm = 3;
    strength = 0.75;
    readonly profile = new THREE.Vector3(1, 0.55, 0.3);
    private readonly kernel = createSkinDiffusionKernel().map(t => uniform(new THREE.Vector4(...t.weight, t.offset / 3)));
    private lastProfile = '';
    private readonly beauty = this.target(4);
    private readonly diffuse = this.target(4);
    private readonly albedo = this.target(4);
    private readonly albedoCache = new Map<THREE.Material, THREE.Material>();
    private readonly horizontal = this.target();
    private readonly vertical = this.target();
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    private readonly cache = new Map<THREE.Material, THREE.Material>();
    private readonly params = { near: uniform(0.01), far: uniform(50), scale: uniform(1), strength: uniform(0.75), profile: uniform(this.profile) };
    private readonly blurX: THREE.Material;
    private readonly blurY: THREE.Material;
    private readonly composite: THREE.Material;

    constructor() {
        this.diffuse.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
        this.scene.add(this.quad);
        this.blurX = this.material(this.diffuse.texture, new THREE.Vector2(1, 0), false);
        this.blurY = this.material(this.horizontal.texture, new THREE.Vector2(0, 1), false);
        this.composite = this.material(this.vertical.texture, new THREE.Vector2(), true);
    }

    private target(samples = 0): THREE.WebGLRenderTarget {
        return new THREE.WebGLRenderTarget(1, 1, { samples, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    }

    private material(input: THREE.Texture, axis: THREE.Vector2, composite: boolean): THREE.Material {
        const resolution = new THREE.Vector2(1, 1);
        const uniforms = {
            source: { value: input }, original: { value: this.diffuse.texture }, beauty: { value: this.beauty.texture },
            albedoMap: { value: this.albedo.texture }, depthMap: { value: this.diffuse.depthTexture }, axis: { value: axis }, resolution: { value: resolution },
            near: this.params.near, far: this.params.far, scale: this.params.scale, strength: this.params.strength, profile: this.params.profile, kernel: { value: this.kernel.map(t => t.value) },
        };
        if (isWebGpuActive()) {
            const material = new MeshBasicNodeMaterial();
            const size = uniform(resolution);
            const p = this.params;
            const depth = (at: Node<'vec2'>) => p.near.mul(p.far).div(p.far.sub(texture(this.diffuse.depthTexture!).sample(at).r.mul(p.far.sub(p.near))));
            material.fragmentNode = Fn(() => {
                const at = vec2(uv().x, uv().y.oneMinus());
                const original = texture(this.diffuse.texture).sample(at);
                if (composite) return vec4(texture(this.beauty.texture).sample(at).rgb.add(texture(input).sample(at).rgb.mul(texture(this.albedo.texture).sample(at).rgb.max(0.02)).sub(original.rgb).mul(original.a).mul(p.strength)).max(0), 1);
                const center = texture(input).sample(at);
                const z = depth(at);
                const centerIrradiance = axis.x === 1 ? center.rgb.div(texture(this.albedo.texture).sample(at).rgb.max(0.02)) : center.rgb;
                const sum = vec3(0).toVar();
                for (const tap of this.kernel) {
                    const sampleUV = at.add(vec2(axis.x, axis.y).div(size).mul(p.scale.div(z)).mul(tap.w));
                    const sample = texture(input).sample(sampleUV);
                    const mask = texture(this.diffuse.texture).sample(sampleUV).a;
                    const inBounds = sampleUV.x.greaterThanEqual(0).and(sampleUV.x.lessThanEqual(1))
                        .and(sampleUV.y.greaterThanEqual(0)).and(sampleUV.y.lessThanEqual(1));
                    const gate = depth(sampleUV).sub(z).abs().div(float(0.003)).negate().exp().mul(mask).mul(float(inBounds));
                    const irradiance = axis.x === 1 ? sample.rgb.div(texture(this.albedo.texture).sample(sampleUV).rgb.max(0.02)) : sample.rgb;
                    // Reject toward the center instead of renormalizing the profile at silhouettes.
                    sum.addAssign(centerIrradiance.add(irradiance.sub(centerIrradiance).mul(gate)).mul(tap.xyz));
                }
                return vec4(sum, center.a);
            })();
            material.depthTest = material.depthWrite = false;
            material.toneMapped = composite;
            material.userData.resolution = resolution;
            return material;
        }
        const material = new THREE.ShaderMaterial({ uniforms, depthTest: false, depthWrite: false,
            vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
            fragmentShader: `varying vec2 vUv; uniform sampler2D source, original, beauty, depthMap, albedoMap;
                uniform vec2 axis,resolution; uniform float near,far,scale,strength; uniform vec3 profile; uniform vec4 kernel[25];
                float depth(vec2 p){return near*far/(far-texture2D(depthMap,p).r*(far-near));}
                void main(){vec4 c=texture2D(source,vUv);vec4 o=texture2D(original,vUv);
                ${composite ? 'gl_FragColor=vec4(max(vec3(0.),texture2D(beauty,vUv).rgb+(c.rgb*max(texture2D(albedoMap,vUv).rgb,vec3(.02))-o.rgb)*o.a*strength),1.);' : `
                float z=depth(vUv);vec3 sum=vec3(0.);
                vec3 centerIrradiance=c.rgb${axis.x === 1 ? '/max(texture2D(albedoMap,vUv).rgb,vec3(.02))' : ''};
                for(int i=0;i<25;i++){vec2 p=vUv+axis/resolution*(scale/z)*kernel[i].w;
                float inside=step(0.,p.x)*step(p.x,1.)*step(0.,p.y)*step(p.y,1.);
                float gate=exp(-abs(depth(p)-z)/.003)*texture2D(original,p).a*inside;
                vec3 irradiance=texture2D(source,p).rgb${axis.x === 1 ? '/max(texture2D(albedoMap,p).rgb,vec3(.02))' : ''};
                sum+=mix(centerIrradiance,irradiance,gate)*kernel[i].rgb;}
                gl_FragColor=vec4(sum,c.a);`}
                ${composite ? 'if(texture2D(depthMap,vUv).r<1.){\n#include <tonemapping_fragment>\n}\n#include <colorspace_fragment>' : ''}
                }`,
        });
        material.toneMapped = composite; material.userData.resolution = resolution;
        return material;
    }

    /** Linear base color, without lighting: keep pigmentation out of the blur. */
    private albedoMaterial(source: THREE.Material): THREE.Material {
        const cached = this.albedoCache.get(source); if (cached) return cached;
        if (source.userData.characterSurface !== 'skin') return this.diffuseMaterial(source);
        if (!(source instanceof THREE.MeshStandardMaterial || source instanceof MeshPhysicalNodeMaterial)) throw new Error('Skin albedo requires a PBR material');
        const material = isWebGpuActive() ? new MeshBasicNodeMaterial() : new THREE.MeshBasicMaterial();
        material.map = source.map;
        material.color.copy(source.color);
        material.side = source.side;
        material.vertexColors = source.vertexColors;
        material.toneMapped = false;
        configureSkinAtlasPigment(source, material);
        this.albedoCache.set(source, material);
        return material;
    }

    private diffuseMaterial(source: THREE.Material): THREE.Material {
        const cached = this.cache.get(source); if (cached) return cached;
        let result: THREE.Material;
        if (source.userData.characterSurface === 'skin' && (source instanceof THREE.MeshStandardMaterial || source instanceof MeshPhysicalNodeMaterial)) {
            result = source.clone();
            copySkinAtlasBinding(source, result);
            // Zero only the surface reflection. Lighting, albedo and fine normals stay identical.
            (result as THREE.MeshPhysicalMaterial).specularIntensity = 0;
            if (result instanceof MeshPhysicalNodeMaterial) result.specularIntensityNode = null;
            result.onBeforeCompile = source.onBeforeCompile;
            if (source.userData.skinSurfaceBlend === true) {
                const previous = result.onBeforeCompile;
                result.onBeforeCompile = (shader, renderer) => {
                    shader.fragmentShader = '#define CHARACTER_SKIN_DIFFUSE_PASS\n' + shader.fragmentShader;
                    previous(shader, renderer);
                };
            }
            result.customProgramCacheKey = () => 'skin-diffuse-only-v1';
            configureSkinCoveragePass(source, result, 'alpha');
        } else {
            result = isWebGpuActive() ? new MeshBasicNodeMaterial() : new THREE.MeshBasicMaterial();
            if (result instanceof MeshBasicNodeMaterial) result.fragmentNode = vec4(0);
            else (result as THREE.MeshBasicMaterial).color.set(0);
            result.opacity = 0; result.transparent = true; result.blending = THREE.NoBlending; result.depthWrite = true;
            result.side = source.side;
        }
        this.cache.set(source, result); return result;
    }

    render(renderer: THREE.WebGLRenderer | WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
        const profileKey = this.profile.toArray().join(',');
        if (profileKey !== this.lastProfile) {
            createSkinDiffusionKernel(this.profile.toArray()).forEach((tap, i) => this.kernel[i]!.value.set(...tap.weight, tap.offset / 3));
            this.lastProfile = profileKey;
        }
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        for (const target of [this.beauty, this.diffuse, this.albedo, this.horizontal, this.vertical]) if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
        for (const material of [this.blurX, this.blurY, this.composite]) (material.userData.resolution as THREE.Vector2).copy(size);
        this.params.near.value = camera.near; this.params.far.value = camera.far;
        this.params.scale.value = this.radiusMm * 0.001 * size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
        this.params.strength.value = this.strength;
        const target = renderer.getRenderTarget() as THREE.WebGLRenderTarget | null, background = scene.background;
        const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
        const saved: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
        try {
            renderer.setRenderTarget(this.beauty); renderer.render(scene, camera);
            scene.traverse(object => { if (object instanceof THREE.Mesh) { saved.push([object, object.material]); object.material = Array.isArray(object.material) ? object.material.map(m => this.diffuseMaterial(m)) : this.diffuseMaterial(object.material); } });
            scene.background = null; renderer.setClearColor(0, 0);
            renderer.setRenderTarget(this.diffuse); renderer.render(scene, camera);
            for (const [object, material] of saved) object.material = Array.isArray(material) ? material.map(m => this.albedoMaterial(m)) : this.albedoMaterial(material);
            renderer.setRenderTarget(this.albedo); renderer.render(scene, camera);
            for (const [object, material] of saved) object.material = material;
            scene.background = background;
            this.quad.material = this.blurX; renderer.setRenderTarget(this.horizontal); renderer.render(this.scene, this.camera);
            this.quad.material = this.blurY; renderer.setRenderTarget(this.vertical); renderer.render(this.scene, this.camera);
            this.quad.material = this.composite; renderer.setRenderTarget(target); renderer.render(this.scene, this.camera);
        } finally {
            for (const [object, material] of saved) object.material = material;
            scene.background = background; renderer.setClearColor(clear, alpha); renderer.setRenderTarget(target);
        }
    }

    releaseMaterials(): void {
        for (const material of [...this.cache.values(), ...this.albedoCache.values()]) material.dispose();
        this.albedoCache.clear();
        this.cache.clear();
    }

    dispose(): void {
        for (const target of [this.beauty, this.diffuse, this.albedo, this.horizontal, this.vertical]) target.dispose();
        for (const material of [this.blurX, this.blurY, this.composite, ...this.cache.values(), ...this.albedoCache.values()]) material.dispose();
        this.cache.clear(); this.albedoCache.clear(); this.quad.geometry.dispose();
    }
}
