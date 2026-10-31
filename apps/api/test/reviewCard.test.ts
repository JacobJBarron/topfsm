/**
 * The review card (lib/reviewCard.ts): a 1080 × 1080 JPEG drawn with resvg's WebAssembly and the
 * vendored Figtree, gold stars, the brand colour or Crewtavo's, the logo on a white plate or the
 * business's name, and a long review cut with an ellipsis. Also that core's Figtree widths, which
 * fit the words, are the font's own (its hmtx table, read here).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { cardColors, FIGTREE_EXTRA, FIGTREE_WIDTHS, fitCardText, measureFigtree } from "@crewtavo/core/social";
import { decode } from "jpeg-js";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { assetDir, BRAND_Y, CARD_PX, cardFit, renderReviewCard, reviewCardSvg } from "../src/lib/reviewCard";

const pixel = (image: { data: Uint8Array; width: number }, x: number, y: number) => {
  const i = (y * image.width + x) * 4;
  return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
};
const near = (got: number[], want: number[], by = 24) => got.every((v, i) => Math.abs(v - want[i]!) <= by);
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const base = { stars: 5, text: "They did a wonderful job on our lawn and were on time every week.", name: "Ana S.", business: "Radford Lawn Care" };

/** A dark logo on a see-through background, as many are. */
function darkLogo(): { png: Uint8Array; width: number; height: number } {
  const png = new PNG({ width: 120, height: 40 });
  for (let i = 0; i < png.data.length; i += 4) {
    const x = (i / 4) % 120;
    const ink = x > 10 && x < 110;
    png.data[i] = 20;
    png.data[i + 1] = 30;
    png.data[i + 2] = 40;
    png.data[i + 3] = ink ? 255 : 0;
  }
  return { png: new Uint8Array(PNG.sync.write(png)), width: 120, height: 40 };
}

