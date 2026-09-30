import { splitWeaponStyleId } from 'engine/WeaponVisualStyle.js';
import { WEAPON_MOVES } from 'engine/AnimationPacks.js';
import type { CustomAttackMove } from 'types/game.js';

/**
 * Which attack clips a melee weapon can swing, and how they become registered moves —
 * the one place both the player (`WeaponMeleeSystem`) and armed NPCs (`NpcMeleeAttack`)
 * turn "this character is holding an axe" into a move set.
 *
 * It lived inside `WeaponMeleeSystem` while the player was the only thing that
 * swung a weapon on registered moves. NPCs now do too, and a second copy would
 * drift: an axe that chops for the player and slashes for the NPC holding the
 * same axe is exactly the kind of divergence this module exists to prevent.
 */

/** A key of `WEAPON_MOVES` — one of the built-in melee swing clips. */
export type MeleeWeaponMove = keyof typeof WEAPON_MOVES;

/**
 * Which attack clips each built-in weapon can swing.
 *
 * The FIRST entry that is a horizontal swipe is the weapon's default attack —
 * see `primaryMoveFor`. The rest are available to templates by name through
 * `WEAPON_MOVES`; they are not rolled at random on a basic attack, because a
 * plain click that sometimes chops, sometimes stabs and sometimes cuts upward
 * reads as the character deciding for you rather than as your input. (An NPC
 * has no input to respect, so its swings ARE rolled from the whole set — see
 * `AttackAnimationSystem.startAttack`.)
 *
 * Grouped by how the weapon is actually used, not one list per weapon:
 * pointy blades thrust, blunt one-handers only swing, polearms lead with the
 * point, and the two-handers draw on the heavy set.
 * `AttackWhirlwind` is deliberately in no default set — a full 360° spin as a
 * random basic attack reads as a glitch; templates register it as a special
 * via `WEAPON_MOVES.whirlwind`.
 *
 * The two-handed set runs PARALLEL to the one-handed one, move for move, so a
 * greatsword has the same variety as a sword rather than rewinding through the
 * same two swings: heavyChop ↔ slashDown, cleave ↔ slashSide, heavyUp ↔ slashUp,
 * spearThrust ↔ thrust. `backCleave` is the extra that only the two-handed set
 * needs — it is `cleave` reversed, so consecutive swings alternate direction
 * instead of resetting between every one.
 */
export const WEAPON_TYPE_MOVES: Record<string, readonly MeleeWeaponMove[]> = {
	sword: ['slashDown', 'slashSide', 'slashUp', 'thrust'],
	katana: ['slashDown', 'slashSide', 'slashUp'],
	lightsaber: ['slashDown', 'slashSide', 'slashUp', 'thrust'],
	dagger: ['thrust', 'slashSide', 'slashUp'],
	mace: ['slashDown', 'slashSide'],
	club: ['slashDown', 'slashSide'],
	cleaver: ['slashDown', 'slashSide'],
	longsword: ['heavyChop', 'cleave', 'heavyUp', 'backCleave'],
	// No rising cut for an axe or a hammer: the head is all the way out at the
	// end of the haft, and swinging that up from a crouch has no target it could
	// plausibly reach. They alternate horizontally instead.
	axe: ['heavyChop', 'cleave', 'backCleave'],
	hammer: ['heavyChop', 'cleave', 'backCleave'],
	spear: ['spearThrust', 'cleave', 'backCleave'],
	staff: ['cleave', 'spearThrust', 'backCleave'],
};

/** Custom weapons without a table entry fall back on their preset's grip. */
export const GRIP_FALLBACK_MOVES: Record<'one' | 'two', readonly MeleeWeaponMove[]> = {
	one: ['slashDown', 'slashSide'],
	two: ['heavyChop', 'cleave', 'heavyUp', 'backCleave'],
};

/**
 * Ordered preference for the default attack: a horizontal swipe.
 *
 * Chosen over the other moves because a side cut is the most legible basic
 * attack — its arc crosses the screen, its hit area is the widest, and it reads
 * the same whatever the target's height. Overhead chops and thrusts stay
 * available as named moves for templates that want them.
 */
const HORIZONTAL_SWIPE_PREFERENCE: readonly MeleeWeaponMove[] = [
	'slashSide', 'cleave', 'backCleave',
];

/**
 * The move a single un-named attack should play. The first horizontal swipe the
 * weapon actually has wins; a weapon with none (none of the built-ins) falls
 * back to its first listed move.
 */
