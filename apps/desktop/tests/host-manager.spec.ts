import { expect, test } from "@playwright/test";

test.use({ locale: "zh-CN" });

test("manager opens independent sessions from one saved host and keeps the workspace geometry unchanged", async ({ page }, info) => {
  await page.addInitScript(() => {
    const host = {
      id: "bc6f7e3e-e59b-4c7f-b485-1f3782ed3240", name: "Session fixture",
      address: "192.0.2.10", port: 22, username: "test", group: "Fixture",
      authMethod: "password", credentialStore: "builtin", privateKeyPath: null,
      proxy: null, jumpHostId: null, startupDirectory: null, keepAliveSeconds: 30,
      connectTimeoutSeconds: 15, favorite: false, color: "#69a9f8", notes: "",
    };
    let callback = 0, count = 0, fail = false;
    const closed: string[] = [], monitors: string[] = [], files: string[] = [];
    const revoked: string[] = [];
    let elevated = 0, requireSudoPassword = false;
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (cmd: string, args: Record<string, any> = {}) => {
        switch (cmd) {
          case "hosts_list": return [host];
          case "host_groups_list": return ["Fixture", "Empty"];
          case "settings_get": return {};
          case "workspace_get": return {};
          case "workspace_save": localStorage.setItem("fixture-workspace", JSON.stringify(args.workspace)); return args.workspace;
          case "monitor_window_is_open": return false;
          case "ssh_probe": return { trusted: true, changed: false, algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" };
          case "host_secret_status": return true;
          case "ssh_connect":
            if (fail) throw Error("Fixture connection refused");
            return { sessionId: "fixture-session-" + ++count, credentialSaveFailed: false };
          case "session_close": closed.push(args.sessionId); return null;
          case "plugin:dialog|message": return "确认";
          case "sftp_sudo_enable":
            if (requireSudoPassword && !args.password) throw { code: "SUDO_SFTP_DENIED", message: "Passwordless sudo SFTP was not authorized" };
            if (requireSudoPassword && args.password !== "fixture-password") throw { code: "SUDO_SFTP_AUTH_FAILED", message: "Fixture wrong password" };
            return "sudo-context-" + args.sessionId + "-" + ++elevated;
          case "sftp_sudo_disable":
            revoked.push(args.contextId); return null;
          case "sftp_realpath": return args.path === "." ? "/app" : args.path;
          case "sftp_list":
            files.push(args.sessionId);
            return [{ name: args.sessionId, path: "/app/" + args.sessionId, isDir: false, isSymlink: false, size: 1, modified: 100, permissions: 420 }];
          case "monitor_snapshot":
            monitors.push(args.sessionId);
            return { hostname: args.sessionId, os: "Linux", kernel: "6.1", cpuCores: 4, uptime: 120,
              load: [0.1, 0.2, 0.3], cpuPercent: 12, memoryTotal: 8192, memoryUsed: 2048,
              swapTotal: 0, swapUsed: 0, diskTotal: 16384, diskUsed: 8192,
              networkRx: 100, networkTx: 200, networkInterfaces: [], diskMounts: [], processes: [] };
          case "plugin:event|listen": return ++callback;
          case "transfers_list": case "tunnels_list": case "snippets_list": return [];
          default: return null;
        }
      },
    }});
    Object.defineProperty(window, "__managerFixture", { value: { count: () => count, closed: () => closed,
      fail: () => { fail = true; }, monitors: () => monitors, files: () => files, revoked: () => revoked,
      requirePassword: () => { requireSudoPassword = true; } } });
  });
  await page.setViewportSize({ width: 1600, height: 960 });
  await page.goto("/");
  const open = () => page.getByRole("button", { name: "连接管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "连接管理", exact: true });
  const terminal = page.locator(".terminal-area");
  const original = await terminal.boundingBox();
  await open();
  await expect(dialog).toBeVisible();
  expect(await terminal.boundingBox()).toEqual(original);
  await expect(dialog.getByRole("columnheader", { name: "连接状态", exact: true })).toHaveCount(0);
  await expect(dialog.locator(".host-item .status-dot")).toHaveCount(0);
  await expect(dialog.locator(".host-item")).toHaveCount(1);
  const table = dialog.locator(".host-manager-table");
  // Hide two optional columns and check that the remaining columns occupy the entire viewport.
  await dialog.getByRole("button", { name: "显示列" }).click();
  await dialog.locator(".manager-column-option").filter({ hasText: "认证方式" }).locator("input").uncheck();
  await dialog.locator(".manager-column-option").filter({ hasText: "最后连接时间" }).locator("input").uncheck();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(() => table.evaluate(el => Math.abs(el.getBoundingClientRect().width - el.parentElement!.clientWidth))).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("connection-manager-v2.png") });
  const row = dialog.locator(".manager-host-name");
  await row.dblclick();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".session-tab.selected")).toContainText("Session fixture");
  await expect(page.locator(".file-list tbody")).toContainText("fixture-session-1");
  const sudo = page.locator(".sudo-mode-button");
  await sudo.click();
  await expect(sudo).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".file-list tbody")).toContainText("sudo-context-fixture-session-1-1");
  await expect(page.locator(".file-panel").getByRole("button", { name: "上传", exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__managerFixture.monitors().at(-1))).toBe("fixture-session-1");
  await sudo.click();
  await expect(sudo).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".file-list tbody")).toContainText("fixture-session-1");
  await expect.poll(() => page.evaluate(() => (window as any).__managerFixture.revoked())).toContain("sudo-context-fixture-session-1-1");
  await sudo.click();
  await expect(page.locator(".file-list tbody")).toContainText("sudo-context-fixture-session-1-2");
  await open();
  await expect(dialog.locator(".host-item")).toHaveCount(1);
  await row.dblclick();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".session-tab")).toHaveCount(2);
  await expect(page.locator(".session-tab.selected")).toContainText("Session fixture (2)");
  await expect(page.locator(".file-list tbody")).toContainText("fixture-session-2");
  await expect(sudo).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => (window as any).__managerFixture.revoked())).toContain("sudo-context-fixture-session-1-2");
  await expect.poll(() => page.evaluate(() => (window as any).__managerFixture.monitors().at(-1))).toBe("fixture-session-2");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("fixture-workspace") || "{}").hostIds?.length)).toBe(2);
  await page.locator(".session-tab").first().click();
  await expect(page.locator(".file-list tbody")).toContainText("fixture-session-1");
  await expect.poll(() => page.evaluate(() => (window as any).__managerFixture.monitors().at(-1))).toBe("fixture-session-1");
  await page.locator(".session-tab").last().getByRole("button").click();
  await expect(page.locator(".session-tab")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__managerFixture.closed())).toEqual(["fixture-session-2"]);
  await expect(page.locator(".file-list tbody")).toContainText("fixture-session-1");
  // Exercise password fallback, one wrong attempt, explicit cancellation,
  // and a successful fresh authorization without changing the SSH tab.
  await page.evaluate(() => (window as any).__managerFixture.requirePassword());
  await sudo.click();
  const sudoDialog = page.getByRole("dialog", { name: "sudo 密码授权" });
  await expect(sudoDialog).toBeVisible();
  await sudoDialog.locator('input[type="password"]').fill("wrong");
  await sudoDialog.getByRole("button", { name: "授权", exact: true }).click();
  await expect(sudoDialog).toContainText("Fixture wrong password");
  await expect(sudoDialog.locator('input[type="password"]')).toHaveValue("");
  await sudoDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(sudoDialog).toHaveCount(0);
  await expect(sudo).toHaveAttribute("aria-pressed", "false");
  await sudo.click();
  await expect(sudoDialog).toBeVisible();
  await sudoDialog.locator('input[type="password"]').fill("fixture-password");
  await sudoDialog.getByRole("button", { name: "授权", exact: true }).click();
  await expect(sudoDialog).toHaveCount(0);
  await expect(sudo).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".file-list tbody")).toContainText("sudo-context-fixture-session-1-3");
  await sudo.click();
  await expect(sudo).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => (window as any).__managerFixture.fail());
  await open();
  await row.dblclick();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".toast").filter({ hasText: "Fixture connection refused" })).toBeVisible();
  await expect(page.locator(".session-tab")).toHaveCount(1);
});
