import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, uniform, vec3, sin, float, varying, normalize, cross, dFdx, dFdy,
    positionLocal, positionWorld, cameraPosition, reflect, pow, smoothstep, mix, attribute, exp,
} from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';

/**
 * Realtime, see-through animated water SURFACE for coastal levels. ONE plane spans the whole
 * level at the sea level (`worldProfileData.waterLevelY`); the higher land terrain occludes it
 * and the carved water basins below it reveal it, so no per-zone clipping is needed.
 *
 * Three directional wave bands displace the vertices; the fragment normal is derived from the
 * DISPLACED geometry itself (screen-space derivatives -> one flat-shaded facet per triangle),
 * so the lighting always agrees with the crests and the faceted look matches the voxel world.
 * A uniform-color transparent plane is NOT a water system — without shading the waves are
 * invisible everywhere except the shoreline. Facets are lit with sun diffuse + specular glints,
 * crest-height tinting and a whitecap wash derived from the SAME wave response, and a
 * view-angle (Fresnel) blend that keeps the surface see-through when looking down and
 * sky-tinted at grazing angles.
 *
 * Dual renderer paths (see game/CLAUDE.md): TSL NodeMaterial on WebGPU, GLSL ShaderMaterial on
 * WebGL. The plane is laid flat (rotation.x = -PI/2), so the geometry's LOCAL +Z is world up —
 * the waves displace local z. Drive `setTime(elapsedSeconds)` once per frame for animation;
 * call `setSunDirection` with the level's sun so glints line up with the directional light.
 */
export interface WaterMaterialHandle {
    material: THREE.Material;
    setTime: (seconds: number) => void;
    setSunDirection: (dir: THREE.Vector3) => void;
}

const DEFAULT_WATER_COLOR = 0x246b8e;

// Three wave bands: direction (unit, in the plane's local XY), angular frequency (rad/m),
// amplitude (m), phase speed (rad/s). Same constants drive BOTH backends.
const D1X = 0.9701, D1Y = 0.2425, F1 = 0.14, A1 = 0.30, S1 = 0.9;  // long swell
const D2X = -0.3714, D2Y = 0.9285, F2 = 0.27, A2 = 0.16, S2 = 1.5; // cross chop
const D3X = 0.7071, D3Y = -0.7071, F3 = 0.55, A3 = 0.07, S3 = 2.4; // detail ripple
const TOTAL_AMP = A1 + A2 + A3;

// Stylized palette. Crest/sky/foam are fixed accents; the base color stays configurable.
const CREST_TINT = new THREE.Color(0x39a9a4);  // shallow turquoise, distinct from white foam
const SKY_TINT = new THREE.Color(0xbfd9ea);    // grazing-angle sky wash
const FOAM_TINT = new THREE.Color(0xeaf4f7);   // whitecap wash at the highest crests
const SHININESS = 64.0;
const SPEC_STRENGTH = 0.6;
const ALPHA_GRAZE = 0.98;  // grazing angle: nearly opaque (Fresnel)
const DEFAULT_SUN = new THREE.Vector3(0.5, 0.75, 0.35).normalize();

