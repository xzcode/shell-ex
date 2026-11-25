import { expect, test } from "@playwright/test";

test.use({ locale: "zh-CN" });

test("default webview context menu is suppressed; completed downloads expose local actions", async ({ page }) => {
  await page.addInitScript(() => {
    const base = { sessionId: "fixture", remotePath: "/tmp/report.xlsx", total: 8192, speed: 0, error: null };
    const tasks = [
      { ...base, id: "finished", direction: "download", localPath: "/tmp/local report.xlsx", status: "completed", transferred: 8192 },
      { ...base, id: "running", direction: "download", localPath: "/tmp/pending.xlsx", status: "running", transferred: 4096 },
      { ...base, id: "failed", direction: "download", localPath: "/tmp/failed.xlsx", status: "failed", transferred: 1024 },
      { ...base, id: "upload", direction: "upload", localPath: "/tmp/source.xlsx", status: "completed", transferred: 8192 },
    ];
    let callback = 0;
    const actions: unknown[] = [];
    Object.defineProperty(window, "isTauri", { value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === "hosts_list" || cmd === "snippets_list") return [];
        if (cmd === "settings_get" || cmd === "workspace_get") return {};
        if (cmd === "monitor_window_is_open") return false;
        if (cmd === "transfers_list") return tasks;
        if (cmd === "plugin:event|listen") return ++callback;
        if (cmd === "transfer_open_local") { actions.push(args); return null; }
        return null;
      },
    }});
    Object.defineProperty(window, "__transferActions", { value: actions });
  });
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  const blank = page.locator(".terminal-area");
  expect(await blank.evaluate((el) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  await page.getByRole("button", { name: "传输", exact: true }).click();
  const row = page.locator('[data-transfer-id="finished"]');
  await expect(row).toContainText("local report.xlsx");
  await row.getByRole("button", { name: "在文件夹中显示", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__transferActions)).toEqual([{ id: "finished", action: "reveal" }]);
  await row.locator(".transfer-name").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "传输记录菜单" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "打开已下载文件" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__transferActions)).toEqual([
    { id: "finished", action: "reveal" }, { id: "finished", action: "open" },
  ]);
  for (const id of ["running", "failed", "upload"]) {
    const item = page.locator('[data-transfer-id="' + id + '"]');
    await expect(item.getByRole("button", { name: "在文件夹中显示", exact: true })).toHaveCount(0);
    await item.locator(".transfer-name").click({ button: "right" });
    await expect(menu.getByRole("menuitem", { name: "在文件夹中显示" })).toBeDisabled();
    await expect(menu.getByRole("menuitem", { name: "打开已下载文件" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
});
