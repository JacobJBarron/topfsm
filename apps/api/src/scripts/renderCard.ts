/**
 * Renders a sample review card with the bundled server's own assets, to prove the card works where
 * the server runs (no browser, no native modules): node dist/server/scripts/render-card.mjs --check
 * decodes the JPEG and checks it's 1080 × 1080 with something drawn on it, and prints "Card rendered".
 * Without --check it writes the card to the path given (card.jpg by default).
 */
import { writeFileSync } from "node:fs";
import { cardColors } from "@crewtavo/core/social";
import { decode } from "jpeg-js";
import { CARD_PX, renderReviewCard } from "../lib/reviewCard";

const jpeg = await renderReviewCard({
  stars: 5,
  text: "The crew showed up on time, worked fast and left the yard spotless. Our lawn has never looked this good. Thank you!",
  name: "Ana S.",
  business: "Crewtavo Lawn Care",
  colors: cardColors(null),
});

if (process.argv.includes("--check")) {
  const image = decode(jpeg, { useTArray: true, formatAsRGBA: true });
  const values = new Set<number>();
  for (let i = 0; i < image.data.length; i += 4 * 997) values.add(image.data[i]!);
  if (image.width !== CARD_PX || image.height !== CARD_PX || values.size < 8) {
    console.error(`The card came out wrong: ${image.width} × ${image.height}, ${values.size} shades.`);
    process.exit(1);
  }
  console.log(`Card rendered: ${image.width} × ${image.height}, ${jpeg.length.toLocaleString("en-US")} bytes`);
} else {
  const out = process.argv[2] ?? "card.jpg";
  writeFileSync(out, jpeg);
  console.log(`Card written to ${out}`);
}
