import * as THREE from 'three';
import { GlbInstanceBatch, isInstanceableGlb } from 'engine/GlbInstancing.js';

function template(): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2), new THREE.MeshBasicMaterial());
  const crown = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.2), new THREE.MeshBasicMaterial());
  crown.position.y = 1.2;
  g.add(trunk, crown);
  return g;
}

function place(world: THREE.Group, tpl: THREE.Group, x: number): THREE.Group {
  const copy = tpl.clone();
  copy.position.set(x, 0, 0);
  world.add(copy);
  return copy;
}

describe('GlbInstanceBatch', () => {
  it('draws every copy through one InstancedMesh per sub-mesh, hiding the copies\' own meshes', () => {
    const world = new THREE.Group();
    const tpl = template();
    const batch = new GlbInstanceBatch(tpl, world, 3);
    const copies = [0, 5, 10].map((x) => place(world, tpl, x));
    copies.forEach((c) => batch.add(c));
    batch.update();

    const instanced = batch.root.children as THREE.InstancedMesh[];
    expect(instanced).toHaveLength(2);
    expect(instanced.every((m) => m.count === 3)).toBe(true);
    const crownAt = new THREE.Matrix4();
    instanced[1]!.getMatrixAt(2, crownAt);
    const crownPos = new THREE.Vector3().setFromMatrixPosition(crownAt);
    expect(crownPos.x).toBeCloseTo(10, 5);
    expect(crownPos.y).toBeCloseTo(1.2, 5);
    copies.forEach((c) => c.traverse((o) => { if ((o as THREE.Mesh).isMesh) expect(o.visible).toBe(false); }));
  });

  it('follows a moved copy and collapses a deleted or hidden one', () => {
    const world = new THREE.Group();
    const tpl = template();
    const batch = new GlbInstanceBatch(tpl, world, 2);
    const [a, b] = [place(world, tpl, 0), place(world, tpl, 3)];
    batch.add(a); batch.add(b);

    a.position.x = 7;
    b.removeFromParent();
    batch.update();
    const trunk = batch.root.children[0] as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    trunk.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(7);
    trunk.getMatrixAt(1, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).length()).toBe(0);

    world.add(b); b.visible = false;
    batch.update();
    trunk.getMatrixAt(1, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).length()).toBe(0);
  });

  it('refuses skinned GLBs, which animate per copy', () => {
    const g = new THREE.Group();
    g.add(new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    expect(isInstanceableGlb(g)).toBe(false);
    expect(isInstanceableGlb(template())).toBe(true);
  });
});

describe('isPickableOnScreen', () => {
  it('lets the editor pick a copy the batch draws, never the batch itself', async () => {
    const { isPickableOnScreen } = await import('engine/GlbInstancing.js');
    const world = new THREE.Group();
    const tpl = template();
    const batch = new GlbInstanceBatch(tpl, world, 1);
    const copy = place(world, tpl, 0);
    batch.add(copy);
    const copyMesh = copy.children[0]!;
    expect(copyMesh.visible).toBe(false);
    expect(isPickableOnScreen(copyMesh)).toBe(true);
    expect(isPickableOnScreen(batch.root.children[0]!)).toBe(false);
    const hidden = new THREE.Mesh();
    hidden.visible = false;
    expect(isPickableOnScreen(hidden)).toBe(false);
  });
});
