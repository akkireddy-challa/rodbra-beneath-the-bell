/**
 * Is this asset still a World-Forger stand-in, i.e. should the Object Inspector offer
 * "Generate high-quality version"?
 *
 * Three states have to be told apart from what the asset carries:
 *
 *  1. `placeholder: true` — a current forger bake. Offer it.
 *  2. `placeholder: false` (or absent) WITH a description — regenerated, or authored
 *     high-quality to begin with. Do not offer it again.
 *  3. `placeholder: false` (or absent) WITHOUT a description — a legacy forger bake.
 *     Offer it. These are levels forged before the flag existed, plus everything from
 *     the period when the flag was gated on the designer having written a description
 *     (which stripped the upgrade path from most forged objects). `fitBox` +
 *     `sourceGlbUrl` are the affordances the forger has always stored, so together
 *     they identify a forge bake.
 *
 * Case 3 is only unambiguous because a regeneration always ends up WITH a description:
 * the HQ job carries the generation prompt onto the asset (hq-asset-jobs.ts). Without
 * that, a regenerated asset would look exactly like a legacy stand-in and would keep
 * being offered forever.
 */
export interface PlaceholderAssetFields {
    placeholder?: boolean;
    description?: string;
    fitBox?: { x: number; z: number; height: number };
    sourceGlbUrl?: string;
}

export function isPlaceholderAsset(asset: PlaceholderAssetFields): boolean {
    if (asset.placeholder === true) return true;
    const forgeBaked = !!asset.fitBox && !!asset.sourceGlbUrl;
    return forgeBaked && !asset.description?.trim();
}
