/**
 * Social posting (docs/marketing-plan.md, phase E): Marketing → Social posts photos marked OK to
 * share, a 4 or 5-star Google review as a square card, or words alone, to the business's own Facebook
 * Page, Instagram account and Google Business Profile (apps/api/src/services/social.ts). Shared by
 * the API and the web: what each network takes, the words a review card shows and how they fit, the
 * card's colours, when automatic 5-star posts go, and a post's status from its networks. The
 * database decides the same way where it has to (supabase/migrations/20261031000410_social_posts.sql
 * and 20261031000420_automatic_review_posts.sql).
 */
import { NAME_FOLDS, nameKey } from "./reviews";
import { addDays, localDate, localTime, zonedTimeToUtc } from "./time";

// ---------------------------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------------------------

export const NETWORKS = ["facebook", "instagram", "google"] as const;
export type Network = (typeof NETWORKS)[number];
export const NETWORK_NAMES: Record<Network, string> = { facebook: "Facebook", instagram: "Instagram", google: "Google" };
export const isNetwork = (value: unknown): value is Network => typeof value === "string" && (NETWORKS as readonly string[]).includes(value);

/** "Facebook", "Facebook and Instagram", "Facebook, Instagram and Google", in this order. */
export function networkWords(networks: readonly string[]): string {
  const names = NETWORKS.filter((n) => networks.includes(n)).map((n) => NETWORK_NAMES[n]);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What posting takes, from Meta's permission reference and content publishing guide: to the Page
 * (pages_manage_posts needs the other two), and to its Instagram account with the Page's token.
 */
export const FACEBOOK_POST_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"] as const;
export const INSTAGRAM_POST_SCOPES = ["pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_content_publish"] as const;

/** Permissions Meta wasn't given, for a network, in words: "Facebook is missing the pages_manage_posts permission. …" */
export function missingPermissionWords(network: Network, missing: readonly string[]): string {
  const one = missing.length === 1;
  const list = one ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
  return `${NETWORK_NAMES[network]} is missing the ${list} permission${one ? "" : "s"}. Reconnect Facebook & Instagram in Apps and allow ${one ? "it" : "them"}.`;
}

/** The longest caption each network takes. Google's is from its own help, not the API's reference. */
export const CAPTION_LIMITS: Record<Network, number> = { facebook: 63_206, instagram: 2_200, google: 1_500 };
/** The longest caption Crewtavo keeps, whatever the network (social_posts.caption). */
export const CAPTION_MAX = 2_200;
export const IG_MAX_HASHTAGS = 30;
export const MAX_PHOTOS = 10;
/** The only photos the server can turn into a JPEG without EXIF (apps/api/src/lib/shareImage.ts). */
export const SHAREABLE_TYPES = ["image/jpeg", "image/jpg", "image/pjpeg", "image/png"] as const;
export const canShareType = (type: string | null | undefined) => (SHAREABLE_TYPES as readonly string[]).includes((type ?? "").toLowerCase());

/** Why a photo can't be marked OK to share, as set_photo_shareable says it. */
export const FORMAT_REFUSAL = "Only JPEG and PNG photos can be posted. Save this one as a JPEG and add it again.";
export const CLIENT_OPT_OUT = "This client asked us not to post photos of their property.";
export const NO_CLIENT = "This photo isn't on a job, visit or client anymore, so it can't be posted.";
export type CantShare = "format" | "client_opt_out" | "no_client";
export const CANT_SHARE: Record<CantShare, string> = { format: FORMAT_REFUSAL, client_opt_out: CLIENT_OPT_OUT, no_client: NO_CLIENT };

/** The shortest limit among the networks chosen: the caption has to fit them all. */
export function captionLimit(networks: readonly string[]): number {
  const limits = NETWORKS.filter((n) => networks.includes(n)).map((n) => CAPTION_LIMITS[n]);
  return Math.min(CAPTION_MAX, ...limits);
}

export interface CaptionProblem {
  network: Network;
  kind: "too_long" | "hashtags" | "phone_google";
  limit: number;
}

const HASHTAG = /#[\p{L}\p{N}_]+/gu;
/** A phone number as people type one: Google takes down posts that have one. */
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

/** What stops a caption going to each network chosen. */
export function captionProblems(caption: string, networks: readonly string[]): CaptionProblem[] {
  const out: CaptionProblem[] = [];
  for (const network of NETWORKS.filter((n) => networks.includes(n))) {
    const limit = Math.min(CAPTION_MAX, CAPTION_LIMITS[network]);
    if (caption.length > limit) out.push({ network, kind: "too_long", limit });
    if (network === "instagram" && (caption.match(HASHTAG)?.length ?? 0) > IG_MAX_HASHTAGS) out.push({ network, kind: "hashtags", limit: IG_MAX_HASHTAGS });
    if (network === "google" && PHONE.test(caption)) out.push({ network, kind: "phone_google", limit: 0 });
  }
  return out;
}

/** Google posts words with every picture: a post to Google without a caption is refused. */
export const GOOGLE_NEEDS_CAPTION = "Google needs a caption.";
export const needsCaption = (caption: string, networks: readonly string[]) => networks.includes("google") && !caption.trim();

/** A caption problem in the composer's words. */
export function captionProblemWords(problem: CaptionProblem): string {
  const name = NETWORK_NAMES[problem.network];
  if (problem.kind === "too_long") return `${name} takes up to ${problem.limit.toLocaleString("en-US")} characters.`;
  if (problem.kind === "hashtags") return `Instagram takes up to ${IG_MAX_HASHTAGS} hashtags.`;
  return "Google takes down posts with a phone number in them. Take it out, or leave Google off.";
}

// ---------------------------------------------------------------------------------------------
// Names and what a caption mustn't say
// ---------------------------------------------------------------------------------------------

const TITLES = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "sir", "prof"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "esq"]);
const ANONYMOUS = new Set(["anonymous", "a google user", "google user"]);
const capital = (word: string) => (word === word.toLowerCase() ? word.charAt(0).toLocaleUpperCase("en-US") + word.slice(1) : word);

