import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, ArrowDownUp, Server, Search, Plus, Star, Folder, FolderPlus, MoreHorizontal, Pencil, Copy, Trash2, TerminalSquare, Download, Upload, FileInput, Code2, CircleHelp, SlidersHorizontal } from "lucide-react";
import { tr, getLocale } from "./i18n";
import type { Host, Notify } from "./types";
import { errorText, native } from "./api";
import { IconButton, Modal } from "./ui";
import { ResizeHandle, clampWidth } from "./ResizeHandle";
import { fitFileColumnWidths, resizeFileColumnWidths, fileTableWidth } from "./fileColumnLayout";

export type HostManagerDataAction = "import" | "export" | "ssh";
const columns = [
  { key: "favorite", label: "收藏", width: 54, min: 42 },
  { key: "name", label: "连接名称", width: 160, min: 96 },
  { key: "address", label: "主机地址", width: 142, min: 90 },
  { key: "port", label: "SSH 端口", width: 82, min: 62 },
  { key: "username", label: "用户名", width: 96, min: 65 },
  { key: "authMethod", label: "认证方式", width: 112, min: 72 },
  { key: "group", label: "分组", width: 110, min: 75 },
  { key: "lastConnected", label: "最后连接时间", width: 162, min: 105 },
] as const;
type Key = typeof columns[number]["key"];
type Column = typeof columns[number];
type Scope = { kind: "all" } | { kind: "favorites" } | { kind: "group"; name: string };
type Menu = { kind: "host"; host: Host; x: number; y: number } | { kind: "group"; group: string; x: number; y: number } | { kind: "columns" | "import"; x: number; y: number };
const PREFS = "shell-ex-host-manager-columns-v1";
const ACTION_WIDTH = 48;
const auth = (host: Host) => host.authMethod === "key" ? tr("私钥文件") : host.authMethod === "agent" ? "SSH Agent" : host.authMethod === "interactive" ? tr("交互式认证") : tr("密码");
const groupName = (group: string) => group === "默认分组" ? tr(group) : group;
const hostGroup = (host: Host) => host.group || "默认分组";
const titleFor = (column: Column) => tr(column.label);
function readPreferences() {
  let raw: { widths?: Partial<Record<Key, number>>; hidden?: Key[] } = {};
  try { raw = JSON.parse(localStorage.getItem(PREFS) || "{}") || {}; } catch { /* Old or invalid settings. */ }
  const widths = Object.fromEntries(columns.map(c => [c.key, clampWidth(raw.widths?.[c.key], c.width, c.min, 1400)])) as Record<Key, number>;
  const hidden = new Set(columns.filter(c => c.key !== "name" && Array.isArray(raw.hidden) && raw.hidden.includes(c.key)).map(c => c.key));
  return { widths, hidden };
}
type Props = {
  hosts: Host[]; groups: string[]; lastConnected: Record<string, number>;
  disabled: boolean; connecting: boolean; notify: Notify;
  onClose: () => void; onConnect: (hosts: Host[]) => Promise<boolean>;
  onCreate: (group?: string) => void; onEdit: (host: Host) => void; onCopy: (host: Host) => void;
  onFavorite: (host: Host) => Promise<void>; onDelete: (hosts: Host[]) => Promise<void>;
  onGroupCreate: () => void; onGroupRename: (group: string) => void; onGroupDelete: (group: string) => Promise<void>;
  onMove: (hosts: Host[]) => void; onData: (action: HostManagerDataAction) => void;
  onLocal: () => void; onHelp: () => void; onLinuxHelp: () => void;
};
export function HostManager(props: Props) {
  const { hosts, groups, lastConnected, disabled, connecting, notify } = props;
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({ key: "name", desc: false });
  const [prefs, setPrefs] = useState(readPreferences);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [viewport, setViewport] = useState(0);
  const [busy, setBusy] = useState(false);
  const operationLock = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = list.current;
    if (!target) return;
    const measure = () => setViewport(target.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try { localStorage.setItem(PREFS, JSON.stringify({ widths: prefs.widths, hidden: [...prefs.hidden] })); } catch { /* Session-only preference. */ }
  }, [prefs]);
  useEffect(() => {
    if (scope.kind === "group" && !groups.includes(scope.name)) setScope({ kind: "all" });
  }, [groups, scope]);
  useEffect(() => {
    const handler = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !menuRef.current?.contains(target) && !target.closest("[data-manager-menu-trigger]")) setMenu(null);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, []);
  const visibleColumns = columns.filter(c => !prefs.hidden.has(c.key));
  const renderedWidths = fitFileColumnWidths(visibleColumns.map(c => prefs.widths[c.key]), Math.max(0, viewport - ACTION_WIDTH));
  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return hosts.filter(h => {
      if (scope.kind === "favorites" && !h.favorite) return false;
      if (scope.kind === "group" && hostGroup(h) !== scope.name) return false;
      return [h.name, h.address, h.port, h.username, h.group, h.notes, auth(h)].join(" ").toLocaleLowerCase().includes(needle);
    }).sort((a, b) => {
      const value = (h: Host): string | number => sort.key === "lastConnected" ? lastConnected[h.id] || 0
        : sort.key === "favorite" ? Number(h.favorite) : sort.key === "authMethod" ? auth(h)
        : sort.key === "group" ? groupName(hostGroup(h)) : h[sort.key];
      const av = value(a), bv = value(b);
      if (sort.key === "lastConnected" && (!av || !bv) && av !== bv) return av ? -1 : 1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), getLocale(), { numeric: true, sensitivity: "base" });
      return (sort.desc ? -cmp : cmp) || a.name.localeCompare(b.name, getLocale(), { numeric: true });
    });
  }, [hosts, query, scope, sort, lastConnected, getLocale()]);
  const targets = matching.filter(h => selected.has(h.id));
  const blocked = disabled || connecting || busy;
  function selectScope(next: Scope) {
    setScope(next); setSelected(new Set()); anchor.current = null; setMenu(null);
  }
  function selectRow(event: MouseEvent, id: string) {
    setMenu(null);
    if (event.shiftKey && anchor.current) {
      const a = matching.findIndex(h => h.id === anchor.current), b = matching.findIndex(h => h.id === id);
      if (a >= 0 && b >= 0) {
        const ids = matching.slice(Math.min(a, b), Math.max(a, b) + 1).map(h => h.id);
        setSelected(old => new Set(event.ctrlKey || event.metaKey ? [...old, ...ids] : ids)); return;
      }
    }
    anchor.current = id;
    setSelected(old => {
      if (!(event.ctrlKey || event.metaKey)) return new Set([id]);
      const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next;
    });
  }
  function position(event: MouseEvent, rightClick = false) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(6, Math.min(rightClick ? event.clientX : rect.left, window.innerWidth - 235)),
      y: Math.max(6, Math.min(rightClick ? event.clientY : rect.bottom, window.innerHeight - 290)) };
  }
  function showHostMenu(event: MouseEvent, host: Host, rightClick = false) {
    event.preventDefault(); event.stopPropagation();
    if (rightClick && !selected.has(host.id)) setSelected(new Set([host.id]));
    setMenu(old => !rightClick && old?.kind === "host" && old.host.id === host.id ? null : { kind: "host", host, ...position(event, rightClick) });
  }
  async function run(action: () => Promise<unknown>) {
    if (blocked || operationLock.current) return;
    operationLock.current = true; setMenu(null); setBusy(true);
    try { await action(); } catch (e) { notify(errorText(e), "error"); }
    finally { operationLock.current = false; setBusy(false); }
  }
  function connect(items: Host[]) {
    if (items.length) void run(() => props.onConnect(items));
  }
  function changeWidth(index: number, width: number) {
    const fitted = resizeFileColumnWidths(renderedWidths, index, width, Math.max(0, viewport - ACTION_WIDTH));
    setPrefs(old => ({ ...old, widths: { ...old.widths, ...Object.fromEntries(visibleColumns.map((c, i) => [c.key, clampWidth(fitted[i], c.width, c.min, 1400)])) } }));
  }
  const allChecked = matching.length > 0 && matching.every(h => selected.has(h.id));
  const footer = <>
    <span className="footer-note">{tr("共 {0} 个连接", matching.length)}{targets.length > 0 ? " · " + tr("已选择 {0} 项", targets.length) : ""}</span>
    <button className="button secondary" onClick={props.onClose}>{tr("关闭")}</button>
    <button className="button primary" disabled={blocked || !targets.length} onClick={() => connect(targets)}><TerminalSquare size={15} />{tr("新建会话")}</button>
  </>;
  return <Modal title={tr("连接管理")} onClose={() => menu ? setMenu(null) : props.onClose()}
      className="host-manager-modal" sizePreference={{ key: "shell-ex-host-manager-size", width: 1060, height: 620 }} footer={footer}>
    <div className="host-manager-toolbar">
      <button className="button secondary small" disabled={blocked} onClick={() => props.onCreate(scope.kind === "group" ? scope.name : undefined)}><Plus size={15} />{tr("新建连接")}</button>
      <button className="button secondary small" disabled={blocked} onClick={props.onGroupCreate}><FolderPlus size={15} />{tr("新建分组")}</button>
      <button className="button secondary small" data-manager-menu-trigger disabled={!native || blocked} onClick={e => setMenu(old => old?.kind === "import" ? null : { kind: "import", ...position(e) })}><Upload size={15} />{tr("导入连接")}</button>
      <button className="button secondary small" disabled={!native || blocked} onClick={() => props.onData("export")}><Download size={15} />{tr("导出加密备份")}</button>
      <div className="flex-spacer" />
      <div className="host-manager-search"><Search size={14} /><input aria-label={tr("筛选主机")} placeholder={tr("筛选主机…")} value={query} onChange={e => { setQuery(e.target.value); setSelected(new Set()); anchor.current = null; }} /></div>
      <IconButton title={tr("显示列")} active={menu?.kind === "columns"} onClick={() => {
        const rect = list.current?.getBoundingClientRect();
        setMenu(old => old?.kind === "columns" ? null : { kind: "columns", x: Math.max(6, Math.min((rect?.right || innerWidth) - 220, innerWidth - 235)), y: Math.max(6, rect?.top || 100) });
      }}><SlidersHorizontal size={16} /></IconButton>
    </div>
    <div className="host-manager-body">
      <aside className="host-manager-groups" aria-label={tr("分组")}>
        <button className={scope.kind === "all" ? "active" : ""} onClick={() => selectScope({ kind: "all" })}><Server size={15} /><span>{tr("全部连接")}</span><small>{hosts.length}</small></button>
        <button className={scope.kind === "favorites" ? "active" : ""} onClick={() => selectScope({ kind: "favorites" })}><Star size={15} /><span>{tr("收藏")}</span><small>{hosts.filter(h => h.favorite).length}</small></button>
        <h3>{tr("分组")}</h3>
        {groups.map(group => <div key={group} data-host-group={group} className={"host-manager-group" + (scope.kind === "group" && scope.name === group ? " active" : "")}
            onContextMenu={e => { e.preventDefault(); setMenu({ kind: "group", group, ...position(e, true) }); }}>
          <button onClick={() => selectScope({ kind: "group", name: group })}><Folder size={14} /><span>{groupName(group)}</span><small>{hosts.filter(h => hostGroup(h) === group).length}</small></button>
          <button className="icon-button group-more" data-manager-menu-trigger aria-label={tr("{0} 分组操作", group)} disabled={blocked}
            onClick={e => setMenu(old => old?.kind === "group" && old.group === group ? null : { kind: "group", group, ...position(e) })}><MoreHorizontal size={14}/></button>
        </div>)}
        <div className="flex-spacer" />
        <div className="host-manager-utilities">
          <button onClick={props.onLocal} disabled={blocked}><TerminalSquare size={14} /><span>{tr("本地终端")}</span></button>
          <button onClick={props.onLinuxHelp}><Code2 size={14} /><span>{tr("Linux 命令帮助")}</span></button>
          <button onClick={props.onHelp}><CircleHelp size={14} /><span>{tr("使用指南")}</span></button>
        </div>
      </aside>
      <div className="host-manager-main">
        <div className="host-manager-batch">
          <span>{scope.kind === "all" ? tr("全部连接") : scope.kind === "favorites" ? tr("收藏") : groupName(scope.name)}</span>
          <div className="flex-spacer"/>
          <button className="button secondary small" disabled={blocked || !targets.length} onClick={() => props.onMove(targets)}><Folder size={13}/>{tr("移动到分组")}</button>
          <button className="button secondary small" disabled={blocked || !targets.length} onClick={() => void run(() => props.onDelete(targets))}><Trash2 size={13}/>{tr("删除连接")}</button>
        </div>
        <div className="host-manager-list scroll-area" ref={list}>
          <table className="host-manager-table" style={{ width: fileTableWidth(renderedWidths) + ACTION_WIDTH }}>
            <colgroup><col style={{ width: 34 }}/>{visibleColumns.map((c, i) => <col key={c.key} style={{ width: renderedWidths[i] }}/>) }<col style={{ width: ACTION_WIDTH }}/></colgroup>
            <thead onContextMenu={e => { e.preventDefault(); setMenu({ kind: "columns", ...position(e, true) }); }}>
              <tr><th className="manager-check"><input type="checkbox" aria-label={tr("全选连接")} checked={allChecked} onChange={e => setSelected(e.target.checked ? new Set(matching.map(h => h.id)) : new Set())}/></th>
              {visibleColumns.map((c, i) => <th key={c.key} aria-sort={sort.key === c.key ? sort.desc ? "descending" : "ascending" : undefined}>
                <div className="file-heading-content">
                  <button className="file-sort-button" onClick={() => setSort(old => ({ key: c.key, desc: old.key === c.key ? !old.desc : false }))} title={tr("按 {0} 排序", titleFor(c))}>
                    <span>{titleFor(c)}</span>{sort.key === c.key ? sort.desc ? <ArrowDown size={12}/> : <ArrowUp size={12}/> : <ArrowDownUp size={11}/>}
                  </button>
                  <ResizeHandle column label={tr("调整列宽：{0}", titleFor(c))} value={renderedWidths[i]} min={c.min} max={1400} onChange={width => changeWidth(i, width)} onReset={() => changeWidth(i, c.width)}/>
                </div>
              </th>)}
              <th className="manager-actions">{tr("操作")}</th></tr>
            </thead>
            <tbody>
              {matching.map(host => <tr className={"host-item" + (selected.has(host.id) ? " selected" : "")} key={host.id} data-host-id={host.id}
                  onClick={e => selectRow(e, host.id)} onDoubleClick={() => connect([host])} onContextMenu={e => showHostMenu(e, host, true)}>
                <td className="manager-check" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(host.id)} aria-label={tr("选择 {0}", host.name)}
                    onChange={() => { anchor.current = host.id; setSelected(old => { const next = new Set(old); if (next.has(host.id)) next.delete(host.id); else next.add(host.id); return next; }); }}/>
                </td>
                {visibleColumns.map(c => <td key={c.key} title={c.key === "lastConnected" || c.key === "favorite" ? undefined : c.key === "authMethod" ? auth(host) : String(host[c.key])}>
                  {c.key === "favorite" ? <button className={"manager-star" + (host.favorite ? " favorite" : "")} disabled={blocked}
                    aria-label={host.favorite ? tr("取消收藏") : tr("加入收藏")} onClick={e => { e.stopPropagation(); void run(() => props.onFavorite(host)); }} onDoubleClick={e => e.stopPropagation()}><Star size={15} fill={host.favorite ? "currentColor" : "none"}/></button>
                  : c.key === "name" ? <span className="manager-host-name"><Server size={15} style={{ color: host.color }} /><strong>{host.name}</strong></span>
                  : c.key === "authMethod" ? auth(host)
                  : c.key === "group" ? groupName(hostGroup(host))
                  : c.key === "lastConnected" ? lastConnected[host.id] ? new Date(lastConnected[host.id]).toLocaleString(getLocale()) : "—"
                  : host[c.key]}
                </td>)}
                <td className="manager-actions"><button className="icon-button" data-manager-menu-trigger aria-label={tr("{0} 更多操作", host.name)}
                  onClick={e => showHostMenu(e, host)} onDoubleClick={e => e.stopPropagation()}><MoreHorizontal size={16}/></button></td>
              </tr>)}
            </tbody>
          </table>
          {matching.length === 0 && <div className="table-empty">{hosts.length ? tr("没有匹配的主机") : tr("还没有连接")}</div>}
        </div>
      </div>
    </div>
    {menu && <div ref={menuRef} className="context-menu host-manager-menu" style={{ left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
      {menu.kind === "host" && <>
        <button disabled={blocked} onClick={() => connect([menu.host])}><TerminalSquare size={14}/>{tr("新建会话")}</button>
        <button disabled={blocked} onClick={() => { props.onEdit(menu.host); setMenu(null); }}><Pencil size={14}/>{tr("编辑连接")}</button>
        <button disabled={blocked} onClick={() => { props.onCopy(menu.host); setMenu(null); }}><Copy size={14}/>{tr("复制配置")}</button>
        <button onClick={() => { void navigator.clipboard.writeText(menu.host.address).catch(e => notify(errorText(e), "error")); setMenu(null); }}><Copy size={14}/>{tr("复制主机地址")}</button>
        <button disabled={blocked} onClick={() => { props.onMove([menu.host]); setMenu(null); }}><Folder size={14}/>{tr("移动到分组")}</button>
        <button disabled={blocked} onClick={() => void run(() => props.onFavorite(menu.host))}><Star size={14}/>{menu.host.favorite ? tr("取消收藏") : tr("加入收藏")}</button>
        <button className="red" disabled={blocked} onClick={() => void run(() => props.onDelete([menu.host]))}><Trash2 size={14}/>{tr("删除连接")}</button>
      </>}
      {menu.kind === "group" && <>
        <button disabled={blocked} onClick={() => { props.onCreate(menu.group); setMenu(null); }}><Plus size={14}/>{tr("在此分组新建连接")}</button>
        {menu.group !== "默认分组" && <>
          <button disabled={blocked} onClick={() => { props.onGroupRename(menu.group); setMenu(null); }}><Pencil size={14}/>{tr("重命名分组")}</button>
          <button disabled={blocked} className="red" onClick={() => void run(() => props.onGroupDelete(menu.group))}><Trash2 size={14}/>{tr("删除分组")}</button>
        </>}
      </>}
      {menu.kind === "columns" && columns.map(c => <label className="manager-column-option" key={c.key}><input type="checkbox" checked={!prefs.hidden.has(c.key)} disabled={c.key === "name"}
          onChange={() => setPrefs(old => { const hidden = new Set(old.hidden); if (hidden.has(c.key)) hidden.delete(c.key); else hidden.add(c.key); return { ...old, hidden }; })}/>{titleFor(c)}</label>)}
      {menu.kind === "import" && <>
        <button onClick={() => { props.onData("ssh"); setMenu(null); }}><FileInput size={14}/>{tr("导入 SSH 配置")}</button>
        <button onClick={() => { props.onData("import"); setMenu(null); }}><Upload size={14}/>{tr("导入加密备份")}</button>
      </>}
    </div>}
  </Modal>;
}
