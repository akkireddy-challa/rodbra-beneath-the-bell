import * as THREE from 'three';
import { audio } from './AudioSystem.js';
import { loadVxlCharacterTemplate, instantiateVxlCharacter, type VxlCharacterTemplate } from 'engine/loaders/VxlCharacterLoader.js';

export type EnemyType = 'thrall' | 'warden' | 'warden_miniboss' | 'butcher' | 'butcher_boss' | 'bellbound' | 'bell_mother';

export interface EnemyStats {
    type: EnemyType;
    name: string;
    maxHealth: number;
    currentHealth: number;
    damage: number;
    moveSpeed: number;
    attackRange: number;
    attackCooldown: number;
    staggerDuration: number;
    ironNailsDrop: number;
}

export const ENEMY_VXL_URLS: Record<EnemyType, string> = {
    thrall: 'https://forged-assets.bitmagic.ai/voxel-characters/vxl/b3460.vxl',
    warden: 'https://forged-assets.bitmagic.ai/voxel-characters/vxl/b3282.vxl',
    warden_miniboss: 'https://forged-assets.bitmagic.ai/voxel-characters/vxl/b3282.vxl',
    butcher: 'https://forged-assets.bitmagic.ai/voxel-characters/vxl/b3808.vxl',
    butcher_boss: 'https://forged-assets.bitmagic.ai/voxel-characters/vxl/b3808.vxl',
    bellbound: 'https://forged-assets.bitmagic.ai/voxel-characters/vxl/b3460.vxl',
    bell_mother: 'https://forged-assets.bitmagic.ai/voxel-characters/vxl/b3587.vxl',
};

const vxlTemplateCache: Map<string, VxlCharacterTemplate> = new Map();

export async function preloadEnemyVxlTemplates(): Promise<void> {
    const urls = Object.values(ENEMY_VXL_URLS);
    for (const url of urls) {
        if (!vxlTemplateCache.has(url)) {
            try {
                const tmpl = await loadVxlCharacterTemplate(url);
                vxlTemplateCache.set(url, tmpl);
            } catch {
                // Non-fatal, falls back to procedural
            }
        }
    }
}

export const ENEMY_PRESETS: Record<EnemyType, EnemyStats> = {
    thrall: {
        type: 'thrall',
        name: 'Hollow Thrall',
        maxHealth: 55,
        currentHealth: 55,
        damage: 14,
        moveSpeed: 2.2,
        attackRange: 2.2,
        attackCooldown: 1.8,
        staggerDuration: 1.0,
        ironNailsDrop: 1,
    },
    warden: {
        type: 'warden',
        name: 'Antler Warden',
        maxHealth: 85,
        currentHealth: 85,
        damage: 20,
        moveSpeed: 3.8,
        attackRange: 3.2,
        attackCooldown: 1.5,
        staggerDuration: 0.7,
        ironNailsDrop: 2,
    },
    warden_miniboss: {
        type: 'warden_miniboss',
        name: 'Antler Chieftain',
        maxHealth: 200,
        currentHealth: 200,
        damage: 26,
        moveSpeed: 4.2,
        attackRange: 3.6,
        attackCooldown: 1.6,
        staggerDuration: 0.5,
        ironNailsDrop: 5,
    },
    butcher: {
        type: 'butcher',
        name: 'Mill Butcher',
        maxHealth: 140,
        currentHealth: 140,
        damage: 28,
        moveSpeed: 2.5,
        attackRange: 2.8,
        attackCooldown: 2.2,
        staggerDuration: 0.6,
        ironNailsDrop: 3,
    },
    butcher_boss: {
        type: 'butcher_boss',
        name: 'The Butcher of Vargdal',
        maxHealth: 320,
        currentHealth: 320,
        damage: 34,
        moveSpeed: 3.0,
        attackRange: 3.2,
        attackCooldown: 2.0,
        staggerDuration: 0.45,
        ironNailsDrop: 8,
    },
    bellbound: {
        type: 'bellbound',
        name: 'Bellbound Priestess',
        maxHealth: 65,
        currentHealth: 65,
        damage: 18,
        moveSpeed: 1.6,
        attackRange: 16.0, // ranged
        attackCooldown: 3.2,
        staggerDuration: 0.8,
        ironNailsDrop: 2,
    },
    bell_mother: {
        type: 'bell_mother',
        name: 'The Bell Mother',
        maxHealth: 650,
        currentHealth: 650,
        damage: 32,
        moveSpeed: 2.8,
        attackRange: 4.5,
        attackCooldown: 2.4,
        staggerDuration: 0.35,
        ironNailsDrop: 15,
    },
};

export class Projectile {
    public mesh: THREE.Group;
    public position: THREE.Vector3;
    public velocity: THREE.Vector3;
    public lifetime: number = 0;
    public maxLifetime: number = 4.0;
    public radius: number = 0.5;
    public damage: number = 18;
    public isPlayerOwned: boolean = false;
    public isDead: boolean = false;