/**
 * How a reviewer is named on a post: first name and last initial ("Ana Maria Smith" → "Ana S."), the
 * way Google already shows many names. Titles and suffixes are dropped, a lowercase name gets its
 * capital, and "Ana S." stays as it is. Null for an empty or anonymous name: "A Google user".
 */
export function firstNameLastInitial(name: string | null | undefined): string | null {
  const text = (name ?? "").replace(/\s+/g, " ").trim();
  if (!text || ANONYMOUS.has(text.toLowerCase())) return null;
  const words = text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w));
  const plain = (w: string) => w.toLowerCase().replace(/[.,]/g, "");
  while (words.length > 1 && TITLES.has(plain(words[0]!))) words.shift();
  while (words.length > 1 && SUFFIXES.has(plain(words.at(-1)!))) words.pop();
  if (!words.length) return null;
  const first = capital(words[0]!.replace(/[.,]+$/, ""));
  if (words.length === 1) return first;
  const last = words.at(-1)!.replace(/^[^\p{L}\p{N}]+/u, "");
  return `${first} ${last.charAt(0).toLocaleUpperCase("en-US")}.`;
}

/** What a post must not name: a client's whole name, or their street address. */
export interface ClientMentions {
  /** Whole names and address lines found: never posted. */
  blocked: string[];
  /** A client's last name on its own, capitalised, which may be an everyday word ("Green", "Stone"). */
  warnings: string[];
}

const FOLD = (() => {
  const from = [...NAME_FOLDS.from];
  const to = [...NAME_FOLDS.to];
  return new Map(from.map((ch, i) => [ch, to[i] ?? ""]));
})();
/** Folded to plain lowercase letters as nameKey folds them, with the punctuation kept. */
function foldKeepingPunctuation(text: string): string {
  let out = text.normalize("NFC");
  for (const [letter, plain] of NAME_FOLDS.pairs) out = out.split(letter).join(plain);
  return [...out].map((ch) => (FOLD.has(ch) ? FOLD.get(ch)! : ch.toLowerCase())).join("");
}

