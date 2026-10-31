/**
 * A 5-star review as a square picture for the business's social pages (docs/marketing-plan.md,
 * phase E): the stars, the review's words set to fit, the reviewer's first name and last initial, and
 * the business's logo (on a white plate, since logos are made for light backgrounds) or its name, in
 * its brand colour or Crewtavo's. "Google review" is written out, without Google's logo.
 *
 * Drawn as SVG and turned into pixels by resvg in WebAssembly (@resvg/resvg-wasm, MPL-2.0) with the
 * Figtree font (OFL-1.1), then into a JPEG by jpeg-js: nothing native, so it works in the one
 * bundled server file, for automatic posts with no browser involved. scripts/build-server.mjs copies
 * the .wasm, the fonts and their licences into dist/server/assets.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fitCardText, measureFigtree, type CardColors } from "@crewtavo/core/social";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { encode } from "jpeg-js";

export const CARD_PX = 1080;
const QUALITY = 90;
const TEXT_WIDTH = 860;
const FONTS = ["Figtree-Regular.ttf", "Figtree-SemiBold.ttf"] as const;
/** Short words are set large, so a short review fills the card; long ones step down to 40 px. */
const TEXT_SIZES = [72, 64, 56, 50, 44, 40] as const;
const LINE_HEIGHT = 1.3;
const STAR_PX = 64;
/** The stars, words and name sit together in the middle of this band, above the business. */
const BAND = { top: 72, bottom: 790 } as const;
const GAP_UNDER_STARS = 56;
const GAP_OVER_NAME = 52;
const NAME_PX = 40;
/** Where the logo's plate, or the business's name, is centred. */
export const BRAND_Y = 900;

