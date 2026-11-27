import { expect, test, type Page } from '@playwright/test'

// RP-E2E-01、RP-E2E-02（e2e/catalog/admin-platform.md）：运行参数——平台管理员修改运维参数、总览与超时链路；
// 只有查看权限的管理员只读。P0 冒烟数据为确定性内存数据（server/src/testing/p0-smoke/runtime-parameters-service.ts）。
const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

// 用例结束（含中途失败）后把运维参数恢复为默认值，避免影响同一冒烟服务中的其他用例（AGENTS.md：显式清理测试数据）。
test.afterEach(async ({ request }) => {
  const response = await request.get(`${adminUrl}/api/admin/v1/runtime-parameters`)
  const { data } = await response.json() as { data: { settings: Array<{ key: string; value: number; defaultValue: number; revision: number }> } }
  const changes = data.settings.filter(item => item.value !== item.defaultValue)
    .map(item => ({ key: item.key, value: item.defaultValue, revision: item.revision }))
  if (changes.length) {
    const restored = await request.put(`${adminUrl}/api/admin/v1/platform-settings`, { data: { changes } })
    expect(restored.ok()).toBe(true)
  }
})

function navigation(page: Page) {
  return page.getByRole('navigation', { name: '管理后台主导航' })
}

async function setParameter(page: Page, label: string, value: string) {
  const input = page.getByRole('textbox', { name: label, exact: true })
  await input.fill(value)
}

test('RP-E2E-01 a platform administrator changes ops parameters and sees them in the overview', async ({ page }) => {
  await page.goto(`${adminUrl}/overview`)
  await navigation(page).getByRole('button', { name: '运行参数', exact: true }).click()
  await expect(page).toHaveURL(`${adminUrl}/runtime-parameters`)
  for (const group of ['磁盘与工作区', '并发与运行', '数据保留']) {
    await expect(page.getByRole('heading', { name: group })).toBeVisible()
  }
  await expect(page.getByText('默认 10 次 · 范围 1～50')).toBeVisible()

  await setParameter(page, '每次运行最多读取网页次数', '99')
  await expect(page.getByRole('note').filter({ hasText: '请输入 1～50 之间的整数' })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await setParameter(page, '每次运行最多读取网页次数', '5')
  await setParameter(page, '站内通知保留天数', '60')
  await expect(page.getByText('有 2 项未保存的修改')).toBeVisible()

  await page.getByRole('button', { name: '保存', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认保存 2 项修改' })
  await expect(dialog.getByText('10 次 → 5 次')).toBeVisible()
  await expect(dialog.getByText('90 天 → 60 天')).toBeVisible()
  await expect(dialog.getByText(/立即从员工的列表与未读数中消失/)).toBeVisible()
  const confirm = dialog.getByRole('button', { name: '确认保存' })
  await expect(confirm).toBeDisabled()
  await dialog.getByText('我已了解上面标出的影响').click()
  await confirm.click()
  await expect(page.getByText('已保存 2 项，已写入审计记录。')).toBeVisible()

  await page.reload()
  await expect(page.getByRole('textbox', { name: '每次运行最多读取网页次数', exact: true })).toHaveValue('5')

  await page.getByRole('tab', { name: '参数总览' }).click()
  const conversation = page.getByRole('listitem', { name: '员工对话' })
  await expect(conversation.getByText('≤ 3 分钟')).toBeVisible()
  await expect(conversation.getByText(/2 个已发布 Agent 的运行超时大于 3 分钟/)).toBeVisible()
  const ops = page.getByRole('region', { name: '运维（本页修改）' })
  const webFetchRow = ops.getByRole('row', { name: /每次运行最多读取网页次数/ })
  await expect(webFetchRow.getByRole('cell', { name: '5 次' })).toBeVisible()
  await expect(webFetchRow.getByRole('cell', { name: '页面配置' })).toBeVisible()
  const fixed = page.getByRole('region', { name: '只读：系统内置与启动参数' })
  await expect(fixed.getByRole('row', { name: /执行容器资源/ }).getByRole('cell', { name: '不可修改（安全隔离）' })).toBeVisible()

  await page.getByRole('radio', { name: /^环境变量/ }).check({ force: true })
  await expect(page.getByRole('region', { name: '运维（本页修改）' })).toHaveCount(0)
  await page.getByRole('radio', { name: /^全部/ }).check({ force: true })
  await page.getByRole('textbox', { name: '搜索参数' }).fill('保留')
  await expect(ops.getByRole('row', { name: /站内通知保留天数/ })).toBeVisible()
  await expect(ops.getByRole('row', { name: /磁盘最低剩余空间/ })).toHaveCount(0)

  // 恢复默认：值回到默认、来源回到“默认值”。
  await page.getByRole('tab', { name: '运维设置' }).click()
  const restore = page.getByRole('button', { name: '恢复默认' })
  await expect(restore).toHaveCount(2)
  await restore.first().click()
  await restore.first().click()
  await expect(restore).toHaveCount(0)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const restoreDialog = page.getByRole('dialog', { name: '确认保存 2 项修改' })
  await restoreDialog.getByText('我已了解上面标出的影响').click()
  await restoreDialog.getByRole('button', { name: '确认保存' }).click()
  await expect(page.getByRole('textbox', { name: '每次运行最多读取网页次数', exact: true })).toHaveValue('10')
  await page.getByRole('tab', { name: '参数总览' }).click()
  await page.getByRole('textbox', { name: '搜索参数' }).fill('')
  await expect(page.getByRole('region', { name: '运维（本页修改）' }).getByRole('row', { name: /每次运行最多读取网页次数/ }).getByRole('cell', { name: '默认值' })).toBeVisible()
})

test('RP-E2E-02 an administrator with view access only reads the runtime parameters', async ({ page }) => {
  await page.context().addCookies([{ name: 'dsh_test_admin_identity', value: 'reader', url: adminUrl }])
  await page.goto(`${adminUrl}/runtime-parameters`)
  await expect(page.getByText('你可以查看这些参数；只有平台管理员能修改和保存。')).toBeVisible()
  await expect(page.getByRole('textbox', { name: '磁盘最低剩余空间', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()

  await page.getByRole('tab', { name: '参数总览' }).click()
  const row = page.getByRole('region', { name: '运维（本页修改）' }).getByRole('row', { name: /磁盘最低剩余空间/ })
  await expect(row.getByRole('cell', { name: '需要平台管理员' })).toBeVisible()
  await expect(row.getByRole('link')).toHaveCount(0)

  const status = await page.evaluate(async () => (await fetch('/api/admin/v1/platform-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: [{ key: 'disk.min_free_gb', value: 12, revision: 0 }] }),
  })).status)
  expect(status).toBe(403)
})
