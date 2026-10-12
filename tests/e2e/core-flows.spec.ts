import { test, expect, instanceId } from "./fixtures.ts";
import { resolve } from "node:path";
test("switch, draft, prompt, stop and create use real Host commands", async ({
  connectedPage: page,
  driver,
}) => {
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("保留草稿");
  await page.getByRole("button", { name: "准备工作", exact: true }).click();
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "核心流程", exact: true }).click();
  await expect(input).toHaveValue("保留草稿");
  await input.press("Enter");
  await expect(
    page.getByText("消息已由本机接受", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  expect(
    driver.commands.filter((m) => m.command.op === "session.prompt"),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByText("停止请求已提交")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "＋ 新建会话", exact: true }).click();
  await expect(page).toHaveURL(/session=[a-f0-9-]{36}/);
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
    "已连接",
  );
  expect(driver.commands.some((m) => m.command.op === "session.create")).toBe(
    true,
  );
});
test("approval and choice/multiple/text question settle globally via accepted answer", async ({
  connectedPage: page,
  driver,
}) => {
  await page.getByRole("button", { name: "允许一次", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "允许一次", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("中性", { exact: true }).check();
  await page.getByLabel("界面", { exact: true }).check();
  await page.getByLabel("文档", { exact: true }).check();
  await page
    .getByRole("textbox", { name: "补充说明文字", exact: true })
    .fill("请保持清晰");
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "提交回答", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "准备工作", exact: true }).click();
  await page.getByRole("button", { name: "核心流程", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "允许一次", exact: true }),
  ).toHaveCount(0);
  expect(
    driver.commands.filter((m) => m.command.op === "interaction.answer"),
  ).toHaveLength(2);
});
test("Host cancellation leaves a read-only handled card", async ({
  connectedPage: page,
  driver,
}) => {
  await expect(
    page.getByRole("button", { name: "允许一次", exact: true }),
  ).toBeVisible();
  driver.cancelInteraction("approval-a");
  await expect(
    page.getByRole("button", { name: "允许一次", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("已处理 · shell")).toBeVisible();
  expect(
    driver.commands.some((m) => m.command.op === "interaction.answer"),
  ).toBe(false);
});
test("fresh page with copied storage takes over, preserves draft, stays retired until explicit retake", async ({
  connectedPage: page, context, relayOrigin, driver, browserNetwork,
}, testInfo) => {
  if (testInfo.project.name === 'webkit') await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = []; const csp: string[] = []; let oldSockets = 0;
  const inspect = (p: typeof page) => { p.on('pageerror', error => errors.push(error.message)); p.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) csp.push(message.text()); }); };
  inspect(page); page.on('websocket', () => oldSockets++);
  const input = page.getByRole("textbox", { name: "消息", exact: true }); await input.fill("接管后保留草稿");
  const storage = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  const second = await context.newPage(); inspect(second);
  if (testInfo.project.name === 'webkit') await second.setViewportSize({ width: 390, height: 844 });
  await second.addInitScript(storage => { for (const [key, value] of Object.entries(storage)) sessionStorage.setItem(key, value); }, storage);
  await second.goto(`${relayOrigin}/connect/${instanceId}?session=a`);
  await expect(second.getByRole("status", { name: "连接状态" })).toHaveText("已连接");
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText("已在其他页面接管，草稿保留在此设备重新接管");
  await expect(input).toHaveValue("接管后保留草稿");
  await expect(page.getByText("工作区已准备好。")).toBeVisible();
  for (const name of ["发送", "停止"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(page.getByLabel("添加附件")).toBeDisabled();
  await expect(page.getByRole("button", { name: "允许一次", exact: true })).toHaveCount(0);
  // WebKit's screenshot synchronizer inserts inline body{} and conflicts with
  // strict style-src. Save Chromium here; keep behavioral CSP checks strict.
  if (testInfo.project.name !== 'webkit') await page.screenshot({ path: resolve(process.env.WEB_CONTROL_EVIDENCE_DIR ?? 'data/task12', `${testInfo.project.name}-replaced.png`) });
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(1600); expect(oldSockets).toBe(0);
  await page.getByRole("button", { name: "重新接管", exact: true }).click();
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText("已连接");
  await expect(second.getByRole("status", { name: "连接状态" })).toContainText("已在其他页面接管");
  await expect(input).toHaveValue("接管后保留草稿"); expect(oldSockets).toBe(1);
  await browserNetwork.disconnect(); await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled(); browserNetwork.resume();
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText("已连接", { timeout: 15000 });
  await expect(second.getByRole("status", { name: "连接状态" })).toContainText("已在其他页面接管");
  expect(driver.commands.filter(m => ['session.prompt', 'session.stop', 'interaction.answer', 'upload.open'].includes(m.command.op))).toHaveLength(0);
  expect(errors).toEqual([]); expect(csp).toEqual([]); await second.close();
});
test("refresh preserves selection and independent authorization cookie", async ({
  connectedPage: page,
}) => {
  await page.getByRole("button", { name: "准备工作", exact: true }).click();
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("刷新后保留");
  await page.reload();
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
    "已连接",
  );
  await expect(page).toHaveURL(/session=b/);
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("刷新后保留");
  expect(new URL(page.url()).hash).toBe("");
});
test("offline retains history and draft and cannot claim send success", async ({
  connectedPage: page,
  driver,
}) => {
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("离线草稿");
  await driver.close();
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
    "连接已断开，草稿保留在此设备重试连接",
  );
  await expect(input).toHaveValue("离线草稿");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("工作区已准备好。")).toBeVisible();
  expect(
    driver.commands.filter((m) => m.command.op === "session.prompt"),
  ).toHaveLength(0);
});
test("upload durable receipt becomes prompt content and recorded diff opens", async ({
  connectedPage: page,
  driver,
}) => {
  await page.getByLabel("添加附件").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(
    page.getByText("notes.txt · 已上传", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("消息已由本机接受", { exact: true }),
  ).toBeVisible();
  const command = driver.commands.find(
    (m) => m.command.op === "session.prompt",
  )!.command;
  if (command.op !== "session.prompt") throw new Error("missing prompt");
  expect(command.content[0]).toMatchObject({
    kind: "upload",
    name: "notes.txt",
  });
  await page
    .getByRole("button", { name: "查看记录的变更", exact: true })
    .click();
  await page.getByRole("button", { name: "example.txt", exact: true }).click();
  await expect(page.getByLabel("文件差异")).toContainText("@@ -1 +1 @@");
});
test("deferred current file preview is not advertised and record detail navigation returns", async ({
  connectedPage: page,
}, testInfo) => {
  // Current-file preview was already deferred in the Task18 baseline; no unsupported action is advertised.
  await expect(page.getByRole("button", { name: "文件预览", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "查看详情", exact: true }).first().click();
  await expect(page.getByRole("complementary", { name: "详情" })).toContainText("long-tool-line-");
  await page.goBack();
  await expect(page.getByRole("complementary", { name: "详情" })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: resolve(process.env.WEB_CONTROL_EVIDENCE_DIR ?? 'data/task12', `${testInfo.project.name}-desktop.png`),
  });
});
test("older page keeps visible anchor and new content waits while reading", async ({
  connectedPage: page,
  driver,
}) => {
  for (let i = 0; i < 15; i++)
    driver.append("a", "assistant/message", {
      content: [
        { type: "text", text: "新增记录 " + i + "\n" + "line\n".repeat(6) },
      ],
    });
  const timeline = page.getByLabel("会话消息", { exact: true });
  await expect(page.getByText("新增记录 14", { exact: false })).toBeVisible();
  await timeline.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.getByRole("button", { name: "加载较早消息" }).click();
  await expect(page.getByText("检查工作区状态")).toBeVisible();
  await timeline.evaluate((node) => {
    node.scrollTop = 20;
  });
  const before = await timeline.evaluate((node) => node.scrollTop);
  driver.append("a", "assistant/message", {
    content: [{ type: "text", text: "新到达的消息" }],
  });
  await expect(page.getByRole("button", { name: "有新内容 ↓" })).toBeVisible();
  expect(await timeline.evaluate((node) => node.scrollTop)).toBeCloseTo(
    before,
    0,
  );
  await page.getByRole("button", { name: "有新内容 ↓" }).click();
  await expect(page.getByRole("button", { name: "有新内容 ↓" })).toHaveCount(0);
});
test("uncertain submit only checks the outcome with the same request ID", async ({
  connectedPage: page,
  driver,
}) => {
  driver.uncertainNextPrompt = true;
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("结果不确定");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "检查提交结果", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "检查提交结果", exact: true }).click();
  await expect(page.getByText("本机已确认接受该消息")).toBeVisible();
  const commands = driver.commands
    .map((m) => m.command)
    .filter((c) => c.op === "session.prompt");
  expect(commands).toHaveLength(2);
  expect(commands[0]).not.toHaveProperty("reconcileOnly");
  expect(commands[1]).toMatchObject({
    requestId: commands[0].requestId,
    reconcileOnly: true,
  });
  expect(
    driver.sessions
      .get("a")!
      .filter((record: any) => record.event.type === "user/message"),
  ).toHaveLength(2);
});
test("accepted captured draft does not erase typing while awaiting reply", async ({
  connectedPage: page,
  driver,
}) => {
  const response = Promise.withResolvers<void>();
  driver.promptWait = response.promise;
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("第一条");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect
    .poll(() => driver.commands.some((m) => m.command.op === "session.prompt"))
    .toBe(true);
  await input.fill("新草稿");
  response.resolve();
  await expect(page.getByText("消息已由本机接受")).toBeVisible();
  await expect(input).toHaveValue("新草稿");
});
test("answer uncertainty is read-only and never automatically replayed; stale stop is explained", async ({
  connectedPage: page,
  driver,
}) => {
  driver.uncertainNextAnswer = true;
  await page.getByRole("button", { name: "允许一次", exact: true }).click();
  await expect(
    page.getByText("回答结果未确认，请在本机查看；不会自动重试。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "允许一次", exact: true }),
  ).toBeDisabled();
  expect(
    driver.commands.filter((m) => m.command.op === "interaction.answer"),
  ).toHaveLength(1);
  driver.staleNextStop = true;
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(
    page.getByText("运行目标已变化，请确认当前状态后再停止"),
  ).toBeVisible();
});
test("background tab return and session sync stay disabled until follow baseline arrives", async ({
  connectedPage: page,
  driver,
  context,
}) => {
  const background = await context.newPage();
  await background.goto("about:blank");
  await background.bringToFront();
  driver.holdSessionBaselines = true;
  await page.getByRole("button", { name: "准备工作", exact: true }).click();
  await page.bringToFront();
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("等待同步");
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
    "正在同步，请稍候",
  );
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await driver.releaseBaselines();
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
    "已连接",
  );
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await background.close();
});
test("attachment progress, failure reselect and uncertain acceptance retain correct ownership", async ({
  connectedPage: page,
  driver,
}) => {
  const wait = Promise.withResolvers<void>();
  driver.uploadWait = wait.promise;
  driver.failNextUpload = true;
  const file = {
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  };
  await page.getByLabel("添加附件").setInputFiles(file);
  await expect(
    page.getByRole("progressbar", { name: "上传 retry.txt" }),
  ).toBeVisible();
  wait.resolve();
  await expect(
    page.getByText("retry.txt · 上传失败，请重新选择文件"),
  ).toBeVisible();
  await page.getByRole("button", { name: "移除 retry.txt" }).click();
  driver.uploadWait = undefined;
  await page.getByLabel("添加附件").setInputFiles(file);
  await expect(page.getByText("retry.txt · 已上传")).toBeVisible();
  driver.uncertainNextPrompt = true;
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "检查提交结果", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "准备工作", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "检查提交结果", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "核心流程", exact: true }).click();
  await page.getByRole("button", { name: "检查提交结果", exact: true }).click();
  await expect(page.getByText("本机已确认接受该消息")).toBeVisible();
  await expect(page.getByText("retry.txt · 已上传")).toHaveCount(0);
});
test("public assistant live chunks are replaced by one durable message", async ({
  connectedPage: page,
  driver,
}) => {
  driver.live("a", "正在输出的内容");
  await expect(page.locator(".message.live")).toContainText("正在输出的内容");
  driver.commitLive("a", "已完成的内容");
  await expect(page.locator(".message.live")).toHaveCount(0);
  await expect(page.getByText("已完成的内容", { exact: true })).toHaveCount(1);
});
test("outcome check settles original attachments even after switching session", async ({
  connectedPage: page,
  driver,
}) => {
  const chooseFile = async (name: string) => {
    await page.getByLabel("添加附件").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await expect(page.getByText(name + " · 已上传")).toBeVisible();
  };
  const select = async (name: string) => {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
      "已连接",
    );
  };
  await chooseFile("owned.txt");
  driver.uncertainNextPrompt = true;
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "检查提交结果", exact: true }),
  ).toBeVisible();
  const wait = Promise.withResolvers<void>();
  driver.reconcileWait = wait.promise;
  await page.getByRole("button", { name: "检查提交结果", exact: true }).click();
  await expect
    .poll(() =>
      driver.commands.some(
        (m) => m.command.op === "session.prompt" && m.command.reconcileOnly,
      ),
    )
    .toBe(true);
  await select("准备工作");
  await chooseFile("other.txt");
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("其他会话草稿");
  await select("核心流程");
  await chooseFile("later.txt");
  await page
    .getByRole("textbox", { name: "消息", exact: true })
    .fill("原会话的新草稿");
  await select("准备工作");
  wait.resolve();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("other.txt · 已上传")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("其他会话草稿");
  await select("核心流程");
  await expect(page.getByText("owned.txt · 已上传")).toHaveCount(0);
  await expect(page.getByText("later.txt · 已上传")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue("原会话的新草稿");
  await expect(
    page.getByRole("button", { name: "检查提交结果", exact: true }),
  ).toHaveCount(0);
});

