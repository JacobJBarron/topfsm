/**
 * A photo as the business's social pages get it (docs/marketing-plan.md, phase E): turned the right
 * way up, at most 2048 px on its longer side, and encoded again as a JPEG, which writes only JFIF, so
 * no EXIF (no GPS of a client's home), ICC profile or other metadata goes with it. Instagram's copy
 * is padded, never cropped, into the shapes it takes (4:5 to 1.91:1), and a carousel's to a square,
 * Instagram's crop for one.
 *
 * Pure JavaScript (jpeg-js and pngjs), so the server stays one bundled file. JPEG and PNG only:
 * nothing pure reads HEIC or WebP, so those can't be marked OK to share (set_photo_shareable). One
 * photo at a time, as thumbnail.ts does, with the server free to answer requests between them.
 */
import { INSTAGRAM_RATIO } from "@crewtavo/core/social";
import { decode, encode } from "jpeg-js";
import { PNG } from "pngjs";
import { isPng, pngSize } from "../services/logo";
import { isJpeg } from "../services/photos";
import { shrinkRgba, type Rgba } from "./thumbnail";

export const SHARE_MAX_PX = 2048;
/** Instagram takes 320 to 1440 px across. */
export const INSTAGRAM_MAX_PX = 1440;
const QUALITY = 85;
/** Bigger than any phone's photo: one this size is something else, and isn't decoded. */
const MAX_MEGAPIXELS = 50;

export type ShareImageProblem = "format" | "too_large" | "broken";
export class ShareImageError extends Error {
  override name = "ShareImageError";
  constructor(readonly kind: ShareImageProblem, message: string) {
    super(message);
  }
}

/**
 * The EXIF orientation of a JPEG (tag 0x0112 in its APP1 segment), 1 to 8, or 1 when it has none.
 * Read before the EXIF is thrown away, since jpeg-js doesn't turn the picture by itself and a phone's
 * photo would come out on its side.
 */
export function exifOrientation(bytes: Uint8Array): number {
  if (!isJpeg(bytes)) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    // The picture itself starts here: no more metadata.
    if (marker === 0xda || marker === 0xd9) break;
    const length = view.getUint16(at + 2);
    if (length < 2) break;
    const start = at + 4;
    if (marker === 0xe1 && start + 14 <= bytes.length && String.fromCharCode(...bytes.subarray(start, start + 4)) === "Exif" && bytes[start + 4] === 0 && bytes[start + 5] === 0) {
      const tiff = start + 6;
      const little = bytes[tiff] === 0x49;
      const u16 = (o: number) => view.getUint16(o, little);
      const u32 = (o: number) => view.getUint32(o, little);
      if (tiff + 8 > bytes.length) return 1;
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > bytes.length) return 1;
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > bytes.length) break;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    at = start + length - 2;
  }
  return 1;
}

/** The pixels turned as EXIF orientation `o` says: mirrored, turned or both. */
export function orient(image: Rgba, o: number): Rgba {
  if (o <= 1 || o > 8) return image;
  const { width: w, height: h, data } = image;
  const turned = o >= 5;
  const out = new Uint8Array(data.length);
  const ow = turned ? h : w;
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      let dx: number;
      let dy: number;
      switch (o) {
        case 2: dx = w - 1 - sx; dy = sy; break;
        case 3: dx = w - 1 - sx; dy = h - 1 - sy; break;
        case 4: dx = sx; dy = h - 1 - sy; break;
        case 5: dx = sy; dy = sx; break;
        case 6: dx = h - 1 - sy; dy = sx; break;
        case 7: dx = h - 1 - sy; dy = w - 1 - sx; break;
        default: dx = sy; dy = w - 1 - sx; break;
      }
      const s = (sy * w + sx) * 4;
      const d = (dy * ow + dx) * 4;
      out[d] = data[s]!;
      out[d + 1] = data[s + 1]!;
      out[d + 2] = data[s + 2]!;
      out[d + 3] = data[s + 3]!;
    }
  }
  return { data: out, width: ow, height: turned ? w : h };
}

const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0) as [number, number, number];

/** A PNG's see-through parts laid on white, as a JPEG has no way to keep them. */
function flatten(image: Rgba): Rgba {
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a >= 1) continue;
    data[i] = Math.round(data[i]! * a + 255 * (1 - a));
    data[i + 1] = Math.round(data[i + 1]! * a + 255 * (1 - a));
    data[i + 2] = Math.round(data[i + 2]! * a + 255 * (1 - a));
    data[i + 3] = 255;
  }
  return image;
}

