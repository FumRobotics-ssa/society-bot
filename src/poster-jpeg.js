import jpeg from 'jpeg-js';

function resized(image, size, quality) {
  const ratio = Math.min(1, size / Math.max(image.width, image.height));
  if (ratio === 1) return jpeg.encode(image, quality).data;
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y * image.height / height) * image.width;
    for (let x = 0; x < width; x++) {
      const source = (row + Math.floor(x * image.width / width)) * 4;
      data.set(image.data.subarray(source, source + 4), (y * width + x) * 4);
    }
  }
  return jpeg.encode({ width, height, data }, quality).data;
}

export function prepareEventPoster(bytes) {
  const maxSize = 52 * 1024;
  if (bytes.length <= maxSize) return bytes;
  try {
    const image = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 12, maxMemoryUsageInMB: 128 });
    const medium = resized(image, 880, 68);
    if (medium.length <= maxSize) return medium;
    const small = resized(image, 640, 56);
    return small.length < bytes.length ? small : bytes;
  } catch {
    return bytes;
  }
}
