import { tr } from "./i18n";
import { api } from "./api";

const tails = new Map<string, Promise<void>>();
const queuedBytes = new Map<string, number>();
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** Serialize keystrokes, paste and snippets through the same bounded per-session queue. */
export function sendTerminalInput(
  sessionId: string,
  text: string,
  local: boolean,
): Promise<void> {
  const input = new TextEncoder().encode(text);
  const total = (queuedBytes.get(sessionId) || 0) + input.length;
  if (total > MAX_QUEUED_BYTES) {
    return Promise.reject(
      new Error(tr("终端待发送内容超过 8 MB，请等待当前输入完成后分批粘贴。")),
    );
  }
  queuedBytes.set(sessionId, total);
  const previous = tails.get(sessionId) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      for (let offset = 0; offset < input.length; offset += CHUNK_BYTES) {
        const chunk = input.subarray(offset, offset + CHUNK_BYTES);
        let binary = "";
        for (const byte of chunk) binary += String.fromCharCode(byte);
        await api("terminal_write", { sessionId, local, data: btoa(binary) });
      }
    });
  tails.set(sessionId, task);
  return task.finally(() => {
    const remaining = (queuedBytes.get(sessionId) || 0) - input.length;
    if (remaining > 0) queuedBytes.set(sessionId, remaining);
    else queuedBytes.delete(sessionId);
    if (tails.get(sessionId) === task) tails.delete(sessionId);
  });
}
