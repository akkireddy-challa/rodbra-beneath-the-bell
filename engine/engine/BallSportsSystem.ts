import type { PlayerController } from 'engine/PlayerController.js';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import type { VoxelObject } from 'engine/VoxelObject.js';
import { detectLimbContact } from 'engine/animation/LimbContact.js';
import { computeColliderRadius, type ColliderShapeView } from 'engine/physics/BallPhysics.js';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * BallSportsSystem — kicking a dynamic ball prop in ball-sports games (soccer,
 * dodgeball, …) with real foot-contact detection.
 *
 * The player walking into the ball already rolls it (the KinematicCharacter-
 * Controller shoves dynamic sphere props on contact — WalkingAndJumpingMovement
 * prop-push). This system adds the deliberate "kick" on the action button: a
 * controlled velocity impulse away from the player with a little lift and spin,
 * gated on the kicking foot actually reaching the ball — so a swing that misses
 * applies no force.
 *
 * Contact is sampled EVERY FRAME across the kick swing (not at the clip's
 * auto-detected impact frame): the foot's closest approach to the ball is what
 * matters, and the clip's peak-speed frame lands ~1 m past the ball — sampling
 * only there would reject every real kick once the gate is the true ball size.
 * The impulse fires on the first frame the kicking foot is within the gate.
 *
 * The contact gate uses the generic `detectLimbContact` primitive (the same
 * bone-position read the combat melee systems use internally), kept out of the
 * combat code so a sports game never has to reach into `UnarmedMeleeSystem`.
 *
 * The ball must be a dynamic VoxelObject env object (placed with `--dynamic`,
 * ideally `colliderShape: 'sphere'`); look it up by its instance/asset name.
 */
export interface BallSportsOptions {
    /** Name of the dynamic ball env object to control (asset / instance name). */
    ballName: string;
    /** Action name bound on the PlayerController (auto-creates a mobile button). */
    actionName: string;
    /** Kick animation motion id (a core clip). */
    kickAnimation: string;
    /** Horizontal kick speed applied to the ball (m/s). */
    kickSpeed: number;
    /** Vertical lift applied on a kick (m/s) for the arc. */
    kickLift: number;
    /** Sidespin angular speed factor; 0 disables spin. */
    spin: number;
    /** Max horizontal player→ball distance to START a kick swing (m). */
    kickRange: number;
    /** Cooldown between kick swings (s). */
    cooldown: number;
    /**
     * Extra reach past the ball surface that still counts as a hit (m). The
     * tested foot bone is the ankle, which sits ~0.15 m behind the instep that
     * strikes; this bridges that offset plus a small margin. Total gate radius
     * is `ballRadius + contactSlack`.
     */
    contactSlack: number;
}

export const DEFAULT_BALL_SPORTS_OPTIONS: BallSportsOptions = {
    ballName: 'soccer_ball',
    actionName: 'kick',
    kickAnimation: 'mSoccerKick01',
    kickSpeed: 11,
    kickLift: 2.8,
    spin: 8,
    kickRange: 2.5,
    cooldown: 0.4,
    contactSlack: 0.25,
};

export class BallSportsSystem {
    private readonly opts: BallSportsOptions;
    private readonly playerController: PlayerController;
    private ballObject: VoxelObject | null = null;
    private ballRadius = 0.4;
    private cooldown = 0;
    /** Seconds left in the active kick swing during which foot↔ball contact is sampled. */
    private swingTimeLeft = 0;
    /** True once the active swing has connected, so one swing applies at most one kick. */
    private swingConnected = false;

    constructor(playerController: PlayerController, options?: Partial<BallSportsOptions>) {
        this.playerController = playerController;
        this.opts = { ...DEFAULT_BALL_SPORTS_OPTIONS, ...options };

        // Look up the placed dynamic ball env object (do NOT create a mesh).
        for (const obj of VoxelObjectBuilder.getAllObjects().values()) {
            if (obj.name === this.opts.ballName) {
                this.ballObject = obj;
                break;
            }
        }
        const ball = this.ballObject;
        const body = this.getBallBody();
        if (!ball || !body) {
            // Ball may still be generating, or wasn't placed as dynamic. Contact-
            // push still works via the engine; the deliberate kick stays disabled.
            console.warn(`[BallSportsSystem] "${this.opts.ballName}" not found or not a dynamic VoxelObject; kick disabled. Place it with --dynamic.`);
            return;
        }
        this.ballRadius = this.resolveBallRadius(ball, body);
        // Never hibernate the ball when the player runs far from it.
        ball.setAlwaysActive(true);
        // A dynamic env prop is placed with its body ASLEEP, so a level full of
        // resting props pays no settle wave on load (PristineDynamic.ts). Rapier
        // never integrates a sleeping body — not even gravity — so a ball
        // authored ABOVE the ground (the soccer/rugby archetypes spawn it at
        // y = 1.5) hangs in mid-air forever: it is then a metre out of the
        // foot-contact gate's reach and the kick can NEVER connect. The ball is
        // the one prop the whole mechanic is about, so wake it here and let it
        // drop onto the pitch; Rapier puts it back to sleep once it settles.
        body.wakeUp();
        this.playerController.setActionHandler(this.opts.actionName, () => this.tryKick());
    }

    /**
     * Read the ball's radius (m) from its actual physics colliders — the size
     * physics (and thus the player) sees. We do NOT use
     * `getBoundsInWorldUnits()`: a VXL's stored bounds can be encoded in
     * voxel-grid units, which inflates a bounds-derived radius by 1/voxelSize
     * (a 0.2 m ball read as 4.0 m, opening a 4 m kick gate that connects on a
     * clean miss). Collider geometry is always in world units.
     */
    private resolveBallRadius(ball: VoxelObject, body: RAPIER.RigidBody): number {
        const center = body.translation();
        const views: ColliderShapeView[] = ball.getColliders().filter((c) => c.isValid()).map((c) => ({
            translation: () => c.translation(),
            shape: c.shape as { halfExtents?: { x: number; y: number; z: number }; radius?: number },
        }));
        return computeColliderRadius(views, center, 0.4);
    }

