import * as THREE from 'three';

/**
 * Draw player-supplied text (names, jersey numbers, decals) into an arbitrary
 * quad of a texture image at runtime.
 *
 * A quad is given by its four corners in NORMALIZED image coordinates
 * (0..1, origin at the texture image's top-left, y down — i.e. plain pixel
 * space divided by width/height, NOT glTF UV space). The corners are in
 * TEXT space: `topLeft` is where the top-left of the rendered text lands in
 * the image. Rotated or mirrored print regions (common in UV atlases) are
 * expressed purely through the corner order — e.g. a quad whose `topLeft`
 * has a larger y than its `bottomLeft` renders the text upside down in the
 * image, which is exactly what a flipped UV island needs.
 *
 * Quads are treated as parallelograms (`topLeft`, `topRight` and `bottomLeft`
 * define the mapping; `bottomRight` is carried for readability and hit-testing).
 */
export interface TextureQuadPoint {
    x: number;
    y: number;
}

export interface TextureTextQuad {
    topLeft: TextureQuadPoint;
    topRight: TextureQuadPoint;
    bottomRight: TextureQuadPoint;
    bottomLeft: TextureQuadPoint;
}

export interface TextureTextStyle {
    /** CSS color of the glyphs. Default `'#151515'` (jersey-print black). */
    fontColor?: string;
    /**
     * CSS color painted over the whole quad before the text, or `null` to
     * leave the existing texels and only draw glyphs. Default `null`.
     */
    backgroundColor?: string | null;
    /** CSS font-family stack. Default is a condensed athletic stack. */
    fontFamily?: string;
    /** CSS font-weight. Default `'bold'`. */
    fontWeight?: string;
    /**
     * Empty margin inside the quad as a fraction of the quad height on every
     * side. Default `0.06`.
     */
    paddingFraction?: number;
}

const DEFAULT_STYLE: Required<TextureTextStyle> = {
    fontColor: '#151515',
    backgroundColor: null,
    fontFamily: "'Arial Narrow', 'Impact', 'Arial', sans-serif",
    fontWeight: 'bold',
    paddingFraction: 0.06,
};

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('TextureTextWriter: could not acquire a 2d canvas context');
    }
    return ctx;
}

/**
 * Set the canvas transform so that text-space (0,0)-(quadW,quadH) maps onto
 * the quad, and return the quad's pixel-space width/height.
 */
function enterQuadSpace(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    quad: TextureTextQuad
): { quadW: number; quadH: number } {
    const w = canvas.width;
    const h = canvas.height;
    const tl = { x: quad.topLeft.x * w, y: quad.topLeft.y * h };
    const tr = { x: quad.topRight.x * w, y: quad.topRight.y * h };
    const bl = { x: quad.bottomLeft.x * w, y: quad.bottomLeft.y * h };
    const quadW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const quadH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    ctx.setTransform(
        (tr.x - tl.x) / quadW,
        (tr.y - tl.y) / quadW,
        (bl.x - tl.x) / quadH,
        (bl.y - tl.y) / quadH,
        tl.x,
        tl.y
    );
    return { quadW, quadH };
}

/**
 * Draw `text` into `quad` on a canvas that holds a texture image.
 *
 * The text is rendered at the quad's full height (minus padding), centered,
 * and horizontally CONDENSED (never wrapped, never vertically shrunk) when it
 * is too wide — matching how long names fit on real jerseys. Works for names
 * and numbers alike; pass numbers as strings (e.g. `'23'`).
 */
export function writeTextInTextureQuad(
    canvas: HTMLCanvasElement,
    quad: TextureTextQuad,
    text: string,
    style?: TextureTextStyle
): void {
    const s = { ...DEFAULT_STYLE, ...style };
    const ctx = get2dContext(canvas);
    ctx.save();
    const { quadW, quadH } = enterQuadSpace(ctx, canvas, quad);
    if (s.backgroundColor !== null) {
        ctx.fillStyle = s.backgroundColor;
        ctx.fillRect(0, 0, quadW, quadH);
    }
    const pad = quadH * s.paddingFraction;
    const availW = quadW - pad * 2;
    const availH = quadH - pad * 2;
    ctx.font = `${s.fontWeight} ${availH}px ${s.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = s.fontColor;
    const textWidth = ctx.measureText(text).width;
    const condense = Math.min(1, availW / Math.max(1, textWidth));
    // Scale horizontally about the quad's center so long text condenses in place.
    const centerX = quadW / 2;
    ctx.transform(condense, 0, 0, 1, centerX * (1 - condense), 0);
    ctx.fillText(text, centerX, quadH / 2);
    ctx.restore();
}

/**
 * Fill a quad with a flat color. Main use: neutralizing a print region in a
 * NORMAL map (`'#8080ff'`) so old embossed text does not show through under
 * lighting after the base-color text is replaced.
 */
export function fillTextureQuad(
    canvas: HTMLCanvasElement,
    quad: TextureTextQuad,
    color: string
): void {
    const ctx = get2dContext(canvas);
    ctx.save();
    const { quadW, quadH } = enterQuadSpace(ctx, canvas, quad);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, quadW, quadH);
    ctx.restore();
}

export interface TextureTextEdit {
    quad: TextureTextQuad;
    text: string;
    style?: TextureTextStyle;
}

/**
 * Copy a texture's image onto a canvas, apply the given text edits, and return
 * a ready-to-assign {@link THREE.CanvasTexture} that inherits the source
 * texture's orientation and color space. The source texture is not modified.
 *
 * Typical use on a loaded GLB character: define the model's print-region
 * quads in game code (they are asset data, measured from the model's UV
 * atlas), then assign the returned texture to `material.map` and set
 * `material.needsUpdate = true`.
 */
export function createTextEditedTexture(
    baseTexture: THREE.Texture,
    edits: TextureTextEdit[]
): THREE.CanvasTexture {
    const image = baseTexture.image as CanvasImageSource & { width: number; height: number };
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    get2dContext(canvas).drawImage(image, 0, 0);
    for (const edit of edits) {
        writeTextInTextureQuad(canvas, edit.quad, edit.text, edit.style);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = baseTexture.flipY;
    texture.colorSpace = baseTexture.colorSpace;
    texture.wrapS = baseTexture.wrapS;
    texture.wrapT = baseTexture.wrapT;
    texture.needsUpdate = true;
    return texture;
}

