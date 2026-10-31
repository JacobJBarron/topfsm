/**
 * A photo made small enough for a card: at most 480 px on its longer side, as a JPEG. ABC Supply's
 * product photos come at up to a megabyte each; a card on a phone needs a few dozen kilobytes.
 * Pure JavaScript (jpeg-js), so the server stays one bundled file.
 *
 * Decoding is the slow part (about a fifth of a second for a big photo), so photos are made small
 * one at a time, with the server free to answer other requests between them. A photo that isn't
 * a JPEG, is small already, or doesn't decode is passed on as it came.
 */
import { decode, encode } from "jpeg-js";

export const THUMBNAIL_PX = 480;
const QUALITY = 78;

let queue: Promise<unknown> = Promise.resolve();

export function thumbnail(body: Uint8Array, type: string, max = THUMBNAIL_PX): Promise<{ body: Uint8Array; type: string }> {
  if (!/^image\/p?jpe?g/i.test(type)) return Promise.resolve({ body, type });
  const next = queue
    // Back to the event loop first, so requests waiting on it go ahead of the next photo.
    .then(() => new Promise((resolve) => setImmediate(resolve)))
    .then(() => shrink(body, max) ?? { body, type })
    .catch(() => ({ body, type }));
  queue = next;
  return next;
}

/** The photo at most `max` px on its longer side, as a JPEG; null when it's that small already. */
function shrink(body: Uint8Array, max: number): { body: Uint8Array; type: string } | null {
  const photo = decode(body, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
  const small = shrinkRgba(photo, max);
  if (small === photo) return null;
  return { body: new Uint8Array(encode(small, QUALITY).data), type: "image/jpeg" };
}

export interface Rgba {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * RGBA pixels at most `max` px on their longer side, each new pixel the average of the ones it
 * covers, fully opaque. The same pixels back when they're that small already. Also used for photos
 * shared to social pages (lib/shareImage.ts).
 */
export function shrinkRgba(photo: Rgba, max: number): Rgba {
  const scale = max / Math.max(photo.width, photo.height);
  if (scale >= 1) return photo;
  const width = Math.max(1, Math.round(photo.width * scale));
  const height = Math.max(1, Math.round(photo.height * scale));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const top = Math.floor(y / scale);
    const bottom = Math.max(top + 1, Math.min(photo.height, Math.floor((y + 1) / scale)));
    for (let x = 0; x < width; x++) {
      const left = Math.floor(x / scale);
      const right = Math.max(left + 1, Math.min(photo.width, Math.floor((x + 1) / scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = top; sy < bottom; sy++) {
        for (let sx = left; sx < right; sx++) {
          const i = (sy * photo.width + sx) * 4;
          r += photo.data[i]!;
          g += photo.data[i + 1]!;
          b += photo.data[i + 2]!;
        }
      }
      const n = (bottom - top) * (right - left);
      const o = (y * width + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}
