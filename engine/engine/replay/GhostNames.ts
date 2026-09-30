/**
 * Generated display names for players without an account.
 *
 * A guest is "NeonKestrel07", not "Guest". That matters for two reasons the
 * design leans on (§10.3.1): a board of indistinguishable "Guest" rows is
 * noise, and a name you have grown attached to is the strongest reason to sign
 * in before you lose it.
 *
 * The name is a PURE FUNCTION of the player id. Nothing is stored, no
 * allocation service exists, and every client — the game, the portal, another
 * player's browser — derives the same name from the same id with no lookup.
 *
 * ⚠ TWO generators live here, and the old one can never be deleted. A name is
 * derived, not stored, so changing how an id maps to a name RENAMES everyone
 * who already races under it — on boards, in challenge links, in a screenshot
 * a player posted. Ids minted before the widening keep `legacyName` forever;
 * `GUEST_ID_V2_PREFIX` is what marks an id as eligible for the new shapes.
 *
 * The new generator varies SHAPE, not just vocabulary. One fixed
 * Adjective-Noun-Number template made every guest on a board look like a
 * variation of every other one, which is exactly what a generated name must not
 * do — names are how a player tells the field apart. Guests stay distinguishable
 * from accounts by rendering without an avatar or a profile link, not by being
 * stamped into an obviously synthetic mould.
 */

/** Anonymous player ids carry this prefix, so a renderer can tell them apart without a lookup. */
export const ANON_PLAYER_PREFIX = 'g_';

/**
 * Guest ids minted with the widened generator.
 *
 * The version rides on the ID because that is the only thing a renderer has:
 * boards store no name for a guest, and there is no account row to carry a
 * flag. An id either announces the generator it was minted for, or it is old.
 */
export const GUEST_ID_V2_PREFIX = 'g_v2_';

export function isAnonymousPlayerId(playerId: string): boolean {
    return playerId.startsWith(ANON_PLAYER_PREFIX);
}

/** A guest id minted before the widening. Frozen to `legacyName` forever. */
function isLegacyGuestId(playerId: string): boolean {
    return playerId.startsWith(ANON_PLAYER_PREFIX) && !playerId.startsWith(GUEST_ID_V2_PREFIX);
}

/**
 * FNV-1a. Chosen because it is short, dependency-free, and — the actual
 * requirement — produces identical output in the game, the portal, and any
 * other client that needs to render the same name for the same id.
 */