describe("the review card", () => {
  it("is a 1080 × 1080 JPEG with gold stars on Crewtavo's colour", async () => {
    const jpeg = await renderReviewCard({ ...base, colors: cardColors(null) });
    expect([jpeg[0], jpeg[1], jpeg[2]]).toEqual([0xff, 0xd8, 0xff]);
    const image = decode(jpeg, { useTArray: true, formatAsRGBA: true });
    expect([image.width, image.height]).toEqual([CARD_PX, CARD_PX]);
    expect(near(pixel(image, 20, 20), hex("#0f2a35"))).toBe(true);
    // The middle of the first star, wherever the words put it.
    const left = (CARD_PX - (5 * 64 + 4 * 18)) / 2;
    const gold = Array.from({ length: 500 }, (_, y) => y + 60).filter((y) => near(pixel(image, left + 32, y), hex("#f5b400"), 40));
    expect(gold.length).toBeGreaterThan(20);
    // Words drawn: the pixels down the middle aren't all the background.
    const column = Array.from({ length: 400 }, (_, y) => pixel(image, 540, 300 + y)[0]);
    expect(new Set(column).size).toBeGreaterThan(10);
  });

  it("uses the brand colour when there is one", async () => {
    const image = decode(await renderReviewCard({ ...base, colors: cardColors("#7a1f3d") }), { useTArray: true, formatAsRGBA: true });
    expect(near(pixel(image, 20, 20), hex("#7a1f3d"))).toBe(true);
  });

  it("puts a dark logo on a white plate, so it shows on a dark card", async () => {
    const image = decode(await renderReviewCard({ ...base, logo: darkLogo(), colors: cardColors(null) }), { useTArray: true, formatAsRGBA: true });
    // The logo is 288 × 96 on a plate 56 px wider: the plate beside it is white, not the card's navy.
    expect(near(pixel(image, 540 - 144 - 14, BRAND_Y), [255, 255, 255], 12)).toBe(true);
    expect(near(pixel(image, 540 - 144 - 40, BRAND_Y), [255, 255, 255], 12)).toBe(false);
    // The logo's ink on it.
    expect(near(pixel(image, 540, BRAND_Y), [20, 30, 40], 30)).toBe(true);
  });

  it("writes the business's name without a logo, and Google review without Google's logo", () => {
    const svg = reviewCardSvg({ ...base, colors: cardColors(null) });
    expect(svg).toContain(">Radford Lawn Care<");
    expect(svg).toContain(">Google review<");
    expect(svg).toContain(">— Ana S.<");
    expect(svg).not.toContain("<image");
    expect(reviewCardSvg({ ...base, name: null, colors: cardColors(null) })).toContain(">— A Google user<");
    expect(reviewCardSvg({ ...base, business: "Tom & Jerry's <Lawns>", colors: cardColors(null) })).toContain("Tom &amp; Jerry&#39;s &lt;Lawns&gt;");
  });

  it("sets a short review large, in the middle, with Google review big enough to read in a feed", async () => {
    const svg = reviewCardSvg({ ...base, text: "Loved it, the best crew", colors: cardColors(null) });
    expect(cardFit("Loved it, the best crew")).toMatchObject({ size: 72, lines: ["Loved it, the best crew"] });
    // Stars, words and name are centred together above the business, not left at the top.
    const starTop = Math.min(...[...svg.matchAll(/<path d="M[\d.]+,([\d.]+)/g)].map((m) => Number(m[1])));
    const nameY = Number(/y="([\d.]+)"[^>]*>— Ana S\.</.exec(svg)![1]);
    expect(starTop).toBeGreaterThan(250);
    expect(nameY).toBeLessThan(BRAND_Y - 100);
    expect(starTop - 72).toBeCloseTo(790 - nameY, -2);
    expect(svg).toMatch(/font-size="34"[^>]*>Google review</);
    // A long business name is set smaller, so it stays on the card.
    const long = reviewCardSvg({ ...base, business: "Radford & Blacksburg Lawn Care and Landscaping Company", colors: cardColors(null) });
    expect(Number(/font-size="(\d+)"[^>]*>Radford &amp; Blacksburg/.exec(long)![1])).toBeLessThan(44);
  });

  it("cuts a long review with an ellipsis", async () => {
    const long = "The crew was great and the lawn has never looked better. ".repeat(20);
    const svg = reviewCardSvg({ ...base, text: long, colors: cardColors(null) });
    expect(svg).toContain("…</text>");
    expect(fitCardText(long, { measure: measureFigtree, width: 860 }).truncated).toBe(true);
    const image = decode(await renderReviewCard({ ...base, text: long, colors: cardColors(null) }), { useTArray: true, formatAsRGBA: true });
    expect(image.width).toBe(CARD_PX);
  });
});

/** Advance widths from a TrueType font's cmap (format 4) and hmtx tables. */
function fontWidths(bytes: Buffer): (code: number) => number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables: Record<string, number> = {};
  for (let i = 0; i < v.getUint16(4); i++) tables[bytes.toString("latin1", 12 + i * 16, 16 + i * 16)] = v.getUint32(20 + i * 16);
  expect(v.getUint16(tables.head! + 18)).toBe(1000);
  const metrics = v.getUint16(tables.hhea! + 34);
  let sub = 0;
  for (let i = 0; i < v.getUint16(tables.cmap! + 2); i++) {
    const at = tables.cmap! + 4 + i * 8;
    if (v.getUint16(at) === 3 && v.getUint16(at + 2) === 1 && v.getUint16(tables.cmap! + v.getUint32(at + 4)) === 4) sub = tables.cmap! + v.getUint32(at + 4);
  }
  const segments = v.getUint16(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const offsets = deltas + segments * 2;
  const glyph = (code: number) => {
    for (let i = 0; i < segments; i++) {
      if (code > v.getUint16(ends + i * 2)) continue;
      const start = v.getUint16(starts + i * 2);
      if (code < start) return 0;
      const delta = v.getInt16(deltas + i * 2);
      const offset = v.getUint16(offsets + i * 2);
      if (!offset) return (code + delta) & 0xffff;
      const g = v.getUint16(offsets + i * 2 + offset + (code - start) * 2);
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  return (code) => {
    const g = glyph(code);
    return g ? v.getUint16(tables.hmtx! + Math.min(g, metrics - 1) * 4) : 0;
  };
}

describe("Figtree's widths", () => {
  const font = readFileSync(fileURLToPath(new URL("../assets/fonts/Figtree-Regular.ttf", import.meta.url)));
  const width = fontWidths(font);

  it("are the vendored font's own, for every letter the card takes", () => {
    expect(FIGTREE_WIDTHS).toHaveLength(0x17f - 0x20 + 1);
    FIGTREE_WIDTHS.forEach((w, i) => expect(w, `U+${(0x20 + i).toString(16)}`).toBe(width(0x20 + i)));
    for (const [ch, w] of Object.entries(FIGTREE_EXTRA)) expect(w, ch).toBe(width(ch.codePointAt(0)!));
  });

  it("are found with the renderer, in the source", () => {
    const dir = assetDir();
    expect(dir.fonts).toMatch(/apps\/api\/assets\/fonts\/$/);
    expect(dir.wasm).toMatch(/index_bg\.wasm$/);
  });
});
