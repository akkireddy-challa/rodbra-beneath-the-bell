/**
 * High-resolution voxel masters: read one, resample it to a requested size.
 *
 * A voxel asset forged by TRELLIS.2 has no mesh behind it, so there is no GLB to
 * re-voxelize when someone changes an object's height or voxel size. The master
 * takes that role: TRELLIS's own grid (512³ and up), stored once, downsampled
 * for every size after that.
 *
 * Storing it instead of the GLB is what makes this worth doing. Measured on two
 * forged objects, the master is 0.4-0.9 MB against the 50-100 MB GLB it
 * replaces, and resampling from the stored copy matches resampling from the raw
 * generator output exactly — 0 occupancy and 0 colour differences.
 *
 * Deliberately free of engine imports so the dataset tooling in
 * `character-forger/datagen` can use this same file rather than keeping a second
 * implementation that drifts.
 */

/** `'HFVX'` little-endian. */
const MAGIC = 0x58_56_46_48;
const HEADER_SIZE = 16;
/** v2 colorFormat values. v1 files predate the byte and are always RGB444. */
const COLOR_RGB444 = 0;
const COLOR_RGB888 = 1;

/** Refuse a height/voxel-size pair that would ask for an unreasonable grid. */
export const MAX_RESAMPLE_SIZE = 512;

/**
 * Index of the world-up axis in a master's coordinate triple.
 *
 * The engine is Y-up and reads leaf coordinates literally
 * (`VoxelOctreeRenderer.worldY` is `gy * minVoxelSize + baseY`), and the forge
 * writes masters to match. Verified by rendering an object whose up direction is
 * unarguable — a hydrant, a building. Two traps live here: a relabel is a
 * permutation, so byte-level round-trips pass on a model lying on its side; and
 * the longest axis is not the up axis, so picking up by extent reads an owl's
 * beak-to-nape length as its height.
 */
export const MASTER_UP_AXIS = 1;

export interface VoxelMaster {
  /** Grid resolution the coordinates are expressed in. */
  readonly resolution: number;
  readonly x: Uint16Array;
  readonly y: Uint16Array;
  readonly z: Uint16Array;
  /**
   * Packed `0xRRGGBB` per voxel, parallel to the coordinate arrays — for BOTH
   * file versions (v1 RGB444 nibbles expand x17 at read). Callers never see the
   * stored precision, so the palette decision stays with whoever writes output:
   * the .vxl importer quantizes to the engine palette itself, and a future
   * RGB565 atlas would change importers, never stored masters.
   */
  readonly color: Uint32Array;
  readonly count: number;
}

export interface MasterExtents {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Cell counts per axis, i.e. `max - min + 1`. */
  readonly span: readonly [number, number, number];
}

export interface ResampleOptions {
  /**
   * A per-master-voxel label (a smart-object part joint) to carry into the
   * working grid by majority vote per cell — the same vote colour takes in
   * `mode`, so a cell that is mostly blade is blade. Length must equal
   * `master.count`.
   */
  attribute?: Uint8Array;
  /** Object height in world units. Other axes follow, preserving proportions. */
  readonly targetHeight: number;
  /** Voxel edge length in world units. */
  readonly voxelSize: number;
  /**
   * How to combine master voxels landing in one target cell.
   *
   * `mode` keeps the palette crisp, which suits blocky assets: at a boundary
   * between a red roof and a grey wall it picks one, where `mean` yields a muddy
   * brown belonging to neither.
   */
  readonly colorMode: 'mode' | 'mean';
}

export const DEFAULT_RESAMPLE_COLOR_MODE: ResampleOptions['colorMode'] = 'mode';

export interface ResampledVoxels {
  /**
   * Master voxel → working cell mapping, so a point given in master grid
   * coordinates (a smart-object pivot, a light) lands on the same lattice the
   * cells did: `cell = (point - masterMin) * scale`.
   */
  masterMin: [number, number, number];
  scale: number;
  /**
   * Per-cell majority of `ResampleOptions.attribute`, parallel to `x/y/z`;
   * absent when no attribute was given.
   */
  attribute?: Uint8Array;
  readonly x: Uint16Array;
  readonly y: Uint16Array;
  readonly z: Uint16Array;
  /** `0xRRGGBB` bytes, ready for `compileVoxelModelToVxlAsset`. */
  readonly color: Uint32Array;
  readonly count: number;
  /** Occupied cells along each axis. */
  readonly dimensions: readonly [number, number, number];
  readonly voxelSize: number;
}

/**
 * Parse an HFVX master.
 *
 * The header exists because the first version did not have one: coordinates were
 * `u8` with the resolution implied by the filename, so at 512³ every axis
 * wrapped mod 256 and folded the object onto itself eight times. The file size
 * was right, and a reader sharing the writer's assumption round-tripped the
 * corruption perfectly. Coordinate width now travels with the data.
 *
 *     magic 'HFVX' | version u8 | coordBytes u8 | pad u16 | grid u32 | count u32
 *     then columnar x | y | z | colour(u16 LE)
 */
