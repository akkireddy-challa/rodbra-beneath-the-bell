import * as THREE from 'three';
import { MeshPhysicalNodeMaterial, type Node } from 'three/webgpu';
import { Fn, attribute, float, materialRoughness, normalMap, normalView, positionView, texture, uniform } from 'three/tsl';

let sharedTexture: THREE.DataTexture | undefined;
/** A repeatable 40 mm patch of irregular pore depressions, not white-noise normals.
 * Replaceable procedural authoring data; this is not a facial scan.
 */
export function skinPoreTexture(): THREE.DataTexture {
    if (sharedTexture) return sharedTexture;
    const size = 1024;
    const height = new Float32Array(size * size);
    const occlusion = new Float32Array(size * size);
    let seed = 71231;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 3400; i++) {
        const cx = random() * size, cy = random() * size;
        const sx = 1.0 + random() * 1.8, sy = sx * (0.7 + random() * 0.8);
        const depth = 0.14 + random() * 0.16;
        const radius = Math.ceil(Math.max(sx, sy) * 4);
        for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
            const q = (x / sx) ** 2 + (y / sy) ** 2;
            const index = ((Math.floor(cy) + y + size) % size) * size + (Math.floor(cx) + x + size) % size;
            const pit = Math.exp(-q * 0.5);
            height[index] = height[index]! + -depth * pit + depth * 0.13 * Math.exp(-q * 0.13);
            occlusion[index] = Math.max(occlusion[index]!, pit);
        }
    }
    const bytes = new Uint8Array(size * size * 4);
    for (let i = 0; i < height.length; i++) {
        bytes[i * 4] = Math.round(THREE.MathUtils.clamp(0.5 + height[i]!, 0, 1) * 255);
        bytes[i * 4 + 1] = Math.round(occlusion[i]! * 255);
        bytes[i * 4 + 2] = 0;
        bytes[i * 4 + 3] = 255;
    }
    sharedTexture = new THREE.DataTexture(bytes, size, size);
    sharedTexture.name = 'Skin pores: procedural 40mm';
    sharedTexture.wrapS = sharedTexture.wrapT = THREE.RepeatWrapping;
    sharedTexture.magFilter = THREE.LinearFilter;
    sharedTexture.minFilter = THREE.LinearMipmapLinearFilter;
    sharedTexture.generateMipmaps = true;
    sharedTexture.needsUpdate = true;
    return sharedTexture;
}

/** Surface gradients combine detail with the original normal in view space,
 * independent of the original atlas's tangent direction. Attributes are rest-space.
 */
export function configureSkinMicroDetail(material: THREE.MeshPhysicalMaterial | MeshPhysicalNodeMaterial): void {
    const map = skinPoreTexture();
    if (material instanceof MeshPhysicalNodeMaterial) {
        const coords = attribute('_skin_uv', 'vec2') as unknown as Node<'vec2'>;
        const params = attribute('_skin_params', 'vec3') as unknown as Node<'vec3'>;
        const sample = texture(map, coords);
        const base = material.normalMap ? normalMap(texture(material.normalMap), uniform(material.normalScale)) : normalView;
        material.normalNode = Fn(() => {
            const n = (base as unknown as Node<'vec3'>).toVar();
            const dpdx = positionView.dFdx(), dpdy = positionView.dFdy();
            const r1 = dpdy.cross(n), r2 = n.cross(dpdx);
            const det = dpdx.dot(r1);
            const h = sample.r.mul(params.y).mul(0.00024);
            const grad = r1.mul(h.dFdx()).add(r2.mul(h.dFdy())).mul(det.sign()).div(det.abs().max(1e-12));
            return n.sub(grad).normalize();
        })();
        material.roughnessNode = materialRoughness.mul(0.72).add(params.x).add(sample.g.mul(0.035)).clamp(0.28, 0.85) as Node<'float'>;
        material.specularIntensityNode = float(material.specularIntensity).mul(float(1).sub(sample.g.mul(params.z).mul(0.35)));
        return;
    }
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        shader.uniforms.skinPores = { value: map };
        shader.vertexShader = 'attribute vec2 _skin_uv; attribute vec3 _skin_params; varying vec2 vSkinUv; varying vec3 vSkinParams;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinUv=_skin_uv;vSkinParams=_skin_params;');
        shader.fragmentShader = 'uniform sampler2D skinPores; varying vec2 vSkinUv; varying vec3 vSkinParams;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            vec4 skinPore=texture2D(skinPores,vSkinUv);
            float skinHeight=skinPore.r*vSkinParams.y*.00024;
            vec3 skinDx=dFdx(-vViewPosition),skinDy=dFdy(-vViewPosition);
            vec3 skinR1=cross(skinDy,normal),skinR2=cross(normal,skinDx);
            float skinDet=dot(skinDx,skinR1);
            normal=normalize(normal-(skinR1*dFdx(skinHeight)+skinR2*dFdy(skinHeight))*sign(skinDet)/max(abs(skinDet),1.e-12));`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor=clamp(roughnessFactor*.72+vSkinParams.x+texture2D(skinPores,vSkinUv).g*.035,.28,.85);');
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.specularColor*=1.-texture2D(skinPores,vSkinUv).g*vSkinParams.z*.35;');
    };
    material.customProgramCacheKey = () => 'character-skin-micro-v1';
}
