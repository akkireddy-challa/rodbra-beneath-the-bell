import * as THREE from 'three';
import { SkinDiffusionPass } from 'engine/hero/SkinDiffusionPass.js';
import { setActiveRendererType } from 'engine/RendererType.js';

test('extraction failure restores scene state without attempting more rendering', () => {
    setActiveRendererType('webgl');
    const pass = new SkinDiffusionPass();
    const scene = new THREE.Scene();
    const background = new THREE.Color('gray'); scene.background = background;
    const material = new THREE.MeshPhysicalMaterial(); material.userData.characterSurface = 'skin';
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material); scene.add(mesh);
    const render = jest.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('extraction failed'); });
    const renderer = {
        getDrawingBufferSize: (v: THREE.Vector2) => v.set(32, 32),
        getRenderTarget: () => null,
        getClearColor: (c: THREE.Color) => c.set('black'),
        getClearAlpha: () => 1,
        setRenderTarget: jest.fn(), setClearColor: jest.fn(), render,
    };
    expect(() => pass.render(renderer as unknown as THREE.WebGLRenderer, scene, new THREE.PerspectiveCamera())).toThrow('extraction failed');
    expect(render).toHaveBeenCalledTimes(2);
    expect(scene.background).toBe(background);
    expect(mesh.material).toBe(material);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
    pass.dispose(); mesh.geometry.dispose(); material.dispose();
});