export function readVoxelMaster(buffer: ArrayBuffer): VoxelMaster {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_SIZE || view.getUint32(0, true) !== MAGIC) {
    throw new Error('Not an HFVX voxel master');
  }
  const version = view.getUint8(4);
  if (version !== 1 && version !== 2) throw new Error(`Unsupported HFVX version ${version}`);
  const colorFormat = version === 2 ? view.getUint8(6) : COLOR_RGB444;
  if (colorFormat !== COLOR_RGB444 && colorFormat !== COLOR_RGB888) {
    throw new Error(`Unsupported HFVX color format ${colorFormat}`);
  }

  const coordBytes = view.getUint8(5);
  if (coordBytes !== 1 && coordBytes !== 2) {
    throw new Error(`Unsupported HFVX coordinate width ${coordBytes}`);
  }
  const resolution = view.getUint32(8, true);
  const count = view.getUint32(12, true);

  const colorBytes = colorFormat === COLOR_RGB888 ? 3 : 2;
  const expected = HEADER_SIZE + count * (3 * coordBytes + colorBytes);
  if (buffer.byteLength !== expected) {
    throw new Error(`HFVX length ${buffer.byteLength}, expected ${expected} for ${count} voxels`);
  }

  const axis = (index: number): Uint16Array => {
    const offset = HEADER_SIZE + index * count * coordBytes;
    const out = new Uint16Array(count);
    if (coordBytes === 1) {
      const bytes = new Uint8Array(buffer, offset, count);
      for (let i = 0; i < count; i++) out[i] = bytes[i]!;
      return out;
    }
    // Read through the DataView rather than aliasing a Uint16Array: the header
    // keeps the body 2-byte aligned today, but a misaligned view throws and the
    // cost here is once per asset.
    for (let i = 0; i < count; i++) out[i] = view.getUint16(offset + i * 2, true);
    return out;
  };

  const colorOffset = HEADER_SIZE + 3 * count * coordBytes;
  const color = new Uint32Array(count);
  if (colorFormat === COLOR_RGB888) {
    // Columnar r | g | b planes.
    for (let i = 0; i < count; i++) {
      color[i] = (view.getUint8(colorOffset + i) << 16)
        | (view.getUint8(colorOffset + count + i) << 8)
        | view.getUint8(colorOffset + 2 * count + i);
    }
  } else {
    for (let i = 0; i < count; i++) {
      const packed = view.getUint16(colorOffset + i * 2, true);
      color[i] = ((((packed >> 8) & 0xf) * 17) << 16)
        | ((((packed >> 4) & 0xf) * 17) << 8)
        | ((packed & 0xf) * 17);
    }
  }

  return { resolution, x: axis(0), y: axis(1), z: axis(2), color, count };
}

export function masterExtents(master: VoxelMaster): MasterExtents {
  if (master.count === 0) throw new Error('Voxel master is empty');
  const axes = [master.x, master.y, master.z];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let a = 0; a < 3; a++) {
    const values = axes[a]!;
    for (let i = 0; i < master.count; i++) {
      const v = values[i]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max, span: [max[0]! - min[0]! + 1, max[1]! - min[1]! + 1, max[2]! - min[2]! + 1] };
}

/**
 * Packed RGB444 -> the `0xRRGGBB` triple the importer expects.
 *
 * A plain nibble expansion (x17). No colour-space conversion belongs here:
 * TRELLIS's albedo is already sRGB, which is what the importer documents its
 * input as. Measured against the image a cottage was forged from, as-is lands
 * within 8/255 and converting puts it 111/255 out.
 */
export function rgb444ToImporterBytes(packed: number): number {
  const r = ((packed >> 8) & 0xf) * 17;
  const g = ((packed >> 4) & 0xf) * 17;
  const b = (packed & 0xf) * 17;
  return (r << 16) | (g << 8) | b;
}

/**
 * Downsample a master to the requested world size.
 *
 * Only ever merges cells, so a shell closed at master resolution stays closed at
 * every coarser one. Upsampling is refused rather than interpolated — asking for
 * more detail than the master holds should re-forge, not invent.
 */
