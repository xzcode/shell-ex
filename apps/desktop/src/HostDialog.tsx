import { tr } from "./i18n";
import { useState } from "react";
import { VaultDialog, type VaultStatus } from "./VaultDialog";
import {
  Server,
  KeyRound,
  Network,
  SlidersHorizontal,
  FolderOpen,
  ShieldCheck,
  Copy,
} from "lucide-react";
import type { Host, HostKeyInfo, SecretInput, Notify } from "./types";
import { newHost, normalizeHost, credentialStoreForHost, type CredentialStore } from "./types";
import { api, chooseFile, errorText, native } from "./api";
import { Modal, Field, Toggle, Busy, ErrorBox } from "./ui";
export function HostDialog({
  host,
  hosts,
  groups = [],
  initialGroup,
  onClose,
  onSaved,
  notify,
}: {
  host: Host | null;
  hosts: Host[];
  groups?: string[];
  initialGroup?: string;
  onClose: () => void;
  onSaved: (host: Host) => void;
  notify: Notify;
}) {
  const [form, setForm] = useState<Host>(() =>
    host ? normalizeHost(host) : { ...newHost(), ...(initialGroup ? { group: initialGroup } : {}) },
  );
  const [tab, setTab] = useState("basic");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [vaultPrompt, setVaultPrompt] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<HostKeyInfo | null>(null);
  const set = <K extends keyof Host>(key: K, value: Host[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const valid =
    form.name.trim() &&
    form.address.trim() &&
    form.username.trim() &&
    form.port > 0 &&
    form.port <= 65535 &&
    (form.authMethod !== "key" || form.privateKeyPath);
  async function submit(connectTest = false, vaultReady = false) {
    if (!valid) {
      setError(
        tr("请填写名称、主机地址、用户名和有效端口；密钥认证还需要选择私钥。"),
      );
      return;
    }
    const mode = credentialStoreForHost(form);
    const persistentAuth = form.authMethod === "password" || form.authMethod === "key";
    const suppliedCredential = form.authMethod === "password" ? password : form.authMethod === "key" ? passphrase : "";
    const requiresVault = mode === "local" && native && persistentAuth &&
      (Boolean(suppliedCredential) || (host && credentialStoreForHost(host) !== "local"));
    if (requiresVault && !vaultReady) {
      try {
        const status = await api<VaultStatus>("vault_status");
        if (!status.unlocked) { setVaultPrompt(connectTest); return; }
      } catch (e) { setError(errorText(e)); return; }
    }
    setBusy(true);
    setError("");
    try {
      const secret: SecretInput = {
        password: form.authMethod === "password" ? password || null : null,
        passphrase: form.authMethod === "key" ? passphrase || null : null,
      };
      const saved = await api<Host>("host_save", {
        host: {
          ...form,
          name: form.name.trim(),
          address: form.address.trim(),
          username: form.username.trim(),
          group: form.group.trim() || "默认分组",
          credentialStore: mode,
        },
        secret: mode !== "session" && native && persistentAuth ? secret : null,
        rememberSecret: mode !== "session" && native && persistentAuth,
      });
      setPassword("");
      setPassphrase("");
      if (connectTest) {
        const result = await api<HostKeyInfo>("ssh_probe", {
          hostId: saved.id,
        });
        setProbe(result);
        notify(tr("SSH 握手完成，连接配置已保存；尚未进行身份认证。"), "success");
      } else {
        onSaved(saved);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
    <Modal
      title={host ? tr("编辑连接") : tr("新建 SSH 连接")}
      subtitle={tr("连接信息与身份认证在同一页，默认内置加密保存服务器密码。")}
      onClose={() => {
        setPassword("");
        setPassphrase("");
        onClose();
      }}
      wide
      footer={
        <>
          <span className="footer-note">
            {native ? tr("本地配置 · 可选加密凭据") : tr("预览模式 · 不保存任何密码")}
          </span>
          <button
            className="button secondary"
            onClick={() => void submit(true)}
            disabled={busy || !native}
          >{tr("保存并测试握手")}</button>
          <button
            className="button primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? <Busy text={tr("保存中")} /> : tr("保存连接")}
          </button>
        </>
      }
    >
      <div className="form-tabs">
        {[
          { id: "basic", label: tr("基础信息"), icon: Server },
          { id: "network", label: tr("网络"), icon: Network },
          { id: "advanced", label: tr("高级"), icon: SlidersHorizontal },
        ].map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            <t.icon size={15} />
            {t.label}
          </button>
        ))}
      </div>
      {error && <ErrorBox message={error} />}
      {tab === "basic" && (
        <>
        <div className="form-grid">
          <Field label={tr("连接名称")} full>
            <input
              autoFocus
              value={form.name}
              placeholder={tr("例如：上海 · 生产服务器")}
              onChange={(e) => set("name", e.target.value)}
              maxLength={100}
            />
          </Field>
          <Field label={tr("主机地址")}>
            <input
              value={form.address}
              placeholder={tr("192.168.1.10 或主机域名")}
              onChange={(e) => set("address", e.target.value)}
            />
          </Field>
          <Field label={tr("SSH 端口")}>
            <input
              type="number"
              value={form.port}
              min={1}
              max={65535}
              onChange={(e) => set("port", +e.target.value)}
            />
          </Field>
          <Field label={tr("用户名")}>
            <input
              autoComplete="off"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
            />
          </Field>
          <Field label={tr("分组")}>
            <input
              value={form.group}
              list="host-groups"
              placeholder={tr("默认分组")}
              onChange={(e) => set("group", e.target.value)}
            />
            <datalist id="host-groups">
              {[...new Set(["默认分组", ...groups, ...hosts.map((h) => h.group).filter(Boolean)])].map((g) => (
                <option value={g} key={g} />
              ))}
            </datalist>
          </Field>
          <Field label={tr("标记颜色")}>
            <div className="swatches">
              {["#69a9f8", "#53cba3", "#edb963", "#b491f4", "#e98092"].map(
                (color) => (
                  <button
                    type="button"
                    key={color}
                    aria-label={color}
                    className={form.color === color ? "selected" : ""}
                    style={{ background: color }}
                    onClick={() => set("color", color)}
                  />
                ),
              )}
            </div>
          </Field>
          <div>
            <Toggle
              label={tr("收藏此连接")}
              checked={form.favorite}
              onChange={(v) => set("favorite", v)}
            />
          </div>
          <Field label={tr("备注")} full>
            <textarea
              value={form.notes}
              placeholder={tr("用途、环境和其他需要记住的信息")}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
            />
          </Field>
        </div>
        <section className="auth-settings">
          <h4><KeyRound size={15} />{" "}{tr("身份认证")}</h4>
          <div className="form-grid">
          <Field label={tr("认证方式")} full>
            <select
              value={form.authMethod}
              onChange={(e) => {
                set("authMethod", e.target.value as Host["authMethod"]);
                setPassword("");
                setPassphrase("");
              }}
            >
              <option value="password">{tr("密码")}</option>
              <option value="key">{tr("私钥文件")}</option>
              <option value="agent">SSH Agent</option>
              <option value="interactive">{tr("交互式认证 / MFA")}</option>
            </select>
          </Field>
          {form.authMethod === "password" && (credentialStoreForHost(form)) !== "session" && (
            <Field
              label={tr("登录密码")}
              full
              hint={
                host
                  ? tr("留空保留已保存凭据；也可以在连接时输入。")
                  : tr("也可以留空，在连接时输入。")
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}
          {form.authMethod === "key" && (
            <>
              <Field
                label={tr("私钥文件")}
                full
                hint={tr("仅保存文件路径，不复制私钥内容。")}
              >
                <div className="input-action">
                  <input
                    value={form.privateKeyPath || ""}
                    placeholder="/Users/you/.ssh/id_ed25519"
                    onChange={(e) => set("privateKeyPath", e.target.value)}
                  />
                  <button
                    className="button secondary"
                    onClick={async () => {
                      try {
                        const file = await chooseFile();
                        if (typeof file === "string")
                          set("privateKeyPath", file);
                      } catch (e) {
                        notify(errorText(e), "error");
                      }
                    }}
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
              </Field>
              {(credentialStoreForHost(form)) !== "session" && <Field label={tr("私钥口令（如果有）")} full>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>}
            </>
          )}
          {form.authMethod === "agent" && (
            <div className="info-note full">
              <KeyRound size={19} />
              <p>{tr("使用当前系统 SSH Agent 中的密钥。请先在系统中运行 ssh-add 加载私钥。")}</p>
            </div>
          )}
          {form.authMethod === "interactive" && (
            <div className="info-note full">
              <ShieldCheck size={19} />
              <p>{tr("连接时根据服务器请求输入密码或验证码。交互式认证的回答不会保存。")}</p>
            </div>
          )}
          {(form.authMethod === "password" || form.authMethod === "key") && (
            <div className="full credential-mode">
              <Field label={tr("密码保存位置")} full>
                <select value={credentialStoreForHost(form)}
                  onChange={(e) => set("credentialStore", e.target.value as CredentialStore)}>
                  <option value="builtin">{tr("本地加密保存（默认）")}</option>
                  <option value="session">{tr("不保存密码（每次输入）")}</option>
                  {(host?.credentialStore === "auto" || form.credentialStore === "auto") && (
                    <option value="auto">{tr("旧版自动加密库（兼容）")}</option>
                  )}
                  {(host?.credentialStore === "local" || form.credentialStore === "local") && (
                    <option value="local">{tr("旧版主密码加密库（兼容）")}</option>
                  )}
                </select>
              </Field>
              <p className="credential-mode-hint">
                {form.credentialStore === "session"
                  ? tr("只保存服务器配置，下次连接时再输入 SSH 密码。")
                  : form.credentialStore === "auto"
                      ? tr("保留旧版自动加密的凭据，原来的本机密钥文件仍用于解密旧记录。")
                      : form.credentialStore === "local"
                        ? tr("兼容以前设置过主密码的加密库，可以重新输入服务器密码切换到默认模式。")
                        : tr("使用内置 AES-256-GCM 统一加密方式，保存后直接连接；不需要主密码或单独的密钥文件。")}
              </p>
              {!native && <p className="credential-mode-hint">{tr("当前是浏览器预览，不会保存任何密码。")}</p>}
            </div>
          )}
          </div>
        </section>
        </>
      )}
      {tab === "network" && (
        <div className="form-grid">
          <Field label={tr("代理类型")} full>
            <select
              value={form.proxy?.kind || "none"}
              onChange={(e) =>
                set(
                  "proxy",
                  e.target.value === "none"
                    ? null
                    : {
                        kind: e.target.value as "socks5" | "http",
                        host: form.proxy?.host || "127.0.0.1",
                        port: form.proxy?.port || 7890,
                      },
                )
              }
            >
              <option value="none">{tr("直接连接")}</option>
              <option value="socks5">SOCKS5</option>
              <option value="http">HTTP CONNECT</option>
            </select>
          </Field>
          {form.proxy && (
            <>
              <Field label={tr("代理地址")}>
                <input
                  value={form.proxy.host}
                  onChange={(e) =>
                    set("proxy", { ...form.proxy!, host: e.target.value })
                  }
                />
              </Field>
              <Field label={tr("代理端口")}>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.proxy.port}
                  onChange={(e) =>
                    set("proxy", { ...form.proxy!, port: +e.target.value })
                  }
                />
              </Field>
            </>
          )}
          <Field
            label={tr("SSH 跳板机")}
            full
            hint={tr("跳板机需要先保存并验证指纹；代理和跳板机的可组合能力以连接诊断为准。")}
          >
            <select
              value={form.jumpHostId || ""}
              onChange={(e) => set("jumpHostId", e.target.value || null)}
            >
              <option value="">{tr("不使用跳板机")}</option>
              {hosts
                .filter((h) => h.id !== form.id)
                .map((h) => (
                  <option value={h.id} key={h.id}>
                    {h.name} · {h.address}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={tr("连接超时（秒）")}>
            <input
              type="number"
              min={5}
              max={120}
              value={form.connectTimeoutSeconds}
              onChange={(e) => set("connectTimeoutSeconds", +e.target.value)}
            />
          </Field>
          <Field label={tr("Keepalive（秒）")}>
            <input
              type="number"
              min={5}
              max={300}
              value={form.keepAliveSeconds}
              onChange={(e) => set("keepAliveSeconds", +e.target.value)}
            />
          </Field>
        </div>
      )}
      {tab === "advanced" && (
        <div className="form-grid">
          <Field
            label={tr("连接后工作目录")}
            full
            hint={tr("作为路径处理。不要填写命令或变量。")}
          >
            <input
              value={form.startupDirectory || ""}
              placeholder={tr("留空使用用户主目录")}
              onChange={(e) => set("startupDirectory", e.target.value || null)}
            />
          </Field>
          <div className="info-note full">
            <ShieldCheck size={19} />
            <p>{tr("主机指纹在认证前校验。首次连接需要确认，已信任的指纹发生变化时会阻止自动连接。终端默认使用 UTF-8 与 xterm-256color。")}</p>
          </div>
        </div>
      )}
      {probe && (
        <div className="fingerprint">
          <span>
            <ShieldCheck size={15} />{" "}{tr("握手检测：")}{probe.algorithm}
          </span>
          <code>{probe.fingerprint}</code>
          <small>
            {probe.trusted
              ? tr("与已信任指纹匹配")
              : probe.changed
                ? tr("警告：主机指纹发生变化")
                : tr("尚未信任；连接时需要核验")}
          </small>
        </div>
      )}
    </Modal>
      {vaultPrompt !== null && (
        <VaultDialog onClose={() => setVaultPrompt(null)} onReady={() => {
          const tested = vaultPrompt;
          setVaultPrompt(null);
          void submit(tested, true);
        }} />
      )}
    </>
  );
}
export function TrustDialog({
  host,
  info,
  onClose,
  onTrust,
}: {
  host: Host;
  info: HostKeyInfo;
  onClose: () => void;
  onTrust: () => Promise<void>;
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={info.changed ? tr("服务器身份发生变化") : tr("验证服务器身份")}
      subtitle={`${host.username}@${host.address}:${host.port}`}
      onClose={onClose}
      footer={
        <>
          <button className="button secondary" onClick={onClose}>{tr("取消连接")}</button>
          <button
            className={`button ${info.changed ? "destructive" : "primary"}`}
            disabled={!ack || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onTrust();
              } catch (e) {
                setError(errorText(e));
                setBusy(false);
              }
            }}
          >
            {busy ? <Busy /> : info.changed ? tr("替换信任并连接") : tr("信任并连接")}
          </button>
        </>
      }
    >
      <div className={`trust-notice${info.changed ? " changed" : ""}`}>
        <ShieldCheck size={28} />
        <p>
          {info.changed
            ? tr("该主机的公钥与之前保存的记录不一致。请通过服务器控制台或其他可信渠道核实原因。")
            : tr("这是第一次连接这台服务器。请与服务器提供的指纹核对，确认连接到正确的主机。")}
        </p>
      </div>
      <div className="fingerprint">
        <span>{info.algorithm} · SHA-256</span>
        <code>{info.fingerprint}</code>
        <button
          className="text-button"
          onClick={() => void navigator.clipboard.writeText(info.fingerprint)}
        >
          <Copy size={13} />{tr("复制指纹")}</button>
      </div>
      {info.previousFingerprint && (
        <div className="fingerprint muted">
          <span>{tr("之前的指纹")}</span>
          <code>{info.previousFingerprint}</code>
        </div>
      )}
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />{tr("我已通过可信渠道核对该指纹")}</label>
      {error && <ErrorBox message={error} />}
    </Modal>
  );
}