    private tryKick(): void {
        const body = this.getBallBody();
        if (this.cooldown > 0 || !body) return;
        const player = this.playerController.player;
        if (!player) return;

        // Coarse precheck: don't even swing if the ball is well out of reach.
        const ballPos = body.translation();
        const startDist = Math.hypot(ballPos.x - player.position.x, ballPos.z - player.position.z);
        if (startDist > this.opts.kickRange) return;

        this.cooldown = this.opts.cooldown;

        const anim = this.playerController.animationController;
        if (anim?.playCustomAnimation) {
            const { success, duration } = anim.playCustomAnimation(this.opts.kickAnimation, {
                speed: 1.5,
                fadeInDuration: 0.05,
                fadeOutDuration: 0.2,
                // Commit the clip's forward step to the player's real position so
                // the kicking foot reaches the ball AND the body stays where the
                // step ended — instead of snapping back when the swing finishes.
                applyRootMotion: true,
                onRootMotionDisplacement: (d) => this.playerController.addExternalDisplacement(d),
                // NOT interruptOnMovement: a soccer kick must fire while running
                // up to the ball. The full-body kick clip briefly overrides the
                // run cycle for the swing while movement input keeps driving the
                // player; locomotion resumes when the clip finishes.
            });
            // Open the contact-sampling window for the swing's duration. The
            // impulse fires the first frame the foot reaches the ball (see
            // sampleSwingContact). A clip not yet loaded returns success:false —
            // skip the window; the lazy load makes the next press play.
            if (success) {
                this.swingTimeLeft = duration > 0 ? duration : 0.6;
                this.swingConnected = false;
            }
        } else {
            // No animation controller to read a foot pose from — best-effort kick
            // gated only by the start-distance precheck above.
            this.applyKick();
        }
    }

    /**
     * During an active swing, apply the kick on the first frame the kicking
     * foot reaches the ball. Sampled every frame because the foot's closest
     * approach (~0.2 m) does not coincide with the clip's peak-speed impact
     * frame (~1 m past the ball).
     */
    private sampleSwingContact(): void {
        if (this.swingConnected) return;
        const body = this.getBallBody();
        const anim = this.playerController.animationController;
        if (!body || !anim) return;
        // Only sample while OUR kick clip is the active overlay, so a plain
        // running foot passing near the ball (no kick swing) never counts as a
        // kick — the swing window can outlast the clip (see swingTimeLeft).
        if (anim.getCustomMotionId?.() !== this.opts.kickAnimation) return;
        const contact = detectLimbContact(
            anim,
            body.translation(),
            this.ballRadius,
            { slack: this.opts.contactSlack },
        );
        if (!contact) return; // foot hasn't reached the ball this frame
        this.swingConnected = true;
        this.applyKick();
    }

    /** Apply the controlled kick velocity + spin (ball always moves away from the player). */
    private applyKick(): void {
        const body = this.getBallBody();
        const player = this.playerController.player;
        if (!body || !player) return;

        const ballPos = body.translation();
        let dirX = ballPos.x - player.position.x;
        let dirZ = ballPos.z - player.position.z;
        const horiz = Math.hypot(dirX, dirZ);
        if (horiz < 1e-3) {
            // Standing on the ball: fall back to facing. Gameplay forward is +Z.
            const yaw = this.playerController.rotation;
            dirX = Math.sin(yaw);
            dirZ = Math.cos(yaw);
        } else {
            dirX /= horiz;
            dirZ /= horiz;
        }

        body.setLinvel({ x: dirX * this.opts.kickSpeed, y: this.opts.kickLift, z: dirZ * this.opts.kickSpeed }, true);
        if (this.opts.spin !== 0) {
            body.setAngvel({ x: dirZ * this.opts.spin, y: 0, z: -dirX * this.opts.spin }, true);
        }
    }

    /**
     * The ball's dynamic rigid body, or null when it isn't there right now.
     * Game rules (goal detection, out-of-bounds, reset) read its position and
     * re-use setTranslation / setLinvel / setAngvel on it.
     *
     * Always re-resolved from the VoxelObject and validity-checked, never
     * cached: an env object rebuilds its body whenever its physics changes (an
     * AI edit re-placing the ball, a level reload, chunk streaming), and Rapier
     * REUSES freed handles — calling translation() through a stale handle traps
     * the WASM module ("unreachable") and freezes physics for the whole game.
     */
    getBallBody(): RAPIER.RigidBody | null {
        const body = this.ballObject?.getRigidBody() ?? null;
        return body?.isValid() ? body : null;
    }

    /** The ball env object, or null if it wasn't found. */
    getBallObject(): VoxelObject | null {
        return this.ballObject;
    }

    /** Reset the ball to a spawn point and clear its motion (e.g. after a goal). */
    resetBall(x: number, y: number, z: number): void {
        const body = this.getBallBody();
        if (!body) return;
        body.setTranslation({ x, y, z }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    update(deltaTime: number): void {
        if (this.cooldown > 0) this.cooldown -= deltaTime;
        if (this.swingTimeLeft > 0) {
            this.swingTimeLeft -= deltaTime;
            this.sampleSwingContact();
        }
    }

    dispose(): void {
        // Engine handles action-handler cleanup with the PlayerController.
        this.ballObject = null;
    }
}