const STREET_TYPES: Record<string, string> = {
  st: "st", street: "st", rd: "rd", road: "rd", ave: "ave", av: "ave", avenue: "ave", dr: "dr", drive: "dr", ln: "ln", lane: "ln",
  ct: "ct", court: "ct", blvd: "blvd", boulevard: "blvd", way: "way", pl: "pl", place: "pl", cir: "cir", circle: "cir", ter: "ter",
  terrace: "ter", pkwy: "pkwy", parkway: "pkwy", hwy: "hwy", highway: "hwy", trl: "trl", trail: "trl", sq: "sq", square: "sq", loop: "loop",
};
const STREET_WORDS = Object.keys(STREET_TYPES).join("|");
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "14 Oak St" as its number and street name, ["14", ["oak"]], or null when it doesn't start with a number. */
function streetParts(line1: string): { number: string; name: string[] } | null {
  const words = (nameKey(line1) ?? "").split(" ").filter(Boolean);
  if (words.length < 2 || !/^\d+[a-z]?$/.test(words[0]!)) return null;
  const rest = words.slice(1);
  const typeAt = rest.findIndex((w, i) => i > 0 && STREET_TYPES[w]);
  const name = typeAt > 0 ? rest.slice(0, typeAt) : rest.slice(0, 3);
  return name.length ? { number: words[0]!, name } : null;
}

/**
 * Whether some words name the clients a post is about: their whole name (two words or more), or their
 * street address (the number and the street's name, "14 Oak St", "14 oak street."). Folded as review
 * matching folds names, so case and accents don't hide one. A last name alone (4 letters or more,
 * capitalised in the words) is only a warning: "green lawn" for a client named Green says nothing.
 */
