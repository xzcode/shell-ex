import { useSyncExternalStore } from "react";

export const TERMINAL_BACKGROUND_KEY = "shell-ex-terminal-background-v1";
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_ENCODED_LENGTH = 1_400_000;
const MAX_EDGE = 1800;
const listeners = new Set<() => void>();

function isBackground(value: string | null): value is string {
  return !!value && value.length <= MAX_ENCODED_LENGTH
    && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
function readBackground(): string | null {
  try {
    const value = localStorage.getItem(TERMINAL_BACKGROUND_KEY);
    return isBackground(value) ? value : null;
  } catch { return null; }
}
let background = readBackground();
function publish(value: string | null) {
  if (background === value) return;
  background = value;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === TERMINAL_BACKGROUND_KEY || event.key === null) publish(readBackground());
  });
}
export function useTerminalBackground() {
  return useSyncExternalStore(subscribe, () => background, () => null);
}
export function saveTerminalBackground(value: string | null) {
  if (value !== null && !isBackground(value)) throw new Error("背景图片格式无效。");
  // Only commit the in-memory preference if local persistence succeeded.
  if (value === null) localStorage.removeItem(TERMINAL_BACKGROUND_KEY);
  else localStorage.setItem(TERMINAL_BACKGROUND_KEY, value);
  publish(value);
}

/** Decode and re-encode a user-picked raster image. No SVG, external URL or
 * original path is retained, and no image is transferred to the SSH host. */
export async function prepareTerminalBackground(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)
    || !file.size || file.size > MAX_SOURCE_BYTES)
    throw new Error("请选择不超过 12 MB 的 PNG、JPEG 或 WebP 图片。");

  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result) : reject(new Error("无法读取背景图片。"));
    reader.onerror = () => reject(new Error("无法读取背景图片。"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("背景图片无法解码。"));
    img.src = source;
  });
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height || width * height > 50_000_000)
    throw new Error("背景图片尺寸过大或无效。");

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("背景图片无法解码。");
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.82, 0.65, 0.45, 0.25]) {
    const value = canvas.toDataURL("image/jpeg", quality);
    if (isBackground(value)) return value;
  }
  throw new Error("背景图片压缩后仍然过大，请选择较小的图片。");
}