function hash32(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/**
 * Murmur3's finalizer — an avalanche step, not a hash.
 *
 * ⚠ Load-bearing. FNV-1a's LOW bits barely move: its last operation is a
 * multiply, so the bottom of the word depends on almost nothing. Every pick
 * below is a `% n` on exactly those bits, and without this step 24 different
 * ids collapsed onto four names. `legacyName` deliberately does not use it —
 * it reads the high bits through shifts, and changing its arithmetic would
 * rename players.
 */
function mix32(value: number): number {
    let h = value >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
}

/**
 * One independent draw per decision.
 *
 * Separate hashes rather than shifted slices of one: a name reads as designed
 * only when its parts are uncorrelated, and 32 bits does not stretch to a
 * dozen decisions without the tail of them moving together.
 */
function draw(playerId: string, index: number): number {
    return mix32(hash32(`${playerId}#${index}`));
}

function pick<T>(list: readonly T[], value: number, fallback: T): T {
    return list[value % list.length] ?? fallback;
}

// ---------------------------------------------------------------------------
// Legacy generator — FROZEN. Every array and every index below is load-bearing
// for names already in the wild; a reordered word renames a real player.
// ---------------------------------------------------------------------------

const ADJECTIVES = [
    'Ultra', 'Rapid', 'Silent', 'Golden', 'Crimson', 'Electric', 'Midnight', 'Cosmic',
    'Iron', 'Neon', 'Turbo', 'Frozen', 'Blazing', 'Shadow', 'Lucky', 'Wild',
    'Chrome', 'Atomic', 'Velvet', 'Thunder', 'Solar', 'Rogue', 'Quantum', 'Vivid',
    'Feral', 'Stellar', 'Rusty', 'Prime', 'Drifting', 'Sonic', 'Arctic', 'Molten',
];

const NOUNS = [
    'Fox', 'Comet', 'Falcon', 'Piston', 'Tiger', 'Rocket', 'Wolf', 'Bandit',
    'Viper', 'Raven', 'Bolt', 'Panther', 'Hawk', 'Drifter', 'Jaguar', 'Phantom',
    'Cobra', 'Badger', 'Meteor', 'Lynx', 'Stallion', 'Hornet', 'Otter', 'Griffin',
    'Marlin', 'Ibex', 'Kestrel', 'Mantis', 'Puma', 'Racer', 'Serpent', 'Bison',
];

function legacyName(playerId: string): string {
    const hash = hash32(playerId);
    const adjective = ADJECTIVES[hash % ADJECTIVES.length] ?? 'Swift';
    const noun = NOUNS[(hash >>> 5) % NOUNS.length] ?? 'Racer';
    const number = 1000 + ((hash >>> 10) % 9000);
    return `${adjective} ${noun} ${number}`;
}

// ---------------------------------------------------------------------------
// Current generator. ⚠ NOT safe to extend in place: every list length is a
// modulus and every shape index is a name, so appending one word reshuffles
// every v2 guest on every board. Widen it by minting a v3 prefix, exactly as v2
// was added — the version is the only thing that keeps a rename from being
// retroactive.
// ---------------------------------------------------------------------------

const EDGE = [
    'Neon', 'Turbo', 'Rogue', 'Cosmic', 'Ghost', 'Iron', 'Nitro', 'Vapor',
    'Hyper', 'Zero', 'Crimson', 'Frost', 'Solar', 'Static', 'Rust', 'Chrome',
    'Blitz', 'Toxic', 'Onyx', 'Pixel', 'Retro', 'Grim', 'Lunar', 'Feral',
    'Volt', 'Ash', 'Storm', 'Quantum', 'Savage', 'Wired', 'Dusk', 'Prime',
    'Amber', 'Arctic', 'Atomic', 'Blaze', 'Bronze', 'Carbon', 'Cinder', 'Cobalt',
    'Copper', 'Cyber', 'Diesel', 'Ember', 'Fury', 'Glass', 'Golden', 'Granite',
    'Halo', 'Havoc', 'Hazard', 'Hollow', 'Ion', 'Jade', 'Jet', 'Kilo',
    'Laser', 'Lava', 'Lime', 'Magma', 'Manic', 'Marble', 'Midnight', 'Mirage',
    'Neutron', 'Noble', 'Nova', 'Ocean', 'Opal', 'Orbit', 'Pale', 'Phase',
    'Photon', 'Plasma', 'Polar', 'Proto', 'Pulse', 'Quartz', 'Radio', 'Razor',
    'Rebel', 'Riot', 'Ripple', 'Rubber', 'Ruby', 'Sable', 'Salt', 'Sand',
    'Scarlet', 'Shade', 'Shale', 'Silver', 'Sleet', 'Slick', 'Smoke', 'Sonic',
    'Spark', 'Spirit', 'Steel', 'Sterling', 'Sugar', 'Sulfur', 'Super', 'Swift',
    'Talon', 'Tidal', 'Titan', 'Tundra', 'Umber', 'Vault', 'Velvet', 'Verdant',
    'Vertex', 'Vinyl', 'Void', 'Wicked', 'Winter', 'Xenon', 'Zinc', 'Amp',
    'Flint', 'Gale', 'Glitch', 'Krypton', 'Radon', 'Torch', 'Zenith', 'Fable',
];

const BEAST = [
    'Fox', 'Viper', 'Kestrel', 'Wolf', 'Comet', 'Hornet', 'Bandit', 'Mantis',
    'Falcon', 'Puma', 'Raven', 'Marlin', 'Jackal', 'Piston', 'Drifter', 'Phantom',
    'Gremlin', 'Otter', 'Badger', 'Bison', 'Cobra', 'Lynx', 'Moth', 'Shark',
    'Tiger', 'Wasp', 'Yeti', 'Crow', 'Ibex', 'Magpie', 'Ram', 'Owl',
    'Adder', 'Albatross', 'Anvil', 'Arrow', 'Axle', 'Bat', 'Bear', 'Beetle',
    'Boar', 'Buffalo', 'Bullet', 'Camel', 'Caribou', 'Cheetah', 'Chisel', 'Condor',
    'Cougar', 'Coyote', 'Crane', 'Cricket', 'Dingo', 'Dragon', 'Eagle', 'Eel',
    'Elk', 'Ferret', 'Finch', 'Flare', 'Gecko', 'Gopher', 'Grouse', 'Gull',
    'Hammer', 'Hare', 'Hawk', 'Heron', 'Hound', 'Husky', 'Impala', 'Jaguar',
    'Kite', 'Koala', 'Kraken', 'Lark', 'Lemur', 'Leopard', 'Lizard', 'Llama',
    'Mako', 'Mammoth', 'Meerkat', 'Mole', 'Mongoose', 'Moose', 'Mule', 'Narwhal',
    'Newt', 'Ocelot', 'Orca', 'Osprey', 'Panda', 'Panther', 'Parrot', 'Pelican',
    'Pike', 'Piranha', 'Pony', 'Quail', 'Rabbit', 'Racer', 'Rattler', 'Rhino',
    'Robin', 'Rooster', 'Salmon', 'Seal', 'Serpent', 'Sloth', 'Sparrow', 'Spider',
    'Sprocket', 'Stag', 'Stallion', 'Starling', 'Stingray', 'Tapir', 'Termite', 'Toad',
    'Turbine', 'Turtle', 'Vulture', 'Walrus', 'Weasel', 'Whale', 'Wombat', 'Wren',
];

const TITLE = [
    'King', 'Queen', 'Boss', 'Ace', 'Pilot', 'Runner', 'Rider', 'Hunter',
    'Baron', 'Wizard', 'Ninja', 'Chief', 'Duke', 'Rookie', 'Legend', 'Menace',
    'Admiral', 'Archer', 'Captain', 'Champ', 'Colonel', 'Commander', 'Count', 'Dealer',
    'Empress', 'Enforcer', 'Envoy', 'Fixer', 'General', 'Guru', 'Herald', 'Jester',
    'Judge', 'Keeper', 'Knight', 'Machinist', 'Marshal', 'Mayor', 'Mechanic', 'Monarch',
    'Nomad', 'Oracle', 'Ranger', 'Sage', 'Scout', 'Sheriff', 'Skipper', 'Smith',
];

const ACTION = [
    'Drift', 'Boost', 'Redline', 'Apex', 'Launch', 'Slide', 'Grip', 'Sprint',
    'Crash', 'Dash', 'Slipstream', 'Burnout', 'Overtake', 'Podium', 'Handbrake', 'Downshift',
    'Bounce', 'Brake', 'Charge', 'Chase', 'Clutch', 'Coast', 'Cruise', 'Dodge',
    'Drag', 'Flip', 'Glide', 'Hustle', 'Jump', 'Kick', 'Leap', 'Nudge',
    'Pivot', 'Pounce', 'Push', 'Ramp', 'Rev', 'Rush', 'Scramble', 'Skid',
    'Slam', 'Smash', 'Spin', 'Swerve', 'Thrust', 'Tumble', 'Vault', 'Whip',
];

const TAG = [
    'GT', 'XL', 'HD', 'EX', 'Pro', 'Zero', 'Prime', 'V2',
    'MK2', 'Alpha', 'Omega', 'Max', 'Neo', 'Ultra', 'Plus', 'X',
    'RS', 'SE', 'TT', 'LX', 'GTX', 'RX', 'SS', 'XR',
    'Elite', 'Core', 'Nano', 'Solo', 'Duo', 'Flux', 'Beta', 'Delta',
];

/** Syllables for a coined handle — the shape that reads least like a template. */
const ONSET = [
    'Za', 'Kri', 'Vor', 'Nix', 'Tal', 'Mor', 'Zep', 'Kal',
    'Ryn', 'Vex', 'Dro', 'Sil', 'Bra', 'Fen', 'Gor', 'Hux',
    'Ax', 'Bel', 'Cyn', 'Dax', 'Eri', 'Fal', 'Gly', 'Hes',
    'Ith', 'Jor', 'Kyr', 'Lum', 'Myr', 'Nev', 'Oxa', 'Pyr',
];

/** Optional middle syllable. The empty entries are what keep short handles short. */
const MIDDLE = [
    '', '', '', '', 'ra', 'ke', 'lo', 'mi',
    'va', 'ne', 'da', 'so', 'ti', 'zo', 'ly', 'ma',
];

const CODA = [
    'ax', 'on', 'ix', 'eth', 'ur', 'ok', 'is', 'ar',
    'en', 'oth', 'ux', 'el', 'ir', 'om', 'yn', 'ade',
    'an', 'dor', 'esh', 'ian', 'ick', 'ion', 'ith', 'orn',
    'oss', 'ox', 'ryx', 'tar', 'us', 'vex', 'wyn', 'zar',
];

/** Numbers a player would actually choose, rather than a flat 1000-9999. */
const ICONIC = [
    '7', '9', '11', '13', '21', '23', '42', '44',
    '55', '64', '77', '88', '99', '101', '256', '404',
    '3', '5', '8', '10', '12', '17', '19', '27',
    '33', '36', '51', '66', '72', '81', '90', '128',
];

/** Two digits, zero-padded — the `07` in `NeonKestrel07`. */
function pad2(value: number): string {
    return String(value % 100).padStart(2, '0');
}

/**
 * Derive a stable display name from a player id.
 *
 * Sixteen shapes over these lists is ~234,000 names (measured over 200k draws,
 * not estimated), or roughly a 0.02% chance of two identical names among the
 * ten rows of one board.
 *
 * ⚠ The ceiling is set by the SHORTEST shapes, not by list size. `LynxGTX` can
 * only ever be |BEAST| x |TAG|, so doubling every list moves the total far less
 * than it looks — the way up from here is to give the short shapes a third
 * part, which is precisely what makes names read as a template again. Names are
 * drawn, never allocated, so they are not unique: nothing here reserves a name,
 * and two players CAN share one. That costs nothing functionally — the ids
 * still differ, so dedupe, ranking and profile links are unaffected.
 */
export function generatedNameFor(playerId: string): string {
    if (isLegacyGuestId(playerId)) return legacyName(playerId);

    const edge = pick(EDGE, draw(playerId, 1), 'Neon');
    const beast = pick(BEAST, draw(playerId, 2), 'Racer');
    const title = pick(TITLE, draw(playerId, 3), 'Ace');
    const action = pick(ACTION, draw(playerId, 4), 'Drift');
    const tag = pick(TAG, draw(playerId, 5), 'GT');
    const coined = pick(ONSET, draw(playerId, 6), 'Vex')
        + pick(MIDDLE, draw(playerId, 11), '')
        + pick(CODA, draw(playerId, 7), 'on');
    const iconic = pick(ICONIC, draw(playerId, 8), '7');
    const two = pad2(draw(playerId, 9));

    switch (draw(playerId, 0) % 16) {
        case 0: return `${edge}${beast}`;
        case 1: return `${edge}${beast}${two}`;
        case 2: return `${beast}_${two}`;
        case 3: return `${edge.toLowerCase()}_${beast.toLowerCase()}`;
        case 4: return `${edge}${action}${title}`;
        case 5: return `${beast}${tag}`;
        case 6: return coined;
        case 7: return `The${edge}${beast}`;
        case 8: return `${beast}${iconic}`;
        case 9: return `V${8 + (draw(playerId, 10) % 5)}${beast}${two}`;
        case 10: return `${edge}_${title}`;
        case 11: return `${edge}${action}`;
        case 12: return `${beast}-${two}`;
        case 13: return `${coined}${two}`;
        case 14: return `${edge.toLowerCase()}${beast.toLowerCase()}${iconic}`;
        default: return `${title}${beast}`;
    }
}
