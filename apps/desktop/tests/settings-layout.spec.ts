import { test, expect } from "@playwright/test";

test.use({ locale: "zh-CN" });

for (const viewport of [{ width: 1440, height: 920 }, { width: 960, height: 640 }]) {
  test("settings geometry is stable across all sections at " + viewport.width + "x" + viewport.height, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("button", { name: "设置 ⌘,", exact: true }).click();
    const dialog = page.locator(".settings-modal");
    const nav = dialog.locator(".settings-nav");
    const content = dialog.locator(".settings-content");
    const footer = dialog.locator(":scope > .modal-footer");
    await expect(dialog).toBeVisible();
    await expect(footer.getByRole("button", { name: "保存设置", exact: true })).toBeVisible();
    const geometry = () => dialog.evaluate((root) => {
      const selectors = [
        ":scope", ":scope > .modal-header", ":scope > .modal-content",
        ".settings-nav", ".settings-content", ":scope > .modal-footer",
        ":scope > .modal-footer > .button.primary",
      ];
      return selectors.map((selector) => {
        const el = selector === ":scope" ? root : root.querySelector(selector)!;
        const r = el.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100);
      });
    });
    const initial = await geometry();
    expect(initial[0][0]).toBeGreaterThanOrEqual(27);
    expect(initial[0][1]).toBeGreaterThanOrEqual(27);
    expect(initial[0][0] + initial[0][2]).toBeLessThanOrEqual(viewport.width - 27);
    expect(initial[0][1] + initial[0][3]).toBeLessThanOrEqual(viewport.height - 27);

    if (viewport.height === 640) {
      expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await content.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      expect(await content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect(footer.getByRole("button", { name: "保存设置", exact: true })).toBeVisible();
    }
    for (const label of ["终端", "工作台", "安全与凭据", "数据与备份", "关于与更新", "外观"]) {
      const button = nav.getByRole("button", { name: label, exact: true });
      await button.click();
      await expect(button).toHaveAttribute("aria-current", "page");
      expect(await geometry()).toEqual(initial);
      expect(await content.evaluate((el) => el.scrollTop)).toBe(0);
    }
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}
