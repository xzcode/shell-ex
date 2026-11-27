import { test, expect } from "@playwright/test";
import { commandCategories, linuxCommands } from "../src/linuxCommands";

test("Linux reference catalog is complete and has unique command names", () => {
  expect(linuxCommands.length).toBe(85);
  expect(commandCategories.length).toBe(11);
  expect(new Set(linuxCommands.map((item) => item.name)).size).toBe(linuxCommands.length);
  for (const item of linuxCommands) {
    expect(commandCategories.some(([id]) => id === item.category)).toBeTruthy();
    expect(item.example.trim()).not.toBe("");
    for (const pair of [item.description, item.options, item.exampleNote, ...(item.warning ? [item.warning] : [])]) {
      expect(pair[0].trim()).not.toBe("");
      expect(pair[1].trim()).not.toBe("");
    }
  }
});

test("command help works offline with categories, bilingual search, stable layout and copying", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");
  await page.getByRole("button", { name: "连接管理", exact: true }).click();
  await page.getByRole("dialog", { name: "连接管理", exact: true }).getByRole("button", { name: "Linux 命令帮助", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Linux 命令帮助", exact: true });
  const query = dialog.getByRole("textbox", { name: "搜索 Linux 命令" });
  const cards = dialog.locator(".linux-command-card");
  const original = await dialog.boundingBox();
  await expect(cards).toHaveCount(85);
  await dialog.getByRole("navigation", { name: "命令分类" }).getByRole("button", { name: /网络排查/ }).click();
  await expect(cards).toHaveCount(9);
  await query.fill("ss -lntp");
  await expect(cards).toHaveCount(1);
  await expect(cards.locator("h3")).toHaveText("ss");
  await dialog.getByRole("button", { name: "复制示例 ss", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "复制示例 ss", exact: true })).toHaveText("已复制");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("ss -lntp");
  expect(await dialog.boundingBox()).toEqual(original);
  await query.fill("找不到的示例关键词");
  await expect(dialog.getByText("没有匹配的命令", { exact: true })).toBeVisible();
  expect(await dialog.boundingBox()).toEqual(original);
  await dialog.getByRole("button", { name: "显示全部命令", exact: true }).click();
  await expect(cards).toHaveCount(85);
  await query.fill("磁盘占用");
  await expect(dialog.locator('[data-command="du"]')).toBeVisible();
  await query.fill("rm -i");
  await expect(dialog.locator('[data-command="rm"] .linux-help-warning')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Force an English interface; the command reference uses the same language preference.
  await page.evaluate(() => localStorage.setItem("shell-ex-language", "en"));
  await page.reload();
  await page.getByRole("button", { name: "Connection manager", exact: true }).click();
  await page.getByRole("dialog", { name: "Connection manager", exact: true }).getByRole("button", { name: "Linux command help", exact: true }).click();
  const english = page.getByRole("dialog", { name: "Linux command help", exact: true });
  await english.getByRole("textbox", { name: "Search Linux commands" }).fill("disk usage");
  await expect(english.locator('[data-command="du"]')).toBeVisible();
  await expect(english.locator('[data-command="du"]')).toContainText("Estimate disk usage");
  await expect(english.getByText("Copies to clipboard only; commands are never executed.", { exact: true })).toBeVisible();
});
