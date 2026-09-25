// On-device photo checks for the bleed capture (brief §6.4: "image must be legible").

/** Sharpness = variance of the Laplacian of a 320 px-wide greyscale copy. Higher is sharper. */
export async function sharpness(blob: Blob): Promise<number> {
  const img = await createImageBitmap(blob);
  const w = 320, h = Math.max(1, Math.round((img.height / img.width) * w));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      sum += l; sq += l * l; n++;
    }
  return n ? sq / n - (sum / n) ** 2 : 0;
}

/** Reads a barcode or QR code from the photo where the browser supports it (Chrome / Android WebView). */
export async function readBarcode(blob: Blob): Promise<string | null> {
  const BD = (window as any).BarcodeDetector;
  if (!BD) return null;
  try {
    const formats = (await BD.getSupportedFormats?.()) ?? undefined;
    const found = await new BD(formats ? { formats } : undefined).detect(await createImageBitmap(blob));
    return found[0]?.rawValue?.trim() || null;
  } catch {
    return null;
  }
}
