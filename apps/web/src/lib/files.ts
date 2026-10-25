/** Photo and receipt uploads to the private "files" bucket, under the company's folder. */
import { supabase } from "./api";

/** The largest file an upload sends (a photo once it's shrunk). */
export const MAX_BYTES = 15 * 1024 * 1024;

/** Shrink a photo to at most `max` pixels on its long side (phones take huge pictures). */
export async function compressImage(file: File, max = 2000, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file; // HEIC or another format the browser can't decode: upload as-is
  }
}

/**
 * A profile photo: the middle of the picture as a square JPEG of at most `size` pixels (for a tall
 * picture, a little above the middle, where faces usually are). Null when the browser can't open it.
 */
export async function squarePhoto(file: File, size = 512): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const out = Math.min(size, side);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = out;
    const ctx = canvas.getContext("2d")!;
    // A transparent picture would turn black as a JPEG.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out, out);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 3, side, side, 0, 0, out, out);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  } catch {
    return null; // HEIC in a browser that can't decode it, or not a picture at all
  }
}

/**
 * A business logo: the picture as a PNG of at most `maxWidth` × `maxHeight` pixels, with its
 * see-through background kept and any empty margin around it cut off. An SVG is drawn as large as
 * fits. Null when the browser can't open it, or there's nothing in it.
 */
export async function logoPicture(file: File, maxWidth = 720, maxHeight = 240): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    // An <img> opens SVGs too, which createImageBitmap doesn't.
    const image = new Image();
    image.src = url;
    await image.decode();
    const vector = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    const width = image.naturalWidth || 300;
    const height = image.naturalHeight || 150;
    const fit = (w: number, h: number) => Math.min(maxWidth / w, maxHeight / h, vector ? Infinity : 1);
    // Draw the whole picture to find what isn't see-through...
    const scale = fit(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    let ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let [left, top, right, bottom] = [canvas.width, canvas.height, -1, -1];
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] < 8) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    if (right < 0) return null;
    // ...then draw just that, again as large as fits.
    const [sx, sy, sw, sh] = [left / scale, top / scale, (right - left + 1) / scale, (bottom - top + 1) / scale];
    const crop = fit(sw, sh);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sw * crop));
    out.height = Math.max(1, Math.round(sh * crop));
    ctx = out.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
  } catch {
    return null; // HEIC in a browser that can't decode it, or not a picture at all
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Where the business's logo loads from (the public logo route), or null when it has none. */
export function logoUrl(settings: unknown): string | null {
  const branding = settings && typeof settings === "object" ? (settings as { branding?: { logo?: unknown } }).branding : null;
  const path = branding?.logo;
  return typeof path === "string" && path.includes("/logo/") ? `/api/public/logo/${path.replace("/logo/", "/")}` : null;
}

/** The server takes a package picture up to 1.4 MB (apps/api/src/services/packagePictures.ts); a little under it. */
const PACKAGE_PICTURE_BYTES = 1_300_000;

/**
 * A package's picture: the photo as a JPEG of at most 1600 pixels on its long side, with white
 * behind anything see-through. A detailed photo that's still too large comes out a little smaller.
 * An SVG is drawn as large as fits. Null when the browser can't open it.
 */
export async function packagePicture(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    // An <img> opens SVGs too, which createImageBitmap doesn't.
    const image = new Image();
    image.src = url;
    await image.decode();
    const vector = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    const width = image.naturalWidth || 1600;
    const height = image.naturalHeight || 1200;
    let blob: Blob | null = null;
    for (const [max, quality] of [[1600, 0.85], [1600, 0.7], [1200, 0.7]] as const) {
      const scale = Math.min(max / Math.max(width, height), vector ? Infinity : 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d")!;
      // A transparent picture would turn black as a JPEG.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      canvas.width = canvas.height = 0; // hand the memory back
      if (!blob || blob.size <= PACKAGE_PICTURE_BYTES) break;
    }
    return blob;
  } catch {
    return null; // HEIC in a browser that can't decode it, or not a picture at all
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A file's contents as base64, for sending a small picture as JSON. */
export function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * What gets uploaded: photos are shrunk first, so the 15 MB limit applies to what's actually
 * sent (a 20 MB phone photo is usually a few MB once shrunk). Other files are checked as they are.
 */
export async function uploadBody(file: File, shrink: (file: File) => Promise<Blob> = compressImage): Promise<Blob> {
  const tooBig = () => new Error(`${file.name} is larger than 15 MB.`);
  if (!file.type.startsWith("image/") && file.size > MAX_BYTES) throw tooBig();
  const body = await shrink(file);
  if (body.size > MAX_BYTES) throw tooBig();
  return body;
}

/** Upload a file under <company>/<folder>/ and return its storage path. */
export async function uploadFile(companyId: string, folder: string, file: File): Promise<string> {
  const body = await uploadBody(file);
  const ext = body === file ? (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") : "jpg";
  const path = `${companyId}/${folder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase().storage.from("files").upload(path, body, { contentType: body.type || file.type || "application/octet-stream", upsert: false });
  if (error) throw new Error(/row-level security/i.test(error.message) ? "You don't have permission to upload here." : `Upload failed: ${error.message}`);
  return path;
}

export async function signedUrls(paths: string[], seconds = 3600): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data, error } = await supabase().storage.from("files").createSignedUrls(paths, seconds);
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).flatMap((d) => (d.signedUrl && d.path ? [[d.path, d.signedUrl] as const] : [])));
}
