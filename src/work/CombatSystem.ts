import * as THREE from 'three';
import { audio } from './AudioSystem.js';
import { COMBAT_CONFIG, type PlayerStats } from './Constants.js';
import { type EnemyManager, type EnemyInstance, Projectile } from './Enemies.js';

export type GoreLevel = 'off' | 'reduced' | 'full';

export interface CombatOptions {
    goreLevel: GoreLevel;
    cameraShake: number; // 0.0 to 1.0
}

export class PlayerCombatSystem {
    private scene: THREE.Scene;
    private playerMesh: THREE.Object3D;
    private camera: THREE.Camera;
    private enemyManager: EnemyManager;
    public stats: PlayerStats;
    public options: CombatOptions = { goreLevel: 'full', cameraShake: 1.0 };

    // Action state
    public actionState: 'idle' | 'light_1' | 'light_2' | 'light_3' | 'heavy_charge' | 'heavy_release' | 'sprint_attack' | 'dodge_attack' | 'dodge' | 'parry' | 'riposte' | 'execution' | 'hurt' | 'dead' = 'idle';
    public stateTimer: number = 0;
    public queuedAction: 'light' | 'heavy' | 'dodge' | 'parry' | 'ward' | 'heal' | 'exec' | null = null;
    public isInvulnerable: boolean = false;
    public isParrying: boolean = false;
    public riposteTarget: EnemyInstance | null = null;
    public heavyChargeTime: number = 0;
    public isChargingHeavy: boolean = false;

    // Target lock
    public targetEnemy: EnemyInstance | null = null;
    public isLockOnActive: boolean = false;

    // Movement lock & impulse
    public rootMotionVelocity: THREE.Vector3 = new THREE.Vector3();
    public isControlLocked: boolean = false;

