import * as THREE from 'three';
import { PhysicsBodyFactory } from 'engine/physics/PhysicsBodyFactory.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { audio } from './AudioSystem.js';
import { type EnemyManager } from './Enemies.js';
import { type PlayerStats } from './Constants.js';
import type { SaveDataV2 } from './SaveGameService.js';

export interface CheckpointInfo {
    id: string;
    name: string;
    position: THREE.Vector3;
    zoneIndex: number;
    discovered: boolean;
}

export interface InteractiveItem {
    id: string;
    type: 'sword_pickup' | 'prayer_post' | 'nail_cache' | 'gate_lever' | 'elin_altar';
    position: THREE.Vector3;
    promptText: string;
    isConsumed: boolean;
    mesh: THREE.Object3D;
    onInteract: () => void;
}

export class WorldZoneManager {
    private scene: THREE.Scene;
    private physicsWorld: PhysicsWorld;
    private enemyManager: EnemyManager;
    private stats: PlayerStats;

    // Visual groups
    public worldGroup: THREE.Group;
    public waterWheelMesh: THREE.Object3D | null = null;
    public colossalBellMesh: THREE.Object3D | null = null;
    public elinMesh: THREE.Object3D | null = null;
    public timingHazardBlade: THREE.Object3D | null = null;
    private timingBladeAngle: number = 0;
    private hazardCooldownTimer: number = 0;
    private onHazardHitCb: ((damage: number, hitDir: THREE.Vector3) => void) | null = null;

    public setHazardHitCallback(cb: (damage: number, hitDir: THREE.Vector3) => void): void {
        this.onHazardHitCb = cb;
    }

    // Checkpoints
    public checkpoints: CheckpointInfo[] = [
        { id: 'checkpoint_prologue', name: 'The Silent Threshold', position: new THREE.Vector3(0, 1.0, 8), zoneIndex: 0, discovered: true },
        { id: 'checkpoint_hushwood', name: 'Hushwood Chapel', position: new THREE.Vector3(0, 1.0, 68), zoneIndex: 1, discovered: false },
        { id: 'checkpoint_redmill', name: 'The Frozen Wheel', position: new THREE.Vector3(0, 1.0, 142), zoneIndex: 2, discovered: false },
        { id: 'checkpoint_belowthebell', name: 'The Rooted Vault', position: new THREE.Vector3(0, 1.0, 225), zoneIndex: 3, discovered: false },
    ];

    // Gates & Barriers
    public hushwoodGateMesh: THREE.Object3D | null = null;
    public millGateMesh: THREE.Object3D | null = null;
    public sanctuaryGateMesh: THREE.Object3D | null = null;
    public elinBarrierMesh: THREE.Object3D | null = null;
    private hushwoodGateBody: any = null;
    private millGateBody: any = null;
    private elinBarrierBody: any = null;

    // Interactable objects
    public interactables: InteractiveItem[] = [];

    // Trigger volumes / spawned encounters
    private spawnedZone0Enemies = false;
    private spawnedZone1Enemies = false;
    private spawnedZone2Enemies = false;
    private spawnedZone3Enemies = false;

    constructor(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        enemyManager: EnemyManager,
        stats: PlayerStats
    ) {
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.enemyManager = enemyManager;
        this.stats = stats;

        this.worldGroup = new THREE.Group();
        this.worldGroup.name = 'Rödbra_World_Structures';
        this.worldGroup.position.set(0, 1.0, 0);
        this.scene.add(this.worldGroup);

        this.buildAllZones();
    }

