import sharp from "sharp";

// Real image files for upload tests, made on the fly so no binary fixtures live in the repo.

const solid = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } });

export async function png(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await solid(width, height).png().toBuffer());
}

/** A plain JPEG: one colour compresses to a few hundred KB even at 50 million pixels. */
export async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await solid(width, height).jpeg({ quality: 90 }).toBuffer());
}

/** A JPEG carrying a camera make and GPS coordinates in its EXIF block. */
export async function jpegWithGps(width: number, height: number): Promise<Uint8Array> {
  const buffer = await solid(width, height)
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Make: "LeakyCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "30/1 16/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "97/1 44/1 0/1" } })
    .toBuffer();
  return new Uint8Array(buffer);
}

/** Two frames, so a naive pipeline would publish a moving image. */
export async function animatedWebp(): Promise<Uint8Array> {
  const frame = (background: string) => sharp({ create: { width: 300, height: 300, channels: 3, background } }).png().toBuffer();
  const frames = await Promise.all([frame("#ff0000"), frame("#0000ff")]);
  return new Uint8Array(await sharp(frames, { join: { animated: true } }).webp().toBuffer());
}

/**
 * A JPEG whose header is whole but whose picture data stops halfway. Reading its size works (the header
 * is all .info() needs); decoding it does not. Noise keeps the file large, so the cut lands in the data.
 */
export async function truncatedJpeg(width: number, height: number): Promise<Uint8Array> {
  const whole = await sharp({ create: { width, height, channels: 3, background: "#000000", noise: { type: "gaussian", mean: 128, sigma: 30 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Uint8Array(whole.subarray(0, Math.floor(whole.byteLength / 2)));
}

export const latin1 = (bytes: Uint8Array): string => new TextDecoder("latin1").decode(bytes);

export function upload(bytes: Uint8Array, name = "photo.jpg", type = "image/jpeg"): FormData {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return form;
}