    constructor(pos: THREE.Vector3, dir: THREE.Vector3, isPlayer: boolean = false, damage: number = 18) {
        this.position = pos.clone();
        this.isPlayerOwned = isPlayer;
        this.damage = damage;
        const speed = isPlayer ? 22 : 9.5;
        this.velocity = dir.clone().normalize().multiplyScalar(speed);

        this.mesh = new THREE.Group();
        this.mesh.position.copy(this.position);

        if (isPlayer) {
            // Iron Ward talisman: spinning disc
            const ironMat = new THREE.MeshStandardMaterial({ color: 0x565B5E, metalness: 0.8, roughness: 0.3 });
            const runeMat = new THREE.MeshBasicMaterial({ color: 0xC49B4D });
            const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 12), ironMat);
            disc.rotation.x = Math.PI / 2;
            this.mesh.add(disc);

            const core = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.05), runeMat);
            this.mesh.add(core);
            this.maxLifetime = 2.0;
            this.radius = 0.6;
        } else {
            // Bellbound root orb with crimson ember glow
            const rootMat = new THREE.MeshStandardMaterial({ color: 0x362419, roughness: 0.9 });
            const glowMat = new THREE.MeshBasicMaterial({ color: 0xB82323 });
            const orb = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), rootMat);
            this.mesh.add(orb);
            const halo = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.04, 6, 12), glowMat);
            halo.rotation.x = Math.PI / 2;
            this.mesh.add(halo);
            this.maxLifetime = 5.0;
            this.radius = 0.65;
        }
    }

    public update(dt: number): void {
        this.lifetime += dt;
        if (this.lifetime >= this.maxLifetime) {
            this.isDead = true;
            return;
        }

        this.position.addScaledVector(this.velocity, dt);
        this.mesh.position.copy(this.position);

        if (this.isPlayerOwned) {
            this.mesh.rotation.y += dt * 18.0;
            this.mesh.rotation.z += dt * 10.0;
        } else {
            this.mesh.rotation.y += dt * 3.0;
        }
    }
}

export class FloorShockwave {
    public mesh: THREE.Group;
    public center: THREE.Vector3;
    public currentRadius: number = 0.8;
    public maxRadius: number = 14.5;
    public expandSpeed: number = 6.2;
    public damage: number = 22;
    public isDead: boolean = false;
    public ringTorus: THREE.Mesh;
    public safeGapAngle: number;
    public safeGapArc: number = Math.PI / 2.8; // ~64-degree safe gap
    private hasHitPlayer: boolean = false;

    constructor(center: THREE.Vector3, damage: number = 22) {
        this.center = center.clone();
        this.center.y = 1.02; // flush above ice ground
        this.damage = damage;
        this.safeGapAngle = Math.random() * Math.PI * 2;

        this.mesh = new THREE.Group();
        this.mesh.position.copy(this.center);

        const mat = new THREE.MeshBasicMaterial({
            color: 0xEE4411,
            transparent: true,
            opacity: 0.88,
            side: THREE.DoubleSide,
            depthWrite: false,
        });

        const ringGeo = new THREE.RingGeometry(0.8, 1.3, 36, 1, this.safeGapAngle + this.safeGapArc / 2, Math.PI * 2 - this.safeGapArc);
        this.ringTorus = new THREE.Mesh(ringGeo, mat);
        this.ringTorus.rotation.x = -Math.PI / 2;
        this.mesh.add(this.ringTorus);
    }

    public update(dt: number, playerPos: THREE.Vector3, onDamagePlayerCb: (damage: number, hitDir: THREE.Vector3) => void): void {
        this.currentRadius += this.expandSpeed * dt;
        const scale = this.currentRadius;
        this.ringTorus.scale.set(scale, scale, 1);

        const lifeRatio = this.currentRadius / this.maxRadius;
        const mat = this.ringTorus.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 0.88 * (1 - lifeRatio * lifeRatio));

        if (this.currentRadius >= this.maxRadius) {
            this.isDead = true;
            return;
        }

        if (!this.hasHitPlayer) {
            const dx = playerPos.x - this.center.x;
            const dz = playerPos.z - this.center.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (Math.abs(dist - this.currentRadius) <= 1.1) {
                const playerAngle = Math.atan2(dx, dz);
                let angleDiff = Math.abs(playerAngle - this.safeGapAngle);
                while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                angleDiff = Math.abs(angleDiff);

                if (angleDiff > this.safeGapArc / 2) {
                    this.hasHitPlayer = true;
                    const hitDir = new THREE.Vector3(dx, 0, dz).normalize();
                    onDamagePlayerCb(this.damage, hitDir);
                    audio.playBellToll('distant');
                }
            }
        }
    }

    public dispose(scene: THREE.Scene): void {
        scene.remove(this.mesh);
    }
}

export class EnemyInstance {
    public id: string;
    public type: EnemyType;
    public name: string;
    public stats: EnemyStats;
    public mesh: THREE.Group;
    public position: THREE.Vector3;
    public rotationY: number = 0;

    // State machine
    public state: 'idle' | 'pursue' | 'windup' | 'attack' | 'recovery' | 'staggered' | 'dead' = 'idle';
    public stateTimer: number = 0;
    public attackCooldownTimer: number = 0;
    public isAttacking: boolean = false;
    public canDealDamage: boolean = false;
    public hasDealtDamageThisAttack: boolean = false;
    public telegraphLight: THREE.PointLight | null = null;
    public armorPlateBroken: boolean = false;
    public armorPlateMesh: THREE.Object3D | null = null;
    public proceduralGroup: THREE.Group | null = null;
    public vxlModel: any = null;

