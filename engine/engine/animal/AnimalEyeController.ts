import * as THREE from 'three';

/**
 * Eye style configuration
 */
export type EyeStyle = 'square' | 'round';

/**
 * Eye placement on the head
 * - 'front': Eyes face forward (predator style - dogs, cats, humans)
 * - 'side': Eyes on sides of head (prey style - horses, deer, rabbits)
 */
export type EyePlacement = 'front' | 'side';

/**
 * Extended eye configuration for animal eyes
 */
export interface AnimalEyeConfig {
    /** Eye style: 'square' (default) or 'round' */
    style?: EyeStyle;
    /** Eye placement: 'front' (default) or 'side' */
    placement?: EyePlacement;
    /** Eye size in meters (default: auto-calculated from head size) */
    size?: number;
    /** Pupil color (default: 0x000000 black) */
    color?: number;
    /** Sclera (white) color (default: 0xFFFFFF white) */
    scleraColor?: number;
    /** Eye position offset relative to auto-calculated position */
    positionOffset?: { x?: number; y?: number; z?: number };
    /** Set to true to disable eyes */
    disabled?: boolean;
    /** Distance at which eyes start tracking player (default: 5 meters) */
    playerTrackingDistance?: number;
}

interface EyeRefs {
    leftEye: THREE.Object3D;
    rightEye: THREE.Object3D;
    leftPupil: THREE.Mesh;
    rightPupil: THREE.Mesh;
    leftSclera: THREE.Mesh;
    rightSclera: THREE.Mesh;
}

const BLINK_INTERVAL_MIN = 2.0;
const BLINK_INTERVAL_MAX = 6.0;
const BLINK_DURATION = 0.12;
/**
 * `updateAlong` synthesises its target this fraction of the tracking distance
 * ahead of the head: close enough that the pupils visibly follow the direction
 * (tracking strength 1 − fraction), far enough that they never pin to the rim.
 */
const GAZE_AHEAD_FRACTION = 0.4;

/**
 * Controls animal eye animations including blinking and player tracking.
 */
export class AnimalEyeController {
    private eyeRefs: EyeRefs | null = null;
    private head: THREE.Object3D | null = null;
    
