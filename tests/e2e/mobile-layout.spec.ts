import { test, expect } from "./fixtures.ts";
test("composition enter does not send", async ({ connectedPage: page }) => {
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("继续");
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(input).toHaveValue("继续");
  await expect(page.getByTestId("sent-message")).toHaveCount(0);
});
test("360px conversation has no page overflow and drawer returns", async ({
  connectedPage: page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole("button", { name: "会话列表", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "会话" })).toBeVisible();
  await page.getByRole("button", { name: "准备工作", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("navigation", { name: "会话" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("long tool result scrolls locally at 360px and detail back restores input", async ({
  connectedPage: page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page
    .getByRole("button", { name: "查看详情", exact: true })
    .first()
    .click();
  const pre = page.getByRole("complementary", { name: "详情" }).locator("pre");
  await expect(pre).toContainText("long-tool-line-");
  expect(
    await pre.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `${process.env.WEB_CONTROL_EVIDENCE_DIR ?? 'data/task12'}/${testInfo.project.name}-mobile-360.png`,
  });
});
test("Shift Enter, viewport keyboard resize and orientation keep composer in view", async ({
  connectedPage: page,
}) => {
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("第一行");
  await input.press("Shift+Enter");
  await input.type("第二行");
  await expect(input).toHaveValue("第一行\n第二行");
  for (const viewport of [
    { width: 360, height: 740 },
    { width: 360, height: 410 },
    { width: 740, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await input.focus();
    await expect
      .poll(async () => {
        const box = await page
          .getByRole("button", { name: "发送", exact: true })
          .boundingBox();
        return (
          !!box &&
          box.height >= 44 &&
          box.y >= 0 &&
          box.y + box.height <= viewport.height
        );
      })
      .toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.getByTestId("sent-message")).toHaveCount(0);
});
