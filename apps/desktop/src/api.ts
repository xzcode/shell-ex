import { tr } from "./i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import type { Host, Snippet } from "./types";
import { defaultSettings, defaultWorkspace, normalizeHost } from "./types";
export const native = isTauri();
export function errorText(error: unknown): string {
  if (typeof error === "string") return tr(error);
  if (error && typeof error === "object" && "message" in error)
    return tr(String(error.message));
  return tr("操作未完成，请重试。");
}
function stored<T>(name: string, fallback: T): T {
  try {
    return (
      JSON.parse(localStorage.getItem(`shell-ex-preview-${name}`) || "null") ??
      fallback
    );
  } catch {
    return fallback;
  }
}
function put(name: string, value: unknown) {
  localStorage.setItem(`shell-ex-preview-${name}`, JSON.stringify(value));
}
export async function api<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (native) return invoke<T>(command, args);
  // Preview is deliberately local and never fabricates a successful remote operation.
  let result: unknown;
  switch (command) {
    case "hosts_list":
      result = stored<Host[]>("hosts", []).map(normalizeHost);
      break;
    case "host_save": {
      const host = normalizeHost(args.host as Host);
      const hosts = stored<Host[]>("hosts", []);
      put("hosts", [...hosts.filter((h) => h.id !== host.id), host]);
      result = host;
      break;
    }
    case "host_delete":
      put(
        "hosts",
        stored<Host[]>("hosts", []).filter((h) => h.id !== args.id),
      );
      break;
    case "host_secret_status":
      result = false;
      break;
    case "settings_get":
      result = stored("settings", defaultSettings);
      break;
    case "settings_save":
      put("settings", args.settings);
      result = args.settings;
      break;
    case "workspace_get":
      result = stored("workspace", defaultWorkspace);
      break;
    case "workspace_save":
      put("workspace", args.workspace);
      result = args.workspace;
      break;
    case "snippets_list":
      result = stored("snippets", []);
      break;
    case "snippet_save": {
      const snippet = args.snippet as Snippet;
      put("snippets", [
        ...stored<Snippet[]>("snippets", []).filter((s) => s.id !== snippet.id),
        snippet,
      ]);
      result = snippet;
      break;
    }
    case "snippet_delete":
      put(
        "snippets",
        stored<Snippet[]>("snippets", []).filter((s) => s.id !== args.id),
      );
      break;
    case "transfers_list":
    case "tunnels_list":
      result = [];
      break;
    default:
      throw new Error(
        tr("当前是界面预览。请在 Shell EX 桌面应用中执行连接、文件操作与系统功能。"),
      );
  }
  return result as T;
}
export async function confirmAction(
  message: string,
  title = tr("确认操作"),
): Promise<boolean> {
  return native
    ? ask(message, {
        title,
        kind: "warning",
        okLabel: tr("确认"),
        cancelLabel: tr("取消"),
      })
    : window.confirm(`${title}\n\n${message}`);
}
export async function chooseFile(options?: {
  directory?: boolean;
  multiple?: boolean;
}): Promise<string | string[] | null> {
  if (!native) throw new Error(tr("选择本地文件需要 Shell EX 桌面应用。"));
  return open({
    directory: options?.directory ?? false,
    multiple: options?.multiple ?? false,
  });
}
export async function savePath(defaultPath?: string): Promise<string | null> {
  if (!native) throw new Error(tr("保存文件需要 Shell EX 桌面应用。"));
  return save({ defaultPath });
}
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export function base64(data: string): string {
  const u8 = new TextEncoder().encode(data);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}
export function joinPath(path: string, name: string): string {
  return `${path.replace(/\/$/, "")}/${name}`;
}