    // Visual nodes for procedural animation
    private leftLegMesh: THREE.Object3D | null = null;
    private rightLegMesh: THREE.Object3D | null = null;
    private leftArmMesh: THREE.Object3D | null = null;
    private rightArmMesh: THREE.Object3D | null = null;
    private weaponMesh: THREE.Object3D | null = null;
    private haloMesh: THREE.Object3D | null = null;

    // Boss state (for Bell Mother)
    public bossPhase: 1 | 2 | 3 = 1;
    public phase2SummonDone: boolean = false;
    public shockwaveTimer: number = 0;
    public currentAttackType: 'normal' | 'grab' = 'normal';

    constructor(type: EnemyType, spawnPos: THREE.Vector3, id: string) {
        this.id = id;
        this.type = type;
        this.stats = { ...ENEMY_PRESETS[type] };
        this.name = this.stats.name;
        this.position = spawnPos.clone();

        this.mesh = new THREE.Group();
        this.mesh.name = `Enemy_${type}_${id}`;
        this.mesh.position.copy(this.position);

        this.buildEnemyMesh();
    }

    public async tryAttachVxlModel(): Promise<void> {
        const url = ENEMY_VXL_URLS[this.type];
        if (!url) return;
        try {
            let tmpl = vxlTemplateCache.get(url);
            if (!tmpl) {
                tmpl = await loadVxlCharacterTemplate(url);
                vxlTemplateCache.set(url, tmpl);
            }
            if (this.state === 'dead' || !tmpl) return;
            const model = instantiateVxlCharacter(tmpl);
            if (model?.scene) {
                let scale = 1.0;
                if (this.type === 'warden_miniboss') scale = 1.35;
                else if (this.type === 'butcher_boss') scale = 1.4;
                else if (this.type === 'bell_mother') scale = 1.5;
                model.scene.scale.set(scale, scale, scale);

                this.vxlModel = model;
                if (this.proceduralGroup) {
                    this.proceduralGroup.visible = false;
                }
                this.mesh.add(model.scene);
            }
        } catch {
            // Graceful fallback to procedural mesh
        }
    }

    private buildEnemyMesh(): void {
        const matCorpse = new THREE.MeshStandardMaterial({ color: 0x8C9490, roughness: 0.9, metalness: 0.05 });
        const matClothDark = new THREE.MeshStandardMaterial({ color: 0x2A2725, roughness: 0.95 });
        const matClothTorn = new THREE.MeshStandardMaterial({ color: 0x47423D, roughness: 0.9 });
        const matBone = new THREE.MeshStandardMaterial({ color: 0xD4CBB7, roughness: 0.7, metalness: 0.1 });
        const matWoodDark = new THREE.MeshStandardMaterial({ color: 0x3D2C20, roughness: 0.85 });
        const matIronRusty = new THREE.MeshStandardMaterial({ color: 0x524844, roughness: 0.5, metalness: 0.7 });
        const matBronze = new THREE.MeshStandardMaterial({ color: 0x7A6848, roughness: 0.4, metalness: 0.8 });
        const matRoot = new THREE.MeshStandardMaterial({ color: 0x2E2018, roughness: 0.9 });
        const matRedGlow = new THREE.MeshBasicMaterial({ color: 0xB51D1D });

        const baseGroup = new THREE.Group();
        this.mesh.add(baseGroup);
        this.proceduralGroup = baseGroup;

        if (this.type === 'thrall') {
            // 1. HOLLOW THRALL: Gaunt, funeral cloth cowl, wrapped rags, crude iron sickle
            // Head with cowl
            const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.28, 0.24), matClothDark);
            head.position.set(0, 1.45, 0);
            baseGroup.add(head);

