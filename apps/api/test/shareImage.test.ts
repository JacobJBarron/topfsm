/**
 * Photos made ready to post (lib/shareImage.ts): a phone's JPEG turned the way its EXIF says and sent
 * without the EXIF (no GPS), at most 2048 px; a PNG's see-through parts laid on white; HEIC and WebP
 * refused as formats that can't be posted; and Instagram's copies padded, never cropped, into its
 * shapes, or a carousel's square.
 */
import { decode, encode } from "jpeg-js";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { exifOrientation, shareJpeg, ShareImageError } from "../src/lib/shareImage";

/** A JPEG `width` × `height`, red on its left half and blue on its right. */
function jpeg(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const left = x < width / 2;
      data[i] = left ? 220 : 20;
      data[i + 1] = 20;
      data[i + 2] = left ? 20 : 220;
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(encode({ data, width, height }, 90).data);
}

/** The JPEG with an EXIF segment saying orientation `o`, with a GPS block (made up coordinates' bytes). */
function withExif(bytes: Uint8Array, o: number): Uint8Array {
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian, IFD0 at 8
    0x00, 0x02, // two entries
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o, 0x00, 0x00, // orientation
    0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, // GPS IFD at 38
    0x00, 0x00, 0x00, 0x00, // no next IFD
    ...[..."GPSLatitude37.1234N80.4321W"].map((c) => c.charCodeAt(0)),
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = body.length + 2;
  const app1 = [0xff, 0xe1, length >> 8, length & 0xff, ...body];
  return new Uint8Array([...bytes.subarray(0, 2), ...app1, ...bytes.subarray(2)]);
}

const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text, "latin1"));
const pixel = (image: { data: Uint8Array; width: number }, x: number, y: number) => {
  const i = (y * image.width + x) * 4;
  return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
};
const reddish = (p: number[]) => p[0]! > 150 && p[2]! < 100;
const bluish = (p: number[]) => p[2]! > 150 && p[0]! < 100;

describe("a photo made ready to post", () => {
  it("is turned the way its EXIF says, and sent without the EXIF or its GPS", async () => {
    const phone = withExif(jpeg(80, 40), 6);
    expect(exifOrientation(phone)).toBe(6);
    expect(has(phone, "Exif")).toBe(true);
    const out = await shareJpeg(phone);
    expect(has(out.body, "Exif")).toBe(false);
    expect(has(out.body, "GPSLatitude")).toBe(false);
    expect(exifOrientation(out.body)).toBe(1);
    const image = decode(out.body, { useTArray: true, formatAsRGBA: true });
    // Turned a quarter clockwise: the red left half is now the top.
    expect([image.width, image.height]).toEqual([40, 80]);
    expect([out.width, out.height]).toEqual([40, 80]);
    expect(reddish(pixel(image, 20, 5))).toBe(true);
    expect(bluish(pixel(image, 20, 75))).toBe(true);
  });

  it("is at most 2048 px on its longer side", async () => {
    const out = await shareJpeg(jpeg(3000, 200));
    expect([out.width, out.height]).toEqual([2048, 137]);
  });

  it("lays a PNG's see-through parts on white", async () => {
    const png = new PNG({ width: 10, height: 10 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 255;
      png.data[i + 1] = 0;
      png.data[i + 2] = 0;
      png.data[i + 3] = 0;
    }
    const out = await shareJpeg(new Uint8Array(PNG.sync.write(png)));
    const image = decode(out.body, { useTArray: true, formatAsRGBA: true });
    expect(pixel(image, 5, 5).every((v) => v > 240)).toBe(true);
  });

  it("refuses HEIC and WebP, which can't be posted", async () => {
    const heic = new Uint8Array([0, 0, 0, 24, ...[..."ftypheic"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
    const webp = new Uint8Array([...[..."RIFF"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."WEBPVP8 "].map((c) => c.charCodeAt(0))]);
    for (const [bytes, name] of [[heic, "HEIC"], [webp, "WebP"]] as const) {
      const error = await shareJpeg(bytes).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(ShareImageError);
      expect((error as ShareImageError).kind).toBe("format");
      expect((error as ShareImageError).message).toContain(name);
    }
  });

  it("pads Instagram's copy into its shapes, and a carousel's to a square", async () => {
    const tall = await shareJpeg(jpeg(100, 300), { pad: "instagram" });
    expect(tall.width / tall.height).toBeGreaterThanOrEqual(0.8);
    expect(tall.width / tall.height).toBeLessThan(0.81);
    const wide = await shareJpeg(jpeg(400, 100), { pad: "instagram" });
    expect(wide.width / wide.height).toBeLessThanOrEqual(1.91);
    expect(wide.width / wide.height).toBeGreaterThan(1.89);
    const fits = await shareJpeg(jpeg(120, 100), { pad: "instagram" });
    expect([fits.width, fits.height]).toEqual([120, 100]);
    const square = await shareJpeg(jpeg(300, 100), { pad: "square", padColor: "#1f4e79" });
    expect(square.width).toBe(square.height);
    const image = decode(square.body, { useTArray: true, formatAsRGBA: true });
    // The padding is the colour given, never a crop of the photo.
    const top = pixel(image, 150, 5);
    expect(Math.abs(top[0]! - 0x1f) + Math.abs(top[1]! - 0x4e) + Math.abs(top[2]! - 0x79)).toBeLessThan(40);
    expect(reddish(pixel(image, 20, 150))).toBe(true);
    expect(bluish(pixel(image, 280, 150))).toBe(true);
  });

  it("keeps Instagram's copies to 1440 px across", async () => {
    const big = await shareJpeg(jpeg(3000, 2000), { pad: "instagram" });
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(1440);
  });
});
