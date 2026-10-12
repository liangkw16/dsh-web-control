/** Synthetic populated Task21 scenes over the owned Relay/public Host fixture. Never shipped. */
import { test, expect } from './fixtures.ts';
import { assistantData, userData, toolData } from '../support/public-host-driver.ts';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
test('populated coding workspace has readable Markdown, compact events and safe links across themes and widths', async ({ connectedPage: page, driver }, testInfo) => {
  const directory = process.env.WEB_CONTROL_EVIDENCE_DIR!;
  const evidence: unknown[] = [];
  const remoteImages: string[] = [];
  page.on('request', request => { if (request.url().includes('transcript-image.invalid')) remoteImages.push(request.url()) });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('.timeline').evaluate(node => { node.scrollTop = node.scrollHeight });
  await page.screenshot({ path: resolve(directory, `${testInfo.project.name}-approval-light-1280.png`) });
  driver.cancelInteraction('approval-a'); driver.cancelInteraction('question-a');
  driver.append('a', 'user/message', userData('梳理会话恢复流程，检查重连后是否会重复发送消息。给我一个简洁的改动方案。') as any);
  driver.append('a', 'assistant/message', assistantData('## 会话恢复流程\n\n已经检查了 `SessionStore` 和提交队列。重连时读取本机状态，未确认的请求保留独立的结果查询入口。\n\n- **保持请求标识**，查询结果时复用已有 ID。\n- 恢复草稿和历史滚动位置。\n\n```ts\nconst outcome = await queue.reconcile(requestId);\nif (outcome.accepted) {\n  drafts.clear(instanceId, sessionId);\n}\n```') as any);
  driver.append('a', 'tool/result', { ...toolData('70 tests passed · packages/web/tests · 275 ms'), name: '运行检查' } as any);
  driver.append('a', 'assistant/message', assistantData('验证完成。结果查询不会再次发送消息，可以继续检查文件变更。') as any);
  const prompt = page.locator('.message.user').filter({ hasText: '梳理会话恢复流程' });
  await expect(prompt).toBeVisible();
  await expect(page.locator('.markdown h2')).toHaveText('会话恢复流程');
  await expect(page.locator('.event-summary').last()).toContainText('70 tests passed');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('继续检查相关文件的变更');
  for (const theme of ['light', 'dark'] as const) for (const width of [1280, 390, 360]) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await prompt.evaluate(node => { const timeline = node.closest('.timeline')!; timeline.scrollTop = (node as HTMLElement).offsetTop - (timeline as HTMLElement).offsetTop - 12 });
    await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--viewport-height')) === visualViewport!.height)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const send = page.getByRole('button', { name: '发送', exact: true }); const input = page.getByRole('textbox', { name: '消息', exact: true });
    if (width < 768) {
      expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44); expect(await input.evaluate(node => getComputedStyle(node).fontSize)).toBe('16px');
      for (const selector of ['.event-detail', '.changes-action', '.record-detail', '.composer-controls button', '.attachment-bar .button']) for (const control of await page.locator(selector).all()) { const r = await control.boundingBox(); expect(r!.height).toBeGreaterThanOrEqual(44); expect(r!.width).toBeGreaterThanOrEqual(44) }
    }
    for (const selector of ['.composer textarea', '.composer button.primary']) for (const state of ['normal', 'hover', 'focus']) {
      const control = page.locator(selector); await page.mouse.move(1, 1); await control.evaluate(node => (node as HTMLElement).blur());
      if (state === 'hover') await control.hover(); if (state === 'focus') { await page.keyboard.press('Tab'); await control.focus(); expect(await control.evaluate(node => node.matches(':focus-visible'))).toBe(true) }
      await control.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))) });
      const contrast = await control.evaluate(node => {
        const style = getComputedStyle(node); const lum = (color: string) => { const c = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722 }; const fg = lum(style.color), bg = lum(style.backgroundColor); return { color: style.color, background: style.backgroundColor, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) };
      });
      expect(contrast.ratio).toBeGreaterThanOrEqual(4.5); evidence.push({ theme, width, selector, state, ...contrast });
    }
    await page.mouse.move(1, 1); await input.evaluate(node => (node as HTMLElement).blur()); await send.evaluate(node => (node as HTMLElement).blur());
    await page.screenshot({ path: resolve(directory, `${testInfo.project.name}-workspace-${theme}-${width}.png`), animations: 'disabled' });
    if (width === 390) { await page.getByRole('button', { name: '会话列表', exact: true }).click(); await page.screenshot({ path: resolve(directory, `${testInfo.project.name}-sidebar-${theme}-390.png`) }); await page.getByRole('button', { name: '关闭会话列表' }).click() }
  }
  // Explicit full diagnostics remain available, including long unbroken tool output.
  await page.setViewportSize({ width: 360, height: 740 });
  await page.locator('.tool .event-detail').first().click();
  const pre = page.getByRole('complementary', { name: '详情' }).locator('pre');
  await expect(pre).toContainText('long-tool-line-'); expect(await pre.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(directory, `${testInfo.project.name}-details-dark-360.png`) });
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.setViewportSize({ width: 360, height: 410 }); await page.getByRole('textbox', { name: '消息', exact: true }).focus();
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--viewport-height')))).toBe(410);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const geometry = await page.evaluate(() => {
    const selectors = ['.conversation-header', '.composer textarea', '.composer button.primary'];
    return { viewport: { height: visualViewport!.height, top: visualViewport!.offsetTop }, appCount: document.querySelectorAll('.app').length, controls: selectors.map(selector => { const node = document.querySelector(selector)!; const r = node.getBoundingClientRect(); return { selector, x: r.x, y: r.y, width: r.width, height: r.height, unoccluded: node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) } }) };
  });
  expect(geometry.appCount).toBe(1); for (const control of geometry.controls) { expect(control.y).toBeGreaterThanOrEqual(0); expect(control.y + control.height).toBeLessThanOrEqual(410); expect(control.unoccluded).toBe(true) }
  evidence.push({ shortViewport: geometry });
  await page.screenshot({ path: resolve(directory, `${testInfo.project.name}-keyboard-dark-360x410.png`) });
  driver.append('a', 'assistant/message', assistantData('![Diagram](https://transcript-image.invalid/private.png)\n\n[unsafe](javascript:alert%281%29) <img src="https://transcript-image.invalid/raw.png">') as any);
  await expect(page.getByRole('link', { name: 'Diagram' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(remoteImages).toEqual([]); await expect(page.locator('.markdown img,.markdown script')).toHaveCount(0);
  await writeFile(resolve(directory, `${testInfo.project.name}-design-metrics.json`), JSON.stringify({ synthetic: true, viewportDimensions: [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 844 }, { width: 360, height: 410 }], contrast: evidence, imageRequests: remoteImages }, null, 2));
});

