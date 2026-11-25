import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Copy, Search, TerminalSquare, X } from "lucide-react";
import { useLocale } from "./i18n";
import { errorText } from "./api";
import { Modal } from "./ui";
import { commandCategories, linuxCommands, type CommandCategory, type LocalizedHelp } from "./linuxCommands";

type Category = CommandCategory | "all";
export function LinuxHelpDialog({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const zh = locale === "zh-CN";
  const loc = (pair: LocalizedHelp) => pair[zh ? 0 : 1];
  const label = (zhText: string, enText: string) => zh ? zhText : enText;
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const resultsRef = useRef<HTMLDivElement>(null);
  const matched = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return linuxCommands.filter((command) => {
      if (category !== "all" && command.category !== category) return false;
      const keywords = commandCategories.find((c) => c[0] === command.category) || [];
      const haystack = [
        command.name, command.example, ...command.description, ...command.options,
        ...command.exampleNote, ...(command.warning || []), ...keywords,
      ].join(" ").toLowerCase();
      return terms.every((word) => haystack.includes(word));
    });
  }, [query, category]);
  useLayoutEffect(() => {
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
    setCopied("");
    setError("");
  }, [query, category]);
  async function copyExample(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      setError("");
    } catch (e) {
      setCopied("");
      setError(label("复制失败：", "Could not copy: ") + errorText(e));
    }
  }
  return (
    <Modal
      title={label("Linux 命令帮助", "Linux command help")}
      subtitle={label("离线命令速查 · 按类别浏览、搜索参数并复制示例", "Offline command reference · Browse, search and copy examples")}
      className="linux-help-modal"
      wide
      onClose={onClose}
      footer={<>
        <span className="footer-note">{label("仅复制到剪贴板，不会执行命令。", "Copies to clipboard only; commands are never executed.")}</span>
        <button className="button secondary" onClick={onClose}>{label("关闭", "Close")}</button>
      </>}
    >
      <div className="linux-help-layout">
        <nav className="linux-help-nav" aria-label={label("命令分类", "Command categories")}>
          <button aria-pressed={category === "all"} onClick={() => setCategory("all")}>
            <span>{label("全部命令", "All commands")}</span><small>{linuxCommands.length}</small>
          </button>
          {commandCategories.map(([id, chinese, english]) => (
            <button key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>
              <span>{zh ? chinese : english}</span>
              <small>{linuxCommands.filter((command) => command.category === id).length}</small>
            </button>
          ))}
        </nav>
        <div className="linux-help-main">
          <div className="linux-help-search">
            <div className="linux-help-search-field">
              <Search size={17} aria-hidden="true" />
              <input
                autoFocus
                aria-label={label("搜索 Linux 命令", "Search Linux commands")}
                placeholder={label("搜索命令、用途或参数，如 磁盘、端口、tail…", "Search commands, uses or flags, e.g. disk, port, tail…")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && <button className="icon-button" aria-label={label("清空搜索", "Clear search")} onClick={() => setQuery("")}><X size={15} /></button>}
            </div>
            <div className="linux-help-results-meta" aria-live="polite">
              <span>{label("匹配 ", "Showing ")}{matched.length} / {linuxCommands.length}{label(" 条命令", " commands")}</span>
              {category !== "all" && <button className="text-button" onClick={() => setCategory("all")}>{label("搜索全部分类", "Search all categories")}</button>}
            </div>
          </div>
          {error && <div className="linux-help-error" role="alert">{error}</div>}
          <div className="linux-help-results" ref={resultsRef}>
            {!matched.length && <div className="linux-help-empty">
              <Search size={24} />
              <strong>{label("没有匹配的命令", "No matching commands")}</strong>
              <p>{label("尝试其他关键词，或切换到全部分类。", "Try different keywords or search all categories.")}</p>
              <button className="button secondary" onClick={() => { setCategory("all"); setQuery(""); }}>{label("显示全部命令", "Show all commands")}</button>
            </div>}
            {matched.map((command) => (
              <article className="linux-command-card" key={command.name} data-command={command.name}>
                <header><TerminalSquare size={16} aria-hidden="true" /><h3>{command.name}</h3></header>
                <p>{loc(command.description)}</p>
                <div className="linux-help-options">
                  <strong>{label("常用参数", "Common options")}</strong>
                  <p>{loc(command.options)}</p>
                </div>
                <div className="linux-help-example">
                  <div><strong>{label("使用示例", "Example")}</strong><button className="button subtle small" onClick={() => void copyExample(command.example)} aria-label={label("复制示例 ", "Copy example ") + command.name}>
                    <Copy size={13} />{copied === command.example ? label("已复制", "Copied") : label("复制命令", "Copy command")}
                  </button></div>
                  <pre><code>{command.example}</code></pre>
                  <p>{loc(command.exampleNote)}</p>
                </div>
                {command.warning && <div className="linux-help-warning"><AlertTriangle size={15} aria-hidden="true" /><span>{loc(command.warning)}</span></div>}
              </article>
            ))}
          </div>
          <div className="linux-help-hint">{label("不同 Linux 发行版的命令及参数可能有差异。示例路径、PID、服务名、容器名和地址应按实际情况修改。更多参数可用 man 或 --help 查询。", "Commands and flags may differ across Linux distributions. Adapt example paths, PIDs, service/container names and addresses. Consult man or --help for more options.")}</div>
        </div>
      </div>
    </Modal>
  );
}