export interface CardLogo {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface CardInput {
  stars: number;
  text: string;
  /** "Ana S.", or null for "A Google user". */
  name: string | null;
  business: string;
  logo?: CardLogo | null;
  colors: CardColors;
}

/**
 * Where the card's files are: next to the bundled server (dist/server/assets), next to a bundled
 * script (dist/server/scripts → ../assets), or in the source (apps/api/assets, with the .wasm read
 * from node_modules), in that order.
 */
export function assetDir(): { fonts: string; wasm: string } {
  for (const rel of ["./assets/", "../assets/", "../../assets/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (!existsSync(`${dir}fonts/${FONTS[0]}`)) continue;
    if (existsSync(`${dir}resvg.wasm`)) return { fonts: `${dir}fonts/`, wasm: `${dir}resvg.wasm` };
    try {
      return { fonts: `${dir}fonts/`, wasm: createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm") };
    } catch {
      // No node_modules here: this isn't the source.
    }
  }
  throw new Error("The review card's font and renderer aren't with the server. Build it again with npm run build:server.");
}

let ready: Promise<Uint8Array[]> | null = null;

/** resvg's WebAssembly, started once, and the fonts. */
function prepare(): Promise<Uint8Array[]> {
  ready ??= (async () => {
    const dir = assetDir();
    await initWasm(await readFile(dir.wasm));
    return Promise.all(FONTS.map(async (f) => new Uint8Array(await readFile(`${dir.fonts}${f}`))));
  })();
  ready.catch(() => {
    ready = null;
  });
  return ready;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** One five-pointed star, centred at (cx, cy), `r` from its middle to a point. */
function starPath(cx: number, cy: number, r: number): string {
  const inner = r * 0.42;
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 ? inner : r;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join("L")}Z`;
}

/** The card's words, set as large as fits the room left beside the stars and the name. */
export function cardFit(text: string) {
  const room = BAND.bottom - BAND.top - STAR_PX - GAP_UNDER_STARS - GAP_OVER_NAME - NAME_PX;
  return fitCardText(text, { measure: measureFigtree, width: TEXT_WIDTH, sizes: TEXT_SIZES, maxLines: 8, maxHeight: room, lineHeight: LINE_HEIGHT });
}

/** The card as SVG, 1080 × 1080. */
export function reviewCardSvg(input: CardInput): string {
  const { colors } = input;
  const fit = cardFit(input.text);
  const lineHeight = Math.round(fit.size * LINE_HEIGHT);
  const block = fit.lines.length * lineHeight;
  // Stars, words and name centred together, so a short review doesn't leave a gap above the business.
  const height = STAR_PX + GAP_UNDER_STARS + block + GAP_OVER_NAME + NAME_PX;
  const groupTop = BAND.top + Math.max(0, (BAND.bottom - BAND.top - height) / 2);

  const stars = Math.max(0, Math.min(5, Math.round(input.stars)));
  const gap = 18;
  const starsLeft = (CARD_PX - (5 * STAR_PX + 4 * gap)) / 2;
  const starShapes = Array.from({ length: 5 }, (_, i) => {
    const d = starPath(starsLeft + i * (STAR_PX + gap) + STAR_PX / 2, groupTop + STAR_PX / 2, STAR_PX / 2);
    return i < stars ? `<path d="${d}" fill="${colors.stars}"/>` : `<path d="${d}" fill="none" stroke="${colors.stars}" stroke-width="3"/>`;
  }).join("");

  const top = groupTop + STAR_PX + GAP_UNDER_STARS;
  const lines = fit.lines
    .map((line, i) => `<text x="540" y="${(top + i * lineHeight + fit.size * 0.8).toFixed(1)}" font-size="${fit.size}" text-anchor="middle" fill="${colors.text}">${escape(line)}</text>`)
    .join("");
  const nameY = top + block + GAP_OVER_NAME + NAME_PX * 0.8;
  const who = `<text x="540" y="${nameY.toFixed(1)}" font-size="${NAME_PX}" font-weight="600" text-anchor="middle" fill="${colors.muted}">${escape(`— ${input.name ?? "A Google user"}`)}</text>`;

  let brand: string;
  const logo = input.logo;
  if (logo && logo.width > 0 && logo.height > 0) {
    const scale = Math.min(360 / logo.width, 96 / logo.height);
    const w = Math.round(logo.width * scale);
    const h = Math.round(logo.height * scale);
    const plateW = w + 56;
    const plateH = h + 36;
    const plateX = (CARD_PX - plateW) / 2;
    const plateY = BRAND_Y - plateH / 2;
    const href = `data:image/png;base64,${Buffer.from(logo.png).toString("base64")}`;
    brand = `<rect x="${plateX}" y="${plateY}" width="${plateW}" height="${plateH}" rx="22" fill="#ffffff"/>`
      + `<image x="${plateX + 28}" y="${plateY + 18}" width="${w}" height="${h}" href="${href}" preserveAspectRatio="xMidYMid meet"/>`;
  } else {
    // A long name is set smaller to stay on the card (SemiBold runs about 6% wider than Regular's widths).
    const size = Math.max(24, Math.min(44, Math.floor((44 * 940) / Math.max(1, measureFigtree(input.business, 44) * 1.06))));
    brand = `<text x="540" y="${BRAND_Y + Math.round(size * 0.32)}" font-size="${size}" font-weight="600" text-anchor="middle" fill="${colors.text}">${escape(input.business)}</text>`;
  }
  // Large enough to read in a feed, where the card shows at about a third of its size.
  const footer = `<text x="540" y="1026" font-size="34" font-weight="600" text-anchor="middle" fill="${colors.muted}">Google review</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_PX}" height="${CARD_PX}" viewBox="0 0 ${CARD_PX} ${CARD_PX}" font-family="Figtree">`
    + `<rect width="${CARD_PX}" height="${CARD_PX}" fill="${colors.background}"/>${starShapes}${lines}${who}${brand}${footer}</svg>`;
}

/** The card as a JPEG. */
export async function renderReviewCard(input: CardInput): Promise<Uint8Array> {
  const fontBuffers = await prepare();
  const resvg = new Resvg(reviewCardSvg(input), { font: { fontBuffers, defaultFontFamily: "Figtree", sansSerifFamily: "Figtree" }, fitTo: { mode: "original" } });
  try {
    const image = resvg.render();
    try {
      const jpeg = encode({ data: image.pixels, width: image.width, height: image.height }, QUALITY);
      return new Uint8Array(jpeg.data.buffer, jpeg.data.byteOffset, jpeg.data.byteLength);
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
