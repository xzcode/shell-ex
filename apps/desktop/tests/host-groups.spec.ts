import { test, expect } from "@playwright/test";

test.use({ locale: "zh-CN" });

test("custom groups can be created empty, renamed, used for new hosts, moved and safely deleted", async ({ page }) => {
  const original = {
    id: "bc6f7e3e-e59b-4c7f-b485-1f3782ed3240", name: "Test server",
    address: "192.0.2.10", port: 22, username: "test", group: "Legacy",
    authMethod: "password", credentialStore: "builtin", privateKeyPath: null,
    proxy: null, jumpHostId: null, startupDirectory: null,
    keepAliveSeconds: 30, connectTimeoutSeconds: 15, favorite: false,
    color: "#69a9f8", notes: "preserve configuration",
  };
  await page.addInitScript((host) => {
    if (localStorage.getItem("shell-ex-preview-hosts") === null)
      localStorage.setItem("shell-ex-preview-hosts", JSON.stringify([host]));
  }, original);
  await page.goto("/");
  const open = async () => page.getByRole("button", { name: "连接管理", exact: true }).click();
  await open();
  const group = (name: string) => page.locator('[data-host-group="' + name + '"]');
  async function create(name: string) {
    await page.getByRole("button", { name: "新建分组", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建分组", exact: true });
    await dialog.getByRole("textbox").fill(name);
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(group(name)).toBeVisible();
  }
  await create("Production");
  await group("Production").locator("button").first().click();
  await expect(page.locator(".host-manager-table .host-item")).toHaveCount(0);
  await page.reload();
  await open();
  await expect(group("Production")).toBeVisible();
  await group("Production").getByRole("button", { name: "Production 分组操作" }).click();
  await page.locator(".host-manager-menu").getByRole("button", { name: "在此分组新建连接" }).click();
  const hostDialog = page.getByRole("dialog", { name: "新建 SSH 连接" });
  await expect(hostDialog.getByLabel("分组", { exact: true })).toHaveValue("Production");
  await page.keyboard.press("Escape");
  await expect(hostDialog).toHaveCount(0);
  const hostRow = page.locator(".host-item").filter({ hasText: "Test server" }).first();
  await hostRow.getByRole("button", { name: "Test server 更多操作" }).click();
  await page.locator(".host-manager-menu").getByRole("button", { name: "移动到分组", exact: true }).click();
  const move = page.getByRole("dialog", { name: "移动到分组" });
  await move.getByRole("combobox").selectOption("Production");
  await move.getByRole("button", { name: "确认", exact: true }).click();
  await group("Production").locator("button").first().click();
  await expect(page.locator(".host-manager-table .host-item")).toHaveCount(1);
  await group("Legacy").locator("button").first().click();
  await expect(page.locator(".host-manager-table .host-item")).toHaveCount(0);
  await group("Production").getByRole("button", { name: "Production 分组操作" }).click();
  await page.locator(".host-manager-menu").getByRole("button", { name: "重命名分组" }).click();
  const rename = page.getByRole("dialog", { name: "重命名分组" });
  await rename.getByRole("textbox").fill("Servers");
  await rename.getByRole("button", { name: "确认", exact: true }).click();
  await expect(group("Production")).toHaveCount(0);
  await group("Servers").locator("button").first().click();
  await expect(page.locator(".host-manager-table .host-item")).toContainText("Test server");
  await group("Servers").getByRole("button", { name: "Servers 分组操作" }).click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("连接和密码不会删除");
    await dialog.accept();
  });
  await page.locator(".host-manager-menu").getByRole("button", { name: "删除分组", exact: true }).click();
  await expect(group("Servers")).toHaveCount(0);
  await group("默认分组").locator("button").first().click();
  await expect(page.locator(".host-manager-table .host-item")).toContainText("Test server");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("shell-ex-preview-hosts")!)))
    .toEqual([{ ...original, group: "默认分组" }]);
  await page.reload();
  await open();
  await expect(group("Legacy")).toBeVisible();
  await group("默认分组").locator("button").first().click();
  await expect(page.locator(".host-manager-table .host-item")).toHaveCount(1);
});