export function mentionsClient(text: string, clients: { names: readonly string[]; addresses: readonly string[] }): ClientMentions {
  const blocked = new Set<string>();
  const warnings = new Set<string>();
  const key = ` ${nameKey(text) ?? ""} `;
  const folded = foldKeepingPunctuation(text);
  for (const name of clients.names) {
    const nk = nameKey(name);
    if (!nk) continue;
    const words = nk.split(" ");
    if (words.length >= 2 && key.includes(` ${nk} `)) {
      blocked.add(name.trim());
      continue;
    }
    const last = words.at(-1)!;
    if (last.length < 4) continue;
    for (const word of text.split(/[^\p{L}\p{N}'’-]+/u)) {
      if (word && /^\p{Lu}/u.test(word) && nameKey(word) === last) warnings.add(word);
    }
  }
  for (const line1 of clients.addresses) {
    const street = streetParts(line1);
    if (street) {
      const core = `${escapeRegex(street.number)}\\s+${street.name.map(escapeRegex).join("\\s+")}`;
      const withType = new RegExp(`(?:^|[^a-z0-9])${core}\\s+(?:${STREET_WORDS})(?![a-z0-9])`);
      const alone = new RegExp(`(?:^|[^a-z0-9])${core}(?=\\s*(?:[^a-z0-9\\s]|$))`);
      if (withType.test(folded) || alone.test(folded)) blocked.add(line1.trim());
    } else {
      const lk = nameKey(line1);
      if (lk && lk.includes(" ") && key.includes(` ${lk} `)) blocked.add(line1.trim());
    }
  }
  return { blocked: [...blocked], warnings: [...warnings].filter((w) => ![...blocked].some((b) => b.includes(w))) };
}

/** The refusal when a caption names a client. */
export const NAMES_CLIENT = "Take out the client's name or address before posting.";

// ---------------------------------------------------------------------------------------------
// The review card
// ---------------------------------------------------------------------------------------------

/**
 * Figtree Regular's advance widths, in thousandths of the font size, for U+0020 to U+017F (Basic
 * Latin to Latin Extended-A), read from the font's hmtx table (apps/api/assets/fonts, compared in
 * apps/api/test/reviewCard.test.ts). 0 for the control characters between them.
 */
export const FIGTREE_WIDTHS: readonly number[] = [
  247, 298, 320, 629, 564, 786, 644, 200, 352, 352, 481, 623, 226, 417, 208, 389, 641, 413, 559, 544, 621, 575, 566, 537,
  614, 566, 253, 259, 623, 623, 623, 504, 989, 677, 611, 721, 688, 592, 543, 760, 751, 271, 515, 610, 520, 846, 774, 776,
  579, 780, 626, 614, 552, 708, 693, 960, 614, 604, 641, 324, 389, 324, 551, 438, 221, 510, 586, 541, 586, 546, 369, 587,
  558, 232, 269, 485, 220, 851, 558, 580, 591, 578, 338, 466, 378, 558, 520, 784, 475, 526, 492, 385, 258, 385, 567, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 247, 294, 536, 576, 555, 543, 271, 570, 439, 815, 331, 551, 623, 0, 623, 300,
  369, 623, 361, 354, 221, 558, 546, 254, 214, 282, 365, 551, 828, 860, 901, 463, 677, 677, 677, 677, 677, 677, 1001, 721,
  592, 592, 592, 592, 271, 271, 271, 275, 751, 774, 776, 776, 776, 776, 776, 623, 784, 708, 708, 708, 708, 604, 583, 564,
  509, 509, 509, 509, 509, 509, 878, 541, 547, 547, 547, 547, 232, 232, 232, 232, 584, 558, 580, 580, 580, 580, 580, 623,
  579, 558, 558, 558, 558, 526, 586, 526, 677, 509, 677, 509, 677, 509, 721, 541, 721, 541, 721, 541, 721, 541, 688, 586,
  751, 586, 592, 547, 0, 0, 592, 547, 592, 547, 592, 547, 760, 587, 760, 587, 760, 587, 760, 587, 751, 558, 751, 558,
  0, 0, 271, 232, 0, 0, 271, 232, 271, 232, 785, 500, 515, 258, 610, 485, 0, 520, 220, 520, 220, 520, 220, 0,
  0, 520, 282, 774, 558, 774, 558, 774, 558, 0, 774, 558, 776, 580, 0, 0, 776, 580, 1133, 986, 626, 338, 626, 338,
  626, 338, 614, 470, 614, 470, 614, 470, 614, 470, 0, 0, 552, 382, 0, 0, 0, 0, 708, 558, 708, 558, 708, 558,
  708, 558, 708, 558, 960, 784, 604, 526, 604, 641, 492, 641, 492, 641, 492, 0,
];

/** The punctuation reviews use beyond Latin Extended-A, with Figtree Regular's widths. */
export const FIGTREE_EXTRA: Readonly<Record<string, number>> = { "–": 550, "—": 1100, "‘": 181, "’": 181, "“": 330, "”": 330, "•": 489, "…": 613, "€": 662 };
const AVERAGE_WIDTH = 560;

/** How wide some words are in Figtree Regular at `size` pixels. */
export function measureFigtree(text: string, size: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    units += code >= 0x20 && code <= 0x17f ? FIGTREE_WIDTHS[code - 0x20] || AVERAGE_WIDTH : (FIGTREE_EXTRA[ch] ?? AVERAGE_WIDTH);
  }
  return (units / 1000) * size;
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu;

/** A review's words as a card shows them: without emoji, on one line, spaces run together. */
export const cardText = (text: string | null | undefined) => (text ?? "").replace(EMOJI, " ").replace(/\s+/g, " ").trim();

/** Whether the card leaves emoji out of a review (its font has none), so the composer can say so. */
export const cardDropsEmoji = (text: string | null | undefined) => cardText(text) !== (text ?? "").replace(/\s+/g, " ").trim();

/** Words, not only emoji or punctuation: an emoji-only review has none. */
export const hasWords = (text: string | null | undefined) => /[\p{L}\p{N}]/u.test(cardText(text));

/**
 * Whether the card's font has every letter in the words: Latin letters and common punctuation,
 * once emoji are taken out. Other scripts (Chinese, Arabic, Cyrillic…) get no card yet.
 */
export function cardSupported(text: string | null | undefined): boolean {
  const words = cardText(text);
  if (!hasWords(words)) return false;
  for (const ch of words) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0x17f && code !== 0xad) || ch in FIGTREE_EXTRA) continue;
    return false;
  }
  return true;
}

export interface CardFit {
  size: number;
  lines: string[];
  truncated: boolean;
}

/**
 * Words set to fit the card: the largest of `sizes` at which they wrap into `maxLines` lines of at
 * most `width` (and, with `maxHeight`, as many lines of `lineHeight` times the size as fit in it),
 * breaking a word too long for a line. When even the smallest is too many lines, the last line kept
 * ends with "…". `measure` says how wide some words are at a size.
 */
