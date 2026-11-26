import { useEffect, useRef, useState } from "react";
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
  const [docking, setDocking] = useState(false);
  const dockingRef = useRef(false);
  const contextGeneration = useRef(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function sync() {
      const generation = contextGeneration.current;
      try {
        const value = await api<MonitorWindowContext | null>("monitor_window_context");
        if (disposed) return;
        if (generation === contextGeneration.current && !dockingRef.current) {
          setContext(value);
          setError("");
        }
        if (value && generation === contextGeneration.current && !dockingRef.current) {
          setLocaleOverride(value.language);
          document.documentElement.dataset.theme = value.theme;
        }
      } catch (e) {
        if (!disposed && generation === contextGeneration.current && !dockingRef.current) {
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
    if (dockingRef.current) return;
    dockingRef.current = true;
    contextGeneration.current += 1;
    setDocking(true);
    try {
      await api("monitor_window_dock");
      setContext(null);
    } catch (e) { setError(errorText(e)); }
    finally {
      contextGeneration.current += 1;
      dockingRef.current = false;
      setDocking(false);
    }
  }
  const session = !docking && context?.session
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
      docking={docking}
    />
    <div className="detached-monitor-note">{tr("跟随主窗口当前 SSH 会话 · 独立监控窗口仅查看数据")}</div>
  </div>;
}
