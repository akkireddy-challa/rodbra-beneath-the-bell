// The Bitmagic watermark of a published game, and where it is allowed to show.
//
// Publishing injects the watermark into the document as a fixed bottom-right
// link (PublishController → `#bitmagic-branding`). On a touch device that
// corner is exactly where the on-screen controls sit, so a thumb aiming for a
// control opened bitmagic.ai instead. The publish snippet therefore hides the
// corner watermark under `@media (pointer: coarse)`, and the pause card shows
// the logo under the *same* query (see `.pause-screen-brand` in modalCard.ts).
// Keep those two rules exact complements: the branding then appears once on
// every device, never twice and never not at all.
//
// The injected node is also the single source for the logo URL — a game
// published with the watermark switched off has no node, so it gets no logo in
// the pause card either.

/** Destination of every Bitmagic branding link, corner watermark included. */
export const BITMAGIC_URL = 'https://bitmagic.ai/';

/**
 * URL of the watermark logo of the running published game, or `null` when this
 * build carries no watermark (creator preview, dev server, watermark opted out).
 */
export function getBitmagicLogoUrl(): string | null {
    if (typeof document === 'undefined') return null;
    const src = document.querySelector<HTMLImageElement>('#bitmagic-branding img')?.getAttribute('src');
    return src ? src : null;
}