export function createWaterMaterial(
    color: THREE.ColorRepresentation = DEFAULT_WATER_COLOR,
    options: { bathymetry?: boolean } = {},
): WaterMaterialHandle {
    const col = new THREE.Color(color);
    const crestCol = col.clone().lerp(CREST_TINT, 0.55);

    if (isWebGpuActive()) {
        const timeU = uniform(0);
        const sunU = uniform(DEFAULT_SUN.clone());
        const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
        material.forceSinglePass = true;
        material.lights = false;
        const depth = options.bathymetry ? attribute<'float'>('waterDepth', 'float') : float(12);
        const vDepth = varying(depth);

        // Shared wave response, evaluated in the vertex stage from the UNDISPLACED local xy.
        const wave = Fn(() => {
            const p = positionLocal;
            return sin(p.x.mul(D1X).add(p.y.mul(D1Y)).mul(F1).add(timeU.mul(S1))).mul(A1)
                .add(sin(p.x.mul(D2X).add(p.y.mul(D2Y)).mul(F2).add(timeU.mul(S2))).mul(A2))
                .add(sin(p.x.mul(D3X).add(p.y.mul(D3Y)).mul(F3).add(timeU.mul(S3))).mul(A3));
        })();

        // positionNode keeps the standard pipeline, so positionWorld below IS the displaced
        // world position (local +z = world up once the plane is laid flat).
        const displacedWave = wave.mul(smoothstep(0, 1.8, depth));
        material.positionNode = positionLocal.add(vec3(0, 0, displacedWave));

        // Crest height in [-1, 1], interpolated from the vertex stage — exact agreement
        // with the displacement (no fragment re-derivation to drift out of phase).
        const vH = varying(wave.div(TOTAL_AMP));
        const vWave = varying(displacedWave);
        const wetDepth = vDepth.add(vWave).max(0);
        // A fragment surviving the terrain depth test can be water even when
        // its coarse triangle says "land". Give that unresolved channel a
        // conservative optical path instead of nearly colourless transparency.
        const opticalDepth = mix(float(2), wetDepth, smoothstep(0, 0.15, vDepth));
        // A narrow broken wash, rooted in depth and pulsing with the actual wave.
        // Broad depth bands made a milky halo several metres offshore.
        const breakup = sin(positionWorld.x.mul(1.7).add(sin(positionWorld.z.mul(0.9))))
            .mul(sin(positionWorld.z.mul(2.3).add(positionWorld.x.mul(0.6)))).mul(0.5).add(0.5);
        const shore = smoothstep(0.015, 0.065, wetDepth).mul(float(1).sub(smoothstep(0.14, 0.34, wetDepth)))
            .mul(smoothstep(0.18, 0.72, breakup)).mul(vH.mul(0.2).add(0.65));

        material.colorNode = Fn(() => {
            // One flat facet per triangle: geometric normal of the DISPLACED surface.
            // cross(dFdx, dFdy) always faces the viewer, which also handles DoubleSide.
            const L = normalize(sunU);
            const V = normalize(cameraPosition.sub(positionWorld));
            const geometric = normalize(cross(dFdx(positionWorld), dFdy(positionWorld)));
            const N = geometric.mul(geometric.dot(V).lessThan(0).select(-1, 1));

            const diff = N.dot(L).max(0);
            const shade = float(0.55).add(diff.mul(0.45));

            // Shared crest metric in [0, 1]: trough at 0, highest crest at 1.
            const h01 = vH.mul(0.5).add(0.5);

            // Trough -> crest color lift from the shared wave response.
            const crestT = smoothstep(0.1, 0.9, h01);
            const deep = vec3(col.r, col.g, col.b).mul(0.62);
            const shallow = vec3(crestCol.r, crestCol.g, crestCol.b);
            const depthTint = float(1).sub(exp(opticalDepth.mul(-0.32)));
            const base = mix(shallow, deep, depthTint).mul(float(0.85).add(crestT.mul(0.15)));

            let rgb = base.mul(shade);
            const spec = pow(reflect(L.negate(), N).dot(V).max(0), SHININESS);
            rgb = rgb.add(spec.mul(SPEC_STRENGTH));

            const fres = float(0.02).add(pow(float(1).sub(N.dot(V).max(0)), 5).mul(0.98));
            rgb = mix(rgb, vec3(SKY_TINT.r, SKY_TINT.g, SKY_TINT.b), fres.mul(0.30));

            // Whitecaps only at the very top of the shared crest metric.
            const cap = smoothstep(0.86, 0.99, h01).mul(smoothstep(1, 3, wetDepth));
            return mix(rgb, vec3(FOAM_TINT.r, FOAM_TINT.g, FOAM_TINT.b), cap.mul(0.25).max(shore));
        })();

        material.opacityNode = Fn(() => {
            const N = normalize(cross(dFdx(positionWorld), dFdy(positionWorld)));
            const V = normalize(cameraPosition.sub(positionWorld));
            const cosine = N.dot(V).abs().max(0.2);
            const fres = float(0.02).add(pow(float(1).sub(cosine), 5).mul(0.98));
            // Vertical bathymetry / view cosine approximates the optical path.
            const absorption = float(1).sub(exp(opticalDepth.div(cosine).mul(-0.55)));
            // Bathymetry is an estimate, not a clipping mask. Terrain depth hides
            // dry land; a missed narrow channel must still show a water surface.
            return mix(absorption.mul(0.48).add(0.50), float(ALPHA_GRAZE), fres).max(shore.mul(0.8));
        })();

        return {
            material,
            setTime: (t) => { timeU.value = t; },
            setSunDirection: (dir) => { (sunU.value as THREE.Vector3).copy(dir).normalize(); },
        };
    }

    const uniforms = {
        time: { value: 0 },
        uColor: { value: col },
        uCrestColor: { value: crestCol },
        uSunDir: { value: DEFAULT_SUN.clone() },
    };
    const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
        uniforms,
        vertexShader: `
            uniform float time;
            varying vec3 vWorldPos;
            varying float vH;
            ${options.bathymetry ? 'attribute float waterDepth;' : ''}
            varying float vDepth;
            varying float vWave;
            void main() {
                vec3 p = position;
                float wave =
                      sin((p.x * ${D1X.toFixed(4)} + p.y * ${D1Y.toFixed(4)}) * ${F1.toFixed(4)} + time * ${S1.toFixed(4)}) * ${A1.toFixed(4)}
                    + sin((p.x * ${D2X.toFixed(4)} + p.y * ${D2Y.toFixed(4)}) * ${F2.toFixed(4)} + time * ${S2.toFixed(4)}) * ${A2.toFixed(4)}
                    + sin((p.x * ${D3X.toFixed(4)} + p.y * ${D3Y.toFixed(4)}) * ${F3.toFixed(4)} + time * ${S3.toFixed(4)}) * ${A3.toFixed(4)};
                float depth = ${options.bathymetry ? 'waterDepth' : '12.0'};
                vWave = wave * smoothstep(0.0, 1.8, depth);
                p.z += vWave;
                vDepth = depth;
                vH = wave / ${TOTAL_AMP.toFixed(4)};
                vec4 world = modelMatrix * vec4(p, 1.0);
                vWorldPos = world.xyz;
                gl_Position = projectionMatrix * viewMatrix * world;
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            uniform vec3 uCrestColor;
            uniform vec3 uSunDir;
            varying vec3 vWorldPos;
            varying float vH;
            varying float vDepth;
            varying float vWave;
            void main() {
                // One flat facet per triangle from the displaced geometry (faces the viewer,
                // so DoubleSide undersides light correctly too).
                vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
                vec3 L = normalize(uSunDir);
                vec3 V = normalize(cameraPosition - vWorldPos);
                N *= dot(N, V) < 0.0 ? -1.0 : 1.0;

                float diff = max(dot(N, L), 0.0);
                float shade = 0.55 + diff * 0.45;

                float crestT = smoothstep(0.1, 0.9, vH * 0.5 + 0.5);
                float wetDepth = max(0.0, vDepth + vWave);
                float opticalDepth = mix(2.0, wetDepth, smoothstep(0.0, 0.15, vDepth));
                vec3 base = mix(uCrestColor, uColor * 0.62, 1.0 - exp(-opticalDepth * 0.32)) * (0.85 + crestT * 0.15);

                vec3 rgb = base * shade;
                float spec = pow(max(dot(reflect(-L, N), V), 0.0), ${SHININESS.toFixed(1)});
                rgb += spec * ${SPEC_STRENGTH.toFixed(2)};

                float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
                rgb = mix(rgb, vec3(${SKY_TINT.r.toFixed(4)}, ${SKY_TINT.g.toFixed(4)}, ${SKY_TINT.b.toFixed(4)}), fres * 0.30);

                float cap = smoothstep(0.86, 0.99, vH * 0.5 + 0.5) * smoothstep(1.0, 3.0, wetDepth);
                float breakup = sin(vWorldPos.x * 1.7 + sin(vWorldPos.z * 0.9)) * sin(vWorldPos.z * 2.3 + vWorldPos.x * 0.6) * 0.5 + 0.5;
                float shore = smoothstep(0.015, 0.065, wetDepth) * (1.0 - smoothstep(0.14, 0.34, wetDepth))
                    * smoothstep(0.18, 0.72, breakup) * (vH * 0.2 + 0.65);
                rgb = mix(rgb, vec3(${FOAM_TINT.r.toFixed(4)}, ${FOAM_TINT.g.toFixed(4)}, ${FOAM_TINT.b.toFixed(4)}), max(cap * 0.25, shore));

                float cosine = max(abs(dot(N, V)), 0.2);
                float opacityFres = 0.02 + 0.98 * pow(1.0 - cosine, 5.0);
                float absorption = 1.0 - exp(-opticalDepth / cosine * 0.55);
                float alpha = max(mix(absorption * 0.48 + 0.50, ${ALPHA_GRAZE.toFixed(2)}, opacityFres), shore * 0.8);
                gl_FragColor = vec4(rgb, alpha);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }
        `,
    });
    return {
        material,
        setTime: (t) => { uniforms.time.value = t; },
        setSunDirection: (dir) => { uniforms.uSunDir.value.copy(dir).normalize(); },
    };
}
