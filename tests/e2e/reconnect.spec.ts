/** Browser/UI supplement over shared public-contract fixture; production Host faults are integration tests. */
import { test, expect } from './fixtures.ts'
test('offline page keeps draft and reconnect synchronizes before new submission', async ({ connectedPage: page, browserNetwork, driver }) => {
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await input.fill('reconnect draft')
  await browserNetwork.disconnect()
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await expect(input).toHaveValue('reconnect draft')
  browserNetwork.resume()
  await expect(page.getByRole('status', { name: '连接状态' })).toHaveText('已连接', { timeout: 15000 })
  await expect(input).toHaveValue('reconnect draft'); await input.press('Enter')
  await expect(page.getByText('消息已由本机接受', { exact: true })).toBeVisible()
  expect(driver.commands.filter(value => value.command.op === 'session.prompt')).toHaveLength(1)
  expect(await page.evaluate(() => Object.values(localStorage).every(value => value === ''))).toBe(true)
})