// Review round 1: deferred UI work must retain its original authority and owner.
test("deferred file details discard session and navigation completions", async ({
  connectedPage: page,
  driver,
}) => {
  const details = page.getByRole("complementary", { name: "详情" });
  const select = async (name: string) => {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
      "已连接",
    );
  };
  const changes = Promise.withResolvers<void>();
  driver.changesWait = changes.promise;
  await page
    .getByRole("button", { name: "查看记录的变更", exact: true })
    .click();
  await expect
    .poll(
      () =>
        driver.commands.filter((m) => m.command.op === "file.changes").length,
    )
    .toBe(1);
  await select("准备工作");
  changes.resolve();
  // Await a later request on the same relay stream, then let React commit.
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(
    page.getByText("已查询会话列表；以本机工作区列表为准"),
  ).toBeVisible();
  await expect(details).toHaveCount(0);
  await expect(page).toHaveURL(/session=b/);
  await select("核心流程");
  const closedChanges = Promise.withResolvers<void>();
  driver.changesWait = closedChanges.promise;
  await page
    .getByRole("button", { name: "查看记录的变更", exact: true })
    .click();
  await expect
    .poll(
      () =>
        driver.commands.filter((m) => m.command.op === "file.changes").length,
    )
    .toBe(2);
  await page.getByRole("button", { name: "查看详情", exact: true }).first().click();
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(details).toHaveCount(0);
  closedChanges.resolve();
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(
    page.getByText("已查询会话列表；以本机工作区列表为准"),
  ).toBeVisible();
  await expect(details).toHaveCount(0);
  driver.changesWait = undefined;
  await page
    .getByRole("button", { name: "查看记录的变更", exact: true })
    .click();
  await expect(details).toContainText("记录的文件变更");
  const diff = Promise.withResolvers<void>();
  driver.diffWait = diff.promise;
  await page.getByRole("button", { name: "example.txt", exact: true }).click();
  await expect
    .poll(
      () => driver.commands.filter((m) => m.command.op === "file.diff").length,
    )
    .toBe(1);
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(details).toHaveCount(0);
  diff.resolve();
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(
    page.getByText("已查询会话列表；以本机工作区列表为准"),
  ).toBeVisible();
  await expect(details).toHaveCount(0);
  driver.diffWait = undefined;
  await page
    .getByRole("button", { name: "查看记录的变更", exact: true })
    .click();
  await page.getByRole("button", { name: "example.txt", exact: true }).click();
  await expect(page.getByLabel("文件差异")).toBeVisible();
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(details).toContainText("记录的文件变更");
  const switchedDiff = Promise.withResolvers<void>();
  driver.diffWait = switchedDiff.promise;
  await page.getByRole("button", { name: "example.txt", exact: true }).click();
  await expect
    .poll(
      () => driver.commands.filter((m) => m.command.op === "file.diff").length,
    )
    .toBe(3);
  await select("准备工作");
  switchedDiff.resolve();
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(
    page.getByText("已查询会话列表；以本机工作区列表为准"),
  ).toBeVisible();
  await expect(details).toHaveCount(0);
  expect(
    driver.commands
      .filter((m) => m.command.op === "file.diff")
      .map((m) => m.command),
  ).toEqual([
    expect.objectContaining({ sessionId: "a", index: 0 }),
    expect.objectContaining({ sessionId: "a", index: 0 }),
    expect.objectContaining({ sessionId: "a", index: 0 }),
  ]);
});
for (const mode of ["uncertain", "in-flight"] as const) {
  test(`answer ${mode} retains read-only authority across card remount`, async ({
    connectedPage: page,
    driver,
  }) => {
    const wait = Promise.withResolvers<void>();
    if (mode === "uncertain") driver.uncertainNextAnswer = true;
    else driver.answerWait = wait.promise;
    const allow = page.getByRole("button", { name: "允许一次", exact: true });
    await allow.click();
    await expect
      .poll(
        () =>
          driver.commands.filter((m) => m.command.op === "interaction.answer")
            .length,
      )
      .toBe(1);
    if (mode === "uncertain")
      await expect(
        page.getByText("回答结果未确认，请在本机查看；不会自动重试。"),
      ).toBeVisible();
    await page.getByRole("button", { name: "准备工作", exact: true }).click();
    await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
      "已连接",
    );
    driver.holdSessionBaselines = true;
    await page.getByRole("button", { name: "核心流程", exact: true }).click();
    await expect(page.getByText("同步完成前暂不可回答").first()).toBeVisible();
    await driver.releaseBaselines();
    await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
      "已连接",
    );
    await expect(allow).toBeDisabled();
    if (mode === "uncertain")
      await expect(
        page.getByText("回答结果未确认，请在本机查看；不会自动重试。"),
      ).toBeVisible();
    else {
      await expect(
        page.getByRole("region", { name: "审批请求" }).getByRole("status"),
      ).toHaveText("正在提交…");
      wait.resolve();
      await expect(allow).toHaveCount(0);
    }
    expect(
      driver.commands.filter((m) => m.command.op === "interaction.answer"),
    ).toHaveLength(1);
  });
}
test("multiple unresolved prompts retain independent checks and attachment ownership", async ({
  connectedPage: page,
  driver,
}) => {
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  const checks = page.getByRole("button", {
    name: "检查提交结果",
    exact: true,
  });
  const send = async (name: string, text: string) => {
    await page.getByLabel("添加附件").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(text),
    });
    await expect(page.getByText(name + " · 已上传")).toBeVisible();
    await input.fill(text);
    driver.uncertainNextPrompt = true;
    await page.getByRole("button", { name: "发送", exact: true }).click();
  };
  await send("first.txt", "第一条未确认");
  await expect(checks).toHaveCount(1);
  driver.uncertainNextReconcile = true;
  await checks.first().click();
  await expect(
    page.getByText("提交结果仍未确认，请查看本机。不会重新发送消息。"),
  ).toBeVisible();
  await expect(checks).toHaveCount(1);
  // R21/R45: explicitly chosen fresh input stays possible after an unproven query.
  await send("second.txt", "第二条未确认");
  await expect(checks).toHaveCount(2);
  const prompts = driver.commands
    .map((m) => m.command)
    .filter((c) => c.op === "session.prompt")
    .filter((c) => !c.reconcileOnly);
  expect(prompts).toHaveLength(2);
  expect(prompts[0].requestId).not.toBe(prompts[1].requestId);
  expect(
    prompts[1].content.filter((p) => p.kind === "upload").map((p) => p.name),
  ).toEqual(["second.txt"]);
  await input.fill("后来编辑的第三条草稿");
  await page.getByRole("button", { name: "准备工作", exact: true }).click();
  await expect(checks).toHaveCount(0);
  await page.getByRole("button", { name: "核心流程", exact: true }).click();
  await expect(checks).toHaveCount(2);
  await page
    .locator(`[data-request-id="${prompts[1].requestId}"]`)
    .getByRole("button", { name: "检查提交结果" })
    .click();
  await expect(checks).toHaveCount(1);
  await expect(page.getByText("second.txt · 已上传")).toHaveCount(0);
  await expect(page.getByText("first.txt · 已上传")).toBeVisible();
  await expect(input).toHaveValue("后来编辑的第三条草稿");
  await page
    .locator(`[data-request-id="${prompts[0].requestId}"]`)
    .getByRole("button", { name: "检查提交结果" })
    .click();
  await expect(checks).toHaveCount(0);
  await expect(page.getByText("first.txt · 已上传")).toHaveCount(0);
  await expect(input).toHaveValue("后来编辑的第三条草稿");
  const checked = driver.commands
    .map((m) => m.command)
    .filter((c) => c.op === "session.prompt")
    .filter((c) => c.reconcileOnly);
  expect(checked.map((c) => c.requestId)).toEqual([
    prompts[0].requestId,
    prompts[1].requestId,
    prompts[0].requestId,
  ]);
});
test("unresolved prompt capacity refuses fresh sends without evicting checks", async ({
  connectedPage: page,
  driver,
}, testInfo) => {
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  const checks = page.getByRole("button", {
    name: "检查提交结果",
    exact: true,
  });
  for (let i = 0; i < 8; i++) {
    driver.uncertainNextPrompt = true;
    await input.fill("未确认尝试 " + i);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(checks).toHaveCount(i + 1);
  }
  await page.getByRole("button", { name: "准备工作", exact: true }).click();
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
    "已连接",
  );
  await expect(checks).toHaveCount(0);
  await input.fill("其他会话新草稿");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "核心流程", exact: true }).click();
  await expect(page.getByRole("status", { name: "连接状态" })).toHaveText(
    "已连接",
  );
  await expect(checks).toHaveCount(8);
  await input.fill("不能丢弃旧入口的新草稿");
  await page.setViewportSize({ width: 360, height: 410 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "--viewport-height",
        ),
      ),
    )
    .toBe("410px");
  const sendButton = page.getByRole("button", { name: "发送", exact: true });
  const inputRect = await input.boundingBox();
  const sendRect = await sendButton.boundingBox();
  expect(inputRect!.y).toBeGreaterThanOrEqual(0);
  expect(inputRect!.y + inputRect!.height).toBeLessThanOrEqual(410);
  expect(sendRect!.y + sendRect!.height).toBeLessThanOrEqual(410);
  expect(sendRect!.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "未确认提交已达上限（8）。请核对已有提交；不会丢弃记录或继续发送。",
    ),
  ).toBeVisible();
  expect(
    driver.commands.filter((m) => m.command.op === "session.prompt"),
  ).toHaveLength(8);
  await page.screenshot({
    path: resolve(
      `${process.env.WEB_CONTROL_EVIDENCE_DIR ?? 'data/task12'}/fix1-${testInfo.project.name}-outcomes-360x410.png`,
    ),
  });
  // Scroll the retained check list, not the composer, to reach an earlier attempt.
  await checks.first().click();
  await expect(checks).toHaveCount(7);
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await expect(input).toHaveValue("不能丢弃旧入口的新草稿");
});

test('removed selected session retires controls and another valid selection remains usable', async ({ connectedPage: page, driver }) => {
  driver.removeSession('a')
  await expect(page.getByText('此会话已不在可访问工作区，请选择其他会话。')).toBeVisible()
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeDisabled()
  await expect(page.getByRole('status', { name: '连接状态' })).toHaveText('已连接')
  await page.getByRole('button', { name: '准备工作', exact: true }).click()
  await expect(page.getByRole('status', { name: '连接状态' })).toHaveText('已连接')
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('valid selection')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
})
test('fragmented live prose and code preserve newlines through durable replacement', async ({ connectedPage: page, driver }) => {
  driver.live('a', 'Hel'); driver.continueLive('a', 'lo\n```js\nx()\n```')
  const live = page.locator('.message.live .message-text')
  await expect(live.locator('p')).toHaveText('Hello'); await expect(live.locator('pre code')).toHaveText('x()\n')
  driver.commitLive('a', 'Hello\n```js\nx()\n```')
  await expect(page.locator('.message.live')).toHaveCount(0)
  await expect(page.locator('.message-text').filter({ hasText: 'Hello' })).toHaveCount(1)
})