/** What the bytes are, when they're a format people send that can't be posted. */
function otherFormat(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1|avif)/.test(ascii(8, 12))) return "HEIC";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "WebP";
  if (bytes.length >= 6 && ascii(0, 3) === "GIF") return "GIF";
  if (bytes.length >= 4 && (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*")) return "TIFF";
  return null;
}

/** The photo's pixels, the right way up and opaque. */
export function decodePhoto(bytes: Uint8Array): Rgba {
  if (isJpeg(bytes)) {
    try {
      const photo = decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_MEGAPIXELS, maxMemoryUsageInMB: 1024 });
      return orient({ data: photo.data, width: photo.width, height: photo.height }, exifOrientation(bytes));
    } catch (error) {
      if (/maxResolutionInMP|maxMemoryUsageInMB/.test(String(error))) throw new ShareImageError("too_large", "This photo is too large to post.");
      throw new ShareImageError("broken", "This photo couldn't be read, so it can't be posted.");
    }
  }
  if (isPng(bytes)) {
    const [width, height] = pngSize(bytes);
    if (width * height > MAX_MEGAPIXELS * 1_000_000) throw new ShareImageError("too_large", "This photo is too large to post.");
    try {
      const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return flatten({ data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength), width: png.width, height: png.height });
    } catch {
      throw new ShareImageError("broken", "This photo couldn't be read, so it can't be posted.");
    }
  }
  const other = otherFormat(bytes);
  throw new ShareImageError("format", other ? `${other} photos can't be posted. Only JPEG and PNG photos can.` : "Only JPEG and PNG photos can be posted.");
}

/** The pixels laid on a canvas `width` × `height` of `color`, in its middle. */
function padTo(image: Rgba, width: number, height: number, color: string): Rgba {
  if (width === image.width && height === image.height) return image;
  const [r, g, b] = hexRgb(color);
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
  }
  const left = Math.floor((width - image.width) / 2);
  const top = Math.floor((height - image.height) / 2);
  for (let y = 0; y < image.height; y++) {
    out.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((top + y) * width + left) * 4);
  }
  return { data: out, width, height };
}

/** The canvas Instagram takes for a picture this shape, padding it out rather than cropping. */
export function instagramCanvas(width: number, height: number): { width: number; height: number } {
  const ratio = width / height;
  if (ratio < INSTAGRAM_RATIO.min) return { width: Math.ceil(height * INSTAGRAM_RATIO.min), height };
  if (ratio > INSTAGRAM_RATIO.max) return { width, height: Math.ceil(width / INSTAGRAM_RATIO.max) };
  return { width, height };
}

export interface SharedJpeg {
  body: Uint8Array;
  width: number;
  height: number;
}

export interface ShareOptions {
  /** The longer side's most, 2048 px by default (Instagram's copies 1440). */
  max?: number;
  /** "instagram": padded into Instagram's shapes; "square": padded to 1:1, a carousel's. */
  pad?: "instagram" | "square";
  /** What the padding is: the brand colour or a light grey (packages/core/src/social.ts padColor). */
  padColor?: string;
}

function make(bytes: Uint8Array, options: ShareOptions): SharedJpeg {
  const max = options.max ?? (options.pad ? INSTAGRAM_MAX_PX : SHARE_MAX_PX);
  let image = decodePhoto(bytes);
  if (options.pad) {
    // Shrunk first so the padding never makes it wider than the most.
    image = shrinkRgba(image, max);
    const canvas = options.pad === "square" ? { width: Math.max(image.width, image.height), height: Math.max(image.width, image.height) } : instagramCanvas(image.width, image.height);
    image = padTo(image, canvas.width, canvas.height, options.padColor ?? "#efeeea");
    image = shrinkRgba(image, max);
  } else {
    image = shrinkRgba(image, max);
  }
  const jpeg = encode({ data: image.data, width: image.width, height: image.height }, QUALITY);
  return { body: new Uint8Array(jpeg.data.buffer, jpeg.data.byteOffset, jpeg.data.byteLength), width: image.width, height: image.height };
}

let queue: Promise<unknown> = Promise.resolve();

/** A photo made ready to post. Throws ShareImageError for one that can't be: its format, too large or broken. */
export function shareJpeg(bytes: Uint8Array, options: ShareOptions = {}): Promise<SharedJpeg> {
  const next = queue
    // Back to the event loop first, so requests waiting on it go ahead of the next photo.
    .then(() => new Promise((resolve) => setImmediate(resolve)))
    .then(() => make(bytes, options));
  queue = next.catch(() => undefined);
  return next;
}
