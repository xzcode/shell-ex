import { useEffect, useState } from "react";
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
  const [tab, setTab] = useState("appearance");
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
            version: "0.3.2",
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
        notify("加密备份已保存。", "success");
      } else {
        const path = await chooseFile();
        if (typeof path !== "string") return;
        if (
          !(await confirmAction(
            "将合并导入备份中的主机和配置。同 ID 的记录会更新。",
            "导入加密备份",
          ))
        )
          return;
        const result = await api<{ hosts: number }>("backup_import", {
          path,
          passphrase,
        });
        notify(`已导入 ${result.hosts} 台主机配置。`, "success");
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
        notify("已是当前更新通道的最新版本。", "success");
        return;
      }
      if (
        await confirmAction(
          `检测到 ${available.version}。\n${available.body || ""}\n下载安装后请手动重启应用。`,
          "发现新版本",
        )
      ) {
        await available.downloadAndInstall();
        notify("更新已安装。请保存工作后关闭并重新启动 Shell EX。", "success");
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
      title="设置"
      subtitle="让工作台适合你的使用习惯。"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="footer-note">
            Shell EX · {update?.version || "0.3.2"}
          </span>
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? <Busy /> : "保存设置"}
          </button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav">
          {[
            { id: "appearance", label: "外观", icon: Palette },
            { id: "terminal", label: "终端", icon: TerminalSquare },
            { id: "behavior", label: "工作台", icon: Settings2 },
            { id: "security", label: "安全与凭据", icon: ShieldCheck },
            { id: "data", label: "数据与备份", icon: Database },
            { id: "about", label: "关于与更新", icon: RefreshCw },
          ].map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {error && <ErrorBox message={error} />}
          {tab === "appearance" && (
            <>
              <h3>外观</h3>
              <p className="section-description">清晰、克制的专业工作空间。</p>
              <div className="theme-options">
                {([
                  { id: "graphite", label: "石墨灰", hint: "柔和的专业深色" },
                  { id: "mist", label: "雾光浅色", hint: "舒适的浅色界面" },
                  { id: "aurora", label: "极光深色", hint: "青绿点缀的暗色" },
                  { id: "light", label: "经典浅色", hint: "原版浅色配色" },
                ] as const).map((theme) => (
                  <button
                    className={`theme-card ${theme.id}${form.theme === theme.id || (form.theme === "dark" && theme.id === "graphite") ? " selected" : ""}`}
                    key={theme.id}
                    onClick={() => set("theme", theme.id)}
                    aria-pressed={form.theme === theme.id || (form.theme === "dark" && theme.id === "graphite")}
                  >
                    <div className="theme-mini">
                      <span />
                      <div><i /><i /><i /></div>
                    </div>
                    <strong>{theme.label}</strong>
                    <small>{theme.hint}</small>
                  </button>
                ))}
              </div>
              <div className="info-note">
                <Palette size={18} />
                <p>主题会同时应用于工作台、终端和文件编辑器。</p>
              </div>
            </>
          )}
          {tab === "terminal" && (
            <>
              <h3>终端</h3>
              <div className="form-grid">
                <Field label="字号">
                  <input
                    type="number"
                    min={10}
                    max={30}
                    value={form.fontSize}
                    onChange={(e) => set("fontSize", +e.target.value)}
                  />
                </Field>
                <Field label="回滚行数">
                  <input
                    type="number"
                    min={1000}
                    max={100000}
                    step={1000}
                    value={form.scrollback}
                    onChange={(e) => set("scrollback", +e.target.value)}
                  />
                </Field>
                <Field label="等宽字体" full>
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
                label="多行粘贴前确认"
                description="避免剪贴板中的多条命令被意外执行。"
              />
            </>
          )}
          {tab === "behavior" && (
            <>
              <h3>工作台</h3>
              <div className="form-grid">
                <Field
                  label="监控采样间隔（秒）"
                  full
                  hint="不活跃窗口降低采样频率；监控失败不影响终端。"
                >
                  <input
                    type="number"
                    min={2}
                    max={60}
                    value={form.monitorInterval}
                    onChange={(e) => set("monitorInterval", +e.target.value)}
                  />
                </Field>
                <Field label="最大并行传输数" full>
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
                label="断线后自动尝试重连"
                description="仅使用已保存凭据，重新核验指纹；创建新会话，不恢复原进程。"
              />
              <div className="info-note">
                <TerminalSquare size={18} />
                <p>
                  主机标签和面板布局会保留。启动后可一键重新打开上次工作区；远程任务连续运行建议使用
                  tmux。
                </p>
              </div>
            </>
          )}
          {tab === "security" && (
            <>
              <h3>安全与凭据</h3>
              <div className="info-note">
                <ShieldCheck size={20} />
                <p>新连接默认使用 Shell EX 内置 AES-256-GCM 加密保存 SSH 密码，无需设置主密码或生成密钥文件。主机配置不含明文密码；已有连接仍按原有方式读取。</p>
              </div>
              <h4>默认：内置 AES 加密保存</h4>
              <p className="section-description">默认保存方式不需要额外操作。程序内置统一加密密钥，每条记录使用随机 nonce；具备程序副本和加密数据库的人仍可能还原密码，请保护电脑登录账户与应用数据。</p>
              {vaultStatus?.initialized && <h4>旧版主密码库（兼容）</h4>}
              {vaultStatus?.initialized && <>
              <div className="settings-list">
                <div>
                  <strong>密码库状态</strong>
                  <span>{vaultStatus
                    ? !vaultStatus.initialized ? "未创建"
                      : vaultStatus.unlocked ? "已解锁" : "已锁定"
                    : native ? "读取中" : "仅桌面应用可用"}</span>
                </div>
                <div>
                  <strong>加密记录</strong>
                  <span>{vaultStatus ? vaultStatus.count + " 项" : "—"}</span>
                </div>
              </div>
              <div className="vault-settings-actions">
                <button className="button secondary" disabled={!native}
                  onClick={() => setVaultDialog("access")}>
                  <KeyRound size={14} />
                  解锁旧版密码库
                </button>
                <button className="button secondary"
                  disabled={!native || !vaultStatus?.unlocked}
                  onClick={async () => {
                    try {
                      await api("vault_lock");
                      await reloadVault();
                      notify("应用内密码库已锁定。", "success");
                    } catch (e) { notify(errorText(e), "error"); }
                  }}>锁定</button>
                <button className="button secondary"
                  disabled={!native || !vaultStatus?.initialized}
                  onClick={() => setVaultDialog("change")}>修改主密码</button>
              </div>
              <p className="section-description">仅旧版手动设置的主密码库需要解锁；默认自动加密库不会要求输入主密码。</p>
              </>}
              <div className="settings-list">
                <div>
                  <strong>主机指纹校验</strong>
                  <span className="green">始终开启</span>
                </div>
                <div>
                  <strong>遥测与云账号</strong>
                  <span>不启用</span>
                </div>
                <div>
                  <strong>终端输入日志</strong>
                  <span>不记录</span>
                </div>
              </div>
              <h4>清除保存的凭据</h4>
              <p className="section-description">
                主机配置会保留，下次连接时重新输入密码。
              </p>
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
                          `清除“${host.name}”保存的密码与私钥口令？`,
                        ))
                      )
                        return;
                      try {
                        await api("host_secret_delete", { id: host.id });
                        notify("已清除保存的凭据。", "success");
                      } catch (e) {
                        notify(errorText(e), "error");
                      }
                    }}
                  >
                    清除
                  </button>
                </div>
              ))}
            </>
          )}
          {tab === "data" && (
            <>
              <h3>数据与备份</h3>
              <p className="section-description">
                加密备份用于迁移和恢复个人工作台。
              </p>
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
                  <strong>导出加密备份</strong>
                  <small>主机、偏好与快捷命令；凭据默认不包含</small>
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
                  <strong>导入加密备份</strong>
                  <small>需要创建备份时使用的密码</small>
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
                  <strong>导入 SSH 配置</strong>
                  <small>粘贴 ~/.ssh/config，预览后选择导入</small>
                </span>
              </button>
              {!native && (
                <p className="muted">文件导入、导出与凭据库需要桌面环境。</p>
              )}
            </>
          )}
          {tab === "about" && (
            <div className="about">
              <div className="brand-mark large">›_</div>
              <h2>Shell EX</h2>
              <p>你的服务器，你的工作台。</p>
              <span className="version">v{update?.version || "0.1.0"}</span>
              <div className="settings-list">
                <div>
                  <span>运行环境</span>
                  <strong>{native ? "桌面应用" : "浏览器界面预览"}</strong>
                </div>
                <div>
                  <span>框架</span>
                  <strong>Tauri · Rust · React</strong>
                </div>
                <div>
                  <span>数据</span>
                  <strong>本机优先</strong>
                </div>
              </div>
              <p className="section-description">
                {update?.configured
                  ? "更新包需要通过签名验证。"
                  : update?.reason ||
                    "此构建未配置签名更新通道。可从项目发布页获取安装包。"}
              </p>
              <button
                className="button secondary"
                disabled={!update?.configured || busy}
                onClick={() => void checkUpdates()}
              >
                <RefreshCw size={14} />
                检查更新
              </button>
            </div>
          )}
        </div>
      </div>
      {backup && (
        <Modal
          title={backup === "export" ? "导出加密备份" : "导入加密备份"}
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
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={busy || passphrase.length < 12}
                onClick={() => void backupAction()}
              >
                {busy ? (
                  <Busy />
                ) : backup === "export" ? (
                  "选择保存位置"
                ) : (
                  "选择备份文件"
                )}
              </button>
            </>
          }
        >
          <Field
            label="备份密码"
            hint="至少 12 个字符。请妥善保存，遗失后无法恢复。"
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
              label="同时包含保存的凭据"
              description="默认关闭；启用后凭据将加密写入备份。"
            />
          )}
          {error && <ErrorBox message={error} />}
        </Modal>
      )}
      {importing && (
        <Modal
          title="导入 SSH 配置"
          subtitle="仅导入可安全识别的配置；不执行 ProxyCommand 或本地命令。"
          onClose={() => setImporting(false)}
          wide
          footer={
            <>
              <span className="footer-note">
                {preview ? `${preview.hosts.length} 个可导入连接` : ""}
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
              >
                解析预览
              </button>
              <button
                className="button primary"
                disabled={!preview?.hosts.length || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("hosts_import", { hosts: preview!.hosts });
                    notify(
                      `已导入 ${preview!.hosts.length} 台主机。`,
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
              >
                导入连接
              </button>
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
          notify("应用内密码库操作成功。", "success");
        }}
      />
    )}
    </>
  );
}
