/**
 * VoxelAnimalRegistry — resolves a free-form animal type (e.g. "wolf",
 * "penguin", "lion cub") to one of the voxel animal GLB files in the pack.
 *
 * The roster (VOXEL_ANIMAL_FILES) is generated from the voxelized output dir by
 * tools/voxelize-animals.js. Files are flat, named like "Wolf_01.glb",
 * "Bear_Cub_02.glb", "Pinguin_Emperor.glb". This module builds a normalized
 * index once and fuzzy-matches requests against it so game/agent code can keep
 * asking for animals by plain name without knowing exact filenames.
 */

import { VOXEL_ANIMAL_FILES } from 'engine/animal/voxelAnimalFiles.js';
import { VOXEL_FISH_FILES } from 'engine/animal/voxelFishFiles.js';

// Age/sex qualifiers — an entry carrying one of these is de-prioritised unless
// the request explicitly asks for it, so "deer" → Deer_01, not Deer_Cub_01.
const AGE_SEX_TOKENS = new Set(['cub', 'cubs', 'baby', 'calf', 'foal', 'female', 'male', 'adult']);

// Common request spellings/synonyms → the pack's spelling (normalized, no
// separators). Applied to the whole normalized query before matching.
const SYNONYMS: Record<string, string> = {
    penguin: 'pinguin',
    kitten: 'kitty',
    puppy: 'dog',
    pup: 'dog',
    doggy: 'dog',
    croc: 'crocodile',
    alligator: 'crocodile',
    gator: 'crocodile',
    ape: 'gorilla',
    llama: 'lama',
    kangaroo: 'kangoroo',
    rhino: 'rhinoceros',
    hippo: 'hippopotamus',
    racoon: 'raccoon',
    bunny: 'rabbit',
    chook: 'chicken',
    hen: 'chicken',
    rooster: 'chicken',
};

interface RegistryEntry {
    file: string;
    speciesKey: string; // normalized species, variant stripped (e.g. "bearcub")
    tokens: string[];   // species words (camelCase + underscore split, e.g. [manta, ray])
    variantNum: number; // trailing _NN, or 0
    isAgeSex: boolean;  // carries an age/sex qualifier (cub/female/…)
    isFish: boolean;    // aquatic creature (from the fish pack) → swims, served from the fish base URL
}

function lettersOnly(s: string): string {
    return s.toLowerCase().replace(/[^a-z]/g, '');
}

// Split a name into species words, breaking on whitespace/underscores AND
// camelCase ("Lion Cub" / "Bear_Cub" / "SeaTurtle" / "GreateWhiteShark" →
// [...]). Used for BOTH entry filenames and incoming requests, so a request
// like "SeaTurtle" matches a "*Turtle" entry on the shared word.
function splitWords(s: string): string[] {
    return s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^a-zA-Z]+/)
        .map((w) => w.toLowerCase())
        .filter(Boolean);
}

function buildEntry(file: string, isFish: boolean): RegistryEntry {
    const stem = file.replace(/\.glb$/i, '');
    const rawParts = stem.split('_');
    // Strip a trailing pure-number variant (e.g. Bear_Cub_02 → Bear_Cub).
    let variantNum = 0;
    const last = rawParts[rawParts.length - 1];
    if (last !== undefined && /^\d+$/.test(last)) {
        variantNum = parseInt(last, 10);
        rawParts.pop();
    }
    const baseStem = rawParts.join('_');
    const tokens = splitWords(baseStem);
    return {
        file,
        speciesKey: lettersOnly(baseStem),
        tokens,
        variantNum,
        isAgeSex: tokens.some((t) => AGE_SEX_TOKENS.has(t)),
        isFish,
    };
}

const ENTRIES: RegistryEntry[] = [
    ...VOXEL_ANIMAL_FILES.map((f) => buildEntry(f, false)),
    ...VOXEL_FISH_FILES.map((f) => buildEntry(f, true)),
];

function scoreEntry(entry: RegistryEntry, q: string, qTokens: string[], wantsAgeSex: boolean): number {
    const sk = entry.speciesKey;
    // Whole-key score: exact / prefix / substring of the joined species key.
    let joined: number;
    if (sk === q) joined = 1000;
    else if (sk.startsWith(q)) joined = 880;
    else if (q.startsWith(sk)) joined = 820;
    else if (sk.includes(q)) joined = 700;
    else if (q.includes(sk)) joined = 640;
    else joined = 0;

    // Word-overlap score: lets multi-word requests match on a shared word,
    // especially the head noun ("Sea Turtle" → a *Turtle, "Great White Shark"
    // → a *Shark) even when the joined keys don't substring-match.
    let token = 0;
    const shared = qTokens.filter((t) => entry.tokens.includes(t)).length;
    if (shared > 0) {
        const headMatch = entry.tokens.includes(qTokens[qTokens.length - 1] ?? '');
        token = (headMatch ? 600 : 460) + (shared - 1) * 40;
    }

    let score = Math.max(joined, token);
    if (score === 0) return 0;
    // De-prioritise cub/female/… unless the request asked for that qualifier.
    if (entry.isAgeSex && !wantsAgeSex) score -= 300;
    return score;
}

/** A resolved voxel body: which GLB to load and whether it's an aquatic fish. */
export interface ResolvedVoxelAnimal {
    file: string;    // basename, e.g. "Wolf_01.glb" / "Clownfish.glb"
    isFish: boolean; // aquatic → swims, served from the fish base URL
}

function resolveEntry(animalType: string): RegistryEntry | null {
    const rawTokens = splitWords(animalType);
    if (rawTokens.length === 0) return null;
    // Substitute synonyms per token; keep the tokens AND the joined key.
    const qTokens = rawTokens.map((t) => SYNONYMS[t] ?? t);
    const q = qTokens.join('');
    const wantsAgeSex = rawTokens.some((t) => AGE_SEX_TOKENS.has(t));

    let best: RegistryEntry | null = null;
    let bestScore = 0;
    for (const entry of ENTRIES) {
        const score = scoreEntry(entry, q, qTokens, wantsAgeSex);
        if (score <= 0) continue;
        if (
            score > bestScore ||
            (score === bestScore && best !== null && isPreferred(entry, best))
        ) {
            best = entry;
            bestScore = score;
        }
    }
    return best;
}

/**
 * Resolve an animal type to a voxel body (GLB filename + whether it's a fish),
 * or null when nothing in the packs is a close match (e.g. "dragon", "octopus")
 * — null tells the caller to fall back to the block-composed animal system.
 */
export function resolveVoxelAnimal(animalType: string): ResolvedVoxelAnimal | null {
    const best = resolveEntry(animalType);
    return best ? { file: best.file, isFish: best.isFish } : null;
}

/** Convenience: just the filename (null if no close match). */
export function resolveVoxelAnimalFile(animalType: string): string | null {
    return resolveEntry(animalType)?.file ?? null;
}

// Tie-break between equal-scoring entries: lowest variant number, then shortest
// species key, then alphabetical filename — so generic queries land on the
// canonical "_01" of the plainest species variant.
function isPreferred(candidate: RegistryEntry, current: RegistryEntry): boolean {
    if (candidate.variantNum !== current.variantNum) return candidate.variantNum < current.variantNum;
    if (candidate.speciesKey.length !== current.speciesKey.length) {
        return candidate.speciesKey.length < current.speciesKey.length;
    }
    return candidate.file < current.file;
}