            // Sunken corpse face inside cowl
            const face = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.05), matCorpse);
            face.position.set(0, 1.43, 0.11);
            baseGroup.add(face);

            // Torso: Emaciated body wrapped in funeral cloth
            const torso = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.55, 0.20), matClothTorn);
            torso.position.set(0, 1.05, 0);
            baseGroup.add(torso);

            // Arms
            const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.55, 0.10), matCorpse);
            lArm.position.set(-0.22, 1.0, 0);
            baseGroup.add(lArm);
            this.leftArmMesh = lArm;

            const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.55, 0.10), matCorpse);
            rArm.position.set(0.22, 1.0, 0);
            baseGroup.add(rArm);
            this.rightArmMesh = rArm;

            // Crude sickle/blade in right hand
            const sickle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.45, 0.12), matIronRusty);
            sickle.position.set(0.02, -0.22, 0.10);
            rArm.add(sickle);
            this.weaponMesh = sickle;

            // Legs
            const lLeg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.70, 0.12), matClothDark);
            lLeg.position.set(-0.10, 0.38, 0);
            baseGroup.add(lLeg);
            this.leftLegMesh = lLeg;

            const rLeg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.70, 0.12), matClothDark);
            rLeg.position.set(0.10, 0.38, 0);
            baseGroup.add(rLeg);
            this.rightLegMesh = rLeg;
        } else if (this.type === 'warden' || this.type === 'warden_miniboss') {
            // 2. ANTLER WARDEN: Tall agile hunter, bark armor, deer skull mask with branching antlers, spear
            const scale = this.type === 'warden_miniboss' ? 1.35 : 1.05;
            baseGroup.scale.set(scale, scale, scale);

            // Deer Skull mask
            const skull = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.32, 0.28), matBone);
            skull.position.set(0, 1.55, 0);
            baseGroup.add(skull);

            // Branching asymmetrical antlers
            const antlerLeftMain = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.45, 6), matBone);
            antlerLeftMain.position.set(-0.16, 1.82, 0);
            antlerLeftMain.rotation.z = 0.45;
            baseGroup.add(antlerLeftMain);

            const antlerLeftBranch = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.22, 6), matBone);
            antlerLeftBranch.position.set(-0.25, 1.95, 0.05);
            antlerLeftBranch.rotation.z = 0.9;
            baseGroup.add(antlerLeftBranch);

            const antlerRightMain = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.50, 6), matBone);
            antlerRightMain.position.set(0.16, 1.84, 0);
            antlerRightMain.rotation.z = -0.4;
            baseGroup.add(antlerRightMain);

            // Glowing eye sockets
            const eye1 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.02), matRedGlow);
            eye1.position.set(-0.06, 1.55, 0.14);
            baseGroup.add(eye1);
            const eye2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.02), matRedGlow);
            eye2.position.set(0.06, 1.55, 0.14);
            baseGroup.add(eye2);

            // Bark/Bone Cuirass
            const cuirass = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.60, 0.24), matWoodDark);
            cuirass.position.set(0, 1.15, 0);
            baseGroup.add(cuirass);

            // Bone rib plating
            const ribs = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.28, 0.26), matBone);
            ribs.position.set(0, 1.20, 0);
            baseGroup.add(ribs);

            // Arms
            const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.60, 0.11), matWoodDark);
            lArm.position.set(-0.26, 1.10, 0);
            baseGroup.add(lArm);
            this.leftArmMesh = lArm;

            const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.60, 0.11), matWoodDark);
            rArm.position.set(0.26, 1.10, 0);
            baseGroup.add(rArm);
            this.rightArmMesh = rArm;

            // Long spear/hooked staff
            const spearShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1.9, 8), matWoodDark);
            spearShaft.position.set(0.05, 0.1, 0.45);
            spearShaft.rotation.x = Math.PI / 4;
            rArm.add(spearShaft);
            const spearBlade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.02), matIronRusty);
            spearBlade.position.set(0, 0.95, 0);
            spearShaft.add(spearBlade);
            this.weaponMesh = spearShaft;

            // Legs
            const lLeg = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.78, 0.13), matWoodDark);
            lLeg.position.set(-0.12, 0.42, 0);
            baseGroup.add(lLeg);
            this.leftLegMesh = lLeg;

            const rLeg = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.78, 0.13), matWoodDark);
            rLeg.position.set(0.12, 0.42, 0);
            baseGroup.add(rLeg);
            this.rightLegMesh = rLeg;
        } else if (this.type === 'butcher' || this.type === 'butcher_boss') {
            // 3. MILL BUTCHER: Massive executioner, wooden bucket mask, bloodied apron, dual hooked cleavers
            const scale = this.type === 'butcher_boss' ? 1.45 : 1.2;
            baseGroup.scale.set(scale, scale, scale);

            // Wooden bucket mask with iron eye slit
            const bucketMask = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.22, 0.36, 10), matWoodDark);
            bucketMask.position.set(0, 1.62, 0);
            baseGroup.add(bucketMask);

            const ironSlit = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.04, 0.24), matIronRusty);
            ironSlit.position.set(0, 1.65, 0.02);
            baseGroup.add(ironSlit);

            // Massive muscular torso with blood-stained apron
            const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.65, 0.36), matClothTorn);
            torso.position.set(0, 1.15, 0);
            baseGroup.add(torso);

            // Destructible wooden chest plate
            const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.42, 0.08), matWoodDark);
            chestPlate.position.set(0, 1.22, 0.19);
            baseGroup.add(chestPlate);
            this.armorPlateMesh = chestPlate;

            // Thick heavy arms
            const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.62, 0.16), matCorpse);
            lArm.position.set(-0.36, 1.12, 0);
            baseGroup.add(lArm);
            this.leftArmMesh = lArm;

            const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.62, 0.16), matCorpse);
            rArm.position.set(0.36, 1.12, 0);
            baseGroup.add(rArm);
            this.rightArmMesh = rArm;

            // Dual hooked cleavers
            const cleaverL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.55, 0.22), matIronRusty);
            cleaverL.position.set(0, -0.32, 0.14);
            lArm.add(cleaverL);

            const cleaverR = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.55, 0.22), matIronRusty);
            cleaverR.position.set(0, -0.32, 0.14);
            rArm.add(cleaverR);
            this.weaponMesh = cleaverR;

            // Heavy legs
            const lLeg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.72, 0.18), matClothDark);
            lLeg.position.set(-0.16, 0.40, 0);
            baseGroup.add(lLeg);
            this.leftLegMesh = lLeg;

            const rLeg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.72, 0.18), matClothDark);
            rLeg.position.set(0.16, 0.40, 0);
            baseGroup.add(rLeg);
            this.rightLegMesh = rLeg;
        } else if (this.type === 'bellbound') {
            // 4. BELLBOUND: Rooted ritual priestess, bronze halo, hand bell, root body
            const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.32, 0.26), matClothDark);
            cowl.position.set(0, 1.48, 0);
            baseGroup.add(cowl);

            // Cracked bronze halo behind head
            const halo = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.035, 8, 16), matBronze);
            halo.position.set(0, 1.55, -0.15);
            baseGroup.add(halo);
            this.haloMesh = halo;

            // Torso dissolving into roots
            const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.50, 0.22), matClothDark);
            torso.position.set(0, 1.10, 0);
            baseGroup.add(torso);

            // Lower body: tangled cluster of roots
            for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2;
                const root = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.08, 0.9, 6), matRoot);
                root.position.set(Math.cos(angle) * 0.25, 0.45, Math.sin(angle) * 0.25);
                root.rotation.z = Math.cos(angle) * 0.2;
                root.rotation.x = Math.sin(angle) * 0.2;
                baseGroup.add(root);
            }

            // Left hand holding bronze ritual bell
            const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.45, 0.09), matClothDark);
            lArm.position.set(-0.22, 1.05, 0);
            baseGroup.add(lArm);
            this.leftArmMesh = lArm;

            const handBell = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.18, 8), matBronze);
            handBell.position.set(0, -0.25, 0.08);
            handBell.rotation.x = Math.PI;
            lArm.add(handBell);

            // Right arm for casting root orbs
            const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.45, 0.09), matClothDark);
            rArm.position.set(0.22, 1.05, 0);
            baseGroup.add(rArm);
            this.rightArmMesh = rArm;
        } else if (this.type === 'bell_mother') {
            // 5. THE BELL MOTHER: Colossal root priestess, colossal cracked bronze halo, rooted robes, staff
            baseGroup.scale.set(1.5, 1.5, 1.5);

            // Veiled head
            const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.38, 0.32), matClothDark);
            head.position.set(0, 1.70, 0);
            baseGroup.add(head);

            // Red glowing eyes beneath veil
            const eye1 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.02), matRedGlow);
            eye1.position.set(-0.08, 1.70, 0.17);
            baseGroup.add(eye1);
            const eye2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.02), matRedGlow);
            eye2.position.set(0.08, 1.70, 0.17);
            baseGroup.add(eye2);

            // Colossal cracked bronze halo
            const halo = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.06, 8, 24), matBronze);
            halo.position.set(0, 1.85, -0.18);
            baseGroup.add(halo);
            this.haloMesh = halo;

            // Torso
            const torso = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.70, 0.32), matClothDark);
            torso.position.set(0, 1.20, 0);
            baseGroup.add(torso);

            // Massive root tendrils descending to floor
            for (let i = 0; i < 10; i++) {
                const angle = (i / 10) * Math.PI * 2;
                const root = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.14, 1.1, 8), matRoot);
                root.position.set(Math.cos(angle) * 0.45, 0.55, Math.sin(angle) * 0.45);
                root.rotation.z = Math.cos(angle) * 0.25;
                root.rotation.x = Math.sin(angle) * 0.25;
                baseGroup.add(root);
            }

            // Arms
            const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.65, 0.14), matClothDark);
            lArm.position.set(-0.34, 1.22, 0);
            baseGroup.add(lArm);
            this.leftArmMesh = lArm;

            const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.65, 0.14), matClothDark);
            rArm.position.set(0.34, 1.22, 0);
            baseGroup.add(rArm);
            this.rightArmMesh = rArm;

            // Giant root staff
            const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.4, 8), matRoot);
            staff.position.set(0, 0.2, 0.5);
            staff.rotation.x = Math.PI / 6;
            rArm.add(staff);
            const staffBell = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.28, 8), matBronze);
            staffBell.position.set(0, 1.2, 0);
            staff.add(staffBell);
            this.weaponMesh = staff;
        }

        // Telegraph point light (for attacks & parry indicators)
        const light = new THREE.PointLight(0xFF2222, 0, 5);
        light.position.set(0, 1.5, 0.4);
        baseGroup.add(light);
        this.telegraphLight = light;
    }

    public update(
        dt: number,
        playerPos: THREE.Vector3,
        canAttackNow: boolean,
        spawnProjectileCb: (p: Projectile) => void,
        spawnShockwaveCb: (center: THREE.Vector3) => void,
        onDamagePlayerCb: (damage: number, hitDir: THREE.Vector3, isUnblockable?: boolean) => void,
        onSummonMobsCb?: (pos: THREE.Vector3) => void
    ): void {
        if (this.state === 'dead') return;

        this.stateTimer += dt;
        this.attackCooldownTimer = Math.max(0, this.attackCooldownTimer - dt);

        const toPlayer = new THREE.Vector3().subVectors(playerPos, this.position);
        toPlayer.y = 0;
        const distToPlayer = toPlayer.length();

        // Face player smoothly when not locked in mid-swing
        if (this.state !== 'attack' && this.state !== 'staggered' && distToPlayer > 0.1) {
            const targetRot = Math.atan2(toPlayer.x, toPlayer.z);
            let diff = targetRot - this.rotationY;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            this.rotationY += diff * Math.min(1, dt * 6.0);
            this.mesh.rotation.y = this.rotationY;
        }

        // Bell Mother Phase Transitions
        if (this.type === 'bell_mother') {
            const hpRatio = this.stats.currentHealth / this.stats.maxHealth;
            if (hpRatio <= 0.30 && this.bossPhase < 3) {
                this.bossPhase = 3;
                this.stats.moveSpeed = 3.6;
                this.stats.damage = 40;
                audio.playBellToll('colossal');
                audio.setMusicMode('boss_p3');
                // Shatter bronze halo visually
                if (this.haloMesh) {
                    this.haloMesh.visible = false;
                }
            } else if (hpRatio <= 0.65 && this.bossPhase < 2) {
                this.bossPhase = 2;
                this.stats.moveSpeed = 3.2;
                audio.playBellToll('large');
                audio.setMusicMode('boss_p2');
                if (!this.phase2SummonDone) {
                    this.phase2SummonDone = true;
                    if (onSummonMobsCb) {
                        onSummonMobsCb(this.position);
                    }
                }
            }

            // Periodic floor shockwaves in Phase 2 & 3
            if (this.bossPhase >= 2) {
                this.shockwaveTimer += dt;
                if (this.shockwaveTimer >= 7.5) {
                    this.shockwaveTimer = 0;
                    spawnShockwaveCb(this.position);
                }
            }
        }

        // State Machine
        switch (this.state) {
            case 'idle':
                if (distToPlayer < 24.0) {
                    this.state = 'pursue';
                    this.stateTimer = 0;
                }
                break;

            case 'pursue': {
                const inRange = distToPlayer <= this.stats.attackRange;
                if (!inRange) {
                    // Move toward player
                    const moveDir = toPlayer.clone().normalize();
                    this.position.addScaledVector(moveDir, this.stats.moveSpeed * dt);
                    this.mesh.position.copy(this.position);

                    // Procedural walk animation
                    const walkCycle = Math.sin(Date.now() * 0.008 * this.stats.moveSpeed);
                    if (this.leftLegMesh) this.leftLegMesh.rotation.x = walkCycle * 0.5;
                    if (this.rightLegMesh) this.rightLegMesh.rotation.x = -walkCycle * 0.5;
                    if (this.leftArmMesh) this.leftArmMesh.rotation.x = -walkCycle * 0.4;
                    if (this.rightArmMesh) this.rightArmMesh.rotation.x = walkCycle * 0.4;
                } else {
                    // Reset limbs to resting stance
                    if (this.leftLegMesh) this.leftLegMesh.rotation.x = 0;
                    if (this.rightLegMesh) this.rightLegMesh.rotation.x = 0;

                    // Trigger attack if cooldown is clear and allowed by attacker quota
                    if (this.attackCooldownTimer <= 0 && canAttackNow) {
                        this.startWindup();
                    }
                }
                break;
            }

            case 'windup': {
                // Clear visual telegraph
                const windupProgress = Math.min(1, this.stateTimer / (this.type === 'thrall' ? 0.7 : 0.5));
                if (this.telegraphLight) {
                    this.telegraphLight.intensity = windupProgress * 4.0;
                }
                if (this.currentAttackType === 'grab') {
                    if (this.leftArmMesh) this.leftArmMesh.rotation.x = -Math.PI * 0.4 * windupProgress;
                    if (this.rightArmMesh) this.rightArmMesh.rotation.x = -Math.PI * 0.4 * windupProgress;
                } else if (this.rightArmMesh) {
                    this.rightArmMesh.rotation.x = -Math.PI * 0.45 * windupProgress;
                }

                if (windupProgress >= 1.0) {
                    this.startAttack(spawnProjectileCb);
                }
                break;
            }

            case 'attack': {
                const attackDuration = this.type === 'thrall' ? 0.45 : 0.35;
                const attackProgress = Math.min(1, this.stateTimer / attackDuration);

                // Swing forward or lunging grab
                if (this.currentAttackType === 'grab') {
                    if (this.leftArmMesh) this.leftArmMesh.rotation.x = -Math.PI * 0.45 * (1 - attackProgress);
                    if (this.rightArmMesh) this.rightArmMesh.rotation.x = -Math.PI * 0.45 * (1 - attackProgress);
                } else if (this.rightArmMesh) {
                    this.rightArmMesh.rotation.x = -Math.PI * 0.45 + Math.PI * 0.9 * attackProgress;
                }

                // Check damage window
                if (!this.hasDealtDamageThisAttack && attackProgress >= 0.25 && attackProgress <= 0.75) {
                    const hitReach = this.currentAttackType === 'grab' ? this.stats.attackRange + 1.2 : this.stats.attackRange + 0.6;
                    if (distToPlayer <= hitReach) {
                        this.hasDealtDamageThisAttack = true;
                        const hitDir = new THREE.Vector3().subVectors(playerPos, this.position).normalize();
                        const isGrab = this.currentAttackType === 'grab';
                        const damage = isGrab ? this.stats.damage * 1.35 : this.stats.damage;
                        onDamagePlayerCb(damage, hitDir, isGrab);
                        audio.playFleshImpact();
                    }
                }

                if (attackProgress >= 1.0) {
                    this.startRecovery();
                }
                break;
            }

            case 'recovery': {
                const recoveryDuration = this.type === 'thrall' ? 1.2 : 0.6; // Thrall miss is vulnerable
                if (this.stateTimer >= recoveryDuration) {
                    this.state = 'pursue';
                    this.stateTimer = 0;
                    this.attackCooldownTimer = this.stats.attackCooldown;
                    if (this.rightArmMesh) this.rightArmMesh.rotation.x = 0;
                    if (this.leftArmMesh) this.leftArmMesh.rotation.x = 0;
                }
                break;
            }

            case 'staggered': {
                if (this.stateTimer >= this.stats.staggerDuration) {
                    this.state = 'pursue';
                    this.stateTimer = 0;
                    if (this.rightArmMesh) this.rightArmMesh.rotation.x = 0;
                    if (this.leftArmMesh) this.leftArmMesh.rotation.x = 0;
                    if (this.mesh) this.mesh.position.y = this.position.y;
                }
                break;
            }
        }

        if (this.vxlModel?.scene) {
            if (this.state === 'pursue') {
                this.vxlModel.scene.rotation.z = Math.sin(Date.now() * 0.008 * this.stats.moveSpeed) * 0.08;
                this.vxlModel.scene.rotation.x = 0;
            } else if (this.state === 'windup') {
                const windupProgress = Math.min(1, this.stateTimer / (this.type === 'thrall' ? 0.7 : 0.5));
                this.vxlModel.scene.rotation.x = 0.18 * windupProgress;
                this.vxlModel.scene.rotation.z = 0;
            } else if (this.state === 'attack') {
                const attackDuration = this.type === 'thrall' ? 0.45 : 0.35;
                const attackProgress = Math.min(1, this.stateTimer / attackDuration);
                this.vxlModel.scene.rotation.x = -0.28 * Math.sin(attackProgress * Math.PI);
                this.vxlModel.scene.rotation.z = 0;
            } else if (this.state === 'staggered') {
                this.vxlModel.scene.rotation.x = 0.35;
                this.vxlModel.scene.rotation.z = 0.1;
            } else {
                this.vxlModel.scene.rotation.x = 0;
                this.vxlModel.scene.rotation.z = 0;
            }
        }
    }

    private startWindup(): void {
        this.state = 'windup';
        this.stateTimer = 0;
        this.isAttacking = true;
        this.hasDealtDamageThisAttack = false;

        this.currentAttackType = (this.type === 'bell_mother' && this.bossPhase === 3 && Math.random() < 0.45) ? 'grab' : 'normal';

        if (this.currentAttackType === 'grab') {
            if (this.telegraphLight) {
                this.telegraphLight.color.setHex(0xFF0033);
                this.telegraphLight.intensity = 8.0;
            }
            audio.playBellToll('large');
        } else if (this.type === 'bellbound') {
            audio.playBellToll('distant');
        } else if (this.type === 'butcher' || this.type === 'butcher_boss') {
            audio.playWoodImpact();
        }
    }

    private startAttack(spawnProjectileCb: (p: Projectile) => void): void {
        this.state = 'attack';
        this.stateTimer = 0;
        if (this.telegraphLight) {
            this.telegraphLight.intensity = 0;
        }

        if (this.type === 'bellbound') {
            // Fires slow homing root projectile
            const spawnPt = this.position.clone().add(new THREE.Vector3(0, 1.4, 0));
            const forward = new THREE.Vector3(Math.sin(this.rotationY), 0, Math.cos(this.rotationY));
            const proj = new Projectile(spawnPt, forward, false, this.stats.damage);
            spawnProjectileCb(proj);
            audio.playWardThrow();
            this.startRecovery();
        } else if (this.currentAttackType === 'grab') {
            audio.playWoodImpact();
            // Lunge forward
            const forward = new THREE.Vector3(Math.sin(this.rotationY), 0, Math.cos(this.rotationY));
            this.position.addScaledVector(forward, 2.2);
            this.mesh.position.copy(this.position);
        } else {
            audio.playSwordWhoosh(2);
        }
    }

    private startRecovery(): void {
        this.state = 'recovery';
        this.stateTimer = 0;
        this.isAttacking = false;
    }

    public takeDamage(amount: number, isParryRiposte: boolean = false): { died: boolean; staggered: boolean } {
        if (this.state === 'dead') return { died: false, staggered: false };

        // Destructible armor plate on Mill Butcher
        if ((this.type === 'butcher' || this.type === 'butcher_boss') && !this.armorPlateBroken) {
            this.armorPlateBroken = true;
            if (this.armorPlateMesh) {
                this.armorPlateMesh.visible = false;
            }
            audio.playWoodImpact();
        }

        this.stats.currentHealth -= amount;

        // Flinch flash
        if (this.telegraphLight) {
            this.telegraphLight.color.setHex(0xFFFFFF);
            this.telegraphLight.intensity = 5;
            setTimeout(() => {
                if (this.telegraphLight) {
                    this.telegraphLight.color.setHex(0xFF2222);
                    this.telegraphLight.intensity = 0;
                }
            }, 100);
        }

        if (this.stats.currentHealth <= 0) {
            this.die();
            return { died: true, staggered: true };
        }

        // Enter stagger state
        this.state = 'staggered';
        this.stateTimer = 0;
        this.isAttacking = false;
        if (this.rightArmMesh) this.rightArmMesh.rotation.x = -Math.PI * 0.2;
        this.mesh.position.y = this.position.y + 0.1;

        return { died: false, staggered: true };
    }

    public die(): void {
        this.state = 'dead';
        this.isAttacking = false;
        if (this.telegraphLight) this.telegraphLight.intensity = 0;

        // Collapse to ground
        this.mesh.rotation.z = Math.PI / 2;
        this.mesh.position.y = this.position.y + 0.15;
    }

    public dispose(): void {
        if (this.vxlModel?.scene) {
            this.mesh.remove(this.vxlModel.scene);
            this.vxlModel = null;
        }
        if (this.mesh.parent) {
            this.mesh.parent.remove(this.mesh);
        }
    }
}

