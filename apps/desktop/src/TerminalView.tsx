import { tr } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEvent, AppSettings, Session, Notify } from "./types";
import { api, confirmAction, errorText } from "./api";
import { IconButton } from "./ui";
import { sendTerminalInput } from "./terminalInput";
import { TerminalAckController } from "./terminalAck";
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
const graphiteTheme = {
  background: "#191e26",
  foreground: "#e4e9ee",
  cursor: "#91bdff",
  selectionBackground: "#36557c80",
  black: "#1d2734",
  red: "#ee8792",
  green: "#6dd5b0",
  yellow: "#e6bd78",
  blue: "#80b4f6",
  magenta: "#c19af0",
  cyan: "#71c8d1",
  white: "#d7dfe9",
  brightBlack: "#77869b",
};
const auroraTheme = {
  ...graphiteTheme,
  background: "#151e1c",
  foreground: "#e3eee8",
  cursor: "#84d6bd",
  selectionBackground: "#3b746180",
  green: "#79cfb7",
  blue: "#83b8da",
  cyan: "#7acdc2",
};
const mistTheme = {
  background: "#fbfbfa",
  foreground: "#26333d",
  cursor: "#417ac4",
  selectionBackground: "#c9d9ec80",
  black: "#28343c",
  red: "#a94454",
  green: "#287b61",
  yellow: "#977025",
  blue: "#417ac4",
  magenta: "#8451ac",
  cyan: "#337f82",
  white: "#e3e9ef",
  brightBlack: "#7e8b94",
};
const lightTheme = {
  background: "#fbfcfe",
  foreground: "#263547",
  cursor: "#2868b6",
  selectionBackground: "#acc9ed80",
  black: "#263547",
  red: "#b4374d",
  green: "#237257",
  yellow: "#926b17",
  blue: "#2868b6",
  magenta: "#8351ac",
  cyan: "#287984",
  white: "#dae2ed",
  brightBlack: "#7d8ca1",
};
const terminalThemes = {
  graphite: graphiteTheme,
  dark: graphiteTheme,
  aurora: auroraTheme,
  mist: mistTheme,
  light: lightTheme,
};
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
  });
  current.current = {
    settings,
    notify,
    onTransportFailure,
    status: session.status,
  };
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    const t = new Terminal({
      cursorBlink: true,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      scrollback: settings.scrollback,
      theme: terminalThemes[settings.theme] ?? graphiteTheme,
      allowProposedApi: false,
      allowTransparency: false,
      convertEol: false,
      rightClickSelectsWord: true,
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearching(true);
        setTimeout(() => input.current?.focus(), 0);
        return false;
      }
      if (
        event.metaKey &&
        event.key.toLowerCase() === "c" &&
        t.hasSelection()
      ) {
        void navigator.clipboard.writeText(t.getSelection());
        return false;
      }
      return true;
    });
    const paste = (event: ClipboardEvent) => {
      const value = event.clipboardData?.getData("text");
      if (!value) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        current.current.settings.confirmMultilinePaste &&
        /[\r\n]/.test(value)
      ) {
        void confirmAction(
          tr("粘贴包含 {0} 行内容，可能直接执行多条命令。\n\n{1}{2}", value.split(/\r?\n/).length, value.slice(0, 600), value.length > 600 ? "…" : ""),
          tr("确认多行粘贴"),
        ).then((ok) => {
          if (ok && !disposed) t.paste(value);
        });
      } else t.paste(value);
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
      term.current.options.theme =
        terminalThemes[settings.theme] ?? graphiteTheme;
      fit.current?.fit();
    }
  }, [settings]);
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fit.current?.fit();
        term.current?.focus();
      });
    }
  }, [visible]);
  return (
    <div className={`terminal-view${visible ? " visible" : ""}`}>
      <div ref={container} className="terminal-canvas" />
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
