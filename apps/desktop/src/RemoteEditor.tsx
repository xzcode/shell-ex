import { useCallback, useEffect, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { Save, SaveAll, RefreshCw, FileCode2 } from "lucide-react";
import type { Notify, RemoteFile } from "./types";
import { api, bytes, confirmAction, errorText } from "./api";
import { Busy, Empty, ErrorBox, Field, Modal } from "./ui";
import { setDraftDirty } from "./drafts";
self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new CssWorker();
    if (label === "html" || label === "handlebars") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
function language(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() || "";
  return (
    (
      {
        js: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        json: "json",
        yml: "yaml",
        yaml: "yaml",
        sh: "shell",
        py: "python",
        rs: "rust",
        xml: "xml",
        html: "html",
        css: "css",
        md: "markdown",
        toml: "ini",
        conf: "ini",
        sql: "sql",
        java: "java",
        go: "go",
      } as Record<string, string>
    )[extension] || "plaintext"
  );
}
export default function RemoteEditor({
  sessionId,
  path,
  notify,
  onClose,
}: {
  sessionId: string;
  path: string;
  notify: Notify;
  onClose: () => void;
}) {
  const [targetPath, setTargetPath] = useState(path);
  const [saveAs, setSaveAll] = useState(false);
  const [saveAsPath, setSaveAllPath] = useState(path + ".copy");
  const [file, setFile] = useState<RemoteFile | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = !!file && text !== file.text;
  useEffect(() => {
    setDraftDirty(sessionId + ":" + path, dirty);
    return () => setDraftDirty(sessionId + ":" + path, false);
  }, [sessionId, path, dirty]);
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api<RemoteFile>("file_read", {
        sessionId,
        path: targetPath,
      });
      setFile(next);
      setText(next.text);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, targetPath]);
  useEffect(() => {
    void load();
  }, [load]);
  const close = useCallback(() => {
    if (!dirty) onClose();
    else
      void confirmAction(
        "尚有未保存的修改。关闭将放弃这些修改。",
        "关闭编辑器",
      ).then((ok) => {
        if (ok) onClose();
      });
  }, [dirty, onClose]);
  async function saveFile() {
    if (!file || busy || saveAs) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<RemoteFile>("file_save", {
        sessionId,
        path: file.path,
        text,
        expectedVersion: file.version,
      });
      setFile(next);
      setText(next.text);
      notify("文件已安全保存。", "success");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveFile();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  });
  return (
    <Modal
      title={`${dirty ? "● " : ""}${targetPath.split("/").pop()}`}
      subtitle={file?.path || targetPath}
      onClose={close}
      wide
      footer={
        <>
          <span className="footer-note">
            <FileCode2 size={13} /> UTF-8 · {file ? bytes(file.size) : "读取中"}{" "}
            · 冲突检测已启用
          </span>
          <button
            className="button secondary"
            disabled={busy}
            onClick={async () => {
              if (
                !dirty ||
                (await confirmAction(
                  "将放弃本地修改，重新读取远程文件。",
                  "重新载入",
                ))
              )
                void load();
            }}
          >
            <RefreshCw size={14} />
            重新载入
          </button>
          <button
            className="button secondary"
            disabled={!file || busy}
            onClick={() => {
              setSaveAllPath(targetPath + ".copy");
              setSaveAll(true);
            }}
          >
            <SaveAll size={14} />
            另存为
          </button>
          <button
            className="button primary"
            disabled={!file || busy || !dirty}
            onClick={() => void saveFile()}
          >
            {busy ? (
              <Busy />
            ) : (
              <>
                <Save size={14} />
                保存 <kbd>⌘S</kbd>
              </>
            )}
          </button>
        </>
      }
    >
      {error && <ErrorBox message={error} />}
      <div className="remote-editor">
        {file ? (
          <Editor
            height="100%"
            language={language(targetPath)}
            value={text}
            theme={
              ["light", "mist"].includes(document.documentElement.dataset.theme || "")
                ? "vs"
                : "vs-dark"
            }
            onChange={(value) => setText(value || "")}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              padding: { top: 12 },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: "off",
              tabSize: 2,
              renderWhitespace: "selection",
            }}
          />
        ) : error ? (
          <Empty
            icon={<FileCode2 size={24} />}
            title="无法读取文件"
            text="请检查文件大小、类型和访问权限。"
          />
        ) : (
          <div className="empty">
            <Busy text="读取远程文件…" />
          </div>
        )}
      </div>
      {saveAs && (
        <Modal
          title="另存为远程文件"
          subtitle="仅写入不存在的新路径，已有文件不会被覆盖。"
          onClose={() => setSaveAll(false)}
          footer={
            <>
              <button
                className="button secondary"
                onClick={() => setSaveAll(false)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={busy || !saveAsPath.trim()}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const next = await api<RemoteFile>("file_save", {
                      sessionId,
                      path: saveAsPath.trim(),
                      text,
                      expectedVersion: "missing",
                    });
                    setFile(next);
                    setText(next.text);
                    setTargetPath(next.path);
                    setSaveAll(false);
                    notify("已保存为新文件。", "success");
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Busy /> : "保存新文件"}
              </button>
            </>
          }
        >
          <Field label="远程路径">
            <input
              value={saveAsPath}
              onChange={(e) => setSaveAllPath(e.target.value)}
            />
          </Field>
          {error && <ErrorBox message={error} />}
        </Modal>
      )}
    </Modal>
  );
}
