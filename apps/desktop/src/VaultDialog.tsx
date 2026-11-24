import { tr } from "./i18n";
import { useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { api, errorText, native } from "./api";
import { Busy, ErrorBox, Field, Modal } from "./ui";

export type VaultStatus = {
  initialized: boolean;
  unlocked: boolean;
  count: number;
};

/** Master password is never persisted in the browser, host configuration, or logs. */
export function VaultDialog({
  onReady,
  onClose,
  changePassword = false,
}: {
  onReady: () => void;
  onClose: () => void;
  changePassword?: boolean;
}) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!native) return;
    void api<VaultStatus>("vault_status").then(setStatus).catch((err) => setError(errorText(err)));
  }, []);
  const creating = !changePassword && status !== null && !status.initialized;
  const changing = changePassword;
  async function submit() {
    if (!status && !changePassword) return;
    if ((creating || changing) && password !== confirmation) {
      setError(tr("两次输入的主密码不一致。"));
      return;
    }
    if ((creating || changing) && password.length < 12) {
      setError(tr("主密码至少需要 12 个字符。"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (changing) {
        await api("vault_change_password", { oldPassword, newPassword: password });
      } else if (creating) {
        await api("vault_initialize", { masterPassword: password });
      } else {
        await api("vault_unlock", { masterPassword: password });
      }
      setPassword("");
      setConfirmation("");
      setOldPassword("");
      onReady();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={changing ? tr("修改本地密码库主密码") : creating ? tr("设置本地密码库主密码") : tr("解锁本地密码库")}
      subtitle={changing
        ? tr("验证原主密码后，在一次数据库事务中重新加密所有已保存凭据。")
        : creating
          ? tr("首次创建后，SSH 密码只以加密密文存放在 Shell EX 应用目录中。")
          : tr("解锁一次后可自动连接已保存密码的主机；关闭软件会清除内存中的密钥。")}
      onClose={onClose}
      footer={
        <>
          <button className="button secondary" onClick={onClose} disabled={busy}>{tr("取消")}</button>
          <button className="button primary" disabled={busy || !native || (!status && !changing)}
            onClick={() => void submit()}>
            {busy ? <Busy text={tr("处理中")} /> : changing ? tr("修改主密码") : creating ? tr("创建并解锁") : tr("解锁")}
          </button>
        </>
      }
    >
      {error && <ErrorBox message={error} />}
      {status === null && !error && <p className="muted">{tr("正在读取本地密码库状态…")}</p>}
      {changing && (
        <Field label={tr("原主密码")} full>
          <input type="password" autoComplete="off" value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)} />
        </Field>
      )}
      <Field label={creating || changing ? tr("新主密码（至少 12 字符）") : tr("主密码")} full>
        <input autoFocus type="password" autoComplete="off" value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !creating && !changing) void submit(); }} />
      </Field>
      {(creating || changing) && (
        <Field label={tr("确认新主密码")} full>
          <input type="password" autoComplete="off" value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        </Field>
      )}
      <div className="info-note">
        {creating ? <KeyRound size={18} /> : <ShieldCheck size={18} />}
        <p>{tr("使用 Argon2id 和 AES-256-GCM 加密；不会把主密码保存到系统凭据库。 请妥善保管主密码：遗忘后无法恢复应用内已加密的密码；只能重新输入各服务器密码。")}</p>
      </div>
    </Modal>
  );
}
