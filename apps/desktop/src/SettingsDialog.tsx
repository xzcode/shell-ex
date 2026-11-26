import { tr, getLanguagePreference, setLanguagePreference, type LanguagePreference } from "./i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Palette,
  TerminalSquare,
  ShieldCheck,
  Database,
  Download,
  Upload,
  Settings2,
  RefreshCw,
  FileInput,
  KeyRound,
} from "lucide-react";
import type { AppSettings, Host, Notify } from "./types";
import {
  api,
  chooseFile,
  confirmAction,
  errorText,
  native,
  savePath,
} from "./api";
import { Busy, ErrorBox, Field, Modal, Toggle } from "./ui";
import { VaultDialog, type VaultStatus } from "./VaultDialog";
export function SettingsDialog({
  settings,
  onSave,
  onClose,
  notify,
  onHostsChanged,
  hosts,
}: {
  settings: AppSettings;
  onSave: (s: AppSettings) => Promise<void>;
  onClose: () => void;
  notify: Notify;
  onHostsChanged: () => void;
  hosts: Host[];
}) {
  const [form, setForm] = useState({ ...settings });
  const [language, setLanguage] = useState<LanguagePreference>(getLanguagePreference);
  const [tab, setTab] = useState("appearance");
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [tab]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [backup, setBackup] = useState<"export" | "import" | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [vaultDialog, setVaultDialog] = useState<"access" | "change" | null>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<{
    hosts: Host[];
    warnings: string[];
  } | null>(null);
  const [update, setUpdate] = useState<{
    configured: boolean;
    version: string;
    reason: string;
  } | null>(null);
  useEffect(() => {
    if (native) void api<VaultStatus>("vault_status").then(setVaultStatus).catch(() => {});
  }, []);
  async function reloadVault() {
    if (native) setVaultStatus(await api<VaultStatus>("vault_status"));
  }
  useEffect(() => {
    if (native)
      void api<{ configured: boolean; version: string; reason: string }>(
        "update_config",
      )
        .then(setUpdate)
        .catch((e) =>
          setUpdate({
            configured: false,
            version: "0.4.11",
            reason: errorText(e),
          }),
        );
  }, []);
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave(form);
      setLanguagePreference(language);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function backupAction() {
    setBusy(true);
    setError("");
    try {
      if (backup === "export") {
        const path = await savePath(
          `shell-ex-backup-${new Date().toISOString().slice(0, 10)}.shex`,
        );
        if (!path) return;
        await api("backup_export", { path, passphrase, includeCredentials });
        notify(tr("加密备份已保存。"), "success");
      } else {
        const path = await chooseFile();
        if (typeof path !== "string") return;
        if (
          !(await confirmAction(
            tr("将合并导入备份中的主机和配置。同 ID 的记录会更新。"),
            tr("导入加密备份"),
          ))
        )
          return;
        const result = await api<{ hosts: number }>("backup_import", {
          path,
          passphrase,
        });
        notify(tr("已导入 {0} 台主机配置。", result.hosts), "success");
        onHostsChanged();
      }
      setBackup(null);
      setPassphrase("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function checkUpdates() {
    setBusy(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const available = await check();
      if (!available) {
        notify(tr("已是当前更新通道的最新版本。"), "success");
        return;
      }
      if (
        await confirmAction(
          tr("检测到 {0}。\n{1}\n下载安装后请手动重启应用。", available.version, available.body || ""),
          tr("发现新版本"),
        )
      ) {
        await available.downloadAndInstall();
        notify(tr("更新已安装。请保存工作后关闭并重新启动 Shell EX。"), "success");
      }
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
    <Modal
      title={tr("设置")}
      subtitle={tr("让工作台适合你的使用习惯。")}
      onClose={onClose}
      className="settings-modal"
      wide
      footer={
        <>
          <span className="footer-note">
            Shell EX · {update?.version || "0.4.11"}
          </span>
          <button className="button secondary" onClick={onClose}>{tr("取消")}</button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? <Busy /> : tr("保存设置")}
          </button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav">
          {[
            { id: "appearance", label: tr("外观"), icon: Palette },
            { id: "terminal", label: tr("终端"), icon: TerminalSquare },
            { id: "behavior", label: tr("工作台"), icon: Settings2 },
            { id: "security", label: tr("安全与凭据"), icon: ShieldCheck },
            { id: "data", label: tr("数据与备份"), icon: Database },
            { id: "about", label: tr("关于与更新"), icon: RefreshCw },
          ].map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </nav>
        <div ref={contentRef} className="settings-content">
          {error && <ErrorBox message={error} />}
          {tab === "appearance" && (
            <>
              <h3>{tr("外观")}</h3>
              <div className="form-grid">
                <Field label={tr("界面语言")} hint={tr("保存后切换界面语言，无需重启或断开 SSH 会话。")} full>
                  <select value={language} onChange={(e) => setLanguage(e.target.value as LanguagePreference)}>
                    <option value="system">{tr("跟随系统")}</option>
                    <option value="zh-CN" lang="zh-CN">简体中文</option>
                    <option value="en" lang="en">English</option>
                  </select>
                </Field>
              </div>
              <p className="section-description">{tr("清晰、克制的专业工作空间。")}</p>
              <div className="theme-options">
                {([
                  { id: "black", label: tr("纯黑"), hint: tr("纯黑背景与中性灰控件") },
                  { id: "gray", label: tr("中性灰"), hint: tr("无蓝色偏色，层次分明的中深灰") },
                  { id: "graphite", label: tr("石墨灰"), hint: tr("柔和的专业深色") },
                  { id: "soft-white", label: tr("柔和白"), hint: tr("低亮度暖白，浅灰导航与工具栏") },
                  { id: "mist", label: tr("雾光浅色"), hint: tr("舒适的浅色界面") },
                  { id: "aurora", label: tr("极光深色"), hint: tr("青绿点缀的暗色") },
                  { id: "light", label: tr("经典浅色"), hint: tr("原版浅色配色") },
                ] as const).map((theme) => (
                  <button
                    className={`theme-card ${theme.id}${form.theme === theme.id || (form.theme === "dark" && theme.id === "graphite") ? " selected" : ""}`}
                    key={theme.id}
                    onClick={() => set("theme", theme.id)}
                    aria-pressed={form.theme === theme.id || (form.theme === "dark" && theme.id === "graphite")}
                  >
                    <div className="theme-mini" data-preview-theme={theme.id} aria-hidden="true">
                      <div className="theme-mini-title"><b /><b /><b /></div>
                      <div className="theme-mini-sidebar"><i /><i /><i /><i /><i /></div>
                      <div className="theme-mini-terminal"><i /><i /><i /></div>
                      <div className="theme-mini-monitor"><i /><i /><i /></div>
                      <div className="theme-mini-files"><b /><i /><i /></div>
                    </div>
                    <strong>{theme.label}</strong>
                    <small>{theme.hint}</small>
                  </button>
                ))}
              </div>
              <div className="info-note">
                <Palette size={18} />
                <p>{tr("主题会同时应用于工作台、终端和文件编辑器。")}</p>
              </div>
            </>
          )}
          {tab === "terminal" && (
            <>
              <h3>{tr("终端")}</h3>
              <div className="form-grid">
                <Field label={tr("字号")}>
                  <input
                    type="number"
                    min={10}
                    max={30}
                    value={form.fontSize}
                    onChange={(e) => set("fontSize", +e.target.value)}
                  />
                </Field>
                <Field label={tr("回滚行数")}>
                  <input
                    type="number"
                    min={1000}
                    max={100000}
                    step={1000}
                    value={form.scrollback}
                    onChange={(e) => set("scrollback", +e.target.value)}
                  />
                </Field>
                <Field label={tr("等宽字体")} full>
                  <input
                    value={form.fontFamily}
                    onChange={(e) => set("fontFamily", e.target.value)}
                  />
                </Field>
              </div>
              <div
                className="terminal-font-preview"
                style={{ fontFamily: form.fontFamily, fontSize: form.fontSize }}
              >
                <span>shell-ex</span>:~$ echo "Hello, Jojo"
                <br />
                Hello, Jojo
              </div>
              <Toggle
                checked={form.confirmMultilinePaste}
                onChange={(v) => set("confirmMultilinePaste", v)}
                label={tr("多行粘贴前确认")}
                description={tr("避免剪贴板中的多条命令被意外执行。")}
              />
            </>
          )}
          {tab === "behavior" && (
            <>
              <h3>{tr("工作台")}</h3>
              <div className="form-grid">
                <Field
                  label={tr("监控采样间隔（秒）")}
                  full
                  hint={tr("不活跃窗口降低采样频率；监控失败不影响终端。")}
                >
                  <input
                    type="number"
                    min={2}
                    max={60}
                    value={form.monitorInterval}
                    onChange={(e) => set("monitorInterval", +e.target.value)}
                  />
                </Field>
                <Field label={tr("最大并行传输数")} full>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={form.transferConcurrency}
                    onChange={(e) =>
                      set("transferConcurrency", +e.target.value)
                    }
                  />
                </Field>
              </div>
              <Toggle
                checked={form.autoReconnect}
                onChange={(v) => set("autoReconnect", v)}
                label={tr("断线后自动尝试重连")}
                description={tr("仅使用已保存凭据，重新核验指纹；创建新会话，不恢复原进程。")}
              />
              <div className="info-note">
                <TerminalSquare size={18} />
                <p>{tr("主机标签和面板布局会保留。启动后可一键重新打开上次工作区；远程任务连续运行建议使用 tmux。")}</p>
              </div>
            </>
          )}
          {tab === "security" && (
            <>
              <h3>{tr("安全与凭据")}</h3>
              <div className="info-note">
                <ShieldCheck size={20} />
                <p>{tr("SSH 密码默认使用 Shell EX 内置 AES-256-GCM 加密保存在本机，不访问系统钥匙串。旧系统凭据连接保留配置，首次连接时可重新输入并保存密码；旧应用内密码库继续兼容。")}</p>
              </div>
              <h4>{tr("默认：内置 AES 加密保存")}</h4>
              <p className="section-description">{tr("默认保存方式不需要额外操作。程序内置统一加密密钥，每条记录使用随机 nonce；具备程序副本和加密数据库的人仍可能还原密码，请保护电脑登录账户与应用数据。")}</p>
              {vaultStatus?.initialized && <h4>{tr("旧版主密码库（兼容）")}</h4>}
              {vaultStatus?.initialized && <>
              <div className="settings-list">
                <div>
                  <strong>{tr("密码库状态")}</strong>
                  <span>{vaultStatus
                    ? !vaultStatus.initialized ? tr("未创建")
                      : vaultStatus.unlocked ? tr("已解锁") : tr("已锁定")
                    : native ? tr("读取中") : tr("仅桌面应用可用")}</span>
                </div>
                <div>
                  <strong>{tr("加密记录")}</strong>
                  <span>{vaultStatus ? vaultStatus.count + tr(" 项") : "—"}</span>
                </div>
              </div>
              <div className="vault-settings-actions">
                <button className="button secondary" disabled={!native}
                  onClick={() => setVaultDialog("access")}>
                  <KeyRound size={14} />{tr("解锁旧版密码库")}</button>
                <button className="button secondary"
                  disabled={!native || !vaultStatus?.unlocked}
                  onClick={async () => {
                    try {
                      await api("vault_lock");
                      await reloadVault();
                      notify(tr("应用内密码库已锁定。"), "success");
                    } catch (e) { notify(errorText(e), "error"); }
                  }}>{tr("锁定")}</button>
                <button className="button secondary"
                  disabled={!native || !vaultStatus?.initialized}
                  onClick={() => setVaultDialog("change")}>{tr("修改主密码")}</button>
              </div>
              <p className="section-description">{tr("仅旧版手动设置的主密码库需要解锁；默认自动加密库不会要求输入主密码。")}</p>
              </>}
              <div className="settings-list">
                <div>
                  <strong>{tr("主机指纹校验")}</strong>
                  <span className="green">{tr("始终开启")}</span>
                </div>
                <div>
                  <strong>{tr("遥测与云账号")}</strong>
                  <span>{tr("不启用")}</span>
                </div>
                <div>
                  <strong>{tr("终端输入日志")}</strong>
                  <span>{tr("不记录")}</span>
                </div>
              </div>
              <h4>{tr("清除保存的凭据")}</h4>
              <p className="section-description">{tr("主机配置会保留，下次连接时重新输入密码。")}</p>
              {hosts.map((host) => (
                <div className="credential-row" key={host.id}>
                  <KeyRound size={14} />
                  <span>{host.name}</span>
                  <button
                    className="text-button red"
                    disabled={!native}
                    onClick={async () => {
                      if (
                        !(await confirmAction(
                          tr("清除“{0}”保存的密码与私钥口令？", host.name),
                        ))
                      )
                        return;
                      try {
                        await api("host_secret_delete", { id: host.id });
                        notify(tr("已清除保存的凭据。"), "success");
                      } catch (e) {
                        notify(errorText(e), "error");
                      }
                    }}
                  >{tr("清除")}</button>
                </div>
              ))}
            </>
          )}
          {tab === "data" && (
            <>
              <h3>{tr("数据与备份")}</h3>
              <p className="section-description">{tr("加密备份用于迁移和恢复个人工作台。")}</p>
              <button
                className="settings-action"
                disabled={!native}
                onClick={() => {
                  setBackup("export");
                  setPassphrase("");
                  setError("");
                }}
              >
                <Download size={19} />
                <span>
                  <strong>{tr("导出加密备份")}</strong>
                  <small>{tr("主机、偏好与快捷命令；凭据默认不包含")}</small>
                </span>
              </button>
              <button
                className="settings-action"
                disabled={!native}
                onClick={() => {
                  setBackup("import");
                  setPassphrase("");
                  setError("");
                }}
              >
                <Upload size={19} />
                <span>
                  <strong>{tr("导入加密备份")}</strong>
                  <small>{tr("需要创建备份时使用的密码")}</small>
                </span>
              </button>
              <button
                className="settings-action"
                disabled={!native}
                onClick={() => {
                  setImporting(true);
                  setPreview(null);
                  setImportText("");
                }}
              >
                <FileInput size={19} />
                <span>
                  <strong>{tr("导入 SSH 配置")}</strong>
                  <small>{tr("粘贴 ~/.ssh/config，预览后选择导入")}</small>
                </span>
              </button>
              {!native && (
                <p className="muted">{tr("文件导入、导出与凭据库需要桌面环境。")}</p>
              )}
            </>
          )}
          {tab === "about" && (
            <div className="about">
              <div className="brand-mark large">›_</div>
              <h2>Shell EX</h2>
              <p>{tr("你的服务器，你的工作台。")}</p>
              <span className="version">v{update?.version || "0.4.11"}</span>
              <div className="settings-list">
                <div>
                  <span>{tr("运行环境")}</span>
                  <strong>{native ? tr("桌面应用") : tr("浏览器界面预览")}</strong>
                </div>
                <div>
                  <span>{tr("框架")}</span>
                  <strong>Tauri · Rust · React</strong>
                </div>
                <div>
                  <span>{tr("数据")}</span>
                  <strong>{tr("本机优先")}</strong>
                </div>
              </div>
              <p className="section-description">
                {update?.configured
                  ? tr("更新包需要通过签名验证。")
                  : (update?.reason ? tr(update.reason) : "") ||
                    tr("此构建未配置签名更新通道。可从项目发布页获取安装包。")}
              </p>
              <button
                className="button secondary"
                disabled={!update?.configured || busy}
                onClick={() => void checkUpdates()}
              >
                <RefreshCw size={14} />{tr("检查更新")}</button>
            </div>
          )}
        </div>
      </div>
      {backup && (
        <Modal
          title={backup === "export" ? tr("导出加密备份") : tr("导入加密备份")}
          onClose={() => {
            setBackup(null);
            setPassphrase("");
            setError("");
          }}
          footer={
            <>
              <button
                className="button secondary"
                onClick={() => {
                  setBackup(null);
                  setPassphrase("");
                }}
              >{tr("取消")}</button>
              <button
                className="button primary"
                disabled={busy || passphrase.length < 12}
                onClick={() => void backupAction()}
              >
                {busy ? (
                  <Busy />
                ) : backup === "export" ? (
                  tr("选择保存位置")
                ) : (
                  tr("选择备份文件")
                )}
              </button>
            </>
          }
        >
          <Field
            label={tr("备份密码")}
            hint={tr("至少 12 个字符。请妥善保存，遗失后无法恢复。")}
          >
            <input
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </Field>
          {backup === "export" && (
            <Toggle
              checked={includeCredentials}
              onChange={setIncludeCredentials}
              label={tr("同时包含保存的凭据")}
              description={tr("默认关闭；启用后凭据将加密写入备份。")}
            />
          )}
          {error && <ErrorBox message={error} />}
        </Modal>
      )}
      {importing && (
        <Modal
          title={tr("导入 SSH 配置")}
          subtitle={tr("仅导入可安全识别的配置；不执行 ProxyCommand 或本地命令。")}
          onClose={() => setImporting(false)}
          wide
          footer={
            <>
              <span className="footer-note">
                {preview ? tr("{0} 个可导入连接", preview.hosts.length) : ""}
              </span>
              <button
                className="button secondary"
                onClick={async () => {
                  setBusy(true);
                  try {
                    setPreview(
                      await api("ssh_config_import", { text: importText }),
                    );
                  } catch (e) {
                    notify(errorText(e), "error");
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={!importText.trim() || busy}
              >{tr("解析预览")}</button>
              <button
                className="button primary"
                disabled={!preview?.hosts.length || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("hosts_import", { hosts: preview!.hosts });
                    notify(
                      tr("已导入 {0} 台主机。", preview!.hosts.length),
                      "success",
                    );
                    onHostsChanged();
                    setImporting(false);
                  } catch (e) {
                    notify(errorText(e), "error");
                  } finally {
                    setBusy(false);
                  }
                }}
              >{tr("导入连接")}</button>
            </>
          }
        >
          <textarea
            className="code-input import-config"
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              setPreview(null);
            }}
            placeholder={
              "Host dev\n  HostName 192.168.1.10\n  User ubuntu\n  IdentityFile ~/.ssh/id_ed25519"
            }
          />
          {preview && (
            <>
              <div className="import-preview">
                {preview.hosts.map((h) => (
                  <div key={h.id}>
                    <strong>{h.name}</strong>
                    <code>
                      {h.username}@{h.address}:{h.port}
                    </code>
                  </div>
                ))}
              </div>
              {preview.warnings.map((w, i) => (
                <div className="warning-note" key={i}>
                  {w}
                </div>
              ))}
            </>
          )}
        </Modal>
      )}
    </Modal>
    {vaultDialog && (
      <VaultDialog changePassword={vaultDialog === "change"}
        onClose={() => setVaultDialog(null)}
        onReady={() => {
          setVaultDialog(null);
          void reloadVault().catch((e) => notify(errorText(e), "error"));
          notify(tr("应用内密码库操作成功。"), "success");
        }}
      />
    )}
    </>
  );
}
