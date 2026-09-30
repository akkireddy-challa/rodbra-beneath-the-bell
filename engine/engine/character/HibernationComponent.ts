import { SimClass } from 'engine/character/CharacterLodScheduler.js';

/**
 * Callbacks for controller-specific hibernate/wake physics operations.
 */
export interface HibernationCallbacks {
    /** Called when hibernating - controller should disable physics, hide visuals */
    onHibernate(): void;
    /** Called when waking - controller should re-enable physics, show visuals */
    onWake(): void;
}

/**
 * HibernationComponent - Manages chunk-based hibernation and physics hold state.
 * Shared between NpcController and AnimalController.
 */
export class HibernationComponent {
    private _isHibernating: boolean = false;
    private _physicsHeld: boolean = false;
    private _alwaysActive: boolean = false;
    private _simClass: SimClass = SimClass.FULL;
    private callbacks: HibernationCallbacks;

    constructor(callbacks: HibernationCallbacks) {
        this.callbacks = callbacks;
    }

    hibernate(): void {
        if (this._isHibernating) return;
        this._isHibernating = true;
        this.callbacks.onHibernate();
    }

    wake(): void {
        if (!this._isHibernating) return;
        this._isHibernating = false;
        this.callbacks.onWake();
    }

    isHibernating(): boolean {
        return this._isHibernating;
    }

    holdPhysicsUntilReady(): void {
        this._physicsHeld = true;
    }

    releasePhysics(): void {
        this._physicsHeld = false;
    }

    isPhysicsHeld(): boolean {
        return this._physicsHeld;
    }

    setAlwaysActive(active: boolean): void {
        this._alwaysActive = active;
    }

    isAlwaysActive(): boolean {
        return this._alwaysActive;
    }

    /** Stamped by the character controller from its scheduler-assigned LOD state. */
    setSimClass(simClass: SimClass): void {
        this._simClass = simClass;
    }

    getSimClass(): SimClass {
        return this._simClass;
    }
}
