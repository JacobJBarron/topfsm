import type { Db } from "./supabase";

/**
 * A file from the files bucket, read only up to `max` bytes: null when it isn't there or is larger,
 * which is never read whole. The public routes answer anyone, and the folders they read can hold what
 * a member uploads straight to Storage (up to its 200 MB limit), so a request never makes the server
 * hold more than a picture's worth. Posting reads photos the same way.
 */
export async function storedFile(admin: Db, path: string, max: number): Promise<Uint8Array | null> {
  const { data, error } = await admin.storage.from("files").download(path).asStream();
  if (error || !data) return null;
  const reader = data.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // Storage stopped partway: as good as not there.
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
