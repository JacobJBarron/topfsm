/**
 * Marketing → Social (services/social.ts), for owners, admins and office staff with the marketing
 * area: where posts can go (GET /social, since only owners and admins read integrations), the photos
 * OK to share and the reviews to post, the review card and a photo ready to share anywhere, the posts
 * themselves (made, changed, cancelled, posted again, and one that may have posted settled by a
 * person), Suggest a caption with the company's Claude key, and automatic 5-star posts. Only the
 * server writes posts. Nothing posts, and nothing new is scheduled, while Marketing is uninstalled.
 */
import { ADMINS, OFFICE } from "@crewtavo/core";
import { marketingOn } from "@crewtavo/core/marketing";
import {
  CANT_SHARE,
  cardDropsEmoji,
  cardSupported,
  cardText,
  firstNameLastInitial,
  hasWords,
  MAX_PHOTOS,
  mentionsClient,
  NETWORKS,
  type CantShare,
  type Network,
} from "@crewtavo/core/social";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { renderReviewCard } from "../lib/reviewCard";
import { shareJpeg, ShareImageError } from "../lib/shareImage";
import { storedFile } from "../lib/storedFile";
import { adminClient } from "../lib/supabase";
import { companyAnthropicKey } from "../services/ai";
import {
  cardInput,
  checkPost,
  clientWords,
  jobServices,
  imagesPublic,
  MARKETING_OFF_POSTS,
  photoFacts,
  postableReview,
  postBody,
  postNow,
  postWhen,
  PRIVATE_ADDRESS_POSTS,
  socialState,
  suggestCaption,
  type PostBody,
} from "../services/social";

export const social = new Hono<AppEnv>();

type Ctx = Parameters<typeof param>[0];
const postScope = (c: Ctx) => ({ env: c.env, companyId: c.var.companyId });
const PAGE = 25;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

async function companyOf(c: Ctx) {
  const company = must(await c.var.db.from("companies").select("name, settings, timezone").eq("id", c.var.companyId).maybeSingle());
  return { ...company, settings: (company.settings ?? {}) as Record<string, unknown> };
}

/** Uninstalled, Marketing posts nothing and schedules nothing. */
async function requireMarketing(c: Ctx, message = MARKETING_OFF_POSTS) {
  const company = await companyOf(c);
  if (!marketingOn(company.settings)) throw new HttpError(409, message);
  return company;
}

// Photos go to the browser as their storage paths, never signed links: the browser signs its own
// (lib/files.ts signedUrls), at the address it reaches Storage by. This server may reach it at
// 127.0.0.1 (stack mode), which in a link would point at the viewer's own computer.

social.get("/social", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const admin = adminClient(c.env);
  const state = await socialState(c.env, admin, c.var.companyId);
  const key = await companyAnthropicKey(c.env, admin, c.var.companyId);
  return c.json({ ...state, can_connect: ADMINS.includes(c.var.role) && c.var.permissions.includes("apps"), ai: Boolean(key || c.env.ANTHROPIC_API_KEY) });
});

/** The photos OK to share, newest first, 48 at a time, with their paths. `job` narrows them to one job's. */
social.get("/social/photos", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const { before_at, before_id, job } = c.req.query();
  const { data, error } = await c.var.db.rpc("social_photos", {
    p_company: c.var.companyId,
    p_before_at: before_at || undefined,
    p_before_id: before_id && uuid.safeParse(before_id).success ? before_id : undefined,
    p_limit: 48,
    p_job: job && uuid.safeParse(job).success ? job : undefined,
  });
  if (error) throw dbError(error);
  const rows = data ?? [];
  return c.json({ photos: rows, more: rows.length === 48 });
});

/**
 * Photos a post has picked, by id, whether or not they're among the newest: each with its path and,
 * when it can't be posted anymore, why (not_shared, client_opt_out, format, no_client, gone).
 */
