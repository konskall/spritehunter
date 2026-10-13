export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(data: Uint8Array) {
  // PNG IDAT is a zlib stream, which the Compression Streams API calls "deflate".
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decodes the 8-bit, non-interlaced PNGs that WMS servers return (RGBA, RGB or
 * palette) using only platform APIs, so it runs in Workers, Node and browsers.
 */
export async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  if (bytes.length < 8 || SIGNATURE.some((value, index) => bytes[index] !== value)) throw new Error("Not a PNG image.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    if (start + length > bytes.length) throw new Error("Truncated PNG chunk.");
    const body = bytes.subarray(start, start + length);
    if (type === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const bitDepth = body[8];
      colorType = body[9];
      if (bitDepth !== 8 || body[12] !== 0 || ![2, 3, 6].includes(colorType)) {
        throw new Error(`Unsupported PNG format (bit depth ${bitDepth}, colour type ${colorType}, interlace ${body[12]}).`);
      }
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset = start + length + 4;
  }
  if (!width || !height || !idat.length) throw new Error("PNG has no image data.");
  if (colorType === 3 && !palette) throw new Error("Palette PNG without PLTE chunk.");

  const compressed = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of idat) { compressed.set(part, cursor); cursor += part.length; }
  const raw = await inflate(compressed);

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("Truncated PNG image data.");
  const pixels = new Uint8Array(height * stride);
  // One tight loop per filter type: a per-byte branch on the filter was ~4× slower.
  // Uint8Array stores wrap modulo 256, which is exactly PNG's byte arithmetic.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    const previous = row - stride;
    const first = y === 0;
    switch (filter) {
      case 0:
        pixels.set(raw.subarray(source, source + stride), row);
        break;
      case 1:
        for (let x = 0; x < channels; x += 1) pixels[row + x] = raw[source + x];
        for (let x = channels; x < stride; x += 1) pixels[row + x] = raw[source + x] + pixels[row + x - channels];
        break;
      case 2:
        if (first) pixels.set(raw.subarray(source, source + stride), row);
        else for (let x = 0; x < stride; x += 1) pixels[row + x] = raw[source + x] + pixels[previous + x];
        break;
      case 3:
        for (let x = 0; x < channels; x += 1) pixels[row + x] = raw[source + x] + (first ? 0 : pixels[previous + x] >> 1);
        for (let x = channels; x < stride; x += 1) {
          pixels[row + x] = raw[source + x] + ((pixels[row + x - channels] + (first ? 0 : pixels[previous + x])) >> 1);
        }
        break;
      case 4:
        for (let x = 0; x < channels; x += 1) pixels[row + x] = raw[source + x] + (first ? 0 : pixels[previous + x]);
        for (let x = channels; x < stride; x += 1) {
          const a = pixels[row + x - channels];
          const b = first ? 0 : pixels[previous + x];
          const c = first ? 0 : pixels[previous + x - channels];
          pixels[row + x] = raw[source + x] + paeth(a, b, c);
        }
        break;
      default:
        throw new Error(`Invalid PNG filter ${filter}.`);
    }
  }

  if (channels === 4) return { width, height, data: pixels };
  const count = width * height;
  const data = new Uint8Array(count * 4);
  if (channels === 3) {
    for (let index = 0, source = 0, target = 0; index < count; index += 1, source += 3, target += 4) {
      data[target] = pixels[source];
      data[target + 1] = pixels[source + 1];
      data[target + 2] = pixels[source + 2];
      data[target + 3] = 255;
    }
    return { width, height, data };
  }
  // Expand the palette to RGBA once, then copy one 32-bit word per pixel. Creating a
  // subarray per pixel made this loop the slowest part of decoding (13.5 ms → 2.5 ms).
  const rgba = new Uint8Array(256 * 4);
  for (let entry = 0; entry < 256; entry += 1) {
    rgba[entry * 4] = palette![entry * 3] ?? 0;
    rgba[entry * 4 + 1] = palette![entry * 3 + 1] ?? 0;
    rgba[entry * 4 + 2] = palette![entry * 3 + 2] ?? 0;
    rgba[entry * 4 + 3] = transparency && entry < transparency.length ? transparency[entry] : 255;
  }
  const words = new Uint32Array(rgba.buffer);
  const output = new Uint32Array(data.buffer);
  for (let index = 0; index < count; index += 1) output[index] = words[pixels[index]];
  return { width, height, data };
}
