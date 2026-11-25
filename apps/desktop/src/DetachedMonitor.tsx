import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { tr, setLocaleOverride, useLocale, type Locale } from "./i18n";
import { MonitorPanel } from "./MonitorPanel";
import { defaultSettings, type AppSettings } from "./types";

export type MonitorWindowContext = {
  session: { id: string; name: string } | null;
  theme: AppSettings["theme"];
  monitorInterval: number;
  language: Locale;
};

/** Only monitor UI is mounted in the secondary native webview. */
export function DetachedMonitor() {
  useLocale();
  const [context, setContext] = useState<MonitorWindowContext | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function sync() {
      try {
        const value = await api<MonitorWindowContext | null>("monitor_window_context");
        if (disposed) return;
        setContext(value);
        setError("");
        if (value) {
          setLocaleOverride(value.language);
          document.documentElement.dataset.theme = value.theme;
        }
      } catch (e) {
        if (!disposed) {
          setContext(null);
          setError(errorText(e));
        }
      }
      if (!disposed) timer = setTimeout(sync, 750);
    }
    void sync();
    return () => {
      disposed = true;
      clearTimeout(timer);
      setLocaleOverride(null);
    };
  }, []);
  async function dock() {
    try { await api("monitor_window_dock"); }
    catch (e) { setError(errorText(e)); }
  }
  const session = context?.session
    ? { ...context.session, local: false, status: "connected" }
    : null;
  return <div className="detached-monitor-window">
    {error && <div className="detached-monitor-error" role="alert">{error}</div>}
    <MonitorPanel
      session={session}
      settings={{ monitorInterval: context?.monitorInterval ?? defaultSettings.monitorInterval }}
      notify={(message) => setError(message)}
      onClose={() => void dock()}
      onDock={() => void dock()}
    />
    <div className="detached-monitor-note">{tr("跟随主窗口当前 SSH 会话 · 独立监控窗口仅查看数据")}</div>
  </div>;
}