social.get("/social/photos/picked", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const ids = [...new Set((c.req.query("ids") ?? "").split(",").filter((id) => uuid.safeParse(id).success))].slice(0, 20);
  const facts = await photoFacts(adminClient(c.env), c.var.companyId, ids);
  return c.json({
    photos: ids.map((id) => {
      const fact = facts.find((f) => f.id === id);
      if (!fact) return { id, path: null, problem: "gone" };
      return { id, path: fact.path, problem: fact.problem ?? (fact.shareable ? null : "not_shared") };
    }),
  });
});

/**
 * Reviews to post: 4 and 5 stars with words, still on Google, newest first, 25 at a time. Each says
 * whether the card can show its words (and whether it leaves emoji out), whether they name the client
 * it's matched to, and when it was posted, if it was.
 */
social.get("/social/reviews", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const { before } = c.req.query();
  let query = c.var.db.from("reviews").select("id, rating, reviewer_name, reviewer_anonymous, posted_at, comment, client_id, location_id, review_id")
    .eq("company_id", c.var.companyId).is("deleted_at", null).gte("rating", 4).not("comment", "is", null)
    .order("posted_at", { ascending: false }).limit(PAGE);
  if (before) query = query.lt("posted_at", before);
  const rows = must(await query);
  const admin = adminClient(c.env);
  const keys = rows.map((r) => `${r.location_id}/${r.review_id}`);
  const { data: posts } = keys.length
    ? await admin.from("social_posts").select("review_key, finished_at, status").eq("company_id", c.var.companyId).in("review_key", keys).in("status", ["posted", "partly_posted"])
    : { data: [] };
  const words = new Map<string, Awaited<ReturnType<typeof clientWords>>>();
  for (const id of new Set(rows.map((r) => r.client_id).filter((id): id is string => Boolean(id)))) words.set(id, await clientWords(admin, c.var.companyId, [id]));
  const reviews = rows.filter((r) => hasWords(r.comment)).map((r) => ({
    id: r.id,
    rating: r.rating,
    name: r.reviewer_anonymous ? null : firstNameLastInitial(r.reviewer_name),
    posted_at: r.posted_at,
    comment: r.comment,
    card_ok: cardSupported(r.comment),
    card_drops_emoji: cardDropsEmoji(r.comment),
    mentions_client: r.client_id ? mentionsClient(r.comment ?? "", words.get(r.client_id)!).blocked.length > 0 : false,
    posted_on: (posts ?? []).filter((p) => p.review_key === `${r.location_id}/${r.review_id}`).map((p) => p.finished_at).sort().at(-1) ?? null,
  }));
  return c.json({ reviews, more: rows.length === PAGE });
});

/** The review's card, as it posts: the composer's preview, and Share elsewhere. */
social.get("/social/reviews/:id/card.jpg", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const review = await postableReview(postScope(c), param(c, "id"));
  const jpeg = await renderReviewCard(await cardInput(adminClient(c.env), c.var.companyId, review));
  return c.body(jpeg, 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" });
});

/** A photo OK to share, ready to post (turned, shrunk, without EXIF), for Share elsewhere. */
social.get("/social/image/:attachmentId", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "attachmentId");
  const admin = adminClient(c.env);
  const [fact] = await photoFacts(admin, c.var.companyId, [id]);
  if (!fact || !fact.shareable) throw new HttpError(404, "That photo isn't OK to share.");
  if (fact.problem) throw new HttpError(400, CANT_SHARE[fact.problem as CantShare] ?? "That photo can't be posted.");
  const bytes = await storedFile(admin, fact.path, 40_000_000);
  if (!bytes) throw new HttpError(404, "That photo couldn't be read.");
  try {
    const jpeg = await shareJpeg(bytes);
    return c.body(jpeg.body, 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" });
  } catch (error) {
    if (error instanceof ShareImageError) throw new HttpError(400, error.message);
    throw error;
  }
});

