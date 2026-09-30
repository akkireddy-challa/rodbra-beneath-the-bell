import * as THREE from 'three';
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import { isWebGpuActive } from 'engine/RendererType.js';
import { configureSkinCoveragePass } from 'engine/hero/SkinAtlasDetail.js';

/** Light-facing skin entry depth. One directional key light; other geometry is an
 * opaque occluder, never a transmitting surface. Distances are in metres.
 */
export class SkinTransmissionPass {
    readonly target = new THREE.WebGLRenderTarget(2048, 2048, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    readonly matrix = new THREE.Matrix4();
    readonly direction = new THREE.Vector3();
    readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 6);
    enabled = true;
    private readonly materials = new Map<THREE.Material, THREE.Material>();
    private readonly bounds = new THREE.Box3();
    private readonly center = new THREE.Vector3();
    private readonly extent = new THREE.Vector3();
    private readonly bias = new THREE.Matrix4().set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1);

    constructor() { this.target.depthTexture = new THREE.DepthTexture(2048, 2048, THREE.UnsignedIntType); }

    private replacement(source: THREE.Material): THREE.Material {
        let result = this.materials.get(source);
        if (result) return result;
        const material = isWebGpuActive() ? new MeshBasicNodeMaterial() : new THREE.MeshBasicMaterial();
        material.color.set(source.userData.characterSurface === 'skin' ? 0xffffff : 0);
        material.side = THREE.DoubleSide;
        material.toneMapped = false;
        configureSkinCoveragePass(source, material, 'color');
        this.materials.set(source, material); result = material;
        return result;
    }

    render(renderer: THREE.WebGLRenderer | WebGPURenderer, scene: THREE.Scene, character: THREE.Object3D, key: THREE.DirectionalLight): void {
        if (!this.enabled) return;
        this.bounds.setFromObject(character); this.bounds.getCenter(this.center); this.bounds.getSize(this.extent);
        this.direction.copy(key.position).sub(key.target.position).normalize();
        const radius = this.extent.length() * .55;
        this.camera.left = this.camera.bottom = -radius;
        this.camera.right = this.camera.top = radius;
        this.camera.far = radius * 4 + .1;
        this.camera.position.copy(this.center).addScaledVector(this.direction, radius * 2);
        this.camera.lookAt(this.center); this.camera.updateMatrixWorld(true); this.camera.updateProjectionMatrix();
        const saved: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
        const background = scene.background, target = renderer.getRenderTarget() as THREE.WebGLRenderTarget | null;
        const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
        try {
            scene.traverse(o => { if (o instanceof THREE.Mesh) { saved.push([o, o.material]); o.material = Array.isArray(o.material) ? o.material.map(m => this.replacement(m)) : this.replacement(o.material); } });
            scene.background = null; renderer.setClearColor(0, 0); renderer.setRenderTarget(this.target); renderer.render(scene, this.camera);
            // Renderer sets the camera coordinate system. Z is already [0,1] on WebGPU.
            this.bias.elements[10] = isWebGpuActive() ? 1 : .5;
            this.bias.elements[14] = isWebGpuActive() ? 0 : .5;
            this.matrix.multiplyMatrices(this.bias, this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse);
        } finally {
            for (const [mesh, material] of saved) mesh.material = material;
            scene.background = background; renderer.setClearColor(clear, alpha); renderer.setRenderTarget(target);
        }
    }

    releaseMaterials(): void { for (const material of this.materials.values()) material.dispose(); this.materials.clear(); }
    dispose(): void { this.releaseMaterials(); this.target.dispose(); }
}