export function fitCardText(text: string, options: { measure: (text: string, size: number) => number; width: number; sizes?: readonly number[]; maxLines?: number; maxHeight?: number; lineHeight?: number }): CardFit {
  const { measure, width } = options;
  const sizes = options.sizes?.length ? options.sizes : [56, 50, 44, 40];
  const most = Math.max(1, options.maxLines ?? 7);
  const linesAt = (size: number) => (options.maxHeight ? Math.max(1, Math.min(most, Math.floor(options.maxHeight / (size * (options.lineHeight ?? 1.3))))) : most);
  const words = cardText(text).split(" ").filter(Boolean);
  const wrap = (size: number) => {
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const pieces: string[] = [];
      let rest = word;
      // A word wider than a line goes on lines of its own, as much as fits on each.
      while (measure(rest, size) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut), size) > width) cut--;
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      pieces.push(rest);
      for (const piece of pieces) {
        const next = line ? `${line} ${piece}` : piece;
        if (line && measure(next, size) > width) {
          lines.push(line);
          line = piece;
        } else {
          line = next;
        }
        if (piece !== pieces.at(-1)) {
          lines.push(line);
          line = "";
        }
      }
    }
    if (line) lines.push(line);
    return lines;
  };
  for (const size of sizes) {
    const lines = wrap(size);
    if (lines.length <= linesAt(size)) return { size, lines, truncated: false };
  }
  const size = sizes.at(-1)!;
  const maxLines = linesAt(size);
  const lines = wrap(size).slice(0, maxLines);
  let last = lines[maxLines - 1] ?? "";
  while (last && measure(`${last}…`, size) > width) last = last.slice(0, -1);
  lines[maxLines - 1] = `${last.replace(/[\s,.;:!?–—-]+$/u, "")}…`;
  return { size, lines, truncated: true };
}

/** Instagram's shapes for one photo: 4:5 tall to 1.91:1 wide. A photo outside them is padded, never cropped. */
export const INSTAGRAM_RATIO = { min: 0.8, max: 1.91 } as const;

/** Crewtavo's own: --solid, and the stars' gold. */
export const CARD_DEFAULT = "#0f2a35";
export const CARD_INK = "#182430";
export const STAR_GOLD = "#f5b400";
/** Instagram's padding for a photo when the business has no brand colour: a neutral light grey. */
export const PAD_GREY = "#efeeea";

const HEX = /^#[0-9a-f]{6}$/i;
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

export interface CardColors {
  background: string;
  text: string;
  /** The reviewer's name and the small print. */
  muted: string;
  stars: string;
  /** True when it's the business's own colour. */
  brand: boolean;
}

/** A card in the business's brand colour (settings.branding.color), else Crewtavo's, with words in white or ink, whichever reads better. */
export function cardColors(brand: string | null | undefined): CardColors {
  const own = typeof brand === "string" && HEX.test(brand);
  const background = own ? brand.toLowerCase() : CARD_DEFAULT;
  const light = contrast(background, "#ffffff") >= contrast(background, CARD_INK);
  return {
    background,
    text: light ? "#ffffff" : CARD_INK,
    muted: light ? "rgba(255,255,255,0.74)" : "rgba(24,36,48,0.72)",
    stars: STAR_GOLD,
    brand: own,
  };
}

/** The colour Instagram's copy of a photo is padded with: the brand colour, or a light grey. */
export const padColor = (brand: string | null | undefined) => (typeof brand === "string" && HEX.test(brand) ? brand.toLowerCase() : PAD_GREY);

/** The business's brand colour, as documents print it (settings.branding.color). */
export function brandColor(settings: unknown): string | null {
  const color = (settings as { branding?: { color?: unknown } } | null)?.branding?.color;
  return typeof color === "string" && HEX.test(color) ? color : null;
}

// ---------------------------------------------------------------------------------------------
// Automatic 5-star posts
// ---------------------------------------------------------------------------------------------