/**
 * Posts, 25 at a time, with each network's result: `list=upcoming` (posting and scheduled in the order
 * they go, then drafts, newest first) or `done` (the rest, newest first). A post of photos carries its
 * first photo's path; a review's carries who wrote it, its stars and its first words, so automatic
 * posts with the same caption can be told apart.
 */
social.get("/social/posts", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const { list, before_at, before_id, before_for } = c.req.query();
  const upcoming = list === "upcoming";
  let query = c.var.db.from("social_posts")
    .select("id, source, review_id, attachment_ids, caption, caption_by, networks, status, scheduled_for, automatic, note, started_at, finished_at, cancelled_at, created_at, created_by, results:social_post_networks(network, status, external_id, permalink, error, error_kind, attempts, next_attempt_at, posted_at)")
    .eq("company_id", c.var.companyId)
    .in("status", upcoming ? ["draft", "scheduled", "posting"] : ["posted", "partly_posted", "check", "failed", "cancelled"]);
  // Drafts have no time, so they come after everything that has one.
  if (upcoming) query = query.order("scheduled_for", { ascending: true, nullsFirst: false });
  query = query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE);
  // The last row's own times, to the microsecond (a Date would round them and skip rows).
  if (before_at && before_id && uuid.safeParse(before_id).success && TIMESTAMP.test(before_at)) {
    const older = `created_at.lt."${before_at}",and(created_at.eq."${before_at}",id.lt.${before_id})`;
    if (!upcoming) query = query.or(older);
    else if (before_for && TIMESTAMP.test(before_for)) query = query.or(`scheduled_for.gt."${before_for}",scheduled_for.is.null,and(scheduled_for.eq."${before_for}",or(${older}))`);
    else query = query.is("scheduled_for", null).or(older);
  }
  const rows = must(await query);
  const admin = adminClient(c.env);
  const first = rows.map((r) => r.attachment_ids[0]).filter((id): id is string => Boolean(id));
  const reviewIds = rows.flatMap((r) => (r.source === "review" && r.review_id ? [r.review_id] : []));
  const [{ data: files }, { data: reviews }] = await Promise.all([
    first.length ? admin.from("attachments").select("id, path").eq("company_id", c.var.companyId).in("id", first) : { data: [] },
    reviewIds.length ? admin.from("reviews").select("id, rating, reviewer_name, reviewer_anonymous, comment").eq("company_id", c.var.companyId).in("id", reviewIds) : { data: [] },
  ]);
  const thumbs = new Map((files ?? []).map((f) => [f.id, f.path]));
  const reviewOf = new Map((reviews ?? []).map((r) => [r.id, { name: r.reviewer_anonymous ? null : firstNameLastInitial(r.reviewer_name), rating: r.rating, words: cardText(r.comment).slice(0, 160) }]));
  return c.json({
    posts: rows.map((r) => ({
      ...r,
      thumb_path: r.attachment_ids[0] ? (thumbs.get(r.attachment_ids[0]) ?? null) : null,
      review: r.source === "review" && r.review_id ? (reviewOf.get(r.review_id) ?? null) : null,
    })),
    more: rows.length === PAGE,
  });
});

// A change names only what changes: nothing here has a default, or it would undo what's saved.
const patchBody = z.object({
  source: z.enum(["photos", "review", "text"]).optional(),
  review_id: uuid.nullable().optional(),
  attachment_ids: z.array(uuid).max(20).optional(),
  caption: z.string().max(2200).optional(),
  caption_by: z.enum(["person", "ai"]).optional(),
  networks: z.array(z.enum(NETWORKS)).min(1, "Pick where it posts.").max(3).optional(),
  when: postWhen.optional(),
});

/**
 * Checks a post as Post now would, saving nothing, so a caption that would be refused (it names a
 * client) is said before the "posts publicly" confirm rather than after it. Says the warnings.
 */
social.post("/social/posts/check", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, postBody);
  await requireMarketing(c);
  const { warnings } = await checkPost(postScope(c), body);
  return c.json({ ok: true, warnings });
});

