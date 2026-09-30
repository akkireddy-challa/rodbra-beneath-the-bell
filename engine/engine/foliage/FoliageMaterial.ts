import * as THREE from 'three';
import { MeshLambertNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { ShaderChunk } from 'three/src/renderers/shaders/ShaderChunk.js';
import { Fn, attribute, uniform, vec3, vec4, sin, mix, varying, positionLocal, normalLocal, normalView, modelWorldMatrix, materialColor, output } from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';

/** Live appearance controls; time=null follows wall time without template update code. */
export interface FoliageAppearance {
    windStrength: number;
    windSpeed: number;
    windDirectionDeg: number;
    time: number | null;
    debug: 'final' | 'roots' | 'wind' | 'normals';
}

export const DEFAULT_FOLIAGE_APPEARANCE: FoliageAppearance = {
    windStrength: 0.28, windSpeed: 1, windDirectionDeg: 28, time: null, debug: 'final',
};

export interface FoliageMaterialOptions {
    appearance: FoliageAppearance;
    block: boolean;
    map: THREE.Texture | null;
    /** Tint only vertices selected by the foliagePetal mask. */
    selectiveTint: boolean;
}

export interface FoliageMaterialHandle {
    material: THREE.Material;
    bind(mesh: THREE.Mesh): void;
}

const START_MS = performance.now();
const DEBUG = { final: 0, roots: 1, wind: 2, normals: 3 };

// The bend is applied AFTER instancing. Height is in mesh-local metres, so
// short flowers and tall grass respond proportionally, including scaled instances.
// f=h/H; offset=wind*h*f. Its Jacobian gives n.y -= 2*f*dot(n.xz,wind).
// No offset at h=0. Zero-scaled destroyed instances also remain exactly zero.
const WIND_GLSL = `
attribute vec4 foliageRoot;
attribute float foliageFlex;
uniform float foliageTime;
uniform float foliageStrength;
uniform float foliageSpeed;
uniform vec2 foliageDirection;
uniform float foliageDebug;
vec2 foliageWind() {
    vec3 root = (modelMatrix * vec4(foliageRoot.xyz, 1.0)).xyz;
    float t = foliageTime * foliageSpeed;
    float phase = dot(root.xz, foliageDirection) * 0.55 - t * 1.25;
    float gust = pow(sin(phase) * 0.5 + 0.5, 3.0);
    float flutter = sin(t * 2.8 + root.x * 3.1 + root.z * 2.4) * 0.13;
    return foliageDirection * foliageStrength * (0.25 + 0.75 * gust + flutter);
}
vec3 foliageBend(vec3 p) {
    float h = max(0.0, p.y - foliageRoot.y);
    p.xz += foliageWind() * h * foliageFlex * foliageRoot.w;
    return p;
}
`;

/** One factory owns both shader paths and the matching WebGL shadow materials. */
export function createFoliageMaterial(options: FoliageMaterialOptions): FoliageMaterialHandle {
    const { appearance, block, map, selectiveTint } = options;
    const time = uniform(0), strength = uniform(0), speed = uniform(1), debug = uniform(0);
    const direction = uniform(new THREE.Vector2());
    const update = (): void => {
        time.value = appearance.time ?? (performance.now() - START_MS) / 1000;
        strength.value = THREE.MathUtils.clamp(appearance.windStrength, 0, 0.65);
        speed.value = Math.max(0, appearance.windSpeed);
        const angle = appearance.windDirectionDeg * Math.PI / 180;
        direction.value.set(Math.cos(angle), Math.sin(angle));
        debug.value = DEBUG[appearance.debug];
    };
    update();

    if (isWebGpuActive()) {
        const material = block ? new MeshLambertNodeMaterial() : new MeshStandardNodeMaterial({ roughness: 0.88 });
        material.map = map; material.vertexColors = true; material.side = THREE.DoubleSide;
        const rootData = attribute<'vec4'>('foliageRoot', 'vec4');
        const root = rootData.xyz;
        const flex = attribute<'float'>('foliageFlex', 'float').mul(rootData.w);
        const wind = Fn(() => {
            const worldRoot = modelWorldMatrix.mul(vec4(root, 1)).xyz;
            const t = time.mul(speed);
            const phase = worldRoot.xz.dot(direction).mul(0.55).sub(t.mul(1.25));
            const gust = sin(phase).mul(0.5).add(0.5).pow(3);
            const flutter = sin(t.mul(2.8).add(worldRoot.x.mul(3.1)).add(worldRoot.z.mul(2.4))).mul(0.13);
            return direction.mul(strength).mul(gust.mul(0.75).add(0.25).add(flutter));
        })();
        material.positionNode = Fn(() => {
            const h = positionLocal.y.sub(root.y).max(0);
            normalLocal.y.subAssign(normalLocal.xz.dot(wind).mul(flex).mul(2));
            return positionLocal.add(vec3(wind.x.mul(h).mul(flex), 0, wind.y.mul(h).mul(flex)));
        })();
        if (selectiveTint) {
            material.colorNode = materialColor.mul(varying(mix(vec3(1), attribute<'vec3'>('foliageTint', 'vec3'), attribute<'float'>('foliagePetal', 'float'))));
        }
        const f = varying(flex);
        const w = varying(wind.length().div(0.65));
        material.outputNode = debug.equal(1).select(vec4(f, f.oneMinus(), 0, 1),
            debug.equal(2).select(vec4(w, w.mul(0.5), w.oneMinus(), 1),
                debug.equal(3).select(vec4(normalView.mul(0.5).add(0.5), 1), output)));
        return { material, bind(mesh): void { mesh.onBeforeRender = update; mesh.onBeforeShadow = update; } };
    }

    const material = block ? new THREE.MeshLambertMaterial({ vertexColors: true })
        : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
    material.map = map; material.side = THREE.DoubleSide;
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    const distance = new THREE.MeshDistanceMaterial({ side: THREE.DoubleSide });
    const patch = (target: THREE.Material, beauty: boolean): void => {
        target.customProgramCacheKey = () => `foliage-v1:${beauty}:${selectiveTint}`;
        target.onBeforeCompile = shader => {
            Object.assign(shader.uniforms, { foliageTime: time, foliageStrength: strength, foliageSpeed: speed, foliageDirection: direction, foliageDebug: debug });
            shader.vertexShader = WIND_GLSL + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', ShaderChunk.project_vertex.replace(
                'mvPosition = modelViewMatrix * mvPosition;', 'mvPosition.xyz = foliageBend(mvPosition.xyz);\nmvPosition = modelViewMatrix * mvPosition;'));
            // Shadow coordinates must use the same displaced position as the beauty pass.
            shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', ShaderChunk.worldpos_vertex.replace(
                'worldPosition = modelMatrix * worldPosition;', 'worldPosition.xyz = foliageBend(worldPosition.xyz);\nworldPosition = modelMatrix * worldPosition;'));
            if (!beauty) return;
            shader.vertexShader = shader.vertexShader.replace('#include <defaultnormal_vertex>', ShaderChunk.defaultnormal_vertex.replace(
                'transformedNormal = normalMatrix * transformedNormal;',
                'transformedNormal.y -= 2.0 * foliageFlex * foliageRoot.w * dot(transformedNormal.xz, foliageWind());\ntransformedNormal = normalMatrix * transformedNormal;'));
            shader.vertexShader = `varying vec2 vFoliageDiagnostic;\n${shader.vertexShader}`.replace('#include <begin_vertex>',
                '#include <begin_vertex>\nvFoliageDiagnostic = vec2(foliageFlex, length(foliageWind()) / 0.65);');
            shader.fragmentShader = `uniform float foliageDebug;\nvarying vec2 vFoliageDiagnostic;\n${shader.fragmentShader}`;
            shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
                if (foliageDebug == 1.0) outgoingLight = vec3(vFoliageDiagnostic.x, 1.0 - vFoliageDiagnostic.x, 0.0);
                if (foliageDebug == 2.0) outgoingLight = vec3(vFoliageDiagnostic.y, vFoliageDiagnostic.y * 0.5, 1.0 - vFoliageDiagnostic.y);
                if (foliageDebug == 3.0) outgoingLight = normal * 0.5 + 0.5;
                #include <opaque_fragment>`);
            if (selectiveTint) {
                shader.vertexShader = `attribute vec3 foliageTint;\nattribute float foliagePetal;\nvarying vec3 vFoliageTint;\n${shader.vertexShader}`
                    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFoliageTint = mix(vec3(1.0), foliageTint, foliagePetal);');
                shader.fragmentShader = `varying vec3 vFoliageTint;\n${shader.fragmentShader}`
                    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vFoliageTint;');
            }
        };
    };
    patch(material, true); patch(depth, false); patch(distance, false);
    material.addEventListener('dispose', () => { depth.dispose(); distance.dispose(); });
    return { material, bind(mesh): void {
        mesh.customDepthMaterial = depth; mesh.customDistanceMaterial = distance;
        mesh.onBeforeRender = update; mesh.onBeforeShadow = update;
    } };
}

/** Attach instanced anchors after setting matrices, then pad culling bounds for the gust envelope. */
export function prepareFoliageInstances(mesh: THREE.InstancedMesh, handle: FoliageMaterialHandle): void {
    const capacity = mesh.instanceMatrix.count;
    let roots = mesh.geometry.getAttribute('foliageRoot');
    if (!(roots instanceof THREE.InstancedBufferAttribute) || roots.count !== capacity) {
        roots = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
        mesh.geometry.setAttribute('foliageRoot', roots);
    }
    const matrix = new THREE.Matrix4();
    mesh.geometry.computeBoundingBox();
    const height = mesh.geometry.boundingBox!.max.y;
    let maxHeight = 0;
    for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        roots.setXYZW(i, matrix.elements[12]!, matrix.elements[13]!, matrix.elements[14]!, 1);
        maxHeight = Math.max(maxHeight, height * Math.hypot(matrix.elements[4]!, matrix.elements[5]!, matrix.elements[6]!));
    }
    roots.needsUpdate = true;
    mesh.computeBoundingBox(); mesh.computeBoundingSphere();
    const padding = maxHeight * 0.75;
    mesh.boundingBox!.expandByScalar(padding); mesh.boundingSphere!.radius += padding;
    handle.bind(mesh);
}
