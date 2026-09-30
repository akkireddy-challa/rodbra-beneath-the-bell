import * as THREE from 'three';

/**
 * Spent casings tumbling out of the ejection port.
 *
 * Pure decoration, and deliberately cheap: a fixed pool of small boxes with no
 * rigid bodies, no collisions and no physics-world involvement at all. A shell
 * exists for under a second and is never interacted with, so paying Rapier for
 * it would be spending the frame budget on something nobody can touch.
 *
 * They are integrated in VIEW SPACE — the same space the weapon lives in —
 * rather than in world space. That is not a shortcut: shells ejected in world
 * space get left behind the instant the player turns, which reads as the world
 * sliding out from under them. Falling relative to the view keeps them in frame
 * exactly as long as they should be, and sidesteps the whole problem.
 */

export interface ShellEjectionOptions {
    /** How many shells can be in flight at once. Oldest is recycled beyond it. */
    poolSize: number;
    /** How long a shell lives, seconds. */
    lifetimeSeconds: number;
    /** Casing colour. */
    color: number;
    /** Size multiplier. */
    scale: number;
}

export const DEFAULT_SHELL_EJECTION_OPTIONS: ShellEjectionOptions = {
    poolSize: 12,
    lifetimeSeconds: 0.9,
    color: 0xc8a04a,
    scale: 1,
};

/** Gravity in view space, m/s². */
const VIEW_GRAVITY = -9.8;

/** Fraction of the lifetime spent fading out. */
const FADE_TAIL = 0.28;

interface Shell {
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    spin: THREE.Vector3;
    age: number;
    alive: boolean;
}

export class ShellEjector {
    private readonly options: ShellEjectionOptions;
    private readonly group = new THREE.Group();
    private readonly geometry: THREE.BoxGeometry;
    private readonly material: THREE.MeshLambertMaterial;
    private readonly shells: Shell[] = [];
    private next = 0;
    private attached: THREE.Object3D | null = null;

    constructor(options: ShellEjectionOptions = DEFAULT_SHELL_EJECTION_OPTIONS) {
        this.options = options;
        this.group.name = 'ShellEjector';

        this.geometry = new THREE.BoxGeometry(0.008, 0.008, 0.020);
        // Lambert rather than a node material: it compiles on both renderer
        // backends, which is the rule for anything the engine constructs.
        this.material = new THREE.MeshLambertMaterial({ color: options.color, transparent: true });

        for (let i = 0; i < options.poolSize; i++) {
            const mesh = new THREE.Mesh(this.geometry, this.material);
            mesh.frustumCulled = false;
            mesh.scale.setScalar(0);
            this.group.add(mesh);
            this.shells.push({
                mesh,
                velocity: new THREE.Vector3(),
                spin: new THREE.Vector3(),
                age: 0,
                alive: false,
            });
        }
    }

    /**
     * Add the shells to a view-space root — the view-model scene itself, NOT
     * the weapon, so an ejected shell stops inheriting the weapon's recoil and
     * sway the moment it leaves.
     */
    attachTo(viewRoot: THREE.Object3D): void {
        this.detach();
        viewRoot.add(this.group);
        this.attached = viewRoot;
    }

    detach(): void {
        this.attached?.remove(this.group);
        this.attached = null;
    }

    /** Throw one casing from a point in view space. */
    eject(fromViewSpace: THREE.Vector3): void {
        const shell = this.shells[this.next];
        if (!shell) return;
        this.next = (this.next + 1) % this.shells.length;

        shell.mesh.position.copy(fromViewSpace);
        shell.mesh.rotation.set(0, 0, 0);
        shell.mesh.scale.setScalar(this.options.scale);
        // Up and to the right, the way a side-ejecting action throws them.
        shell.velocity.set(
            0.9 + Math.random() * 0.5,
            1.1 + Math.random() * 0.4,
            -0.2 + (Math.random() - 0.5) * 0.4,
        );
        shell.spin.set(
            (Math.random() - 0.5) * 16,
            (Math.random() - 0.5) * 16,
            (Math.random() - 0.5) * 16,
        );
        shell.age = 0;
        shell.alive = true;
    }

    update(deltaTime: number): void {
        if (!(deltaTime > 0)) return;
        const { lifetimeSeconds } = this.options;
        const fadeFrom = lifetimeSeconds * (1 - FADE_TAIL);
        let anyAlive = false;

        for (const shell of this.shells) {
            if (!shell.alive) continue;
            shell.age += deltaTime;
            if (shell.age >= lifetimeSeconds) {
                shell.alive = false;
                shell.mesh.scale.setScalar(0);
                continue;
            }
            anyAlive = true;

            // Plain explicit Euler: this is a ballistic arc, not an oscillator,
            // so there is no energy to gain and nothing to go unstable.
            shell.velocity.y += VIEW_GRAVITY * deltaTime;
            shell.mesh.position.addScaledVector(shell.velocity, deltaTime);
            shell.mesh.rotation.x += shell.spin.x * deltaTime;
            shell.mesh.rotation.y += shell.spin.y * deltaTime;
            shell.mesh.rotation.z += shell.spin.z * deltaTime;

            if (shell.age > fadeFrom) {
                const fade = 1 - (shell.age - fadeFrom) / (lifetimeSeconds - fadeFrom);
                shell.mesh.scale.setScalar(this.options.scale * Math.max(fade, 0));
            }
        }

        // One shared material, so opacity is a per-pool property: hold it at
        // full while anything is in flight and let the per-shell scale do the
        // fading. Cheaper than a material per shell, and visually equivalent
        // at this size.
        this.material.opacity = anyAlive ? 1 : 0;
    }

    dispose(): void {
        this.detach();
        this.geometry.dispose();
        this.material.dispose();
        this.shells.length = 0;
    }
}
