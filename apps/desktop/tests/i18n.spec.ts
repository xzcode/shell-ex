import { expect, test } from "@playwright/test";

test.describe("language preferences", () => {
  test.use({ locale: "en-US" });

  test("system locale, manual selection, reload, and saved host data", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator(".terminal-area > .workspace-idle img")).toBeVisible();
    await expect(page.locator(".terminal-area > .terminal-slot")).toHaveCount(0);
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.getByRole("dialog", { name: "Connection manager" }).getByRole("button", { name: "New connection", exact: true }).click();
    const connection = page.getByRole("dialog", { name: "New SSH connection" });
    await connection.getByLabel("Connection name", { exact: true }).fill("测试服务器");
    await connection.getByLabel("Host address", { exact: true }).fill("192.0.2.45");
    await connection.getByLabel("Username", { exact: true }).fill("ubuntu");
    await connection.getByLabel("Group", { exact: true }).fill("我的分组");
    await connection.getByRole("button", { name: "Save connection" }).click();
    await expect(page.locator(".host-item").filter({ hasText: "测试服务器" })).toBeVisible();

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings ⌘,", exact: true }).click();
    let settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings.getByLabel("Interface language")).toHaveValue("system");
    await settings.getByLabel("Interface language").selectOption("zh-CN");
    await settings.getByRole("button", { name: "Save settings" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.getByRole("button", { name: "连接管理", exact: true }).click();
    await expect(page.locator("[data-host-group]").filter({ hasText: "我的分组" })).toBeVisible();
    await expect(page.locator(".host-item").filter({ hasText: "测试服务器" })).toBeVisible();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.getByRole("button", { name: "设置 ⌘,", exact: true }).click();
    settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings.getByLabel("界面语言")).toHaveValue("zh-CN");
    await settings.getByLabel("界面语言").selectOption("system");
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByRole("button", { name: "Connection manager", exact: true }).click();
    await expect(page.locator(".host-item").filter({ hasText: "测试服务器" })).toBeVisible();
  });

  test("legacy system credential settings show only local storage", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("shell-ex-preview-hosts", JSON.stringify([{
        id: "bc6f7e3e-e59b-4c7f-b485-1f3782ed3240", name: "Legacy host",
        address: "192.0.2.45", port: 22, username: "ubuntu", group: "Legacy",
        authMethod: "password", credentialStore: "system", privateKeyPath: null,
        proxy: null, jumpHostId: null, startupDirectory: null,
        keepAliveSeconds: 30, connectTimeoutSeconds: 15, favorite: false,
        color: "#69a9f8", notes: ""
      }]));
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connection manager", exact: true }).click();
    await page.getByRole("button", { name: "More actions for Legacy host" }).click();
    await page.locator(".context-menu").getByRole("button", { name: "Edit connection", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit connection" });
    const storage = dialog.getByLabel("Password storage");
    await expect(storage).toHaveValue("builtin");
    await expect(storage.locator('option[value="system"]')).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save connection" }).click();
    const hosts = await page.evaluate(() => JSON.parse(localStorage.getItem("shell-ex-preview-hosts")!));
    expect(hosts[0].credentialStore).toBe("builtin");
    expect(hosts[0].id).toBe("bc6f7e3e-e59b-4c7f-b485-1f3782ed3240");
  });
});
