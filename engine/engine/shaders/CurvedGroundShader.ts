import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, uniform, vec3, vec4, float,
    positionLocal, normalView,
    modelViewMatrix, cameraProjectionMatrix,
} from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';

/**
 * Curved shader material for subway-surfers-style ground and objects. Curves
 * both downward (Y) and horizontally (X) based on view-space Z. Two backends:
 * TSL NodeMaterial under WebGPU, classic GLSL ShaderMaterial under WebGL.
 */
export function createCurvedGroundShaderMaterial(
    color: THREE.Color | number,
    options: {
        roughness?: number;
        metalness?: number;
        emissive?: THREE.Color | number;
        emissiveIntensity?: number;
        curveIntensity?: number;
        horizontalCurveIntensity?: number;
    } = {}
): THREE.Material {
    const colorValue = color instanceof THREE.Color ? color : new THREE.Color(color);
    const emissiveColor = options.emissive
        ? (options.emissive instanceof THREE.Color ? options.emissive : new THREE.Color(options.emissive))
        : new THREE.Color(0x000000);
    const emissiveIntensity = options.emissiveIntensity ?? 0.0;
    const curveIntensity = options.curveIntensity ?? 0.1;
    const horizontalCurveIntensity = options.horizontalCurveIntensity ?? 0.05;

    // roughness/metalness are accepted for API compatibility but ignored — the
    // shader hand-rolls lambert lighting and doesn't honor PBR.
    void options.roughness;
    void options.metalness;

    if (isWebGpuActive()) {
        const colorU = uniform(colorValue);
        const emissiveU = uniform(emissiveColor);
        const emissiveIntensityU = uniform(emissiveIntensity);
        const curveIntensityU = uniform(curveIntensity);
        const horizontalCurveIntensityU = uniform(horizontalCurveIntensity);

        const material = new MeshBasicNodeMaterial();

        material.vertexNode = Fn(() => {
            const vp = modelViewMatrix.mul(vec4(positionLocal, 1.0)).toVar();
            const zOff = vp.z.div(10.0);
            const verticalCurve = curveIntensityU.mul(zOff).mul(zOff);
            vp.y.subAssign(verticalCurve);
            const horizontalCurve = horizontalCurveIntensityU.mul(vp.x).mul(zOff).mul(zOff);
            vp.x.subAssign(horizontalCurve);
            return cameraProjectionMatrix.mul(vp);
        })();

        material.colorNode = Fn(() => {
            const lightDir = vec3(1.0, 1.0, 1.0).normalize();
            const NdotL = normalView.dot(lightDir).max(float(0.3));
            return colorU.mul(NdotL).add(emissiveU.mul(emissiveIntensityU));
        })();

        return material;
    }

    return new THREE.ShaderMaterial({
        uniforms: {
            color: { value: colorValue },
            emissive: { value: emissiveColor },
            emissiveIntensity: { value: emissiveIntensity },
            curveIntensity: { value: curveIntensity },
            horizontalCurveIntensity: { value: horizontalCurveIntensity },
        },
        vertexShader: `
            varying vec3 vNormal;
            uniform float curveIntensity;
            uniform float horizontalCurveIntensity;

            void main() {
                vNormal = normalize(normalMatrix * normal);
                vec4 vPos = modelViewMatrix * vec4(position, 1.0);
                float zOff = vPos.z / 10.0;
                float verticalCurve = curveIntensity * zOff * zOff;
                vPos.y -= verticalCurve;
                float horizontalCurve = horizontalCurveIntensity * vPos.x * zOff * zOff;
                vPos.x -= horizontalCurve;
                gl_Position = projectionMatrix * vPos;
            }
        `,
        fragmentShader: `
            uniform vec3 color;
            uniform vec3 emissive;
            uniform float emissiveIntensity;
            varying vec3 vNormal;

            void main() {
                vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0));
                float NdotL = max(dot(vNormal, lightDir), 0.3);
                vec3 finalColor = color * NdotL + emissive * emissiveIntensity;
                gl_FragColor = vec4(finalColor, 1.0);
            }
        `,
    });
}

/**
 * Applies curved shader material to all meshes in an object hierarchy (recursively)
 * Converts MeshStandardMaterial to curved shader material
 */
export function applyCurvedShaderToObject(
    object: THREE.Object3D,
    options: {
        curveIntensity?: number;
        horizontalCurveIntensity?: number;
    } = {}
): void {
    object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
            const mesh = child as THREE.Mesh;
            if (mesh.material instanceof THREE.MeshStandardMaterial) {
                const originalMat = mesh.material as THREE.MeshStandardMaterial;
                mesh.material = createCurvedGroundShaderMaterial(originalMat.color, {
                    roughness: originalMat.roughness,
                    metalness: originalMat.metalness,
                    emissive: originalMat.emissive,
                    emissiveIntensity: originalMat.emissiveIntensity,
                    curveIntensity: options.curveIntensity,
                    horizontalCurveIntensity: options.horizontalCurveIntensity
                });
            } else if (Array.isArray(mesh.material)) {
                mesh.material = mesh.material.map((mat) => {
                    if (mat instanceof THREE.MeshStandardMaterial) {
                        return createCurvedGroundShaderMaterial(mat.color, {
                            roughness: mat.roughness,
                            metalness: mat.metalness,
                            emissive: mat.emissive,
                            emissiveIntensity: mat.emissiveIntensity,
                            curveIntensity: options.curveIntensity,
                            horizontalCurveIntensity: options.horizontalCurveIntensity
                        });
                    }
                    return mat;
                });
            }
        }
    });
}
