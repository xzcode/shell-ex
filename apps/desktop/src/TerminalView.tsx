import { tr } from "./i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Search, X, ChevronUp, ChevronDown, Copy, ClipboardPaste, Image, Eraser } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEvent, AppSettings, Session, Notify } from "./types";
import { api, confirmAction, errorText } from "./api";
import { IconButton } from "./ui";
import { sendTerminalInput } from "./terminalInput";
import { TerminalAckController } from "./terminalAck";
import { terminalTheme } from "./themePalettes";
import { prepareTerminalBackground, saveTerminalBackground, useTerminalBackground } from "./terminalBackground";

const isMac = /Mac/i.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);
const copyShortcut = isMac ? "⌘C" : "Ctrl+Shift+C";
const pasteShortcut = isMac ? "⌘V" : "Ctrl+Shift+V";
const searchShortcut = isMac ? "⌘F" : "Ctrl+F";
function displayTheme(theme: AppSettings["theme"], background: string | null) {
  const palette = terminalTheme(theme);
  return background ? { ...palette, background: "#00000000" } : palette;
}
const pending = new Map<string, TerminalEvent[]>();
const sinks = new Map<string, (event: TerminalEvent) => void>();
export function receiveTerminalEvent(event: TerminalEvent) {
  const sink = sinks.get(event.sessionId);
  if (sink) sink(event);
  else {
    const queue = pending.get(event.sessionId) || [];
    queue.push(event);
    pending.set(event.sessionId, queue);
  }
}
export function forgetTerminal(id: string) {
  sinks.delete(id);
  pending.delete(id);
}
export function TerminalView({
  session,
  settings,
  visible,
  notify,
  onTransportFailure,
}: {
  session: Session;
  settings: AppSettings;
  visible: boolean;
  notify: Notify;
  onTransportFailure: (sessionId: string, message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const ackController = useRef<TerminalAckController | null>(null);
  const current = useRef({
    settings,
    notify,
    onTransportFailure,
    status: session.status,
    visible,
  });
  current.current = {
    settings,
    notify,
    onTransportFailure,
    status: session.status,
    visible,
  };
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const background = useTerminalBackground();

  function openSearch() {
    setSearching(true);
    requestAnimationFrame(() => input.current?.focus());
  }
  async function copyText(value: string) {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); }
    catch { current.current.notify(tr("无法访问剪贴板，请使用系统复制快捷键。"), "error"); }
  }
  async function pasteText(value: string, target: Terminal | null) {
    if (!target || !value || term.current !== target
      || !current.current.visible || current.current.status !== "connected") return;
    if (current.current.settings.confirmMultilinePaste && /[\r\n]/.test(value)) {
      if (!(await confirmAction(
        tr("粘贴包含 {0} 行内容，可能直接执行多条命令。\n\n{1}{2}",
          value.split(/\r\n|\r|\n/).length, value.slice(0, 600), value.length > 600 ? "…" : ""),
        tr("确认多行粘贴"),
      ))) return;
    }
    // Never paste into a terminal that was switched or closed during confirmation.
    if (term.current === target && current.current.visible && current.current.status === "connected") {
      target.focus();
      target.paste(value);
    }
  }
  async function pasteClipboard() {
    const target = term.current;
    if (!target || current.current.status !== "connected") return;
    let value: string;
    try { value = await navigator.clipboard.readText(); }
    catch { current.current.notify(tr("无法读取剪贴板，请使用系统粘贴快捷键。"), "error"); return; }
    await pasteText(value, target);
  }
  function closeMenu(focus = false) {
    setMenu(null);
    if (focus) term.current?.focus();
  }
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const node = menuRef.current;
    const rect = node.getBoundingClientRect();
    node.style.left = Math.max(6, Math.min(menu.x, window.innerWidth - rect.width - 6)) + "px";
    node.style.top = Math.max(6, Math.min(menu.y, window.innerHeight - rect.height - 6)) + "px";
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const dismiss = () => setMenu(null);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);
  useEffect(() => {
    if (!visible) setMenu(null);
  }, [visible]);

  async function chooseBackground(file: File) {
    try {
      saveTerminalBackground(await prepareTerminalBackground(file));
      notify(tr("终端背景图片已保存。"), "success");
    } catch (e) { notify(errorText(e), "error"); }
  }
  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    const t = new Terminal({
      cursorBlink: true,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      scrollback: settings.scrollback,
      theme: displayTheme(settings.theme, background),
      allowProposedApi: false,
      allowTransparency: true,
      minimumContrastRatio: 4.5,
      convertEol: false,
      rightClickSelectsWord: false,
    });
    const f = new FitAddon();
    const s = new SearchAddon();
    t.loadAddon(f);
    t.loadAddon(s);
    t.open(container.current);
    term.current = t;
    fit.current = f;
    search.current = s;
    const resize = () => {
      if (
        disposed ||
        !container.current?.clientWidth ||
        !container.current?.clientHeight
      )
        return;
      f.fit();
    };
    const sizeEvent = t.onResize(({ cols, rows }) => {
      void api("terminal_resize", {
        sessionId: session.id,
        cols,
        rows,
        local: session.local,
      }).catch(() => {});
    });
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    resize();
    const acknowledgements = new TerminalAckController({
      send: (sequence) =>
        api<void>("terminal_ack", {
          sessionId: session.id,
          sequence,
          local: session.local,
        }),
      onFailure: ({ cause }) => {
        if (
          disposed ||
          ["closing", "closed", "failed", "disconnected", "error"].includes(
            current.current.status,
          )
        )
          return;
        t.options.disableStdin = true;
        const detail = tr("终端输出确认失败：{0}", errorText(cause));
        t.write(
          tr("\r\n\u001b[31m[{0}。会话将关闭，请重新连接。]\u001b[0m\r\n", detail.replace(/[\x00-\x1f\x7f]/g, " ")),
        );
        current.current.onTransportFailure(session.id, detail);
      },
    });
    ackController.current = acknowledgements;
    const consume = (event: TerminalEvent) => {
      if (disposed) return;
      if (
        event.type === "exit" ||
        (event.type === "state" &&
          ["closed", "failed", "disconnected", "error"].includes(event.state))
      ) {
        t.options.disableStdin = true;
        acknowledgements.dispose();
      }
      if (event.type === "data") {
        const raw = atob(event.data);
        const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        t.write(bytes, () => {
          if (!disposed) acknowledgements.acknowledge(event.sequence);
        });
      } else if (event.type === "exit") {
        t.write(
          tr("\r\n\u001b[90m[会话已结束{0}；重新连接会建立新会话]\u001b[0m\r\n", event.code == null ? "" : tr("，退出码 {0}", event.code)),
        );
      } else if (event.type === "state" && event.message) {
        t.write(
          `\r\n\x1b[90m[${event.message.replace(/[\x00-\x1f\x7f]/g, " ")}]\x1b[0m\r\n`,
        );
      }
    };
    sinks.set(session.id, consume);
    for (const e of pending.get(session.id) || []) consume(e);
    pending.delete(session.id);
    const data = t.onData((value) => {
      void sendTerminalInput(session.id, value, session.local).catch((e) =>
        current.current.notify(errorText(e), "error"),
      );
    });
    t.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "f") {
        event.preventDefault();
        openSearch();
        return false;
      }
      const clipboardShortcut = isMac ? event.metaKey : event.ctrlKey && event.shiftKey;
      if (clipboardShortcut && key === "c" && t.hasSelection()) {
        event.preventDefault();
        void copyText(t.getSelection());
        return false;
      }
      // Ctrl+C remains a terminal interrupt. System paste still follows the
      // same confirmation path as the right-click menu.
      if (!isMac && clipboardShortcut && key === "v") {
        event.preventDefault();
        void pasteClipboard().catch((e) => current.current.notify(errorText(e), "error"));
        return false;
      }
      return true;
    });
    const paste = (event: ClipboardEvent) => {
      const value = event.clipboardData?.getData("text");
      if (!value) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void pasteText(value, t).catch((e) => current.current.notify(errorText(e), "error"));
    };
    const element = container.current;
    element.addEventListener("paste", paste, true);
    // A remote OSC 52 sequence must never silently read or write the local clipboard.
    const osc = t.parser.registerOscHandler(52, () => true);
    return () => {
      disposed = true;
      acknowledgements.dispose();
      ackController.current = null;
      observer.disconnect();
      element.removeEventListener("paste", paste, true);
      data.dispose();
      sizeEvent.dispose();
      osc.dispose();
      sinks.delete(session.id);
      if (term.current === t) term.current = null;
      t.dispose();
    };
    // Session identity is immutable; changing preferences is applied without clearing the buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  useEffect(() => {
    if (
      ["closing", "closed", "failed", "disconnected", "error"].includes(
        session.status,
      )
    ) {
      if (term.current) term.current.options.disableStdin = true;
      ackController.current?.dispose();
    }
  }, [session.status]);
  useEffect(() => {
    if (term.current) {
      term.current.options.fontSize = settings.fontSize;
      term.current.options.fontFamily = settings.fontFamily;
      term.current.options.scrollback = settings.scrollback;
      term.current.options.theme = displayTheme(settings.theme, background);
      fit.current?.fit();
    }
  }, [settings, background]);
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fit.current?.fit();
        term.current?.focus();
      });
    }
  }, [visible]);
  return (
    <div className={"terminal-view" + (visible ? " visible" : "") + (background ? " has-background" : "")}>
      {background && <div className="terminal-backdrop" aria-hidden="true"
        style={{ backgroundImage: 'url("' + background + '")' }} />}
      <div ref={container} className="terminal-canvas"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (visible && term.current) setMenu({
            x: event.clientX, y: event.clientY, selection: term.current.getSelection(),
          });
        }} />
      <input type="file" ref={backgroundInput} hidden
        aria-label={tr("设置背景图片")} accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void chooseBackground(file);
        }} />
      {menu && visible && createPortal(
        <div ref={menuRef} role="menu" aria-label={tr("终端右键菜单")}
          className="file-context-menu terminal-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault(); event.stopPropagation(); closeMenu(true); return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
            if (!buttons.length) return;
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}>
          <button role="menuitem" disabled={!menu.selection}
            onClick={() => { const text = menu.selection; closeMenu(true); void copyText(text); }}>
            <span><Copy size={14} />{tr("复制")}</span><kbd>{copyShortcut}</kbd>
          </button>
          <button role="menuitem" disabled={session.status !== "connected"}
            onClick={() => { closeMenu(true); void pasteClipboard().catch((e) => notify(errorText(e), "error")); }}>
            <span><ClipboardPaste size={14} />{tr("粘贴")}</span><kbd>{pasteShortcut}</kbd>
          </button>
          <button role="menuitem" disabled={!menu.selection || session.status !== "connected"}
            onClick={() => { const text = menu.selection; closeMenu(true);
              void pasteText(text, term.current).catch((e) => notify(errorText(e), "error")); }}>
            <span><ClipboardPaste size={14} />{tr("粘贴选中")}</span>
          </button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" onClick={() => { closeMenu(); openSearch(); }}>
            <span><Search size={14} />{tr("查找")}</span><kbd>{searchShortcut}</kbd>
          </button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" title={tr("仅清空当前终端的本地输出缓存，不会执行服务器命令。")}
            onClick={() => {
              closeMenu(true);
              search.current?.clearDecorations();
              setQuery("");
              term.current?.clearSelection();
              term.current?.clear();
            }}>
            <span><Eraser size={14} />{tr("清空缓存")}</span>
          </button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" onClick={() => { closeMenu(); backgroundInput.current?.click(); }}>
            <span><Image size={14} />{tr("设置背景图片")}</span>
          </button>
          {background && <button role="menuitem" onClick={() => {
            closeMenu(true);
            try { saveTerminalBackground(null); notify(tr("已恢复默认终端背景。"), "success"); }
            catch (e) { notify(errorText(e), "error"); }
          }}><span><Image size={14} />{tr("恢复默认背景")}</span></button>}
        </div>, document.body)}
      {searching && (
        <div className="terminal-search">
          <Search size={14} />
          <input
            ref={input}
            value={query}
            placeholder={tr("在终端中查找")}
            onChange={(e) => {
              setQuery(e.target.value);
              search.current?.findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) search.current?.findPrevious(query);
                else search.current?.findNext(query);
              }
              if (e.key === "Escape") {
                setSearching(false);
                term.current?.focus();
              }
            }}
          />
          <IconButton
            title={tr("上一个")}
            onClick={() => {
              search.current?.findPrevious(query);
            }}
          >
            <ChevronUp size={15} />
          </IconButton>
          <IconButton
            title={tr("下一个")}
            onClick={() => {
              search.current?.findNext(query);
            }}
          >
            <ChevronDown size={15} />
          </IconButton>
          <IconButton title={tr("关闭搜索")} onClick={() => setSearching(false)}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