    public update(dt: number, playerPos: THREE.Vector3): void {
        // Rotate Red Mill waterwheel
        if (this.waterWheelMesh) {
            this.waterWheelMesh.rotation.x += dt * 0.45;
        }

        // Oscillate Mill timing blade hazard
        if (this.timingHazardBlade) {
            this.timingBladeAngle += dt * 2.2;
            this.timingHazardBlade.rotation.z = Math.sin(this.timingBladeAngle) * 0.75;

            // Safe readable timing hazard check:
            if (this.hazardCooldownTimer > 0) {
                this.hazardCooldownTimer -= dt;
            } else if (Math.abs(playerPos.z - 160) < 1.0 && Math.abs(playerPos.x) < 1.2) {
                const bladeLow = Math.abs(Math.sin(this.timingBladeAngle)) < 0.35;
                if (bladeLow && this.onHazardHitCb) {
                    this.hazardCooldownTimer = 1.2;
                    this.onHazardHitCb(12, new THREE.Vector3(0, 0, -1));
                }
            }
        }

        // Zone Progression & Encounter Spawns based on player Z
        if (playerPos.z >= 12 && !this.spawnedZone0Enemies && this.stats.swordAcquired) {
            this.spawnedZone0Enemies = true;
            // First Hollow Thrall tutorial
            this.enemyManager.spawnEnemy('thrall', new THREE.Vector3(0, 1.5, 26), 'thrall_tut');
        }

        if (playerPos.z >= 45 && !this.spawnedZone1Enemies) {
            this.spawnedZone1Enemies = true;
            // Hushwood Approach enemies
            this.enemyManager.spawnEnemy('thrall', new THREE.Vector3(-4, 1.5, 75), 'hw_thrall_1');
            this.enemyManager.spawnEnemy('thrall', new THREE.Vector3(4, 1.5, 82), 'hw_thrall_2');
            this.enemyManager.spawnEnemy('warden', new THREE.Vector3(0, 1.5, 92), 'hw_warden_1');
            // Antler Chieftain Miniboss in Chapel clearing (only if not defeated)
            if (!this.stats.completedBosses.antlerMiniboss) {
                this.enemyManager.spawnEnemy('warden_miniboss', new THREE.Vector3(0, 1.5, 104), 'hw_boss');
            }
        }

        if (playerPos.z >= 120 && !this.spawnedZone2Enemies) {
            this.spawnedZone2Enemies = true;
            // The Red Mill enemies
            this.enemyManager.spawnEnemy('thrall', new THREE.Vector3(-5, 1.5, 148), 'mill_thrall_1');
            this.enemyManager.spawnEnemy('bellbound', new THREE.Vector3(5, 1.5, 155), 'mill_priestess');
            this.enemyManager.spawnEnemy('butcher', new THREE.Vector3(0, 1.5, 164), 'mill_butcher_guard');
            // Named Boss: The Butcher of Vargdal in circular arena (only if not defeated)
            if (!this.stats.completedBosses.millButcherBoss) {
                this.enemyManager.spawnEnemy('butcher_boss', new THREE.Vector3(0, 1.5, 180), 'mill_boss');
            }
        }

        if (playerPos.z >= 200 && !this.spawnedZone3Enemies) {
            this.spawnedZone3Enemies = true;
            // Below the Bell subterranean encounters
            this.enemyManager.spawnEnemy('bellbound', new THREE.Vector3(-6, 1.5, 230), 'crypt_priestess_1');
            this.enemyManager.spawnEnemy('bellbound', new THREE.Vector3(6, 1.5, 230), 'crypt_priestess_2');
            this.enemyManager.spawnEnemy('warden', new THREE.Vector3(0, 1.5, 238), 'crypt_warden');
            // Final Boss: The Bell Mother (only if not defeated)
            if (!this.stats.completedBosses.bellMotherBoss) {
                this.enemyManager.spawnEnemy('bell_mother', new THREE.Vector3(0, 1.5, 258), 'final_bell_mother');
            }
        }

        // Checkpoint proximity discovery (tracking only, NO activeCheckpointId auto-assignment!)
        for (const cp of this.checkpoints) {
            if (!cp.discovered && playerPos.distanceTo(cp.position) <= 6.0) {
                cp.discovered = true;
            }
        }
    }

    public getClosestInteractable(playerPos: THREE.Vector3, maxDist: number = 3.5): InteractiveItem | null {
        let bestDist = maxDist;
        let bestItem: InteractiveItem | null = null;
        for (const item of this.interactables) {
            if (item.isConsumed) continue;
            // Elin altar is only interactable after Bell Mother is slain
            if (item.type === 'elin_altar' && !this.stats.completedBosses.bellMotherBoss) continue;
            const itemWorldPos = new THREE.Vector3(item.position.x, item.position.y + 1.0, item.position.z);
            const dist = playerPos.distanceTo(itemWorldPos);
            if (dist < bestDist) {
                bestDist = dist;
                bestItem = item;
            }
        }
        return bestItem;
    }

    // =========================================================================
    // LEVEL GEOMETRY & LANDMARKS BUILD
    // =========================================================================