    // Blood / ash particle pool
    private particles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number }[] = [];

    // Surface blood / ash ground decals
    private decals: { mesh: THREE.Mesh; life: number; maxLife: number }[] = [];
    private maxDecals: number = 40;

    // Weapon & Arm mesh ref (for trail, blood staining, & procedural attack animation)
    private swordMesh: THREE.Object3D | null = null;
    private swordStainTimer: number = 0;
    private rightArmMesh: THREE.Object3D | null = null;
    private rightForearmMesh: THREE.Object3D | null = null;

    constructor(
        scene: THREE.Scene,
        playerMesh: THREE.Object3D,
        camera: THREE.Camera,
        enemyManager: EnemyManager,
        stats: PlayerStats
    ) {
        this.scene = scene;
        this.playerMesh = playerMesh;
        this.camera = camera;
        this.enemyManager = enemyManager;
        this.stats = stats;

        this.swordMesh = playerMesh.getObjectByName('liv_seax_sword') || null;
        this.rightArmMesh = playerMesh.getObjectByName('rightUpperArm') || null;
        this.rightForearmMesh = playerMesh.getObjectByName('rightForearm') || null;
    }

    public setSwordMesh(mesh: THREE.Object3D): void {
        this.swordMesh = mesh;
    }

    public update(dt: number, isSprinting: boolean, isMoving: boolean): void {
        this.stateTimer += dt;

        // Ward recharge
        if (this.stats.wardCharges < this.stats.wardMaxCharges) {
            const cooldown = this.stats.upgrades.quickenedWard ? COMBAT_CONFIG.ward.baseCooldown * 0.8 : COMBAT_CONFIG.ward.baseCooldown;
            this.stats.wardRechargeTimer += dt;
            if (this.stats.wardRechargeTimer >= cooldown) {
                this.stats.wardRechargeTimer = 0;
                this.stats.wardCharges++;
                audio.playWardRecharged();
            }
        }

        // Heavy attack charge update
        if (this.isChargingHeavy) {
            this.heavyChargeTime += dt;
            if (this.heavyChargeTime >= COMBAT_CONFIG.heavyAttack.maxChargeTime) {
                this.releaseHeavyAttack();
            }
        }

        // Decay root motion impulse
        this.rootMotionVelocity.multiplyScalar(Math.max(0, 1 - dt * 10.0));

        // State Machine Execution
        this.tickStateMachine(dt, isSprinting, isMoving);

        // Update blood/ash particles
        this.updateParticles(dt);

        // Update surface ground decals
        this.updateDecals(dt);

        // Fade sword blood staining back to metallic steel
        if (this.swordStainTimer > 0) {
            this.swordStainTimer -= dt;
            if (this.swordStainTimer <= 0 && this.swordMesh) {
                this.swordMesh.traverse((child) => {
                    if ((child as THREE.Mesh).isMesh) {
                        const m = child as THREE.Mesh;
                        if (m.material && (m.material as any).color) {
                            (m.material as THREE.MeshStandardMaterial).color.setHex(0xABB2B8);
                        }
                    }
                });
            }
        }

        // Target Lock Maintenance
        if (this.isLockOnActive) {
            if (!this.targetEnemy || this.targetEnemy.state === 'dead' || this.targetEnemy.position.distanceTo(this.playerMesh.position) > 28) {
                this.findNextLockTarget();
            }
        }

        // Procedural Sword Swing & Attack Animation
        this.updateProceduralAnimation(dt);
    }

    private updateProceduralAnimation(dt: number): void {
        if (!this.rightArmMesh) {
            this.rightArmMesh = this.playerMesh.getObjectByName('rightUpperArm') || null;
            this.rightForearmMesh = this.playerMesh.getObjectByName('rightForearm') || null;
        }
        if (!this.rightArmMesh) return;

        switch (this.actionState) {
            case 'light_1': {
                // Slash 1: Diagonal sweeping slash across from right to left
                const p = Math.min(1, this.stateTimer / COMBAT_CONFIG.lightAttack1.duration);
                this.rightArmMesh.rotation.x = -0.3 + Math.sin(p * Math.PI) * 1.3;
                this.rightArmMesh.rotation.y = -0.6 + p * 1.5;
                this.rightArmMesh.rotation.z = -0.2 - Math.sin(p * Math.PI) * 0.7;
                break;
            }

            case 'light_2': {
                // Slash 2: Backhand slash sweeping back from left to right
                const p = Math.min(1, this.stateTimer / COMBAT_CONFIG.lightAttack2.duration);
                this.rightArmMesh.rotation.x = -0.2 + Math.sin(p * Math.PI) * 1.1;
                this.rightArmMesh.rotation.y = 0.9 - p * 1.7;
                this.rightArmMesh.rotation.z = 0.3 + Math.sin(p * Math.PI) * 0.6;
                break;
            }

            case 'light_3': {
                // Slash 3: Overhead vertical power cleave downward
                const p = Math.min(1, this.stateTimer / COMBAT_CONFIG.lightAttack3.duration);
                if (p < 0.28) {
                    this.rightArmMesh.rotation.x = -0.5 - (p / 0.28) * 1.8;
                    this.rightArmMesh.rotation.y = 0.1;
                    this.rightArmMesh.rotation.z = 0.1;
                } else {
                    const strikeP = (p - 0.28) / 0.72;
                    this.rightArmMesh.rotation.x = -2.3 + strikeP * 2.8;
                    this.rightArmMesh.rotation.y = 0.1;
                    this.rightArmMesh.rotation.z = 0.1;
                }
                break;
            }

            case 'heavy_charge': {
                // High guard ready stance while charging heavy
                this.rightArmMesh.rotation.x = -1.5;
                this.rightArmMesh.rotation.y = -0.5;
                this.rightArmMesh.rotation.z = -0.3;
                break;
            }

            case 'heavy_release': {
                // Forward lunging thrust with blade tip
                const p = Math.min(1, this.stateTimer / COMBAT_CONFIG.heavyAttack.duration);
                this.rightArmMesh.rotation.x = -1.2 + Math.sin(p * Math.PI) * 1.2;
                this.rightArmMesh.rotation.y = 0.2;
                this.rightArmMesh.rotation.z = 0.1;
                break;
            }

            case 'sprint_attack': {
                // Wide horizontal running slash
                const p = Math.min(1, this.stateTimer / COMBAT_CONFIG.sprintAttack.duration);
                this.rightArmMesh.rotation.x = -0.4 + Math.sin(p * Math.PI) * 1.2;
                this.rightArmMesh.rotation.y = -0.9 + p * 1.8;
                this.rightArmMesh.rotation.z = -0.3;
                break;
            }

            case 'dodge_attack': {
                // Rising slash from roll
                const p = Math.min(1, this.stateTimer / COMBAT_CONFIG.dodgeAttack.duration);
                this.rightArmMesh.rotation.x = -1.2 + Math.sin(p * Math.PI) * 1.5;
                this.rightArmMesh.rotation.y = 0.4;
                this.rightArmMesh.rotation.z = -0.4 + p * 0.8;
                break;
            }

            case 'parry': {
                // Iron ward deflection stance across chest
                this.rightArmMesh.rotation.x = -1.2;
                this.rightArmMesh.rotation.y = 0.7;
                this.rightArmMesh.rotation.z = 0.5;
                break;
            }

            case 'idle':
            default: {
                // Smoothly decay back to standard resting posture
                this.rightArmMesh.rotation.x = THREE.MathUtils.lerp(this.rightArmMesh.rotation.x, 0, dt * 8.0);
                this.rightArmMesh.rotation.y = THREE.MathUtils.lerp(this.rightArmMesh.rotation.y, 0, dt * 8.0);
                this.rightArmMesh.rotation.z = THREE.MathUtils.lerp(this.rightArmMesh.rotation.z, 0, dt * 8.0);
                break;
            }
        }
    }

    private tickStateMachine(dt: number, isSprinting: boolean, isMoving: boolean): void {
        switch (this.actionState) {
            case 'idle':
                this.isControlLocked = false;
                this.isInvulnerable = false;
                this.isParrying = false;
                this.processQueuedAction(isSprinting, isMoving);
                break;

            case 'light_1': {
                const cfg = COMBAT_CONFIG.lightAttack1;
                // Hit check
                if (this.stateTimer >= cfg.hitWindow[0]! && this.stateTimer <= cfg.hitWindow[1]! && !this.hasHitThisAction) {
                    this.executeMeleeHit(cfg.damage, cfg.range, cfg.rendGain, 1);
                }

                // Late cancel window allows dodge or queued light 2
                if (this.stateTimer >= cfg.duration * 0.7 && this.queuedAction) {
                    this.transitionToNextCombo();
                } else if (this.stateTimer >= cfg.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                }
                break;
            }

            case 'light_2': {
                const cfg = COMBAT_CONFIG.lightAttack2;
                if (this.stateTimer >= cfg.hitWindow[0]! && this.stateTimer <= cfg.hitWindow[1]! && !this.hasHitThisAction) {
                    this.executeMeleeHit(cfg.damage, cfg.range, cfg.rendGain, 2);
                }

                if (this.stateTimer >= cfg.duration * 0.7 && this.queuedAction) {
                    this.transitionToNextCombo();
                } else if (this.stateTimer >= cfg.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                }
                break;
            }

            case 'light_3': {
                const cfg = COMBAT_CONFIG.lightAttack3;
                if (this.stateTimer >= cfg.hitWindow[0]! && this.stateTimer <= cfg.hitWindow[1]! && !this.hasHitThisAction) {
                    this.executeMeleeHit(cfg.damage, cfg.range, cfg.rendGain, 3);
                }

                if (this.stateTimer >= cfg.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                }
                break;
            }

            case 'heavy_release': {
                const cfg = COMBAT_CONFIG.heavyAttack;
                if (this.stateTimer >= cfg.hitWindow[0]! && this.stateTimer <= cfg.hitWindow[1]! && !this.hasHitThisAction) {
                    const chargeRatio = Math.min(1, this.heavyChargeTime / cfg.maxChargeTime);
                    const damage = cfg.minDamage + (cfg.maxDamage - cfg.minDamage) * chargeRatio;
                    this.executeMeleeHit(damage, cfg.range, cfg.rendGain, 3, true);
                }

                if (this.stateTimer >= cfg.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                }
                break;
            }

            case 'sprint_attack': {
                const cfg = COMBAT_CONFIG.sprintAttack;
                if (this.stateTimer >= cfg.hitWindow[0]! && this.stateTimer <= cfg.hitWindow[1]! && !this.hasHitThisAction) {
                    this.executeMeleeHit(cfg.damage, cfg.range, cfg.rendGain, 2);
                }
                if (this.stateTimer >= cfg.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                }
                break;
            }

            case 'dodge_attack': {
                const cfg = COMBAT_CONFIG.dodgeAttack;
                if (this.stateTimer >= cfg.hitWindow[0]! && this.stateTimer <= cfg.hitWindow[1]! && !this.hasHitThisAction) {
                    this.executeMeleeHit(cfg.damage, cfg.range, cfg.rendGain, 1);
                }
                if (this.stateTimer >= cfg.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                }
                break;
            }

            case 'dodge': {
                const cfg = COMBAT_CONFIG.dodge;
                this.isInvulnerable = this.stateTimer >= cfg.iframes[0]! && this.stateTimer <= cfg.iframes[1]!;

                // Late cancel window for responsive counter-attack
                if (this.stateTimer >= cfg.cancelWindow && this.queuedAction === 'light') {
                    this.queuedAction = null;
                    this.startDodgeAttack();
                    return;
                }

                if (this.stateTimer >= cfg.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                    this.isInvulnerable = false;
                }
                break;
            }

            case 'parry': {
                const cfg = COMBAT_CONFIG.parry;
                this.isParrying = this.stateTimer >= cfg.activeWindow[0]! && this.stateTimer <= cfg.activeWindow[1]!;

                if (this.stateTimer >= cfg.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                    this.isParrying = false;
                }
                break;
            }

            case 'riposte': {
                const cfg = COMBAT_CONFIG.riposte;
                if (this.stateTimer >= 0.25 && !this.hasHitThisAction && this.riposteTarget) {
                    this.hasHitThisAction = true;
                    this.riposteTarget.takeDamage(cfg.damage, true);
                    audio.playParryClang();
                    audio.playFleshImpact();
                    this.spawnGore(this.riposteTarget.position, 25);
                }
                if (this.stateTimer >= cfg.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                    this.riposteTarget = null;
                }
                break;
            }

            case 'execution': {
                if (this.stateTimer >= 0.6 && !this.hasHitThisAction && this.riposteTarget) {
                    this.hasHitThisAction = true;
                    audio.playExecutionStab();
                    this.spawnGore(this.riposteTarget.position, 40, true);
                    this.riposteTarget.takeDamage(COMBAT_CONFIG.execution.damage, true);
                }
                if (this.stateTimer >= COMBAT_CONFIG.execution.duration) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                    this.riposteTarget = null;
                }
                break;
            }

            case 'hurt': {
                if (this.stateTimer >= 0.35) {
                    this.actionState = 'idle';
                    this.stateTimer = 0;
                }
                break;
            }
        }
    }

    private hasHitThisAction: boolean = false;

    // =========================================================================
    // INPUT HANDLERS
    // =========================================================================

    public handleLightAttackInput(isSprinting: boolean): void {
        if (!this.stats.swordAcquired) return;
        if (this.actionState === 'idle') {
            if (isSprinting) {
                this.startSprintAttack();
            } else {
                this.startLightAttack(1);
            }
        } else if (this.actionState === 'dodge' && this.stateTimer >= COMBAT_CONFIG.dodge.cancelWindow) {
            this.startDodgeAttack();
        } else {
            // Buffer input for combo
            this.queuedAction = 'light';
        }
    }

    public handleHeavyAttackDown(): void {
        if (!this.stats.swordAcquired) return;
        if (this.actionState === 'idle') {
            this.actionState = 'heavy_charge';
            this.stateTimer = 0;
            this.isChargingHeavy = true;
            this.heavyChargeTime = 0;
            this.isControlLocked = true;
        } else {
            this.queuedAction = 'heavy';
        }
    }

    public handleHeavyAttackUp(): void {
        if (this.actionState === 'heavy_charge') {
            this.releaseHeavyAttack();
        }
    }

    private releaseHeavyAttack(): void {
        this.isChargingHeavy = false;
        this.actionState = 'heavy_release';
        this.stateTimer = 0;
        this.hasHitThisAction = false;
        audio.playChargedHeavyRelease();

        // Forward thrust impulse
        const forward = this.getPlayerForward();
        this.rootMotionVelocity.copy(forward).multiplyScalar(6.5);
    }

    public handleDodgeInput(): void {
        if (this.actionState === 'dodge' || this.actionState === 'execution' || this.actionState === 'dead') return;

        this.actionState = 'dodge';
        this.stateTimer = 0;
        this.isInvulnerable = true;
        this.isChargingHeavy = false;
        this.isControlLocked = true;
        this.queuedAction = null;
        audio.playDodgeSwoosh();

        // Dodge roll forward or movement direction
        const forward = this.getPlayerForward();
        this.rootMotionVelocity.copy(forward).multiplyScalar(COMBAT_CONFIG.dodge.speed);
    }

    public handleParryInput(): void {
        if (this.actionState !== 'idle' && this.actionState !== 'light_1' && this.actionState !== 'light_2') return;

        this.actionState = 'parry';
        this.stateTimer = 0;
        this.isParrying = true;
        this.isControlLocked = true;
        this.hasHitThisAction = false;
        audio.playSwordWhoosh(1);
    }

    public handleThrowWard(): void {
        if (this.stats.wardCharges <= 0) return;
        if (this.actionState === 'dead') return;

        this.stats.wardCharges--;
        const spawnPos = this.playerMesh.position.clone().add(new THREE.Vector3(0, 1.3, 0));
        const forward = this.getPlayerForward();
        const proj = new Projectile(spawnPos, forward, true, COMBAT_CONFIG.ward.damage);
        this.enemyManager.spawnProjectile(proj);
        audio.playWardThrow();
    }

    public handleHealInput(): void {
        if (this.stats.healCharges <= 0) return;
        if (this.stats.currentHealth >= this.getMaxHealth()) return;

        this.stats.healCharges--;
        const healAmt = this.getMaxHealth() * COMBAT_CONFIG.healAmountPercent;
        this.stats.currentHealth = Math.min(this.getMaxHealth(), this.stats.currentHealth + healAmt);
        audio.playHealFlask();
    }

    public handleExecutionInput(): void {
        if (this.stats.rendMeter < 100) return;

        // Find nearby staggered enemy
        for (const enemy of this.enemyManager.enemies) {
            if (enemy.state === 'staggered' || enemy.state === 'dead') {
                const dist = this.playerMesh.position.distanceTo(enemy.position);
                if (dist <= COMBAT_CONFIG.execution.range + 0.8) {
                    this.stats.rendMeter = 0;
                    this.actionState = 'execution';
                    this.stateTimer = 0;
                    this.isControlLocked = true;
                    this.hasHitThisAction = false;
                    this.riposteTarget = enemy;
                    // Face target
                    const toEnemy = new THREE.Vector3().subVectors(enemy.position, this.playerMesh.position);
                    this.playerMesh.rotation.y = Math.atan2(toEnemy.x, toEnemy.z);
                    return;
                }
            }
        }
    }

    public toggleLockOn(): void {
        this.isLockOnActive = !this.isLockOnActive;
        if (this.isLockOnActive) {
            this.findNextLockTarget();
        } else {
            this.targetEnemy = null;
        }
    }

    private findNextLockTarget(): void {
        let bestDist = 24.0;
        let bestTarget: EnemyInstance | null = null;
        for (const enemy of this.enemyManager.enemies) {
            if (enemy.state === 'dead') continue;
            const dist = this.playerMesh.position.distanceTo(enemy.position);
            if (dist < bestDist) {
                bestDist = dist;
                bestTarget = enemy;
            }
        }
        this.targetEnemy = bestTarget;
        if (!bestTarget) {
            this.isLockOnActive = false;
        }
    }

    // =========================================================================
    // COMBAT ACTIONS EXECUTION
    // =========================================================================

    private startLightAttack(stage: 1 | 2 | 3): void {
        this.actionState = `light_${stage}` as any;
        this.stateTimer = 0;
        this.isControlLocked = true;
        this.hasHitThisAction = false;
        audio.playSwordWhoosh(stage);

        // Small step forward
        const forward = this.getPlayerForward();
        this.rootMotionVelocity.copy(forward).multiplyScalar(2.4);
    }

    private startSprintAttack(): void {
        this.actionState = 'sprint_attack';
        this.stateTimer = 0;
        this.isControlLocked = true;
        this.hasHitThisAction = false;
        audio.playSwordWhoosh(2);

        const forward = this.getPlayerForward();
        this.rootMotionVelocity.copy(forward).multiplyScalar(5.5);
    }

    private startDodgeAttack(): void {
        this.actionState = 'dodge_attack';
        this.stateTimer = 0;
        this.isControlLocked = true;
        this.isInvulnerable = false;
        this.hasHitThisAction = false;
        audio.playSwordWhoosh(1);

        const forward = this.getPlayerForward();
        this.rootMotionVelocity.copy(forward).multiplyScalar(3.2);
    }

    private transitionToNextCombo(): void {
        if (this.queuedAction === 'dodge') {
            this.queuedAction = null;
            this.handleDodgeInput();
        } else if (this.queuedAction === 'light') {
            this.queuedAction = null;
            if (this.actionState === 'light_1') {
                this.startLightAttack(2);
            } else if (this.actionState === 'light_2') {
                this.startLightAttack(3);
            }
        }
    }

    private processQueuedAction(isSprinting: boolean, isMoving: boolean): void {
        if (!this.queuedAction) return;
        const act = this.queuedAction;
        this.queuedAction = null;

        if (act === 'light') this.handleLightAttackInput(isSprinting);
        else if (act === 'heavy') this.handleHeavyAttackDown();
        else if (act === 'dodge') this.handleDodgeInput();
        else if (act === 'parry') this.handleParryInput();
        else if (act === 'ward') this.handleThrowWard();
        else if (act === 'heal') this.handleHealInput();
        else if (act === 'exec') this.handleExecutionInput();
    }

    private executeMeleeHit(baseDamage: number, range: number, rendGain: number, comboStage: number, isHeavy: boolean = false): void {
        this.hasHitThisAction = true;
        const forward = this.getPlayerForward();
        const playerPos = this.playerMesh.position;

        // Apply Tempered Edge upgrade bonus (+15%)
        const damage = this.stats.upgrades.temperedEdge ? baseDamage * 1.15 : baseDamage;

        let hitAny = false;
        for (const enemy of this.enemyManager.enemies) {
            if (enemy.state === 'dead') continue;
            const toEnemy = new THREE.Vector3().subVectors(enemy.position, playerPos);
            const dist = toEnemy.length();

            if (dist <= range + 0.4) {
                toEnemy.y = 0;
                toEnemy.normalize();
                const dot = forward.dot(toEnemy);
                if (dot >= 0.35) { // in frontal arc
                    hitAny = true;
                    const result = enemy.takeDamage(damage);
                    if (result.died) {
                        this.stats.ironNails += enemy.stats.ironNailsDrop;
                        this.spawnGore(enemy.position, 20);
                    } else {
                        this.spawnGore(enemy.position, 8);
                    }

                    if (isHeavy) {
                        audio.playArmorImpact();
                    } else {
                        audio.playFleshImpact();
                    }
                }
            }
        }

        if (hitAny) {
            this.stats.rendMeter = Math.min(100, this.stats.rendMeter + rendGain);
            if (this.stats.rendMeter >= 100) {
                audio.playRendReady();
            }

            // Weapon staining that fades over time
            if (this.options.goreLevel !== 'off' && this.swordMesh) {
                this.swordStainTimer = 3.5;
                this.swordMesh.traverse((child) => {
                    if ((child as THREE.Mesh).isMesh) {
                        const m = child as THREE.Mesh;
                        if (m.material && (m.material as any).color) {
                            (m.material as THREE.MeshStandardMaterial).color.setHex(0x6E1414);
                        }
                    }
                });
            }
        }
    }

    public takeDamage(damage: number, hitDirection: THREE.Vector3, isGrab: boolean = false): void {
        if (this.isInvulnerable || this.actionState === 'dead') return;

        // Directional Parry Check
        if (this.isParrying && !isGrab) {
            const forward = this.getPlayerForward();
            const facingEnemy = forward.dot(hitDirection.clone().negate()) >= 0.2;
            if (facingEnemy) {
                // Successful Parry!
                audio.playParryClang();
                this.isParrying = false;
                this.actionState = 'idle';

                // Find parried enemy and stagger them into riposte vulnerability
                for (const enemy of this.enemyManager.enemies) {
                    if (enemy.isAttacking && enemy.position.distanceTo(this.playerMesh.position) <= 3.8) {
                        enemy.state = 'staggered';
                        enemy.stateTimer = 0;
                        enemy.isAttacking = false;
                        this.riposteTarget = enemy;
                        break;
                    }
                }
                return;
            }
        }

        // Damage received
        this.stats.currentHealth = Math.max(0, this.stats.currentHealth - damage);
        audio.playFleshImpact();
        this.spawnGore(this.playerMesh.position, 12);

        if (this.stats.currentHealth <= 0) {
            this.actionState = 'dead';
            this.isControlLocked = true;
            audio.playBellToll('large');
        } else {
            this.actionState = 'hurt';
            this.stateTimer = 0;
            this.isControlLocked = true;
            this.rootMotionVelocity.copy(hitDirection).multiplyScalar(4.0);
        }
    }

    public getMaxHealth(): number {
        return this.stats.upgrades.wovenCharm ? this.stats.baseMaxHealth * 1.2 : this.stats.baseMaxHealth;
    }

    private getPlayerForward(): THREE.Vector3 {
        const yaw = this.playerMesh.rotation.y;
        return new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    }

    // =========================================================================
    // GORE & PARTICLES SYSTEM (Settings: Off, Reduced, Full)
    // =========================================================================

    private spawnGore(pos: THREE.Vector3, count: number, isDismemberment: boolean = false): void {
        // Spawn ground surface decal
        this.spawnSurfaceDecal(pos);

        if (this.options.goreLevel === 'off') {
            // Gore OFF: Replaced with black ash bursts and no dismemberment
            this.spawnAshParticles(pos, count);
            return;
        }

        const particleCount = this.options.goreLevel === 'reduced' ? Math.floor(count * 0.4) : count;
        const color = 0x6E0D0D; // Deep crimson blood spray
        const mat = new THREE.MeshBasicMaterial({ color });

        for (let i = 0; i < particleCount; i++) {
            const size = 0.05 + Math.random() * 0.08;
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
            mesh.position.copy(pos).add(new THREE.Vector3(
                (Math.random() - 0.5) * 0.4,
                0.8 + (Math.random() - 0.5) * 0.4,
                (Math.random() - 0.5) * 0.4
            ));

            const vel = new THREE.Vector3(
                (Math.random() - 0.5) * 5.0,
                2.0 + Math.random() * 4.0,
                (Math.random() - 0.5) * 5.0
            );

            this.scene.add(mesh);
            this.particles.push({ mesh, vel, life: 0, maxLife: 0.6 + Math.random() * 0.4 });
        }

        // Monster dismemberment on execution in FULL gore mode only
        if (isDismemberment && this.options.goreLevel === 'full') {
            const boneMat = new THREE.MeshStandardMaterial({ color: 0x8C7A68, roughness: 0.8 });
            const boneChunk = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.35, 0.15), boneMat);
            boneChunk.position.copy(pos).add(new THREE.Vector3(0, 1.0, 0));
            const boneVel = new THREE.Vector3((Math.random() - 0.5) * 4, 3.5, (Math.random() - 0.5) * 4);
            this.scene.add(boneChunk);
            this.particles.push({ mesh: boneChunk, vel: boneVel, life: 0, maxLife: 2.5 });
        }
    }

    private spawnAshParticles(pos: THREE.Vector3, count: number): void {
        const mat = new THREE.MeshBasicMaterial({ color: 0x222222 }); // Black ash
        for (let i = 0; i < count; i++) {
            const size = 0.04 + Math.random() * 0.05;
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
            mesh.position.copy(pos).add(new THREE.Vector3(
                (Math.random() - 0.5) * 0.5,
                0.8 + (Math.random() - 0.5) * 0.4,
                (Math.random() - 0.5) * 0.5
            ));

            const vel = new THREE.Vector3(
                (Math.random() - 0.5) * 2.5,
                1.5 + Math.random() * 2.0,
                (Math.random() - 0.5) * 2.5
            );

            this.scene.add(mesh);
            this.particles.push({ mesh, vel, life: 0, maxLife: 0.8 + Math.random() * 0.5 });
        }
    }

    private spawnSurfaceDecal(pos: THREE.Vector3): void {
        if (this.decals.length >= this.maxDecals) {
            const oldest = this.decals.shift();
            if (oldest) this.scene.remove(oldest.mesh);
        }

        const isAsh = this.options.goreLevel === 'off';
        const color = isAsh ? 0x1A1A1A : 0x480808;
        const radius = 0.28 + Math.random() * 0.35;
        const mat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: isAsh ? 0.55 : 0.8,
            depthWrite: false,
        });

        const geo = new THREE.CircleGeometry(radius, 12);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(
            pos.x + (Math.random() - 0.5) * 0.4,
            1.015,
            pos.z + (Math.random() - 0.5) * 0.4
        );

        this.scene.add(mesh);
        this.decals.push({ mesh, life: 0, maxLife: 15.0 });
    }

    private updateParticles(dt: number): void {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            if (!p) continue;
            p.life += dt;
            if (p.life >= p.maxLife) {
                this.scene.remove(p.mesh);
                this.particles.splice(i, 1);
                continue;
            }

            // Gravity
            p.vel.y -= 14.0 * dt;
            p.mesh.position.addScaledVector(p.vel, dt);

            // Ground floor check (ice ground is at y = 1.0)
            if (p.mesh.position.y < 1.02) {
                p.mesh.position.y = 1.02;
                p.vel.set(0, 0, 0);
            }
        }
    }

    private updateDecals(dt: number): void {
        for (let i = this.decals.length - 1; i >= 0; i--) {
            const d = this.decals[i];
            if (!d) continue;
            d.life += dt;
            if (d.life >= d.maxLife) {
                this.scene.remove(d.mesh);
                this.decals.splice(i, 1);
                continue;
            }

            const remaining = d.maxLife - d.life;
            if (remaining < 4.0) {
                (d.mesh.material as THREE.MeshBasicMaterial).opacity = (remaining / 4.0) * (this.options.goreLevel === 'off' ? 0.55 : 0.8);
            }
        }
    }

    public dispose(): void {
        for (const p of this.particles) {
            this.scene.remove(p.mesh);
        }
        this.particles = [];

        for (const d of this.decals) {
            this.scene.remove(d.mesh);
        }
        this.decals = [];
    }
}