/** What an automatic post says until a person changes it, the same words as private.default_review_caption. */
export const DEFAULT_REVIEW_CAPTION = "Another 5-star review from a happy client. Thank you!";
/** The times of day automatic posts go, in the company's time zone. */
export const AUTO_SLOTS = ["10:00", "13:00", "16:00"] as const;
export const AUTO_POSTS_PER_DAY = 3;
/** Brought in before this, a review can post the same day: the office still has two hours to look. */
export const AUTO_SAME_DAY_BEFORE = "08:00";
/** A review is news, and can post automatically, when it was posted this lately (record_reviews). */
export const AUTO_REVIEW_DAYS = 14;
/** A post's pictures stay at their public link this long after it finishes. */
export const IMAGE_LINK_DAYS = 7;

export interface SocialSettings {
  auto: { enabled: boolean; networks: Network[] };
}

/** settings.social as private.social_settings_auto reads it: automatic posts and where they go. */
export function socialSettings(settings: unknown): SocialSettings {
  const auto = ((settings as { social?: { auto?: unknown } } | null)?.social?.auto ?? {}) as { enabled?: unknown; networks?: unknown };
  const networks = Array.isArray(auto.networks) ? NETWORKS.filter((n) => (auto.networks as unknown[]).includes(n)) : [];
  return { auto: { enabled: auto.enabled === true, networks } };
}

/**
 * When the next automatic post can go, as private.next_auto_post_slot picks it: the first of 10 AM,
 * 1 PM and 4 PM in the company's time zone that isn't taken, on a day with fewer than 3 automatic
 * posts, from today if it's before 8 AM there and otherwise tomorrow, up to 60 days out. `taken` is
 * when the company's other automatic posts go (cancelled ones left out).
 */
export function nextAutoSlot(now: Date, timeZone: string, taken: readonly Date[]): Date | null {
  const today = localDate(now, timeZone);
  const first = localTime(now, timeZone) < AUTO_SAME_DAY_BEFORE ? today : addDays(today, 1);
  const at = new Set(taken.map((t) => t.getTime()));
  for (let d = 0; d <= 60; d++) {
    const day = addDays(first, d);
    if (taken.filter((t) => localDate(t, timeZone) === day).length >= AUTO_POSTS_PER_DAY) continue;
    for (const slot of AUTO_SLOTS) {
      const time = zonedTimeToUtc(day, slot, timeZone);
      if (!at.has(time.getTime())) return time;
    }
  }
  return null;
}

/** "10 AM", "1:30 PM", in the company's time zone. */
export function clockWords(at: Date, timeZone: string): string {
  const [h, m] = localTime(at, timeZone).split(":").map(Number) as [number, number];
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * "today at 10 AM", "tomorrow at 1 PM", "Nov 6 at 4 PM", as private.auto_post_when says it and the
 * Social tab lists it: a date past tomorrow, since an automatic post can be weeks out.
 */
export function autoPostWhen(at: Date, timeZone: string, now: Date = new Date()): string {
  const day = localDate(at, timeZone);
  const today = localDate(now, timeZone);
  const words = day === today ? "today" : day === addDays(today, 1) ? "tomorrow" : at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  return `${words} at ${clockWords(at, timeZone)}`;
}

/** A time zone as people say it: "Eastern Time". The zone's own name when Intl has no words for it. */
export function timeZoneWords(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

// ---------------------------------------------------------------------------------------------
// How a post went
// ---------------------------------------------------------------------------------------------

export type PostStatus = "draft" | "scheduled" | "posting" | "posted" | "partly_posted" | "check" | "failed" | "cancelled";
export type NetworkStatus = "waiting" | "sending" | "posted" | "retry" | "failed" | "unknown" | "skipped";

/**
 * A post's status from its networks, as private.social_post_status says it: posting while any is
 * still to go, posted when all posted, partly posted when some did, check when none did and one may
 * have, cancelled when every one was called off, and failed otherwise. Null with no networks yet.
 */
export function postStatusOf(networks: ReadonlyArray<{ status: string; error_kind?: string | null }>): PostStatus | null {
  if (!networks.length) return null;
  if (networks.some((n) => n.status === "waiting" || n.status === "sending" || n.status === "retry")) return "posting";
  if (networks.every((n) => n.status === "posted")) return "posted";
  if (networks.some((n) => n.status === "posted")) return "partly_posted";
  if (networks.some((n) => n.status === "unknown")) return "check";
  if (networks.every((n) => n.status === "skipped" && n.error_kind === "cancelled")) return "cancelled";
  return "failed";
}
