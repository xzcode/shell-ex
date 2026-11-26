import { expect, test } from "@playwright/test";

test.use({ locale: "zh-CN" });

test("shortcut cards stay compact and keep their insert and copy controls together", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const command = "tail -n 100 /var/log/" + "very-long-file-name-".repeat(20) + "app.log";
  await page.addInitScript((command) => {
    localStorage.setItem("shell-ex-preview-snippets", JSON.stringify([
      { id: "sample", name: "查看日志", command, group: "常用命令" },
    ]));
  }, command);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await page.getByRole("button", { name: "快捷命令", exact: true }).click();
  const card = page.locator(".snippet").first();
  const insert = card.getByRole("button", { name: "插入终端", exact: true });
  const copy = card.getByRole("button", { name: "复制命令", exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator(".snippet-command")).toHaveText(command);
  expect((await card.boundingBox())!.width).toBeLessThanOrEqual(340);
  expect((await insert.boundingBox())!.x - (await card.boundingBox())!.x).toBeLessThan(24);
  expect((await copy.boundingBox())!.x - (await insert.boundingBox())!.x).toBeLessThan(130);
  await expect(insert).toBeDisabled();
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await page.setViewportSize({ width: 960, height: 640 });
  expect((await card.boundingBox())!.width).toBeLessThanOrEqual(340);
  await expect(copy).toBeVisible();
});