social.post("/social/posts", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, postBody);
  await requireMarketing(c);
  const { row, warnings } = await checkPost(postScope(c), body);
  const admin = adminClient(c.env);
  const { data, error } = await admin.from("social_posts")
    .insert({ ...row, company_id: c.var.companyId, caption_by: body.caption_by, created_by: c.var.userId, updated_by: c.var.userId })
    .select("id, status, scheduled_for").single();
  if (error) throw dbError(error);
  if (body.when === "now") runInBackground(c, postNow(c.env, admin, data.id));
  return c.json({ post: data, warnings }, 201);
});

const STARTED = "This post has started posting, so it can't be changed.";
const KEEPS_REVIEW = "An automatic post keeps its review. Cancel it and make a new post to share another one.";

/** Changes a draft or scheduled post: its caption, networks, photos, time, or draft and scheduled. */
social.patch("/social/posts/:id", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  const patch = await readJson(c, patchBody);
  await requireMarketing(c);
  const admin = adminClient(c.env);
  const { data: post } = await admin.from("social_posts").select("*").eq("company_id", c.var.companyId).eq("id", id).maybeSingle();
  if (!post) throw new HttpError(404, "That post isn't here.");
  if (post.status !== "draft" && post.status !== "scheduled") throw new HttpError(409, STARTED);
  // One automatic post per review: it never becomes another review's, or something else.
  if (post.automatic && ((patch.source !== undefined && patch.source !== post.source) || (patch.review_id !== undefined && patch.review_id !== post.review_id))) {
    throw new HttpError(400, KEEPS_REVIEW);
  }
  const merged: PostBody = {
    source: post.automatic ? (post.source as PostBody["source"]) : (patch.source ?? (post.source as PostBody["source"])),
    review_id: patch.review_id !== undefined && !post.automatic ? patch.review_id : post.review_id,
    attachment_ids: patch.attachment_ids ?? post.attachment_ids,
    caption: patch.caption ?? post.caption,
    caption_by: patch.caption_by ?? "person",
    networks: (patch.networks ?? post.networks) as Network[],
    when: patch.when ?? (post.status === "draft" ? "draft" : post.scheduled_for && Date.parse(post.scheduled_for) < Date.now() + 5 * 60_000 ? "now" : { at: post.scheduled_for! }),
  };
  const { row, warnings } = await checkPost(postScope(c), merged);
  const captionChanged = patch.caption !== undefined && patch.caption !== post.caption;
  const { data, error } = await admin.from("social_posts")
    .update({ ...row, caption_by: captionChanged ? merged.caption_by : post.caption_by, note: null, updated_by: c.var.userId })
    .eq("company_id", c.var.companyId).eq("id", id).in("status", ["draft", "scheduled"])
    .select("id, status, scheduled_for");
  if (error) {
    if (error.code === "55000") throw new HttpError(409, STARTED);
    throw dbError(error);
  }
  if (!data?.length) throw new HttpError(409, STARTED);
  if (merged.when === "now") runInBackground(c, postNow(c.env, admin, id));
  return c.json({ post: data[0], warnings });
});

/** Cancel post: a scheduled one, or what's still to go of one partway through. */
social.post("/social/posts/:id/cancel", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  const { data, error } = await adminClient(c.env).rpc("cancel_social_post", { p_company: c.var.companyId, p_post: id, p_by: c.var.userId });
  if (error) throw dbError(error);
  if (!data) throw new HttpError(409, "This post can't be cancelled now.");
  return c.json({ status: data });
});

social.delete("/social/posts/:id", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  const { data, error } = await adminClient(c.env).from("social_posts").delete().eq("company_id", c.var.companyId).eq("id", id).eq("status", "draft").select("id");
  if (error) throw dbError(error);
  if (!data?.length) throw new HttpError(409, "Only drafts can be deleted.");
  return c.json({ deleted: id });
});

