// Shared renderer for the visible content of an engine-built button: an
// optional image, an optional text label, or both. Used by the HUD action rows
// (GameHUD.createActionRow) and the mobile touch buttons (MobileControls), so
// both accept images the same way instead of each setting `textContent` and
// silently dropping anything that isn't text.

/** What a button shows. `label` is always the accessible name, visible or not. */
export interface ButtonContent {
    label?: string;
    /** Image URL (PNG/SVG/WebP…) shown ahead of the label; null/empty for none. */
    imageUrl?: string | null;
    /** Show only the image — the label stays as the accessible name. */
    imageOnly?: boolean;
}

/**
 * Replace a button's children with `content`. Element classes are
 * `<block>__image` / `<block>__label`, and the button gets `<block>--image-only`
 * when the image stands alone (so CSS can square it and let the image fill it).
 */
export function renderButtonContent(button: HTMLButtonElement, block: string, content: ButtonContent): void {
    const label = content.label ?? '';
    const imageUrl = content.imageUrl || null;
    // No image to stand in for it, so the label shows even when imageOnly is set.
    const imageOnly = imageUrl !== null && (content.imageOnly === true || label === '');

    button.replaceChildren();
    if (imageUrl) {
        const img = document.createElement('img');
        img.className = `${block}__image`;
        img.src = imageUrl;
        // Decorative: the button's aria-label carries the name.
        img.alt = '';
        img.draggable = false;
        button.appendChild(img);
    }
    if (!imageOnly && label) {
        const span = document.createElement('span');
        span.className = `${block}__label`;
        span.textContent = label;
        button.appendChild(span);
    }
    button.classList.toggle(`${block}--image-only`, imageOnly);
    if (label) button.setAttribute('aria-label', label);
    else button.removeAttribute('aria-label');
}
