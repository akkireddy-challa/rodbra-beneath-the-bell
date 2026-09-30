/**
 * Interface for objects that can be interacted with by the player
 */
export interface Interactable {
	/**
	 * Called when player starts interacting with the object
	 * @returns true if interaction was successful, false otherwise
	 */
	onInteractStart(): boolean;

	/**
	 * Called when player stops interacting with the object
	 * Optional - may not be called for some objects like collectibles
	 */
	onInteractEnd?(): void;

	/**
	 * Get the display text for starting interaction
	 * Engine will prepend "Press E to " to this text
	 * @returns Display text (e.g., "enter the vehicle")
	 */
	getInteractStartDisplayName(): string;

	/**
	 * Get the display text for ending interaction
	 * Engine will prepend "Press E to " to this text
	 * Optional - only needed if onInteractEnd is implemented
	 * @returns Display text (e.g., "exit the vehicle")
	 */
	getInteractEndDisplayName?(): string;

	/**
	 * Check if interaction is currently enabled
	 * Optional - if not implemented, interaction is always enabled
	 * @returns true if interaction is enabled, false otherwise
	 */
	interactionEnabled?(): boolean;

	/**
	 * Whether pressing the interact key actually does something right now.
	 * When false, the engine still shows the prompt (so the player knows the
	 * object exists) but renders it as a plain label without the [E] key
	 * glyph — useful for "locked", "empty", "out of charge", etc. where the
	 * object is present but no action is available.
	 *
	 * This is distinct from `interactionEnabled()`, which fully removes the
	 * object from detection.
	 *
	 * Optional - if not implemented, the action is always considered available.
	 */
	isActionable?(): boolean;

	/**
	 * Whether this interactable's sensor is glued to the player's position
	 * (i.e. it overlaps the player by construction, not because the player
	 * walked up to a world-fixed object). The carry-drop prompt is the
	 * canonical example — the carried object follows the player, so its
	 * sensor is always at distance ~0.
	 *
	 * Interactables that return true here are treated as **fallbacks**:
	 * if any non-following interactable is also in range, the non-following
	 * one is shown instead. This stops the "Drop the key" prompt from
	 * shadowing a keycard reader, vehicle, or NPC the player is trying to
	 * interact with while carrying something.
	 *
	 * Optional - if not implemented, the interactable is treated as world-fixed.
	 */
	isFollowingPlayer?(): boolean;
}