/** Post again: the networks that failed or were skipped go again, with the same words and pictures. */
social.post("/social/posts/:id/retry", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  await requireMarketing(c);
  const admin = adminClient(c.env);
  const { data, error } = await admin.rpc("retry_social_post", { p_company: c.var.companyId, p_post: id, p_by: c.var.userId });
  if (error) throw dbError(error);
  if (!data) throw new HttpError(409, "There's nothing to post again.");
  runInBackground(c, postNow(c.env, admin, id));
  return c.json({ networks: data });
});

/** A network that may have posted, settled by a person: it's on the Page, or it isn't, so it posts. */
social.post("/social/posts/:id/networks/:network/resolve", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  const network = c.req.param("network");
  if (!(NETWORKS as readonly string[]).includes(network)) throw new HttpError(404, "That isn't a network.");
  const body = await readJson(c, z.object({ posted: z.boolean(), permalink: z.url({ protocol: /^https$/ }).max(2000).nullable().optional() }));
  if (!body.posted) await requireMarketing(c);
  const admin = adminClient(c.env);
  const { data, error } = await admin.rpc("resolve_social_network", {
    p_company: c.var.companyId, p_post: id, p_network: network, p_posted: body.posted, p_permalink: body.permalink ?? null, p_by: c.var.userId,
  } as never);
  if (error) throw dbError(error);
  if (!data) throw new HttpError(409, "That isn't waiting to be checked.");
  if (!body.posted) runInBackground(c, postNow(c.env, admin, id));
  return c.json({ status: data });
});

/** Suggest a caption (or, with `draft`, Rewrite): a draft from Claude to read and change. Nothing is posted. */
social.post("/social/caption", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, z.object({
    source: z.enum(["photos", "review", "text"]),
    review_id: uuid.nullable().optional(),
    attachment_ids: z.array(uuid).max(MAX_PHOTOS).default([]),
    draft: z.string().max(2200).optional(),
    instruction: z.string().max(300).optional(),
  }));
  const company = await requireMarketing(c, "Marketing is off, so captions can't be drafted. An owner or admin can install it again in Apps.");
  const admin = adminClient(c.env);
  const review = body.source === "review" && body.review_id ? await postableReview(postScope(c), body.review_id) : null;
  const facts = body.source === "photos" ? await photoFacts(admin, c.var.companyId, body.attachment_ids) : [];
  try {
    const result = await suggestCaption(c.env, {
      apiKey: await companyAnthropicKey(c.env, admin, c.var.companyId),
      company: company.name,
      source: body.source,
      review,
      services: await jobServices(admin, c.var.companyId, facts.map((f) => f.job_id)),
      draft: body.draft,
      instruction: body.instruction,
      clients: await clientWords(admin, c.var.companyId, [...facts.map((f) => f.client_id), review?.client_id]),
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof HttpError && error.status === 501) throw new HttpError(501, "Suggest a caption needs a Claude key. An owner or admin can add one in Apps → Claude.");
    throw error;
  }
});

/**
 * Post 5-star reviews automatically: on (with one of its networks ready, and this server's address
 * public) or off, which cancels the automatic posts still scheduled and says how many. Saved by the
 * database alone (social_set_auto), so nothing else in the company's settings is written.
 */
social.put("/social/settings", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, z.object({ auto: z.object({ enabled: z.boolean(), networks: z.array(z.enum(NETWORKS)).max(3) }) }));
  if (body.auto.enabled) await requireMarketing(c);
  // Every automatic post is a review's card, which Meta and Google fetch from this server.
  if (body.auto.enabled && !imagesPublic(c.env)) throw new HttpError(409, PRIVATE_ADDRESS_POSTS);
  const { data, error } = await adminClient(c.env).rpc("social_set_auto", { p_company: c.var.companyId, p_enabled: body.auto.enabled, p_networks: body.auto.networks });
  if (error) {
    if (error.code === "22023") throw new HttpError(400, error.message);
    throw dbError(error);
  }
  return c.json(data as { enabled: boolean; networks: string[]; cancelled: number });
});