export function primaryMoveFor(moves: readonly MeleeWeaponMove[]): MeleeWeaponMove | null {
	for (const preferred of HORIZONTAL_SWIPE_PREFERENCE) {
		if (moves.includes(preferred)) return preferred;
	}
	return moves[0] ?? null;
}

/**
 * The swing set for a weapon id. Matched case- and whitespace-insensitively,
 * the same way `WeaponRegistry` matches the id to its preset — so a template
 * that writes `'Sword'` gets the sword's moves rather than the grip fallback.
 */
export function weaponMovesFor(weaponType: string, grip: 'one' | 'two' | undefined): readonly MeleeWeaponMove[] {
	return WEAPON_TYPE_MOVES[splitWeaponStyleId(weaponType).baseId] ?? GRIP_FALLBACK_MOVES[grip ?? 'one'];
}

/**
 * The move-registration surface of an animation controller. Structural because the two
 * callers reach it through different types — `ICharacterAnimationController` for the
 * player, a narrower host interface for NPCs — and both members are optional because
 * published games ship frozen controllers that predate them.
 */
export interface AttackMoveRegistrar {
	registerCustomAttack?: (move: CustomAttackMove) => boolean;
	unregisterCustomAttack?: (name: string) => boolean;
}

export interface WeaponMoveOptions {
	/** Weapon id, matched against `WEAPON_TYPE_MOVES`. */
	weaponType: string;
	/** Grip of the weapon actually held; picks the fallback set for custom weapons. */
	grip: 'one' | 'two' | undefined;
	/** Namespace for the registered names, so each owner can remove exactly its own
	 *  moves and leave a template's specials alone (`'weapon:'`, `'npc_weapon:'`). */
	namePrefix: string;
	/** Rides each move; what the hit registration reads on contact. */
	damage: number;
	range: number;
	/** True keeps the legs cycling under an upper-body swing during a run. The player
	 *  wants it (you keep control of your feet mid-swing); an NPC plants to strike. */
	splitBodyOnRun: boolean;
}

export interface WeaponMoveRegistration {
	/** Names that actually registered — pass to `unregisterWeaponAttackMoves` on swap.
	 *  Shorter than the weapon's move list when a clip wasn't loaded, and EMPTY when
	 *  none were, which is the caller's signal that this weapon cannot swing. */
	names: string[];
	/** Prefixed name of the weapon's default single attack, or null when it has none. */
	primaryName: string | null;
}

/**
 * Register the grip-appropriate swings for a weapon, so a hammer smashes and a sword
 * slashes. Replaces nothing on its own — call `unregisterWeaponAttackMoves` with the
 * previous result first when swapping weapons, or the old weapon's swings stay in the
 * random-pick pool and a fresh axe keeps slashing like the sword it replaced.
 *
 * Clip availability is NOT pre-filtered here: `registerCustomAttack` already resolves the
 * motionId against the clips actually loaded and warns when one is missing, which catches
 * strictly more than checking a pack's declared ids (it sees load failures too). The
 * returned `names` are the ones that survived that check.
 */
export function registerWeaponAttackMoves(
	registrar: AttackMoveRegistrar,
	options: WeaponMoveOptions,
): WeaponMoveRegistration {
	const moves = weaponMovesFor(options.weaponType, options.grip);
	const primary = primaryMoveFor(moves);
	const registration: WeaponMoveRegistration = {
		names: [],
		primaryName: primary ? `${options.namePrefix}${primary}` : null,
	};
	if (!registrar.registerCustomAttack) return registration;

	for (const key of moves) {
		const name = `${options.namePrefix}${key}`;
		const registered = registrar.registerCustomAttack({
			name,
			animationMotionId: WEAPON_MOVES[key],
			type: 'attack',
			damage: options.damage,
			range: options.range,
			splitBodyOnRun: options.splitBodyOnRun,
			// Physics owns the character's position; swings play in place.
			filterRootMotion: true,
		});
		if (registered) registration.names.push(name);
	}
	return registration;
}

/** Remove moves registered by `registerWeaponAttackMoves`. Empties the array it is given
 *  so a caller cannot unregister the same names twice. */
export function unregisterWeaponAttackMoves(registrar: AttackMoveRegistrar, names: string[]): void {
	for (const name of names) registrar.unregisterCustomAttack?.(name);
	names.length = 0;
}
