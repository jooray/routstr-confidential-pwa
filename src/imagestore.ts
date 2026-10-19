/**
 * Generated images, kept in this browser only (IndexedDB), and the client-side
 * re-encode that keeps them small: the provider's WebP is near-lossless (a
 * 16:9 1K image is ~300 KB); WebP at quality 0.75 and at most 1200 px wide is
 * ~65–90 KB. A browser that cannot encode WebP gets JPEG at 0.8.
 */

export interface StoredImage {
  id?: number;
  created: number;
  prompt: string;
  model: string;
  variant: string;
  costMsats: number;
  sid: string;
  receiptJson: string;
  blob: Blob;
}

const DB = "rc-images";
const STORE = "images";

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((res, rej) => {
      const t = db.transaction(STORE, mode);
      const r = run(t.objectStore(STORE));
      t.oncomplete = () => res(r.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  } finally {
    db.close();
  }
}

/** Store an image; resolves with its id. Falls back to memory-only (undefined) when IndexedDB is unavailable. */
export async function putImage(img: StoredImage): Promise<number | undefined> {
  try {
    return (await tx("readwrite", (s) => s.add(img))) as number;
  } catch {
    return undefined;
  }
}

/** All stored images, newest first. */
export async function listImages(): Promise<StoredImage[]> {
  try {
    const all = (await tx("readonly", (s) => s.getAll())) as StoredImage[];
    return all.sort((a, b) => b.created - a.created);
  } catch {
    return [];
  }
}

export async function deleteImage(id: number): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* nothing stored */
  }
}

const MAX_WIDTH = 1200;

/**
 * Re-encode to WebP 0.75 (JPEG 0.8 where WebP encoding is unsupported), at
 * most 1200 px wide. Always re-encoded, even when that is not smaller: a
 * redrawn image carries none of the provider file's metadata (which could
 * hold the prompt). `undefined` when the image cannot be decoded here.
 */
export async function reencode(blob: Blob): Promise<Blob | undefined> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return undefined;
  }
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const hgt = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(bitmap, 0, 0, w, hgt);
  bitmap.close();
  const encode = (type: string, q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
  const webp = await encode("image/webp", 0.75);
  if (webp && webp.type === "image/webp") return webp;
  return (await encode("image/jpeg", 0.8)) ?? undefined;
}