export function resampleMaster(master: VoxelMaster, options: ResampleOptions): ResampledVoxels {
  const { targetHeight, voxelSize, colorMode, attribute } = options;
  if (!(targetHeight > 0) || !(voxelSize > 0)) {
    throw new Error('targetHeight and voxelSize must both be positive');
  }
  if (attribute && attribute.length !== master.count) {
    throw new Error(`attribute has ${attribute.length} entries for ${master.count} voxels`);
  }

  const extents = masterExtents(master);
  const spanUp = extents.span[MASTER_UP_AXIS]!;
  const targetUp = Math.max(1, Math.round(targetHeight / voxelSize));
  const scale = targetUp / spanUp;

  if (scale > 1) {
    throw new Error(
      `${targetUp} voxels tall exceeds the master's ${spanUp} — re-forge at a higher resolution `
      + 'rather than upsampling');
  }

  const dimensions: [number, number, number] = [
    Math.max(1, Math.ceil(extents.span[0]! * scale)),
    Math.max(1, Math.ceil(extents.span[1]! * scale)),
    Math.max(1, Math.ceil(extents.span[2]! * scale)),
  ];
  const size = Math.max(dimensions[0], dimensions[1], dimensions[2]);
  if (size > MAX_RESAMPLE_SIZE) {
    throw new Error(
      `height ${targetHeight} at voxel size ${voxelSize} needs a ${size}³ grid `
      + `(limit ${MAX_RESAMPLE_SIZE}) — use a larger voxel size`);
  }

  // Group by target cell via a sort. Cost tracks the master's voxel count rather
  // than the grid volume, which matters because a master holds ~1M voxels.
  const axes = [master.x, master.y, master.z];
  const cellOf = new Int32Array(master.count);
  for (let i = 0; i < master.count; i++) {
    const tx = Math.min(dimensions[0] - 1, Math.floor((axes[0]![i]! - extents.min[0]!) * scale));
    const ty = Math.min(dimensions[1] - 1, Math.floor((axes[1]![i]! - extents.min[1]!) * scale));
    const tz = Math.min(dimensions[2] - 1, Math.floor((axes[2]![i]! - extents.min[2]!) * scale));
    cellOf[i] = (tz * size + ty) * size + tx;
  }

  const order = new Uint32Array(master.count);
  for (let i = 0; i < master.count; i++) order[i] = i;
  order.sort((a, b) => cellOf[a]! - cellOf[b]! || master.color[a]! - master.color[b]!);

  // Sized to the master's voxel count, which is the hard upper bound on distinct
  // target cells, then trimmed. Typed throughout — boxed arrays have no place on
  // a path that routinely handles a million voxels.
  const outX = new Uint16Array(master.count);
  const outY = new Uint16Array(master.count);
  const outZ = new Uint16Array(master.count);
  const outColor = new Uint32Array(master.count);
  const outAttribute = attribute ? new Uint8Array(master.count) : null;
  let n = 0;

  for (let start = 0; start < order.length;) {
    const cell = cellOf[order[start]!]!;
    let end = start;
    while (end < order.length && cellOf[order[end]!] === cell) end++;

    outX[n] = cell % size;
    outY[n] = Math.floor(cell / size) % size;
    outZ[n] = Math.floor(cell / (size * size));
    outColor[n] = colorMode === 'mean'
      ? meanColor(master.color, order, start, end)
      : modeColor(master.color, order, start, end);
    if (outAttribute) outAttribute[n] = majorityAttribute(attribute!, order, start, end);
    n++;
    start = end;
  }

  return {
    x: outX.subarray(0, n),
    y: outY.subarray(0, n),
    z: outZ.subarray(0, n),
    color: outColor.subarray(0, n),
    count: n,
    dimensions,
    voxelSize,
    masterMin: [extents.min[0]!, extents.min[1]!, extents.min[2]!],
    scale,
    ...(outAttribute ? { attribute: outAttribute.subarray(0, n) } : {}),
  };
}

/** Most frequent attribute value among `order[start..end)`; ties break to the lowest value. */
function majorityAttribute(attribute: Uint8Array, order: Uint32Array, start: number, end: number): number {
  const counts = new Map<number, number>();
  for (let i = start; i < end; i++) {
    const value = attribute[order[i]!]!;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = 0, bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) { best = value; bestCount = count; }
  }
  return best;
}

/** Longest run of one colour in the group, which is pre-sorted by colour. */
function modeColor(colors: Uint32Array, order: Uint32Array, start: number, end: number): number {
  let best = colors[order[start]!]!;
  let bestRun = 0;
  let current = best;
  let run = 0;
  for (let i = start; i < end; i++) {
    const c = colors[order[i]!]!;
    run = c === current ? run + 1 : 1;
    current = c;
    if (run > bestRun) { bestRun = run; best = c; }
  }
  return best;
}

/** Per-channel mean over 0xRRGGBB. No palette here — that belongs to importers. */
function meanColor(colors: Uint32Array, order: Uint32Array, start: number, end: number): number {
  let r = 0, g = 0, b = 0;
  for (let i = start; i < end; i++) {
    const c = colors[order[i]!]!;
    r += (c >> 16) & 0xff;
    g += (c >> 8) & 0xff;
    b += c & 0xff;
  }
  const n = end - start;
  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
}
