import { expect, test } from "@playwright/test";

test.describe("language preferences", () => {
  test.use({ locale: "en-US" });

  test("system locale, manual selection, reload, and saved host data", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByText("Start with a server.")).toBeVisible();
    await page.getByRole("button", { name: "New SSH connection", exact: true }).click();
    const connection = page.getByRole("dialog", { name: "New SSH connection" });
    await connection.getByLabel("Connection name", { exact: true }).fill("测试服务器");
    await connection.getByLabel("Host address", { exact: true }).fill("192.0.2.45");
    await connection.getByLabel("Username", { exact: true }).fill("ubuntu");
    await connection.getByLabel("Group", { exact: true }).fill("我的分组");
    await connection.getByRole("button", { name: "Save connection" }).click();
    await expect(page.locator(".host-item").filter({ hasText: "测试服务器" })).toBeVisible();

    await page.getByRole("button", { name: "Settings ⌘,", exact: true }).click();
    let settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings.getByLabel("Interface language")).toHaveValue("system");
    await settings.getByLabel("Interface language").selectOption("zh-CN");
    await settings.getByRole("button", { name: "Save settings" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByText("我的分组", { exact: true })).toBeVisible();
    await expect(page.locator(".host-item").filter({ hasText: "测试服务器" })).toBeVisible();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.getByRole("button", { name: "设置 ⌘,", exact: true }).click();
    settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings.getByLabel("界面语言")).toHaveValue("zh-CN");
    await settings.getByLabel("界面语言").selectOption("system");
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator(".host-item").filter({ hasText: "测试服务器" })).toBeVisible();
  });
});
