import * as THREE from 'three';

export class Physics2DCamera {
    private camera: THREE.PerspectiveCamera;
    private target: THREE.Object3D | null = null;
    private offset = new THREE.Vector3(0, 0, 20);
    private smoothSpeed = 5.0;
    private lookAhead = 2.0;
    private lastTargetVelX = 0;

    constructor(camera: THREE.PerspectiveCamera) {
        this.camera = camera;
        camera.position.set(0, 0, this.offset.z);
        camera.lookAt(0, 0, 0);
    }

    setTarget(target: THREE.Object3D): void {
        this.target = target;
    }

    setDistance(distance: number): void {
        this.offset.z = distance;
    }

    setVerticalOffset(offset: number): void {
        this.offset.y = offset;
    }

    setSmoothSpeed(speed: number): void {
        this.smoothSpeed = speed;
    }

    setLookAhead(amount: number): void {
        this.lookAhead = amount;
    }

    update(deltaTime: number): void {
        if (!this.target) return;

        const targetX = this.target.position.x + this.lastTargetVelX * this.lookAhead;
        const targetY = this.target.position.y + this.offset.y;
        const targetZ = this.offset.z;

        const t = 1 - Math.exp(-this.smoothSpeed * deltaTime);
        this.camera.position.x += (targetX - this.camera.position.x) * t;
        this.camera.position.y += (targetY - this.camera.position.y) * t;
        this.camera.position.z = targetZ;

        this.camera.lookAt(this.camera.position.x, this.camera.position.y, 0);
    }

    setTargetVelocityX(vx: number): void {
        this.lastTargetVelX = vx;
    }

    dispose(): void {
        this.target = null;
    }
}