    private blinkTimer = 0;
    private isBlinking = false;
    private blinkDuration = 0;
    private nextBlinkTime = Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN) + BLINK_INTERVAL_MIN;
    
    private playerTrackingDistance: number;
    private maxPupilOffset: number = 0;
    private placement: EyePlacement;
    
    private originalLeftPupilPos = new THREE.Vector3();
    private originalRightPupilPos = new THREE.Vector3();
    private readonly scratchHead = new THREE.Vector3();
    private readonly scratchTarget = new THREE.Vector3();
    
    constructor(config: AnimalEyeConfig = {}) {
        this.playerTrackingDistance = config.playerTrackingDistance ?? 5;
        this.placement = config.placement ?? 'front';
    }
    
    setEyeReferences(
        head: THREE.Object3D,
        leftEye: THREE.Object3D,
        rightEye: THREE.Object3D,
        leftPupil: THREE.Mesh,
        rightPupil: THREE.Mesh,
        leftSclera: THREE.Mesh,
        rightSclera: THREE.Mesh,
        pupilOffset: number
    ): void {
        this.head = head;
        this.eyeRefs = {
            leftEye,
            rightEye,
            leftPupil,
            rightPupil,
            leftSclera,
            rightSclera
        };
        this.maxPupilOffset = pupilOffset;
        
        this.originalLeftPupilPos.copy(leftPupil.position);
        this.originalRightPupilPos.copy(rightPupil.position);
    }
    
    update(deltaTime: number, animalPosition: THREE.Vector3, playerPosition: THREE.Vector3 | null): void {
        if (!this.eyeRefs) return;
        
        this.updateBlink(deltaTime);
        
        if (playerPosition) {
            this.updateLookAt(animalPosition, playerPosition);
        }
    }
    
    /**
     * `update` for a character that has a gaze DIRECTION but nothing to watch —
     * the player, whose eyes follow the aim. The target is placed a fixed
     * fraction of the tracking distance ahead of the HEAD along `direction`
     * (world space, need not be normalised), so head height never enters it
     * and the pupils sit at a steady partial offset toward the direction.
     */
    updateAlong(deltaTime: number, direction: THREE.Vector3): void {
        if (!this.eyeRefs || !this.head) return;
        const headPos = this.head.getWorldPosition(this.scratchHead);
        const target = this.scratchTarget.copy(direction).normalize()
            .multiplyScalar(this.playerTrackingDistance * GAZE_AHEAD_FRACTION)
            .add(headPos);
        this.update(deltaTime, headPos, target);
    }

    private updateBlink(deltaTime: number): void {
        if (!this.eyeRefs) return;
        
        this.blinkTimer += deltaTime;
        
        if (!this.isBlinking && this.blinkTimer >= this.nextBlinkTime) {
            this.isBlinking = true;
            this.blinkDuration = 0;
            this.blinkTimer = 0;
            this.nextBlinkTime = Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN) + BLINK_INTERVAL_MIN;
        }
        
        if (this.isBlinking) {
            this.blinkDuration += deltaTime;
            const blinkProgress = this.blinkDuration / BLINK_DURATION;
            
            if (blinkProgress < 0.5) {
                const closeAmount = blinkProgress * 2;
                const scaleY = 1.0 - (closeAmount * 0.95);
                this.eyeRefs.leftPupil.scale.y = scaleY;
                this.eyeRefs.rightPupil.scale.y = scaleY;
                this.eyeRefs.leftSclera.scale.y = scaleY;
                this.eyeRefs.rightSclera.scale.y = scaleY;
            } else if (blinkProgress < 1.0) {
                const openAmount = (blinkProgress - 0.5) * 2;
                const scaleY = 0.05 + (openAmount * 0.95);
                this.eyeRefs.leftPupil.scale.y = scaleY;
                this.eyeRefs.rightPupil.scale.y = scaleY;
                this.eyeRefs.leftSclera.scale.y = scaleY;
                this.eyeRefs.rightSclera.scale.y = scaleY;
            } else {
                this.eyeRefs.leftPupil.scale.y = 1.0;
                this.eyeRefs.rightPupil.scale.y = 1.0;
                this.eyeRefs.leftSclera.scale.y = 1.0;
                this.eyeRefs.rightSclera.scale.y = 1.0;
                this.isBlinking = false;
                this.blinkDuration = 0;
            }
        }
    }
    
    private updateLookAt(animalPosition: THREE.Vector3, playerPosition: THREE.Vector3): void {
        if (!this.eyeRefs || !this.head) return;
        
        const distance = animalPosition.distanceTo(playerPosition);
        
        if (distance > this.playerTrackingDistance) {
            this.eyeRefs.leftPupil.position.copy(this.originalLeftPupilPos);
            this.eyeRefs.rightPupil.position.copy(this.originalRightPupilPos);
            return;
        }
        
        const headWorldPos = new THREE.Vector3();
        this.head.getWorldPosition(headWorldPos);
        
        const dirToPlayer = new THREE.Vector3()
            .subVectors(playerPosition, headWorldPos)
            .normalize();
        
        const headWorldQuat = new THREE.Quaternion();
        this.head.getWorldQuaternion(headWorldQuat);
        const invQuat = headWorldQuat.clone().invert();
        const localDir = dirToPlayer.clone().applyQuaternion(invQuat);
        
        const trackingStrength = 1.0 - Math.min(distance / this.playerTrackingDistance, 1.0);
        const maxOffset = this.maxPupilOffset * trackingStrength;
        
        if (this.placement === 'front') {
            const offsetX = THREE.MathUtils.clamp(localDir.x * maxOffset * 2, -maxOffset, maxOffset);
            const offsetY = THREE.MathUtils.clamp(localDir.y * maxOffset * 2, -maxOffset * 0.5, maxOffset * 0.5);
            
            this.eyeRefs.leftPupil.position.set(
                this.originalLeftPupilPos.x + offsetX,
                this.originalLeftPupilPos.y + offsetY,
                this.originalLeftPupilPos.z
            );
            this.eyeRefs.rightPupil.position.set(
                this.originalRightPupilPos.x + offsetX,
                this.originalRightPupilPos.y + offsetY,
                this.originalRightPupilPos.z
            );
        } else {
            const leftOffsetZ = THREE.MathUtils.clamp(localDir.z * maxOffset * 2, -maxOffset, maxOffset);
            const leftOffsetY = THREE.MathUtils.clamp(localDir.y * maxOffset * 2, -maxOffset * 0.5, maxOffset * 0.5);
            
            this.eyeRefs.leftPupil.position.set(
                this.originalLeftPupilPos.x,
                this.originalLeftPupilPos.y + leftOffsetY,
                this.originalLeftPupilPos.z + leftOffsetZ
            );
            
            this.eyeRefs.rightPupil.position.set(
                this.originalRightPupilPos.x,
                this.originalRightPupilPos.y + leftOffsetY,
                this.originalRightPupilPos.z - leftOffsetZ
            );
        }
    }
    
    dispose(): void {
        this.eyeRefs = null;
        this.head = null;
    }
}
