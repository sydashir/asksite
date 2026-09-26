// The upload checks and re-encoding of §8, kept apart from HTTP so each rule is testable.

export type ImageKind = "jpeg" | "png" | "webp";

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((byte, i) => bytes[offset + i] === byte);

/** The real format from the first bytes. The file name and declared type are never trusted. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

export const MIN_SIDE_PX = 200;
export const MAX_PIXELS = 50_000_000;

export type SizeProblem = "too_small" | "too_many_pixels";

export function sizeProblem(width: number, height: number): SizeProblem | null {
  if (width < MIN_SIDE_PX || height < MIN_SIDE_PX) return "too_small";
  if (width * height > MAX_PIXELS) return "too_many_pixels";
  return null;
}

const stream = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Blob([bytes]).stream();

/** Width and height as the Images binding reads them, or null when it cannot decode the file. */
export async function imageInfo(images: ImagesBinding, bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const info = await images.info(stream(bytes));
    return "width" in info ? { width: info.width, height: info.height } : null;
  } catch {
    return null;
  }
}

/**
 * Re-encode to a still WebP, at most 1600 px on the long edge (§8 step 3). WebP output drops all
 * metadata (GPS included) and `anim: false` turns an animated file into a still one.
 */
export async function toStillWebp(images: ImagesBinding, bytes: Uint8Array): Promise<{ webp: Uint8Array; width: number; height: number }> {
  const result = await images
    .input(stream(bytes))
    .transform({ width: 1600, height: 1600, fit: "scale-down" })
    .output({ format: "image/webp", quality: 82, anim: false });
  const webp = new Uint8Array(await new Response(result.image()).arrayBuffer());
  const info = await imageInfo(images, webp);
  if (info === null) throw new Error("re-encoded image could not be measured");
  return { webp, ...info };
}
