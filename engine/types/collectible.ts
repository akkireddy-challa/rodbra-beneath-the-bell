/**
 * Interface for objects that are automatically collected when the player walks into them.
 * Unlike Interactable (which requires the player to press E), collectibles trigger
 * immediately on proximity via a Rapier sensor overlap.
 */
export interface Collectible {
	/**
	 * Called automatically when the player enters the trigger radius.
	 * Use this to update score, remove the object from scene, play effects, etc.
	 */
	onCollect(): void;
}
