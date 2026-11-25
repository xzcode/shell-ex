import { tr, useLocale } from "./i18n";
import type { MonitorWindowContext } from "./DetachedMonitor";
import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  Server,
  TerminalSquare,
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  PanelBottom,
  PanelRight,
  Columns2,
  Rows2,
  Maximize2,
  X,
  Folder,
  ArrowDownUp,
  Code2,
  Network,
  Container,
  ShieldCheck,
  Star,
  MoreHorizontal,
  Pencil,
  Copy,
  Trash2,
  ArrowUpRight,
  CircleHelp,
  Command,
  Check,
  AlertCircle,
  LoaderCircle,
  Monitor,
  LockKeyhole,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import type {
  AppSettings,
  AuthRequest,
  Host,
  HostKeyInfo,
  Notify,
  SecretInput,
  Session,
  TerminalEvent,
  Workspace,
} from "./types";
import { defaultSettings, defaultWorkspace, credentialStoreForHost, transferColumnMinimums } from "./types";
import { api, confirmAction, errorText, native } from "./api";
import { Busy, ErrorBox, Field, IconButton, Modal, Toggle } from "./ui";
import { HostDialog, TrustDialog } from "./HostDialog";
import {
  TerminalView,
  forgetTerminal,
  receiveTerminalEvent,
} from "./TerminalView";
import { FilePanel } from "./FilePanel";
import { ResizeHandle, clampWidth } from "./ResizeHandle";
import {
  DockerPanel,
  SnippetPanel,
  TransferPanel,
  TunnelPanel,
} from "./OperationsPanels";
import { MonitorPanel } from "./MonitorPanel";
import { SettingsDialog } from "./SettingsDialog";
import { LinuxHelpDialog } from "./LinuxHelpDialog";
import workspaceLogo from "../src-tauri/icons/128x128@2x.png";
import { VaultDialog, type VaultStatus } from "./VaultDialog";
import { hasDirtyDrafts } from "./drafts";
// Overlay window decorations are macOS-only. Browser previews keep the normal header.
const macTitlebar = native && (/^Mac/i.test(navigator.platform) || /Macintosh/.test(navigator.userAgent));
type Toast = {
  id: number;
  message: string;
  kind: "success" | "error" | "info";
};
type PromptAnswer = { secret: SecretInput; remember: boolean };
type SecretPrompt = {
  host: Host;
  resolve: (answer: PromptAnswer | null) => void;
};
const labels: Record<string, string> = {
  connected: "已连接",
  connecting: "连接中",
  authenticating: "认证中",
  disconnected: "连接中断",
  closed: "已关闭",
  closing: "正在关闭",
  error: "连接失败",
  failed: "连接失败",
  reconnecting: "重连中",
};
const panelItems = [
  { id: "files", name: "文件", icon: Folder },
  { id: "transfers", name: "传输", icon: ArrowDownUp },
  { id: "snippets", name: "快捷命令", icon: Code2 },
  { id: "tunnels", name: "隧道", icon: Network },
  { id: "docker", name: "Docker", icon: Container },
];
export default function App() {
  const locale = useLocale();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [workspace, setWorkspace] = useState<Workspace>(defaultWorkspace);
  const mainArea = useRef<HTMLDivElement>(null);
  const [mainAreaWidth, setMainAreaWidth] = useState(1000);
  useEffect(() => {
    if (!mainArea.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setMainAreaWidth(entry.contentRect.width);
    });
    observer.observe(mainArea.current);
    return () => observer.disconnect();
  }, []);
  const maxMonitorWidth = Math.max(240, Math.min(1000, mainAreaWidth - 240));
  const actualMonitorWidth = Math.min(workspace.monitorWidth, maxMonitorWidth);
  const [ready, setReady] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hostDialog, setHostDialog] = useState<Host | null | undefined>(
    undefined,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [monitorMode, setMonitorMode] = useState<"docked" | "opening" | "detached">("docked");
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [panel, setPanel] = useState("files");
  const [hostMenu, setHostMenu] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  const [trust, setTrust] = useState<{
    host: Host;
    info: HostKeyInfo;
    resolve: (yes: boolean) => void;
  } | null>(null);
  const [secretPrompt, setSecretPrompt] = useState<SecretPrompt | null>(null);
  const [vaultPrompt, setVaultPrompt] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const [authRequests, setAuthRequests] = useState<AuthRequest[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bootError, setBootError] = useState("");
  const [help, setHelp] = useState(false);
  const [linuxHelp, setLinuxHelp] = useState(false);
  const connectionLock = useRef(false);
  const closingSessions = useRef(new Set<string>());
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const sessionRef = useRef(sessions);
  sessionRef.current = sessions;
  const statusRef = useRef(
    new Map<string, { status: string; error?: string }>(),
  );
  const restoreRef = useRef<string[]>([]);
  const initialized = useRef(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reconnecting = useRef(new Set<string>());
  const reconnectControllers = useRef(new Map<string, AbortController>());
  const reconnectAttempts = useRef(new Map<string, number>());
  const active = sessions.find((s) => s.id === activeId) || null;
  const notify: Notify = useCallback((message, kind = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, kind }]);
    setTimeout(
      () => setToasts((t) => t.filter((n) => n.id !== id)),
      kind === "error" ? 10000 : 5000,
    );
  }, []);
  function monitorContext(): MonitorWindowContext {
    return {
      session: active && !active.local && active.status === "connected"
        ? { id: active.id, name: active.name } : null,
      theme: settings.theme,
      monitorInterval: settings.monitorInterval,
      language: locale,
    };
  }
  async function detachMonitor() {
    if (!native || monitorMode !== "docked") return;
    // Stop docked sampling before creating the separate native monitor window.
    setMonitorMode("opening");
    try {
      await api("monitor_window_open", { context: monitorContext() });
      setMonitorMode("detached");
    } catch (e) {
      setMonitorMode("docked");
      notify(errorText(e), "error");
    }
  }
  async function dockMonitor() {
    try {
      await api("monitor_window_dock");
      setMonitorMode("docked");
      setWorkspace((w) => ({ ...w, monitorVisible: true }));
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    void api<boolean>("monitor_window_is_open").then((open) => {
      if (!disposed && open === true) setMonitorMode("detached");
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!native || monitorMode !== "detached" || !ready) return;
    // Follow the active SSH tab and saved visual preferences without any
    // additional server login or terminal connection.
    void api("monitor_window_update", { context: monitorContext() }).catch((e) => notify(errorText(e), "error"));
  }, [monitorMode, ready, active?.id, active?.name, active?.status, active?.local, settings.theme, settings.monitorInterval, locale, notify]);
  useEffect(() => {
    if (monitorMode !== "detached") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const open = await api<boolean>("monitor_window_is_open");
        if (disposed) return;
        if (open === false) {
          setMonitorMode("docked");
          setWorkspace((w) => ({ ...w, monitorVisible: true }));
          return;
        }
      } catch { /* Keep the current mode on transient IPC failures. */ }
      if (!disposed) timer = setTimeout(check, 750);
    }
    void check();
    return () => { disposed = true; clearTimeout(timer); };
  }, [monitorMode]);
  const reloadHosts = useCallback(async () => {
    setHosts(await api<Host[]>("hosts_list"));
  }, []);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    Promise.all([
      api<Host[]>("hosts_list"),
      api<AppSettings>("settings_get"),
      api<Workspace>("workspace_get"),
    ])
      .then(([h, s, w]) => {
        setHosts(h);
        setSettings({ ...defaultSettings, ...s });
        setWorkspace({
          ...defaultWorkspace,
          ...w,
          sidebarWidth: Math.min(360, Math.max(196, w.sidebarWidth || 236)),
          filesHeight: Math.min(560, Math.max(180, w.filesHeight || 326)),
          monitorWidth: clampWidth(w.monitorWidth, defaultWorkspace.monitorWidth, 240, 1000),
          fileTreeWidth: clampWidth(w.fileTreeWidth, defaultWorkspace.fileTreeWidth, 120, 700),
          fileColumnWidths: defaultWorkspace.fileColumnWidths.map((fallback, i) =>
            clampWidth(Array.isArray(w.fileColumnWidths) ? w.fileColumnWidths[i] : undefined,
              fallback, [120, 64, 64, 112, 90, 78][i], 1400)),
          transferColumnWidths: defaultWorkspace.transferColumnWidths.map((fallback, i) =>
            clampWidth(Array.isArray(w.transferColumnWidths) ? w.transferColumnWidths[i] : undefined,
              fallback, transferColumnMinimums[i], 1400)),
        });
        restoreRef.current = w.hostIds || [];
        setReady(true);
      })
      .catch((e) => {
        setBootError(errorText(e));
        setReady(true);
      });
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      const hostIds = [
        ...new Set(sessions.filter((s) => s.hostId).map((s) => s.hostId!)),
      ];
      const data = {
        ...workspace,
        hostIds: hostIds.length ? hostIds : restoreRef.current,
        activeHostId: active?.hostId || null,
      };
      void api("workspace_save", { workspace: data }).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [workspace, sessions, active?.hostId, ready]);
  function onEvent(event: TerminalEvent) {
    if (
      (event.type === "state" &&
        ["failed", "closed", "error", "disconnected"].includes(event.state)) ||
      event.type === "exit"
    )
      setAuthRequests((list) =>
        list.filter((r) => r.sessionId !== event.sessionId),
      );
    if (event.type === "auth") {
      setAuthRequests((r) => [...r, event]);
      return;
    }
    receiveTerminalEvent(event);
    if (event.type === "state" || event.type === "exit") {
      const status = event.type === "exit" ? "closed" : event.state;
      const error = event.type === "state" ? event.message : undefined;
      statusRef.current.set(event.sessionId, { status, error });
      setSessions((list) =>
        list.map((s) =>
          s.id === event.sessionId
            ? {
                ...s,
                status: s.terminalFailure ? "error" : status,
                error: s.terminalFailure || error,
              }
            : s,
        ),
      );
    }
  }
  function terminalTransportFailure(sessionId: string, message: string) {
    const session = sessionRef.current.find((s) => s.id === sessionId);
    if (
      !session ||
      closingSessions.current.has(sessionId) ||
      ["closed", "disconnected", "failed", "error"].includes(session.status)
    )
      return;
    notify(tr("{0}：{1}。正在关闭会话，请重新连接。", session.name, message), "error");
    setSessions((list) =>
      list.map((s) =>
        s.id === sessionId
          ? { ...s, status: "error", error: message, terminalFailure: message }
          : s,
      ),
    );
    closingSessions.current.add(sessionId);
    void api("session_close", { sessionId, local: session.local })
      .catch((error) => {
        notify(
          tr("关闭 {0} 未完成：{1}。请关闭该会话或退出应用。", session.name, errorText(error)),
          "error",
        );
      })
      .finally(() => {
        closingSessions.current.delete(sessionId);
        setSessions((list) => [...list]);
      });
  }
  async function connectHost(
    host: Host,
    automatic = false,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let secret: SecretInput | null = null;
    let rememberSecret = false;
    let stopListening: (() => void) | undefined;
    // A reconnect belongs to its source tab, including a native call already in flight.
    const cancelled = () => automatic && !!signal?.aborted;
    if (cancelled()) return false;
    if (connectionLock.current) {
      if (!automatic) notify(tr("请先完成当前连接的身份核验。"), "info");
      return false;
    }
    if (hasDirtyDrafts()) {
      if (automatic) return false;
      if (
        !(await confirmAction(
          tr("新连接成功后将切换工作台，当前未保存的文件修改会被放弃。"),
          tr("打开新会话"),
        ))
      )
        return false;
    }
    if (connecting.has(host.id)) return false;
    if (!native) {
      notify(tr("当前是界面预览，请使用桌面应用连接 SSH 服务器。"), "info");
      return false;
    }
    connectionLock.current = true;
    setConnecting((s) => new Set(s).add(host.id));
    setHostMenu(null);
    setPalette(false);
    try {
      if (
        host.jumpHostId &&
        !sessionRef.current.some(
          (s) => s.hostId === host.jumpHostId && s.status === "connected",
        )
      )
        throw new Error(tr("请先连接并验证此主机配置的跳板机，再连接目标服务器。"));
      const info = await api<HostKeyInfo>("ssh_probe", { hostId: host.id });
      if (cancelled()) return false;
      if (!info.trusted) {
        if (automatic)
          throw new Error(tr("主机指纹需要手动核验，已暂停自动重连。"));
        const accept = await new Promise<boolean>((resolve) =>
          setTrust({ host, info, resolve }),
        );
        if (!accept) return false;
      }
      if (host.authMethod === "password" || host.authMethod === "key") {
        let saved = false;
        try {
          saved = await api<boolean>("host_secret_status", { id: host.id });
        } catch (e) {
          const mode = credentialStoreForHost(host);
          if (mode === "local") {
            const status = await api<VaultStatus>("vault_status");
            if (status.initialized && !status.unlocked) {
              if (automatic) throw new Error(tr("本地密码库已锁定，请手动解锁后连接。"));
              const unlocked = await new Promise<boolean>((resolve) =>
                setVaultPrompt({ resolve }),
              );
              if (!unlocked) return false;
              saved = await api<boolean>("host_secret_status", { id: host.id });
            } else {
              throw e;
            }
          } else {
            if (automatic) throw e;
            notify(tr("当前凭据库不可用，请为本次连接输入临时密码。"), "info");
          }
        }
        if (cancelled()) return false;
        if (!saved) {
          if (automatic) throw new Error(tr("没有已保存的凭据，请手动重新连接。"));
          const answer = await new Promise<PromptAnswer | null>((resolve) =>
            setSecretPrompt({ host, resolve }),
          );
          if (!answer) return false;
          secret = answer.secret;
          rememberSecret = answer.remember;
        }
      }
      if (cancelled()) return false;
      const onEventChannel = new Channel<TerminalEvent>();
      const challenges = new Set<string>();
      const cancelChallenges = () => {
        for (const requestId of challenges)
          void api("ssh_auth_respond", { requestId, responses: [] }).catch(
            () => {},
          );
        setAuthRequests((list) =>
          list.filter((request) => !challenges.has(request.requestId)),
        );
      };
      if (automatic && signal) {
        signal.addEventListener("abort", cancelChallenges, { once: true });
        stopListening = () =>
          signal.removeEventListener("abort", cancelChallenges);
      }
      onEventChannel.onmessage = (event) => {
        if (automatic && event.type === "auth") {
          challenges.add(event.requestId);
          if (cancelled()) {
            cancelChallenges();
            return;
          }
        }
        onEvent(event);
      };
      const { sessionId: id, credentialSaveFailed } = await api<{
        sessionId: string;
        credentialSaveFailed: boolean;
      }>("ssh_connect", {
        hostId: host.id,
        secret,
        rememberSecret,
        onEvent: onEventChannel,
      });
      if (secret) {
        secret.password = null;
        secret.passphrase = null;
      }
      if (cancelled()) {
        try {
          await api("session_close", { sessionId: id, local: false });
          forgetTerminal(id);
          statusRef.current.delete(id);
        } catch (error) {
          const message = tr("自动重连已取消，但新会话未能关闭：{0}。请关闭此会话重试。", errorText(error));
          // Keep an actionable recovery tab, without restarting the cancelled connection.
          reconnecting.current.add(id);
          setSessions((list) => [
            ...list,
            {
              id,
              hostId: host.id,
              name: host.name,
              local: false,
              status: "error",
              error: message,
              terminalFailure: message,
              connectedAt: Date.now(),
            },
          ]);
          if (!hasDirtyDrafts()) setActiveId(id);
          notify(message, "error");
        }
        return false;
      }
      const pending = statusRef.current.get(id);
      setSessions((list) => [
        ...list,
        {
          id,
          hostId: host.id,
          name: host.name,
          local: false,
          status: pending?.status || "connected",
          error: pending?.error,
          connectedAt: Date.now(),
        },
      ]);
      if (!automatic) await selectSession(id);
      else if (
        sessionRef.current.find((s) => s.id === activeRef.current)?.hostId ===
        host.id
      )
        setActiveId(id);
      restoreRef.current = [];
      reconnectAttempts.current.delete(host.id);
      notify(tr("已连接 {0}。", host.name), "success");
      if (credentialSaveFailed)
        notify(tr("连接成功，但密码未能保存。请编辑连接重新保存。"), "error");
      return true;
    } catch (e) {
      if (!cancelled()) notify(errorText(e), "error");
      return false;
    } finally {
      stopListening?.();
      connectionLock.current = false;
      if (secret) {
        secret.password = null;
        secret.passphrase = null;
      }
      setConnecting((s) => {
        const next = new Set(s);
        next.delete(host.id);
        return next;
      });
    }
  }
  async function selectSession(id: string) {
    if (
      id !== activeId &&
      hasDirtyDrafts() &&
      !(await confirmAction(
        tr("文件编辑器有未保存的修改。切换终端会放弃当前编辑。"),
        tr("切换会话"),
      ))
    )
      return;
    setActiveId(id);
  }
  async function openLocal() {
    if (
      hasDirtyDrafts() &&
      !(await confirmAction(
        tr("打开本地终端会切换工作台并放弃当前未保存的文件修改。"),
        tr("打开本地终端"),
      ))
    )
      return;
    if (!native) {
      notify(tr("本地终端需要在 Shell EX 桌面应用中打开。"), "info");
      return;
    }
    try {
      const channel = new Channel<TerminalEvent>();
      channel.onmessage = onEvent;
      const id = await api<string>("local_open", {
        cwd: null,
        cols: 100,
        rows: 30,
        onEvent: channel,
      });
      setSessions((s) => [
        ...s,
        {
          id,
          hostId: null,
          name: tr("本地终端"),
          local: true,
          status: "connected",
          connectedAt: Date.now(),
        },
      ]);
      await selectSession(id);
      setPalette(false);
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  async function closeSession(session: Session, force = false) {
    if (
      !force &&
      (session.status === "connected" || hasDirtyDrafts()) &&
      !(await confirmAction(
        tr("关闭“{0}”会终止此终端和相关隧道，并取消关联传输。{1}", session.name, hasDirtyDrafts() ? tr("编辑器尚有未保存修改，将被放弃。") : ""),
        tr("关闭会话"),
      ))
    )
      return;
    closingSessions.current.add(session.id);
    reconnectControllers.current.get(session.id)?.abort();
    reconnectControllers.current.delete(session.id);
    const reconnectTimer = timers.current.get(session.id);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    timers.current.delete(session.id);
    reconnecting.current.add(session.id);
    setSessions((list) =>
      list.map((s) => (s.id === session.id ? { ...s, status: "closing" } : s)),
    );
    try {
      await api("session_close", {
        sessionId: session.id,
        local: session.local,
      });
    } catch (e) {
      notify(errorText(e), "error");
      setSessions((list) =>
        list.map((s) =>
          s.id === session.id
            ? {
                ...s,
                status: "error",
                error: tr("关闭会话未完成：{0}", errorText(e)),
              }
            : s,
        ),
      );
      return;
    } finally {
      closingSessions.current.delete(session.id);
    }
    forgetTerminal(session.id);
    setSessions((s) => s.filter((item) => item.id !== session.id));
    if (activeId === session.id) {
      const others = sessions.filter((s) => s.id !== session.id);
      setActiveId(others.at(-1)?.id || null);
    }
    const timer = timers.current.get(session.id);
    if (timer) clearTimeout(timer);
    timers.current.delete(session.id);
  }
  useEffect(() => {
    if (!settings.autoReconnect || !native) return;
    for (const s of sessions) {
      if (
        s.local ||
        !s.hostId ||
        !["disconnected", "closed", "error", "failed"].includes(s.status) ||
        closingSessions.current.has(s.id) ||
        reconnecting.current.has(s.id)
      )
        continue;
      const host = hosts.find((h) => h.id === s.hostId);
      if (!host) continue;
      reconnecting.current.add(s.id);
      const controller = new AbortController();
      reconnectControllers.current.set(s.id, controller);
      const attempt = async (count: number) => {
        if (
          controller.signal.aborted ||
          !sessionRef.current.some((x) => x.id === s.id) ||
          closingSessions.current.has(s.id) ||
          hasDirtyDrafts()
        )
          return;
        const timer = setTimeout(async () => {
          timers.current.delete(s.id);
          if (
            controller.signal.aborted ||
            !sessionRef.current.some((x) => x.id === s.id) ||
            closingSessions.current.has(s.id) ||
            hasDirtyDrafts()
          )
            return;
          const ok = await connectHost(host, true, controller.signal);
          if (controller.signal.aborted) return;
          if (ok) {
            reconnectControllers.current.delete(s.id);
            void api("session_close", { sessionId: s.id, local: false }).catch(
              () => {},
            );
            forgetTerminal(s.id);
            setSessions((list) => list.filter((x) => x.id !== s.id));
          } else if (count < 2) void attempt(count + 1);
          else reconnectControllers.current.delete(s.id);
        }, [2000, 5000, 12000][count]);
        timers.current.set(s.id, timer);
      };
      void attempt(0);
    }
  }, [sessions, settings.autoReconnect]);
  useEffect(() => {
    const closeHandler = () => setHostMenu(null);
    document.addEventListener("click", closeHandler);
    return () => document.removeEventListener("click", closeHandler);
  }, []);
  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || document.querySelector(".modal")) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(true);
        setPaletteQuery("");
      }
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if (e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setHostDialog(null);
      }
      if (e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void openLocal();
      }
    };
    document.addEventListener("keydown", keyHandler);
    return () => document.removeEventListener("keydown", keyHandler);
  });
  useEffect(() => {
    if (!native) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onCloseRequested(async (event) => {
          const cancelReconnects = () => {
            for (const controller of reconnectControllers.current.values())
              controller.abort();
            reconnectControllers.current.clear();
            for (const timer of timers.current.values()) clearTimeout(timer);
            timers.current.clear();
          };
          if (
            !hasDirtyDrafts() &&
            !sessionRef.current.some((s) => s.status === "connected")
          ) {
            cancelReconnects();
            return;
          }
          event.preventDefault();
          if (
            await confirmAction(
              hasDirtyDrafts()
                ? tr("编辑器有未保存的修改。退出会放弃修改，关闭会话并取消传输。")
                : tr("退出将关闭所有终端和隧道，并取消正在运行的传输。请确认重要任务已保存。"),
              tr("退出 Shell EX"),
            )
          ) {
            cancelReconnects();
            for (const session of sessionRef.current)
              closingSessions.current.add(session.id);
            setSessions((list) =>
              list.map((session) => ({ ...session, status: "closing" })),
            );
            await Promise.allSettled(
              sessionRef.current.map((s) =>
                api("session_close", { sessionId: s.id, local: s.local }),
              ),
            );
            await getCurrentWindow().destroy();
          }
        }),
      )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => notify(errorText(e), "error"));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  async function deleteHost(host: Host) {
    if (
      sessions.some((s) => s.hostId === host.id && s.status === "connected")
    ) {
      notify(tr("请先关闭此主机的会话。"), "info");
      return;
    }
    if (
      !(await confirmAction(tr("删除“{0}”及其保存的凭据？", host.name), tr("删除连接")))
    )
      return;
    try {
      await api("host_delete", { id: host.id });
      await reloadHosts();
    } catch (e) {
      notify(errorText(e), "error");
    }
  }
  async function saveSettings(next: AppSettings) {
    const saved = await api<AppSettings>("settings_save", { settings: next });
    setSettings(saved);
    notify(tr("设置已保存。"), "success");
  }
  function dragDimension(e: React.PointerEvent, kind: "sidebar" | "files") {
    e.preventDefault();
    const startX = e.clientX,
      startY = e.clientY;
    const initial =
      kind === "sidebar" ? workspace.sidebarWidth : workspace.filesHeight;
    const move = (event: PointerEvent) =>
      setWorkspace((w) => ({
        ...w,
        ...(kind === "sidebar"
          ? {
              sidebarWidth: Math.max(
                196,
                Math.min(360, initial + event.clientX - startX),
              ),
            }
          : {
              filesHeight: Math.max(
                180,
                Math.min(
                  window.innerHeight - 260,
                  initial + startY - event.clientY,
                ),
              ),
            }),
      }));
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.body.style.cursor = "";
    };
    document.body.style.cursor =
      kind === "sidebar" ? "col-resize" : "row-resize";
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
  }
  const visibleHosts = hosts.filter((h) =>
    `${h.name} ${h.address} ${h.username} ${h.group}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const groups = [...new Set(visibleHosts.map((h) => h.group || "默认分组"))];
  const secondary = sessions.filter((s) => s.id !== activeId).at(-1);
  const splitEnabled = workspace.split !== "none" && !!secondary;
  const remembered = restoreRef.current
    .map((id) => hosts.find((h) => h.id === id))
    .filter((h): h is Host => !!h);
  const renderHost = (host: Host, slot: string) => {
    const connected = sessions.some(
      (s) => s.hostId === host.id && s.status === "connected",
    );
    const pending = connecting.has(host.id);
    return (
      <div
        className={`host-item${active?.hostId === host.id ? " active" : ""}`}
        key={host.id}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setHostMenu(slot + host.id);
        }}
        onDoubleClick={() => void connectHost(host)}
      >
        <button
          className="host-main"
          onClick={() => {
            const open = sessions.find((s) => s.hostId === host.id);
            if (open) void selectSession(open.id);
          }}
          title={tr("双击连接 {0}@{1}:{2}", host.username, host.address, host.port)}
        >
          <span className="host-icon" style={{ color: host.color }}>
            <Server size={16} />
            <i
              className={connected ? "connected" : pending ? "connecting" : ""}
            />
          </span>
          <span>
            <strong>{host.name}</strong>
            <small>{host.address}</small>
          </span>
          {host.favorite && <Star className="favorite" size={11} />}
        </button>
        <IconButton
          title={tr("{0} 更多操作", host.name)}
          onClick={() => {
            setHostMenu(hostMenu === slot + host.id ? null : slot + host.id);
          }}
        >
          <MoreHorizontal size={15} />
        </IconButton>
        {hostMenu === slot + host.id && (
          <div className="context-menu" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => void connectHost(host)}>
              <TerminalSquare size={14} />{tr("连接服务器")}</button>
            <button
              onClick={() => {
                setHostDialog(host);
                setHostMenu(null);
              }}
            >
              <Pencil size={14} />{tr("编辑连接")}</button>
            <button
              onClick={() => {
                setHostDialog({
                  ...host,
                  id: crypto.randomUUID(),
                  name: tr("{0} 副本", host.name),
                });
                setHostMenu(null);
              }}
            >
              <Copy size={14} />{tr("复制配置")}</button>
            <button
              onClick={async () => {
                try {
                  await api("host_save", {
                    host: { ...host, favorite: !host.favorite },
                    rememberSecret: false,
                  });
                  await reloadHosts();
                  setHostMenu(null);
                } catch (e) {
                  notify(errorText(e), "error");
                }
              }}
            >
              <Star size={14} />
              {host.favorite ? tr("取消收藏") : tr("加入收藏")}
            </button>
            <button className="red" onClick={() => void deleteHost(host)}>
              <Trash2 size={14} />{tr("删除连接")}</button>
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="app-shell">
      <header
        className={`titlebar${macTitlebar ? " mac-titlebar" : ""}`}
        data-tauri-drag-region={macTitlebar ? "" : undefined}
      >
        <div className="brand">
          <span className="brand-mark">›_</span>
          <strong>Shell EX</strong>
          <span className="version-tag">0.4.9</span>
        </div>
        {macTitlebar && <div className="titlebar-drag" data-tauri-drag-region="" aria-hidden="true" />}
        <div className="header-actions">
          <IconButton
            title={tr("快速查找主机和操作 ⌘K")}
            onClick={() => { setPalette(true); setPaletteQuery(""); }}
          >
            <Search size={16} />
          </IconButton>
          <span className={`environment-label${!native ? " preview" : ""}`}>
            {native ? (
              <>
                <LockKeyhole size={12} />{tr("本地工作台")}</>
            ) : (
              <>
                <Monitor size={12} />{tr("界面预览")}</>
            )}
          </span>
          <span className="toolbar-separator" />
          <IconButton title={tr("设置 ⌘,")} onClick={() => setSettingsOpen(true)}>
            <Settings size={17} />
          </IconButton>
        </div>
      </header>
      <div className="workspace-shell">
        {sidebar && (
          <>
            <aside
              className="sidebar"
              style={{ width: workspace.sidebarWidth }}
            >
              <header className="sidebar-heading">
                <strong>{tr("连接")}</strong>
                <span>{hosts.length}</span>
                <div className="flex-spacer" />
                <IconButton
                  title={tr("新建连接 ⌘⇧N")}
                  onClick={() => setHostDialog(null)}
                >
                  <Plus size={17} />
                </IconButton>
              </header>
              <div className="host-search">
                <Search size={13} />
                <input
                  placeholder={tr("筛选主机…")}
                  aria-label={tr("筛选主机")}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                {filter && (
                  <button onClick={() => setFilter("")}>
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="host-groups scroll-area">
                {hosts.some((h) => h.favorite) && !filter && (
                  <section className="host-group">
                    <button
                      className="group-heading"
                      onClick={() =>
                        setCollapsed((c) => {
                          const n = new Set(c);
                          if (n.has("__favorites")) n.delete("__favorites");
                          else n.add("__favorites");
                          return n;
                        })
                      }
                    >
                      {collapsed.has("__favorites") ? (
                        <ChevronRight size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )}
                      <Star size={12} />
                      <span>{tr("收藏")}</span>
                    </button>
                    {!collapsed.has("__favorites") &&
                      hosts
                        .filter((h) => h.favorite)
                        .map((h) => renderHost(h, "favorite"))}
                  </section>
                )}
                {groups.map((group) => (
                  <section className="host-group" key={group}>
                    <button
                      className="group-heading"
                      onClick={() =>
                        setCollapsed((c) => {
                          const n = new Set(c);
                          if (n.has(group)) n.delete(group);
                          else n.add(group);
                          return n;
                        })
                      }
                    >
                      {collapsed.has(group) ? (
                        <ChevronRight size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )}
                      <FolderOpen size={12} />
                      <span>{group === "默认分组" ? tr("默认分组") : group}</span>
                      <small>
                        {
                          visibleHosts.filter(
                            (h) => (h.group || "默认分组") === group,
                          ).length
                        }
                      </small>
                    </button>
                    {!collapsed.has(group) &&
                      visibleHosts
                        .filter((h) => (h.group || "默认分组") === group)
                        .map((h) => renderHost(h, "group"))}
                  </section>
                ))}
                {!hosts.length && (
                  <div className="sidebar-empty">
                    <Server size={26} />
                    <strong>{tr("还没有连接")}</strong>
                    <p>{tr("添加你的第一台服务器")}<br />{tr("开始管理远程工作。")}</p>
                    <button
                      className="button secondary small"
                      onClick={() => setHostDialog(null)}
                    >
                      <Plus size={13} />{tr("添加连接")}</button>
                  </div>
                )}
                {!!hosts.length && !visibleHosts.length && (
                  <p className="sidebar-no-results">{tr("没有匹配的主机")}</p>
                )}
              </div>
              <div className="sidebar-bottom">
                <button onClick={() => void openLocal()}>
                  <TerminalSquare size={16} />
                  <span>{tr("本地终端")}</span>
                  <kbd>⌘⇧L</kbd>
                </button>
                <button onClick={() => setLinuxHelp(true)}>
                  <Code2 size={16} />
                  <span>{tr("Linux 命令帮助")}</span>
                  <ArrowUpRight size={13} />
                </button>
                <button onClick={() => setHelp(true)}>
                  <CircleHelp size={16} />
                  <span>{tr("使用指南")}</span>
                  <ArrowUpRight size={13} />
                </button>
              </div>
            </aside>
            <div
              className="resize-handle vertical"
              onPointerDown={(e) => dragDimension(e, "sidebar")}
              role="separator"
              aria-label={tr("调整侧边栏宽度")}
              aria-orientation="vertical"
            />
          </>
        )}
        <main className="workbench">
          <div className="session-bar">
            <IconButton
              title={sidebar ? tr("收起主机列表") : tr("显示主机列表")}
              onClick={() => setSidebar((v) => !v)}
            >
              {sidebar ? (
                <PanelLeftClose size={15} />
              ) : (
                <PanelLeftOpen size={15} />
              )}
            </IconButton>
            <div className="session-tabs">
              {!sessions.length ? (
                <div className="session-tab selected welcome-tab">
                  <TerminalSquare size={14} />{tr("工作台")}</div>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.id}
                    className={`session-tab${s.id === activeId ? " selected" : ""}`}
                    onClick={() => void selectSession(s.id)}
                  >
                    <span className={`status-dot ${s.status}`} />
                    <span>{s.name}</span>
                    {s.local && <small>{tr("本地")}</small>}
                    <button
                      aria-label={tr("关闭 {0}", s.name)}
                      onClick={(e) => {
                        e.stopPropagation();
                        void closeSession(s);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <IconButton
              title={tr("新建会话")}
              onClick={() => {
                setPalette(true);
                setPaletteQuery("");
              }}
            >
              <Plus size={16} />
            </IconButton>
            <span className="toolbar-separator" />
            <IconButton
              title={tr("左右分屏")}
              active={workspace.split === "horizontal"}
              disabled={sessions.length < 2}
              onClick={() =>
                setWorkspace((w) => ({
                  ...w,
                  split: w.split === "horizontal" ? "none" : "horizontal",
                }))
              }
            >
              <Columns2 size={15} />
            </IconButton>
            <IconButton
              title={tr("上下分屏")}
              active={workspace.split === "vertical"}
              disabled={sessions.length < 2}
              onClick={() =>
                setWorkspace((w) => ({
                  ...w,
                  split: w.split === "vertical" ? "none" : "vertical",
                }))
              }
            >
              <Rows2 size={15} />
            </IconButton>
            <IconButton
              title={tr("专注模式")}
              onClick={async () => {
                if (
                  hasDirtyDrafts() &&
                  !(await confirmAction(
                    tr("专注模式将关闭文件面板并放弃当前未保存的修改。"),
                    tr("进入专注模式"),
                  ))
                )
                  return;
                setSidebar(false);
                setWorkspace((w) => ({
                  ...w,
                  filesVisible: false,
                  monitorVisible: false,
                }));
              }}
            >
              <Maximize2 size={14} />
            </IconButton>
          </div>
          <div className="workspace-main" ref={mainArea}>
            <section className="terminal-column">
              {bootError && <ErrorBox message={bootError} />}
              <div
                className={`terminal-area ${splitEnabled ? "split-" + workspace.split : ""}`}
              >
                {sessions.length === 0 && connecting.size === 0 && (
                  <div className="workspace-idle" aria-hidden="true">
                    <img src={workspaceLogo} alt="" draggable={false} />
                  </div>
                )}
                {sessions.map((s) => (
                    <div
                      key={s.id}
                      className={`terminal-slot${s.id === activeId ? " primary" : splitEnabled && s.id === secondary?.id ? " secondary" : " hidden"}`}
                      onMouseDown={() => {
                        if (s.id !== activeId && workspace.split === "none")
                          setActiveId(s.id);
                      }}
                    >
                      <TerminalView
                        session={s}
                        settings={settings}
                        visible={
                          s.id === activeId ||
                          (splitEnabled && s.id === secondary?.id)
                        }
                        notify={notify}
                        onTransportFailure={terminalTransportFailure}
                      />
                      {s.status !== "connected" && (
                        <div className="disconnected-banner">
                          <AlertCircle size={14} />
                          <span>
                            {labels[s.status] ? tr(labels[s.status]) : s.status} ·{" "}
                            {s.error || tr("重新连接将打开新会话")}
                          </span>
                          {s.hostId && (
                            <button
                              className="text-button"
                              onClick={() => {
                                const h = hosts.find((h) => h.id === s.hostId);
                                if (h) void connectHost(h);
                              }}
                            >
                              <RefreshCw size={13} />{tr("重新连接")}</button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                {connecting.size > 0 && (
                  <div className="connecting-overlay">
                    <LoaderCircle size={15} className="spin" />{tr("正在连接")}{" "}{connecting.size}{" "}{tr("台主机…")}</div>
                )}
              </div>
            </section>
            {workspace.monitorVisible && monitorMode === "docked" && (
              <>
              <ResizeHandle label={tr("调整监控面板宽度")} value={actualMonitorWidth}
                min={240} max={maxMonitorWidth} direction={-1}
                onChange={(width) => setWorkspace((w) => ({ ...w, monitorWidth: width }))}
                onReset={() => setWorkspace((w) => ({ ...w, monitorWidth: defaultWorkspace.monitorWidth }))} />
              <MonitorPanel
                width={actualMonitorWidth}
                onDetach={native ? () => void detachMonitor() : undefined}
                session={active}
                settings={settings}
                notify={notify}
                onClose={() =>
                  setWorkspace((w) => ({ ...w, monitorVisible: false }))
                }
              />
              </>
            )}
          </div>
              {workspace.filesVisible && (
                <>
                  <div
                    className="resize-handle horizontal"
                    onPointerDown={(e) => dragDimension(e, "files")}
                    role="separator"
                    aria-label={tr("调整文件面板高度")}
                    aria-orientation="horizontal"
                  />
                  <section
                    className="bottom-panel"
                    style={{ height: workspace.filesHeight }}
                  >
                    <header className="panel-tabs">
                      {panelItems.map((item) => (
                        <button
                          key={item.id}
                          className={panel === item.id ? "active" : ""}
                          onClick={async () => {
                            if (
                              hasDirtyDrafts() &&
                              !(await confirmAction(
                                tr("编辑器有未保存的修改。切换面板将暂时隐藏编辑器，返回文件面板可继续编辑。"),
                                tr("切换面板"),
                              ))
                            )
                              return;
                            setPanel(item.id);
                          }}
                        >
                          <item.icon size={14} />
                          {tr(item.name)}
                        </button>
                      ))}
                      <span className="flex-spacer" />
                      <IconButton
                        title={tr("隐藏工具面板")}
                        onClick={async () => {
                          if (
                            hasDirtyDrafts() &&
                            !(await confirmAction(
                              tr("隐藏面板将放弃当前编辑器未保存的修改。"),
                              tr("隐藏面板"),
                            ))
                          )
                            return;
                          setWorkspace((w) => ({ ...w, filesVisible: false }));
                        }}
                      >
                        <X size={14} />
                      </IconButton>
                    </header>
                    <div className="bottom-panel-content">
                      <div
                        className="persistent-file-panel"
                        style={{ display: panel === "files" ? "flex" : "none" }}
                      >
                        <FilePanel
                          session={active}
                          notify={notify}
                          onTransfer={() => setPanel("transfers")}
                          treeWidth={workspace.fileTreeWidth}
                          columnWidths={workspace.fileColumnWidths}
                          onTreeWidth={(width) => setWorkspace((w) => ({ ...w, fileTreeWidth: width }))}
                          onColumnWidth={(index, width) => setWorkspace((w) => ({
                            ...w, fileColumnWidths: w.fileColumnWidths.map((v, i) => i === index ? width : v),
                          }))}
                        />
                      </div>
                      {panel === "transfers" && (
                        <TransferPanel notify={notify}
                          columnWidths={workspace.transferColumnWidths}
                          onColumnWidth={(index, width) => setWorkspace((w) => ({
                            ...w, transferColumnWidths: w.transferColumnWidths.map((v, i) => i === index ? width : v),
                          }))} />
                      )}
                      {panel === "snippets" && (
                        <SnippetPanel session={active} notify={notify} />
                      )}
                      {panel === "tunnels" && (
                        <TunnelPanel session={active} notify={notify} />
                      )}
                      {panel === "docker" && (
                        <DockerPanel session={active} notify={notify} />
                      )}
                    </div>
                  </section>
                </>
              )}
        </main>
      </div>
      <footer className="statusbar">
        <div>
          <ShieldCheck size={12} />
          <span>
            {sessions.filter((s) => s.status === "connected").length}{" "}{tr("个连接")}</span>
          <span className="status-separator" />
          {active ? (
            <>
              <span className={`status-dot ${active.status}`} />
              <span>
                {active.local ? tr("本地 PTY") : "SSH"} ·{" "}
                {labels[active.status] ? tr(labels[active.status]) : active.status}
              </span>
            </>
          ) : (
            <span>{native ? tr("就绪") : tr("预览模式 · SSH 功能需桌面应用")}</span>
          )}
        </div>
        <div>
          <span>UTF-8</span>
          <span>xterm-256color</span>
          <IconButton
            title={tr("显示工具面板")}
            active={workspace.filesVisible}
            onClick={async () => {
              if (
                workspace.filesVisible &&
                hasDirtyDrafts() &&
                !(await confirmAction(
                  tr("隐藏面板将放弃当前编辑器未保存的修改。"),
                  tr("隐藏面板"),
                ))
              )
                return;
              setWorkspace((w) => ({ ...w, filesVisible: !w.filesVisible }));
            }}
          >
            <PanelBottom size={13} />
          </IconButton>
          <IconButton
            title={monitorMode === "detached" ? tr("停靠监控面板") : tr("显示监控面板")}
            active={workspace.monitorVisible || monitorMode === "detached"}
            disabled={monitorMode === "opening"}
            onClick={() => {
              if (monitorMode === "detached") void dockMonitor();
              else setWorkspace((w) => ({ ...w, monitorVisible: !w.monitorVisible }));
            }}
          >
            <PanelRight size={13} />
          </IconButton>
        </div>
      </footer>
      {hostDialog !== undefined && (
        <HostDialog
          host={hostDialog}
          hosts={hosts}
          notify={notify}
          onClose={() => {
            setHostDialog(undefined);
            void reloadHosts();
          }}
          onSaved={() => {
            setHostDialog(undefined);
            void reloadHosts();
            notify(tr("连接已保存。"), "success");
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          hosts={hosts}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
          notify={notify}
          onHostsChanged={() => void reloadHosts()}
        />
      )}
      {trust && (
        <TrustDialog
          host={trust.host}
          info={trust.info}
          onClose={() => {
            trust.resolve(false);
            setTrust(null);
          }}
          onTrust={async () => {
            await api("ssh_trust", {
              hostId: trust.host.id,
              algorithm: trust.info.algorithm,
              fingerprint: trust.info.fingerprint,
              replace: trust.info.changed,
            });
            trust.resolve(true);
            setTrust(null);
          }}
        />
      )}
      {vaultPrompt && (
        <VaultDialog
          onClose={() => { vaultPrompt.resolve(false); setVaultPrompt(null); }}
          onReady={() => { vaultPrompt.resolve(true); setVaultPrompt(null); }}
        />
      )}
      {secretPrompt && (
        <CredentialPrompt
          prompt={secretPrompt}
          onDone={(secret) => {
            secretPrompt.resolve(secret);
            setSecretPrompt(null);
          }}
        />
      )}
      {authRequests[0] && (
        <AuthDialog
          request={authRequests[0]}
          onDone={async (responses) => {
            try {
              await api("ssh_auth_respond", {
                requestId: authRequests[0].requestId,
                responses,
              });
            } catch (e) {
              notify(errorText(e), "error");
            }
            setAuthRequests((r) => r.slice(1));
          }}
        />
      )}
      {palette && (
        <Modal title={tr("快速连接")} onClose={() => setPalette(false)}>
          <div className="palette-input">
            <Search size={18} />
            <input
              autoFocus
              placeholder={tr("输入主机名称、地址或用户名…")}
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
            />
            <kbd>ESC</kbd>
          </div>
          <div className="palette-results">
            {!sessions.length && remembered.length > 0 && !paletteQuery.trim() && (
              <button
                disabled={connecting.size > 0}
                onClick={async () => {
                  setPalette(false);
                  for (const h of remembered) await connectHost(h);
                  restoreRef.current = [];
                }}
              >
                <RefreshCw size={17} />
                <span>
                  <strong>{tr("恢复上次工作区")}</strong>
                  <small>{remembered.length} {tr("台主机")}</small>
                </span>
                <ArrowUpRight size={15} />
              </button>
            )}
            {hosts
              .filter((h) =>
                `${h.name} ${h.address} ${h.username}`
                  .toLowerCase()
                  .includes(paletteQuery.toLowerCase()),
              )
              .map((h) => (
                <button key={h.id} onClick={() => void connectHost(h)}>
                  <Server size={17} />
                  <span>
                    <strong>{h.name}</strong>
                    <small>
                      {h.username}@{h.address}:{h.port}
                    </small>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
            <button
              onClick={() => {
                setPalette(false);
                setHostDialog(null);
              }}
            >
              <Plus size={17} />
              <span>
                <strong>{tr("新建 SSH 连接")}</strong>
                <small>{tr("添加服务器到工作台")}</small>
              </span>
              <kbd>⌘⇧N</kbd>
            </button>
            <button onClick={() => { setPalette(false); setLinuxHelp(true); }}>
              <Code2 size={17} />
              <span>
                <strong>{tr("Linux 命令帮助")}</strong>
                <small>{tr("离线查阅常用命令、参数和示例")}</small>
              </span>
              <ArrowUpRight size={15} />
            </button>
            <button onClick={() => void openLocal()}>
              <TerminalSquare size={17} />
              <span>
                <strong>{tr("打开本地终端")}</strong>
                <small>{tr("使用本机默认 Shell")}</small>
              </span>
              <kbd>⌘⇧L</kbd>
            </button>
          </div>
        </Modal>
      )}
      {linuxHelp && <LinuxHelpDialog onClose={() => setLinuxHelp(false)} />}
      {help && (
        <Modal
          title={tr("使用指南")}
          subtitle={tr("Shell EX · 快捷上手")}
          onClose={() => setHelp(false)}
        >
          <div className="help-list">
            <section>
              <span>01</span>
              <div>
                <h3>{tr("添加并连接服务器")}</h3>
                <p>{tr("保存主机地址与认证方式，双击主机连接。首次连接请核对服务器指纹，再输入凭据。")}</p>
              </div>
            </section>
            <section>
              <span>02</span>
              <div>
                <h3>{tr("终端与文件一起工作")}</h3>
                <p>{tr("底部文件面板支持双击目录与文件。拖入本地文件开始上传；传输面板可查看进度、暂停和取消。")}</p>
              </div>
            </section>
            <section>
              <span>03</span>
              <div>
                <h3>{tr("配置自己的工作台")}</h3>
                <p>{tr("拖动面板边界调整尺寸。连接多个终端后可左右或上下分屏。快捷命令支持参数模板。")}</p>
              </div>
            </section>
            <section>
              <span>04</span>
              <div>
                <h3>{tr("备份与长期会话")}</h3>
                <p>{tr("在设置中导出加密备份。网络断开后重连会创建新会话，持续运行的远程任务建议放入 tmux。")}</p>
              </div>
            </section>
          </div>
          <div className="info-note">
            <Command size={17} />
            <p>{tr("macOS 使用 ⌘ 快捷键；Windows 与 Linux 使用 Ctrl。终端中的 Ctrl+C 保持发送中断信号。")}</p>
          </div>
          <button className="button secondary" onClick={() => { setHelp(false); setLinuxHelp(true); }}>
            <Code2 size={15} />{tr("Linux 命令帮助")}
          </button>
        </Modal>
      )}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast ${t.kind}`} key={t.id}>
            {t.kind === "error" ? (
              <AlertCircle size={16} />
            ) : t.kind === "success" ? (
              <Check size={16} />
            ) : (
              <CircleHelp size={16} />
            )}
            <span>{t.message}</span>
            <button
              aria-label={tr("关闭提示")}
              onClick={() =>
                setToasts((ts) => ts.filter((item) => item.id !== t.id))
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
function CredentialPrompt({
  prompt,
  onDone,
}: {
  prompt: SecretPrompt;
  onDone: (answer: PromptAnswer | null) => void;
}) {
  const [value, setValue] = useState("");
  const canRemember = credentialStoreForHost(prompt.host) === "builtin";
  const [remember, setRemember] = useState(canRemember);
  function submit() {
    onDone({
      secret: prompt.host.authMethod === "key"
        ? { passphrase: value || null }
        : { password: value },
      remember: canRemember && remember && value.length > 0,
    });
    setValue("");
  }
  return (
    <Modal
      title={prompt.host.authMethod === "key" ? tr("私钥口令") : tr("登录凭据")}
      subtitle={`${prompt.host.username}@${prompt.host.address}`}
      onClose={() => {
        setValue("");
        onDone(null);
      }}
      footer={
        <>
          <button
            className="button secondary"
            onClick={() => {
              setValue("");
              onDone(null);
            }}
          >{tr("取消")}</button>
          <button
            className="button primary"
            onClick={submit}
          >{tr("连接")}</button>
        </>
      }
    >
      <Field
        label={
          prompt.host.authMethod === "key"
            ? tr("私钥口令（未加密私钥可留空）")
            : tr("密码")
        }
        hint={canRemember ? undefined : tr("只用于本次连接，不会保存。需要自动登录可在基本信息中选择应用内加密密码库。")}
      >
        <input
          autoFocus
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </Field>
      {canRemember && <Toggle
        checked={remember}
        onChange={setRemember}
        label={tr("连接成功后本地加密保存")}
        description={tr("仅保存在 Shell EX 应用目录，不访问系统钥匙串。")}
      />}
    </Modal>
  );
}
function AuthDialog({
  request,
  onDone,
}: {
  request: AuthRequest;
  onDone: (responses: string[]) => Promise<void>;
}) {
  const [values, setValues] = useState(request.prompts.map(() => ""));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValues(request.prompts.map(() => ""));
    setBusy(false);
  }, [request.requestId]);
  async function submit() {
    setBusy(true);
    await onDone(values);
    setValues([]);
  }
  return (
    <Modal
      title={request.name || tr("交互式认证")}
      subtitle={
        request.instructions || tr("请回答服务器的认证请求。回答不会保存。")
      }
      onClose={() => void onDone([])}
      footer={
        <>
          <button className="button secondary" onClick={() => void onDone([])}>{tr("取消认证")}</button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? <Busy /> : tr("提交认证")}
          </button>
        </>
      }
    >
      <div className="form-grid">
        {request.prompts.map((p, i) => (
          <Field label={p.prompt || tr("认证信息 {0}", i + 1)} key={i} full>
            <input
              type={p.echo ? "text" : "password"}
              autoComplete="off"
              value={values[i] || ""}
              onChange={(e) =>
                setValues((v) =>
                  v.map((s, j) => (j === i ? e.target.value : s)),
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </Field>
        ))}
      </div>
    </Modal>
  );
}