export class EnemyManager {
    public enemies: EnemyInstance[] = [];
    public projectiles: Projectile[] = [];
    public shockwaves: FloorShockwave[] = [];
    private scene: THREE.Scene;
    private maxSimultaneousAttackers: number = 3;

    constructor(scene: THREE.Scene) {
        this.scene = scene;
    }

    public spawnEnemy(type: EnemyType, position: THREE.Vector3, idPrefix: string = 'mob'): EnemyInstance {
        const id = `${idPrefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const enemy = new EnemyInstance(type, position, id);
        enemy.tryAttachVxlModel().catch(() => {});
        this.enemies.push(enemy);
        this.scene.add(enemy.mesh);
        return enemy;
    }

    public spawnProjectile(projectile: Projectile): void {
        this.projectiles.push(projectile);
        this.scene.add(projectile.mesh);
    }

    public spawnShockwave(center: THREE.Vector3): void {
        const sw = new FloorShockwave(center, 22);
        this.shockwaves.push(sw);
        this.scene.add(sw.mesh);
    }

    public update(
        dt: number,
        playerPos: THREE.Vector3,
        onDamagePlayerCb: (damage: number, hitDir: THREE.Vector3, isUnblockable?: boolean) => void,
        onEnemyKilledCb: (enemy: EnemyInstance) => void
    ): void {
        // Count active attackers to respect quota
        let currentAttackers = 0;
        for (const e of this.enemies) {
            if (e.state === 'windup' || e.state === 'attack') {
                currentAttackers++;
            }
        }

        // Update enemies
        for (let i = this.enemies.length - 1; i >= 0; i--) {
            const enemy = this.enemies[i];
            if (!enemy) continue;
            if (enemy.state === 'dead') {
                // Keep dead bodies visible briefly then remove
                enemy.stateTimer += dt;
                if (enemy.stateTimer > 8.0 && enemy.type !== 'bell_mother') {
                    enemy.dispose();
                    this.enemies.splice(i, 1);
                }
                continue;
            }

            const canAttack = currentAttackers < this.maxSimultaneousAttackers || enemy.state === 'windup' || enemy.state === 'attack';
            enemy.update(
                dt,
                playerPos,
                canAttack,
                (p) => this.spawnProjectile(p),
                (center) => this.spawnShockwave(center),
                onDamagePlayerCb,
                (pos) => {
                    // Phase 2: Bell Mother rings bell and summons two Hollow Thralls
                    this.spawnEnemy('thrall', new THREE.Vector3(pos.x - 3.5, 1.5, pos.z - 2), 'bm_thrall_1');
                    this.spawnEnemy('thrall', new THREE.Vector3(pos.x + 3.5, 1.5, pos.z - 2), 'bm_thrall_2');
                    audio.playBellToll('large');
                }
            );
        }

        // Update floor shockwaves
        for (let i = this.shockwaves.length - 1; i >= 0; i--) {
            const sw = this.shockwaves[i];
            if (!sw) continue;
            sw.update(dt, playerPos, (damage, hitDir) => {
                onDamagePlayerCb(damage, hitDir, false);
            });
            if (sw.isDead) {
                sw.dispose(this.scene);
                this.shockwaves.splice(i, 1);
            }
        }

        // Update projectiles
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            if (!p) continue;
            p.update(dt);

            if (p.isDead) {
                this.scene.remove(p.mesh);
                this.projectiles.splice(i, 1);
                continue;
            }

            // Hit test player if enemy projectile
            if (!p.isPlayerOwned) {
                const distToPlayer = p.position.distanceTo(playerPos);
                if (distToPlayer <= p.radius + 0.4) {
                    p.isDead = true;
                    onDamagePlayerCb(p.damage, p.velocity.clone().normalize());
                    audio.playWardHit();
                }
            } else {
                // Hit test enemies if player projectile (Ward)
                for (const enemy of this.enemies) {
                    if (enemy.state === 'dead') continue;
                    const dist = p.position.distanceTo(enemy.position);
                    if (dist <= p.radius + 1.0) {
                        p.isDead = true;
                        audio.playWardHit();
                        const result = enemy.takeDamage(p.damage);
                        if (result.died) {
                            onEnemyKilledCb(enemy);
                        }
                        break;
                    }
                }
            }
        }
    }

    public getBossInstance(): EnemyInstance | null {
        return this.enemies.find(e => e.type === 'bell_mother' || e.type === 'butcher_boss') || null;
    }

    public clearProjectilesAndShockwaves(): void {
        for (const p of this.projectiles) {
            this.scene.remove(p.mesh);
        }
        this.projectiles = [];

        for (const sw of this.shockwaves) {
            sw.dispose(this.scene);
        }
        this.shockwaves = [];
    }

    public clearAll(): void {
        for (const e of this.enemies) {
            e.dispose();
        }
        this.enemies = [];

        this.clearProjectilesAndShockwaves();
    }
}