    private buildAllZones(): void {
        const matBasalt = new THREE.MeshStandardMaterial({ color: 0x1A1C1E, roughness: 0.9 });
        const matSnowyWood = new THREE.MeshStandardMaterial({ color: 0x2E2A27, roughness: 0.85 });
        const matRibbon = new THREE.MeshStandardMaterial({ color: 0x8C1818, roughness: 0.7 });
        const matBronze = new THREE.MeshStandardMaterial({ color: 0x6E583C, metalness: 0.8, roughness: 0.4 });
        const matIce = new THREE.MeshStandardMaterial({ color: 0x89B5C9, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.85 });
        const matIron = new THREE.MeshStandardMaterial({ color: 0x3E4246, metalness: 0.8, roughness: 0.4 });

        // ---------------------------------------------------------------------
        // ZONE 0: THE LAST RING (Tutorial Clearing)
        // ---------------------------------------------------------------------
        // Stone Altar with Liv's Sword
        const altar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.2), matBasalt);
        altar.position.set(0, 0.45, 16);
        this.worldGroup.add(altar);
        this.createStaticBoxCollider(altar.position, new THREE.Vector3(0.8, 0.45, 0.6));

        // Sword prop resting on altar
        const swordProp = new THREE.Group();
        swordProp.position.set(0, 0.95, 16);
        swordProp.rotation.y = Math.PI / 4;
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.7), new THREE.MeshStandardMaterial({ color: 0xABB2B8, metalness: 0.9 }));
        swordProp.add(blade);
        this.worldGroup.add(swordProp);

        this.interactables.push({
            id: 'altar_sword',
            type: 'sword_pickup',
            position: new THREE.Vector3(0, 0.9, 16),
            promptText: 'Draw Seax Sword',
            isConsumed: false,
            mesh: swordProp,
            onInteract: () => {
                this.stats.swordAcquired = true;
                swordProp.visible = false;
                audio.playParryClang();
            }
        });

        // First Iron Prayer Post Checkpoint
        this.buildPrayerPost(this.checkpoints[0]!.position, 'checkpoint_prologue');

        // Atmospheric Terrain Dressing: Snow drifts, basalt crags, and torch braziers along mountain pass
        for (let z = 0; z < 42; z += 6) {
            this.buildSnowDrift(-5.8, z, 2.6, 3.8);
            this.buildSnowDrift(5.8, z + 3, 2.6, 3.8);
        }
        this.buildBasaltCrag(-4.8, 6, 1.2);
        this.buildBasaltCrag(4.8, 11, 1.4);
        this.buildBasaltCrag(-4.5, 20, 1.3);
        this.buildBasaltCrag(4.6, 28, 1.5);

        this.buildIronTorchBrazier(-3.4, 5);
        this.buildIronTorchBrazier(3.4, 13);
        this.buildIronTorchBrazier(-3.4, 23);
        this.buildIronTorchBrazier(3.4, 33);

        // Boundary pine tree corridors & red ribbons
        for (let z = 0; z < 35; z += 6) {
            this.buildSnowyPine(-9 - Math.random() * 2, z, matSnowyWood, matRibbon);
            this.buildSnowyPine(9 + Math.random() * 2, z, matSnowyWood, matRibbon);
        }

        // Burning Bell Tower landmark silhouette in far backdrop
        const towerGroup = new THREE.Group();
        towerGroup.position.set(0, 0, 48);
        const towerBody = new THREE.Mesh(new THREE.BoxGeometry(8, 28, 8), matBasalt);
        towerBody.position.set(0, 14, 0);
        towerGroup.add(towerBody);
        const spire = new THREE.Mesh(new THREE.ConeGeometry(5.5, 12, 4), matBasalt);
        spire.position.set(0, 34, 0);
        towerGroup.add(spire);
        // Orange flickering fire light in the belfry
        const belfryLight = new THREE.PointLight(0xFF6600, 4.0, 35);
        belfryLight.position.set(0, 24, 0);
        towerGroup.add(belfryLight);
        this.worldGroup.add(towerGroup);

        // ---------------------------------------------------------------------
        // ZONE 1: HUSHWOOD APPROACH (Chapel & Pine Forest)
        // ---------------------------------------------------------------------
        this.buildPrayerPost(this.checkpoints[1]!.position, 'checkpoint_hushwood');

        // Ruined Stave Chapel at Z=104
        const chapel = new THREE.Group();
        chapel.position.set(0, 0, 104);
        const chapelWall = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 18), matSnowyWood);
        chapelWall.position.set(0, 4, 0);
        chapel.add(chapelWall);
        const chapelRoof = new THREE.Mesh(new THREE.ConeGeometry(10, 8, 4), matSnowyWood);
        chapelRoof.position.set(0, 12, 0);
        chapelRoof.rotation.y = Math.PI / 4;
        chapel.add(chapelRoof);
        const chapelArch = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 2), matBasalt);
        chapelArch.position.set(0, 2.5, -9.1);
        chapel.add(chapelArch);
        this.worldGroup.add(chapel);
        this.createStaticBoxCollider(new THREE.Vector3(0, 4, 104), new THREE.Vector3(7, 4, 9));

        // Hidden Nail Cache near chapel
        const nailChest = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.6), matIron);
        nailChest.position.set(-8.5, 0.3, 100);
        this.worldGroup.add(nailChest);
        this.interactables.push({
            id: 'cache_hushwood',
            type: 'nail_cache',
            position: new THREE.Vector3(-8.5, 0.5, 100),
            promptText: 'Pry Open Nail Cache (+4 Iron Nails)',
            isConsumed: false,
            mesh: nailChest,
            onInteract: () => {
                this.stats.ironNails += 4;
                nailChest.scale.set(0.8, 0.3, 0.8);
                audio.playArmorImpact();
            }
        });

        // Hushwood Gate shortcut
        const hwGate = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 0.6), matIron);
        hwGate.position.set(0, 3, 114);
        this.worldGroup.add(hwGate);
        this.hushwoodGateMesh = hwGate;
        this.hushwoodGateBody = this.createStaticBoxCollider(hwGate.position, new THREE.Vector3(3, 3, 0.3));

        // ---------------------------------------------------------------------
        // ZONE 2: THE RED MILL (Sawmill & Frozen River)
        // ---------------------------------------------------------------------
        this.buildPrayerPost(this.checkpoints[2]!.position, 'checkpoint_redmill');

        // Frozen River ice plane
        const riverIce = new THREE.Mesh(new THREE.PlaneGeometry(16, 50), matIce);
        riverIce.rotation.x = -Math.PI / 2;
        riverIce.position.set(10, 0.05, 155);
        this.worldGroup.add(riverIce);

        // Huge rotating timber waterwheel at Z=150, X=11
        const wheelGroup = new THREE.Group();
        wheelGroup.position.set(11, 4.5, 150);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(4.0, 0.3, 8, 20), matSnowyWood);
        rim.rotation.y = Math.PI / 2;
        wheelGroup.add(rim);
        // Spokes and paddles
        for (let p = 0; p < 8; p++) {
            const angle = (p / 8) * Math.PI * 2;
            const paddle = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3.8, 1.8), matSnowyWood);
            paddle.position.set(0, Math.sin(angle) * 2.0, Math.cos(angle) * 2.0);
            paddle.rotation.x = angle;
            wheelGroup.add(paddle);
        }
        this.worldGroup.add(wheelGroup);
        this.waterWheelMesh = wheelGroup;

        // Mill timber buildings
        const millBuilding = new THREE.Mesh(new THREE.BoxGeometry(12, 10, 16), matSnowyWood);
        millBuilding.position.set(-10, 5, 155);
        this.worldGroup.add(millBuilding);
        this.createStaticBoxCollider(millBuilding.position, new THREE.Vector3(6, 5, 8));

        // Timing Hazard: Pendulum timber blade hanging in the mill gateway
        const bladeArm = new THREE.Group();
        bladeArm.position.set(0, 6.0, 160);
        const armBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4.5, 6), matSnowyWood);
        armBeam.position.set(0, -2.2, 0);
        bladeArm.add(armBeam);
        const pendBlade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.7), matIron);
        pendBlade.position.set(0, -4.2, 0);
        bladeArm.add(pendBlade);
        this.worldGroup.add(bladeArm);
        this.timingHazardBlade = bladeArm;

        // Mill Butcher Circular Arena at Z=180
        const arenaRing = new THREE.Mesh(new THREE.TorusGeometry(12, 0.5, 8, 32), matBasalt);
        arenaRing.rotation.x = Math.PI / 2;
        arenaRing.position.set(0, 0.25, 180);
        this.worldGroup.add(arenaRing);

        // Hanging chains and red lanterns
        for (let l = 0; l < 4; l++) {
            const angle = (l / 4) * Math.PI * 2;
            const lanternPost = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 4.5, 6), matBasalt);
            lanternPost.position.set(Math.cos(angle) * 11, 2.25, 180 + Math.sin(angle) * 11);
            this.worldGroup.add(lanternPost);
            const redLight = new THREE.PointLight(0xB81D1D, 2.5, 12);
            redLight.position.set(lanternPost.position.x, 4.0, lanternPost.position.z);
            this.worldGroup.add(redLight);
        }

        // Mill gate to crypts
        const millGate = new THREE.Mesh(new THREE.BoxGeometry(6, 7, 0.8), matIron);
        millGate.position.set(0, 3.5, 195);
        this.worldGroup.add(millGate);
        this.millGateMesh = millGate;
        this.millGateBody = this.createStaticBoxCollider(millGate.position, new THREE.Vector3(3, 3.5, 0.4));

        // ---------------------------------------------------------------------
        // ZONE 3: BELOW THE BELL (Subterranean Crypt & Bell Sanctuary)
        // ---------------------------------------------------------------------
        this.buildPrayerPost(this.checkpoints[3]!.position, 'checkpoint_belowthebell');

        // Vaulted stone corridor pillars
        for (let cp = 205; cp < 245; cp += 10) {
            const pLeft = new THREE.Mesh(new THREE.BoxGeometry(1.4, 7, 1.4), matBasalt);
            pLeft.position.set(-6, 3.5, cp);
            this.worldGroup.add(pLeft);
            this.createStaticBoxCollider(pLeft.position, new THREE.Vector3(0.7, 3.5, 0.7));

            const pRight = new THREE.Mesh(new THREE.BoxGeometry(1.4, 7, 1.4), matBasalt);
            pRight.position.set(6, 3.5, cp);
            this.worldGroup.add(pRight);
            this.createStaticBoxCollider(pRight.position, new THREE.Vector3(0.7, 3.5, 0.7));
        }

        // COLOSSAL CRACKED BRONZE BELL at Z=258, Y=9
        const bellGroup = new THREE.Group();
        bellGroup.position.set(0, 9.0, 258);
        const bellMesh = new THREE.Mesh(new THREE.ConeGeometry(5.2, 7.5, 16), matBronze);
        bellMesh.rotation.x = Math.PI; // Opening faces downward toward arena
        bellGroup.add(bellMesh);

        // Cracked fissure glow inside bell
        const crackLight = new THREE.PointLight(0xB82424, 3.5, 18);
        crackLight.position.set(0, -1.0, 0);
        bellGroup.add(crackLight);

        // Hanging iron chains from ceiling
        const chainL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 8, 6), matIron);
        chainL.position.set(-2.5, 5, 0);
        bellGroup.add(chainL);
        const chainR = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 8, 6), matIron);
        chainR.position.set(2.5, 5, 0);
        bellGroup.add(chainR);

        this.worldGroup.add(bellGroup);
        this.colossalBellMesh = bellGroup;

        // Circular Bell Mother Pit Arena
        const pitBorder = new THREE.Mesh(new THREE.TorusGeometry(14, 0.6, 8, 36), matBasalt);
        pitBorder.rotation.x = Math.PI / 2;
        pitBorder.position.set(0, 0.3, 258);
        this.worldGroup.add(pitBorder);

        // Root Barrier separating Bell Mother arena from Elin's altar (Z=263)
        const barrierGroup = new THREE.Group();
        barrierGroup.position.set(0, 2.5, 263);
        const matRootBarrier = new THREE.MeshStandardMaterial({ color: 0x2A1C16, roughness: 0.95 });
        for (let r = -6; r <= 6; r += 1.5) {
            const rootPillar = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 6, 6), matRootBarrier);
            rootPillar.position.set(r, 0, (Math.abs(r) % 3 === 0 ? 0.3 : -0.3));
            rootPillar.rotation.z = (r * 0.04);
            barrierGroup.add(rootPillar);
        }
        this.worldGroup.add(barrierGroup);
        this.elinBarrierMesh = barrierGroup;
        this.elinBarrierBody = this.createStaticBoxCollider(new THREE.Vector3(0, 2.5, 263), new THREE.Vector3(7, 3, 0.5));

        // ELIN'S ALTAR: Sister bound to root-woven pedestal beneath bell
        const elinGroup = new THREE.Group();
        elinGroup.position.set(0, 0.6, 268);
        const elinPedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 0.8, 8), matBasalt);
        elinGroup.add(elinPedestal);

        // Elin human model (fair hair, white gown intertwined with wooden roots)
        const elinBody = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.2, 0.25), new THREE.MeshStandardMaterial({ color: 0xD6C4B2 }));
        elinBody.position.set(0, 1.0, 0);
        elinGroup.add(elinBody);
        const elinHead = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.22), new THREE.MeshStandardMaterial({ color: 0xE8C5AF }));
        elinHead.position.set(0, 1.7, 0);
        elinGroup.add(elinHead);

        this.worldGroup.add(elinGroup);
        this.elinMesh = elinGroup;

        this.interactables.push({
            id: 'altar_elin',
            type: 'elin_altar',
            position: new THREE.Vector3(0, 1.0, 268),
            promptText: 'Approach Elin (Make Fateful Choice)',
            isConsumed: false,
            mesh: elinGroup,
            onInteract: () => {
                // Handled by UI Manager
            }
        });
    }

    private buildPrayerPost(pos: THREE.Vector3, id: string): void {
        const postWorldPos = new THREE.Vector3(pos.x + 2.4, 0, pos.z);
        const postGroup = new THREE.Group();
        postGroup.position.copy(postWorldPos);

        const matStone = new THREE.MeshStandardMaterial({ color: 0x1C1E20, roughness: 0.95 });
        const matTimber = new THREE.MeshStandardMaterial({ color: 0x2A201A, roughness: 0.85 });
        const matIron = new THREE.MeshStandardMaterial({ color: 0x484D52, metalness: 0.8, roughness: 0.35 });
        const matRibbon = new THREE.MeshStandardMaterial({ color: 0x9C1C1C, roughness: 0.7 });
        const matEmberCore = new THREE.MeshStandardMaterial({ color: 0xFF5500, emissive: 0xFF3300, emissiveIntensity: 2.2, roughness: 0.3 });

        // Octagonal carved stone base
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 0.35, 8), matStone);
        base.position.set(0, 0.17, 0);
        postGroup.add(base);

        // Weathered timber shrine upright
        const upright = new THREE.Mesh(new THREE.BoxGeometry(0.20, 2.2, 0.20), matTimber);
        upright.position.set(0, 1.25, 0);
        postGroup.add(upright);

        // Iron reinforcement bands
        for (let b = 0; b < 3; b++) {
            const band = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.22), matIron);
            band.position.set(0, 0.6 + b * 0.7, 0);
            postGroup.add(band);
        }

        // Timber crossbeam with carved ends
        const crossbeam = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.15, 0.18), matTimber);
        crossbeam.position.set(0, 2.1, 0);
        postGroup.add(crossbeam);

        // Red ritual ribbons hanging from crossbeam ends
        const ribbonL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.1, 0.04), matRibbon);
        ribbonL.position.set(-0.36, 1.45, 0);
        ribbonL.rotation.z = 0.08;
        postGroup.add(ribbonL);

        const ribbonR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.95, 0.04), matRibbon);
        ribbonR.position.set(0.36, 1.55, 0);
        ribbonR.rotation.z = -0.06;
        postGroup.add(ribbonR);

        // Ornate wrought-iron cage lantern hanging from iron bracket
        const cageFrame = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.34, 0.24), matIron);
        cageFrame.position.set(0, 1.75, 0.25);
        postGroup.add(cageFrame);

        // Burning ember core inside the iron cage
        const emberCore = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.22, 0.14), matEmberCore);
        emberCore.position.set(0, 1.75, 0.25);
        postGroup.add(emberCore);

        // Iron prayer ward plaque on front of upright
        const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.32, 0.04), matIron);
        plaque.position.set(0, 1.2, 0.11);
        postGroup.add(plaque);

        const holyLight = new THREE.PointLight(0xFFA533, 2.0, 8);
        holyLight.position.set(0, 1.75, 0.3);
        postGroup.add(holyLight);

        this.worldGroup.add(postGroup);
        this.createStaticBoxCollider(postWorldPos, new THREE.Vector3(0.5, 1.2, 0.5));

        this.interactables.push({
            id: id,
            type: 'prayer_post',
            position: postWorldPos.clone().add(new THREE.Vector3(0, 0.8, 0)),
            promptText: 'Rest at Iron Prayer Post',
            isConsumed: false,
            mesh: postGroup,
            onInteract: () => {
                // Heals, refills flask, saves game
                this.stats.currentHealth = this.stats.upgrades.wovenCharm ? this.stats.baseMaxHealth * 1.2 : this.stats.baseMaxHealth;
                this.stats.healCharges = this.stats.healMaxCharges;
                this.stats.wardCharges = this.stats.wardMaxCharges;
                this.stats.activeCheckpointId = id;
                audio.playPrayerPostRest();
                this.resetEncounterForCheckpoint(id, this.stats.completedBosses);
            }
        });
    }

    public buildSnowDrift(x: number, z: number, scaleX: number, scaleZ: number): void {
        const driftMat = new THREE.MeshStandardMaterial({ color: 0xDAE5EE, roughness: 0.9 });
        const drift = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 5), driftMat);
        drift.scale.set(scaleX, 0.35, scaleZ);
        drift.position.set(x, 0.12, z);
        this.worldGroup.add(drift);
    }

    public buildBasaltCrag(x: number, z: number, scale: number): void {
        const rockMat = new THREE.MeshStandardMaterial({ color: 0x1C1E20, roughness: 0.95 });
        const snowMat = new THREE.MeshStandardMaterial({ color: 0xDAE5EE, roughness: 0.9 });
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(scale, 0), rockMat);
        rock.position.set(x, scale * 0.4, z);
        rock.rotation.set(0.3, 0.8, -0.2);
        this.worldGroup.add(rock);

        const snowCap = new THREE.Mesh(new THREE.ConeGeometry(scale * 0.8, scale * 0.3, 5), snowMat);
        snowCap.position.set(x, scale * 0.75, z);
        this.worldGroup.add(snowCap);
    }

    public buildIronTorchBrazier(x: number, z: number): void {
        const matIron = new THREE.MeshStandardMaterial({ color: 0x3E4246, metalness: 0.85, roughness: 0.3 });
        const matFire = new THREE.MeshStandardMaterial({ color: 0xFF5500, emissive: 0xFF3300, emissiveIntensity: 2.5 });

        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.4, 6), matIron);
        stand.position.set(x, 0.7, z);
        this.worldGroup.add(stand);

        const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.14, 0.18, 6), matIron);
        bowl.position.set(x, 1.45, z);
        this.worldGroup.add(bowl);

        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 5), matFire);
        flame.position.set(x, 1.62, z);
        this.worldGroup.add(flame);

        const fireLight = new THREE.PointLight(0xFF6600, 2.5, 9);
        fireLight.position.set(x, 1.7, z);
        this.worldGroup.add(fireLight);
    }

    private buildSnowyPine(x: number, z: number, trunkMat: THREE.Material, ribbonMat: THREE.Material): void {
        const pine = new THREE.Group();
        pine.position.set(x, 0, z);

        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 6.0, 6), trunkMat);
        trunk.position.set(0, 3.0, 0);
        pine.add(trunk);

        // Tiered snowy pine needle cones
        const snowNeedleMat = new THREE.MeshStandardMaterial({ color: 0x22352B, roughness: 0.8 });
        for (let t = 0; t < 3; t++) {
            const cone = new THREE.Mesh(new THREE.ConeGeometry(2.4 - t * 0.6, 3.2, 7), snowNeedleMat);
            cone.position.set(0, 3.5 + t * 2.0, 0);
            pine.add(cone);
        }

        // Red ritual ribbon flutter
        if (Math.random() < 0.6) {
            const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.08), ribbonMat);
            ribbon.position.set(0.35, 2.8, 0);
            ribbon.rotation.z = 0.2;
            pine.add(ribbon);
        }

        this.worldGroup.add(pine);
        this.createStaticBoxCollider(new THREE.Vector3(x, 2, z), new THREE.Vector3(0.5, 2.5, 0.5));
    }

    private createStaticBoxCollider(pos: THREE.Vector3, halfExtents: THREE.Vector3): any {
        try {
            return PhysicsBodyFactory.createStaticBody(
                this.physicsWorld,
                new THREE.Vector3(pos.x, pos.y + 1.0, pos.z),
                { shape: { type: 'box', halfExtents: halfExtents } }
            );
        } catch (e) {
            return null;
        }
    }

    public openHushwoodGate(): void {
        if (this.hushwoodGateMesh) {
            this.hushwoodGateMesh.position.y = 9.0; // Raise gate
            audio.playArmorImpact();
        }
        if (this.hushwoodGateBody?.rigidBody) {
            try {
                this.hushwoodGateBody.rigidBody.setTranslation({ x: 0, y: 100, z: 114 }, true);
            } catch (_) {}
        }
        this.stats.unlockedShortcuts.hushwoodGate = true;
    }

    public openMillGate(): void {
        if (this.millGateMesh) {
            this.millGateMesh.position.y = 9.5;
            audio.playArmorImpact();
        }
        if (this.millGateBody?.rigidBody) {
            try {
                this.millGateBody.rigidBody.setTranslation({ x: 0, y: 100, z: 195 }, true);
            } catch (_) {}
        }
        this.stats.unlockedShortcuts.millGate = true;
    }

    public openElinBarrier(): void {
        if (this.elinBarrierMesh) {
            this.elinBarrierMesh.position.y = -6.0; // Sink roots into earth
            audio.playBellToll('distant');
        }
        if (this.elinBarrierBody?.rigidBody) {
            try {
                this.elinBarrierBody.rigidBody.setTranslation({ x: 0, y: -100, z: 263 }, true);
            } catch (_) {}
        }
    }

    public resetEncounterForCheckpoint(checkpointId: string, completedBosses: Record<string, boolean>): void {
        this.enemyManager.clearAll();

        // Reset spawn triggers based on which checkpoint was restarted at
        if (checkpointId === 'checkpoint_prologue') {
            this.spawnedZone0Enemies = false;
            this.spawnedZone1Enemies = false;
            this.spawnedZone2Enemies = false;
            this.spawnedZone3Enemies = false;
        } else if (checkpointId === 'checkpoint_hushwood') {
            this.spawnedZone0Enemies = true;
            this.spawnedZone1Enemies = false;
            this.spawnedZone2Enemies = false;
            this.spawnedZone3Enemies = false;
        } else if (checkpointId === 'checkpoint_redmill') {
            this.spawnedZone0Enemies = true;
            this.spawnedZone1Enemies = true;
            this.spawnedZone2Enemies = false;
            this.spawnedZone3Enemies = false;
        } else if (checkpointId === 'checkpoint_belowthebell') {
            this.spawnedZone0Enemies = true;
            this.spawnedZone1Enemies = true;
            this.spawnedZone2Enemies = true;
            this.spawnedZone3Enemies = false;
        }
    }

    public resetAll(): void {
        this.spawnedZone0Enemies = false;
        this.spawnedZone1Enemies = false;
        this.spawnedZone2Enemies = false;
        this.spawnedZone3Enemies = false;

        for (const cp of this.checkpoints) {
            cp.discovered = cp.id === 'checkpoint_prologue';
        }

        for (const item of this.interactables) {
            item.isConsumed = false;
            if (item.mesh) {
                item.mesh.visible = true;
                item.mesh.scale.set(1, 1, 1);
            }
        }

        if (this.hushwoodGateMesh) this.hushwoodGateMesh.position.set(0, 3, 114);
        if (this.hushwoodGateBody?.rigidBody) {
            try { this.hushwoodGateBody.rigidBody.setTranslation({ x: 0, y: 3, z: 114 }, true); } catch (_) {}
        }

        if (this.millGateMesh) this.millGateMesh.position.set(0, 3.5, 195);
        if (this.millGateBody?.rigidBody) {
            try { this.millGateBody.rigidBody.setTranslation({ x: 0, y: 3.5, z: 195 }, true); } catch (_) {}
        }

        if (this.elinBarrierMesh) this.elinBarrierMesh.position.set(0, 2.5, 263);
        if (this.elinBarrierBody?.rigidBody) {
            try { this.elinBarrierBody.rigidBody.setTranslation({ x: 0, y: 2.5, z: 263 }, true); } catch (_) {}
        }
    }

    public restoreFromSave(save: SaveDataV2): void {
        for (const cp of this.checkpoints) {
            cp.discovered = save.discoveredCheckpointIds.includes(cp.id) || cp.id === save.activeCheckpointId;
        }

        for (const item of this.interactables) {
            if (save.consumedInteractableIds.includes(item.id)) {
                item.isConsumed = true;
                if (item.type === 'nail_cache' && item.mesh) {
                    item.mesh.scale.set(0.8, 0.3, 0.8);
                } else if (item.type === 'sword_pickup' && item.mesh) {
                    item.mesh.visible = false;
                }
            }
        }

        if (save.unlockedShortcuts.hushwoodGate) {
            this.openHushwoodGate();
        }
        if (save.unlockedShortcuts.millGate) {
            this.openMillGate();
        }
        if (save.completedBosses.bellMotherBoss) {
            this.openElinBarrier();
        }

        this.resetEncounterForCheckpoint(save.activeCheckpointId, save.completedBosses);
    }

    public getDiscoveredCheckpointIds(): string[] {
        return this.checkpoints.filter(c => c.discovered).map(c => c.id);
    }

    public getConsumedInteractableIds(): string[] {
        return this.interactables.filter(i => i.isConsumed).map(i => i.id);
    }

    public getCurrentZoneIndex(playerZ: number): number {
        if (playerZ < 50) return 0;
        if (playerZ < 130) return 1;
        if (playerZ < 210) return 2;
        return 3;
    }
}
