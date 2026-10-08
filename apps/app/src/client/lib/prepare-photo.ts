/**
 * Redraws a chosen photo at most 3,000 px on the long edge as a JPEG (§8 step 1). Decoding with
 * createImageBitmap applies the EXIF orientation, and the redrawn file carries none of the
 * original's GPS or camera data. Returns null when this browser cannot read the file (a HEIC
 * photo in most browsers), so the owner can be asked for a JPG or PNG instead.
 */
export async function preparePhoto(file: Blob, maxEdge = 3000): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (context === null) return null;
  // JPEG has no transparency: paint white first so a transparent logo does not turn black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.9));
}