test('local session search and workspace collapse preserve selection and server scope', async ({ connectedPage: page, driver }) => {
  const search = page.getByRole('searchbox', { name: '搜索会话' });
  await search.fill('准备'); await expect(page.getByRole('button', { name: '准备工作', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '核心流程', exact: true })).toHaveCount(0);
  await search.fill('没有这样的会话'); await expect(page.getByText('无匹配会话')).toBeVisible();
  await search.fill(''); const workspace = page.getByRole('button', { name: '测试工作区', exact: true }); await workspace.click(); await expect(workspace).toHaveAttribute('aria-expanded', 'false'); await expect(page.getByRole('button', { name: '核心流程', exact: true })).toHaveCount(0);
  await workspace.click(); await expect(page.getByRole('button', { name: '核心流程', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(driver.commands).toEqual([]);
});

test('pending approval remains conspicuous and reachable in the coding workspace', async ({ connectedPage: page }, testInfo) => {
  const approval = page.getByRole('region', { name: '审批请求' });
  for (const theme of ['light', 'dark'] as const) for (const width of [1280, 390]) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--viewport-height')))).toBe(width === 1280 ? 900 : 844);
    await approval.evaluate(node => { const timeline = node.closest('.timeline')!; timeline.scrollTop = (node as HTMLElement).offsetTop - (timeline as HTMLElement).offsetTop - 12 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(approval.getByRole('button', { name: '允许一次', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width < 768) for (const button of await approval.getByRole('button').all()) { const r = await button.boundingBox(); expect(r!.height).toBeGreaterThanOrEqual(44); expect(r!.width).toBeGreaterThanOrEqual(44) }
    await page.screenshot({ path: resolve(process.env.WEB_CONTROL_EVIDENCE_DIR!, `${testInfo.project.name}-pending-approval-${theme}-${width}.png`) });
  }
});
