import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

// RP-E2E-01、02、04、05（e2e/catalog/admin-platform.md）：平台配置——平台管理员修改参数、总览与超时链路；
// 平台配置管理员不能保存安全类参数；只读管理员只能查看；Runtimes 页不再编辑容量与超时；
// 登录会话有效期、知识库与模型超时在平台配置中修改。
// P0 冒烟数据为确定性内存数据（server/src/testing/p0-smoke/platform-config-service.ts），冒烟服务按测试 Cookie 切换身份。
const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
const runtimeId = 'runtime-prototype-01'
/** 冒烟数据中该 Runtime 的初始容量与单次执行超时（分钟）。 */
const runtimeOriginal: Record<string, number> = { [`runtime.${runtimeId}.capacity`]: 4, [`runtime.${runtimeId}.timeout_minutes`]: 30 }

interface Setting { key: string; storage: string; source: string; value: number; defaultValue: number; revision: number }

async function restore(request: APIRequestContext) {
  const response = await request.get(`${adminUrl}/api/admin/v1/platform-config`)
  const { data } = await response.json() as { data: { settings: Setting[] } }
  const changes = data.settings
    .map(item => ({ item, target: item.storage === 'runtime' ? runtimeOriginal[item.key] : item.defaultValue }))
    // 沿用环境变量的项（登录会话有效期）没有被页面保存过，保持原样，不改成默认值。
    .filter(({ item, target }) => target !== undefined && item.source !== 'env' && item.value !== target)
    .map(({ item, target }) => ({ key: item.key, value: target, revision: item.revision }))
  if (changes.length) {
    const restored = await request.put(`${adminUrl}/api/admin/v1/platform-settings`, { data: { changes } })
    expect(restored.ok()).toBe(true)
  }
}

// 用例结束（含中途失败）后恢复冒烟数据，避免影响同一冒烟服务中的其他用例（AGENTS.md：显式清理测试数据）。
test.afterEach(async ({ request }) => {
  await restore(request)
})

function navigation(page: Page) {
  return page.getByRole('navigation', { name: '管理后台主导航' })
}

function field(page: Page, label: string) {
  return page.getByRole('textbox', { name: label, exact: true })
}

async function asAdmin(page: Page, identity: 'config-admin' | 'reader') {
  await page.context().addCookies([{ name: 'dsh_test_admin_identity', value: identity, url: adminUrl }])
}

async function saveStatus(page: Page, changes: Array<{ key: string; value: number }>) {
  return page.evaluate(async (items) => {
    const config = await (await fetch('/api/admin/v1/platform-config')).json() as { data: { settings: Array<{ key: string; revision: number }> } }
    const revision = new Map(config.data.settings.map(item => [item.key, item.revision]))
    return (await fetch('/api/admin/v1/platform-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: items.map(item => ({ ...item, revision: revision.get(item.key) ?? 0 })) }),
    })).status
  }, changes)
}

test('RP-E2E-01 a platform administrator changes parameters across storages and sees them in the overview', async ({ page }) => {
  await page.goto(`${adminUrl}/overview`)
  await navigation(page).getByRole('button', { name: '平台配置', exact: true }).click()
  await expect(page).toHaveURL(`${adminUrl}/platform-config`)
  for (const group of ['磁盘与工作区', '并发与运行', '数据保留', 'Runtime', '登录与钉钉', '外部服务']) {
    await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible()
  }
  await expect(page.getByText('只有平台管理员能保存', { exact: true })).toHaveCount(4)

  await field(page, '每次运行最多读取网页次数').fill('99')
  await expect(page.getByRole('note').filter({ hasText: '请输入 1～50 之间的整数' })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await field(page, '每次运行最多读取网页次数').fill('5')
  await field(page, '站内通知保留天数').fill('60')
  await field(page, 'Runtime 容量（本地 Runtime）').fill('6')
  await field(page, 'Runtime 单次执行超时（本地 Runtime）').fill('3')
  await field(page, '钉钉接口超时').fill('20')
  await expect(page.getByText('有 5 项未保存的修改')).toBeVisible()

  await page.getByRole('button', { name: '保存', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认保存 5 项修改' })
  await expect(dialog.getByText('10 次 → 5 次')).toBeVisible()
  await expect(dialog.getByText('4 个 → 6 个')).toBeVisible()
  await expect(dialog.getByText(/立即从员工的列表与未读数中消失/)).toBeVisible()
  await dialog.getByText('我已了解上面标出的影响').click()
  await dialog.getByRole('button', { name: '确认保存' }).click()
  await expect(page.getByText('已保存 5 项，已写入审计记录。')).toBeVisible()

  await page.reload()
  await expect(field(page, '每次运行最多读取网页次数')).toHaveValue('5')
  await expect(field(page, 'Runtime 容量（本地 Runtime）')).toHaveValue('6')

  await page.getByRole('tab', { name: '总览' }).click()
  const conversation = page.getByRole('listitem', { name: '员工对话' })
  await expect(conversation.getByText('≤ 3 分钟')).toBeVisible()
  await expect(conversation.getByText(/2 个已发布 Agent 的运行超时大于 3 分钟/)).toBeVisible()
  const config = page.getByRole('region', { name: '平台配置（本页修改）' })
  const webFetchRow = config.getByRole('row', { name: /每次运行最多读取网页次数/ })
  await expect(webFetchRow.getByRole('cell', { name: '5 次' })).toBeVisible()
  await expect(webFetchRow.getByRole('cell', { name: '页面配置' })).toBeVisible()
  await expect(page.getByRole('region', { name: '留在原页面' }).getByRole('row', { name: /Agent 运行超时/ })).toBeVisible()

  await page.getByRole('tab', { name: '配置' }).click()
  const restoreButtons = page.getByRole('button', { name: '恢复默认' })
  await expect(restoreButtons.first()).toBeVisible()

  await page.goto(`${adminUrl}/runtime-parameters`)
  await expect(page).toHaveURL(`${adminUrl}/platform-config`)
})

test('RP-E2E-02 a platform config administrator cannot save safety items; a reader only views', async ({ page }) => {
  await asAdmin(page, 'config-admin')
  await page.goto(`${adminUrl}/platform-config`)
  await expect(page.getByText('标注“只有平台管理员能保存”的安全类参数不能修改。')).toBeVisible()
  await expect(field(page, '钉钉会话有效期')).toBeDisabled()
  await expect(field(page, '每位管理员每日代绑上限')).toBeDisabled()
  await field(page, '磁盘最低剩余比例').fill('12')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认保存 1 项修改' })
  // 调高磁盘阈值立即生效（包括正在运行的命令），需要先勾选已了解。
  await dialog.getByText('我已了解上面标出的影响').click()
  await dialog.getByRole('button', { name: '确认保存' }).click()
  await expect(page.getByText('已保存 1 项，已写入审计记录。')).toBeVisible()
  expect(await saveStatus(page, [{ key: 'dingtalk.admin_daily_bind_limit', value: 9999 }])).toBe(403)

  await asAdmin(page, 'reader')
  await page.goto(`${adminUrl}/platform-config`)
  await expect(page.getByText('你可以查看平台配置；修改需要“平台配置”修改权限。')).toBeVisible()
  await expect(field(page, '磁盘最低剩余空间')).toBeDisabled()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  expect(await saveStatus(page, [{ key: 'disk.min_free_gb', value: 12 }])).toBe(403)
})

test('RP-E2E-04 the Runtimes page keeps the load but no longer edits capacity or timeout', async ({ page }) => {
  await page.goto(`${adminUrl}/runtimes`)
  const row = page.getByRole('row', { name: /本地 Runtime/ })
  await expect(row.getByText('2 / 4 · 排队 1')).toBeVisible()
  await row.getByRole('button', { name: '配置' }).click()
  const dialog = page.getByRole('dialog', { name: '配置 Runtime：本地 Runtime' })
  await expect(dialog.getByText('调度状态')).toBeVisible()
  await expect(dialog.getByText('最大并发 Worker 数')).toHaveCount(0)
  await expect(dialog.getByText('单次执行超时时间')).toHaveCount(0)
  await dialog.getByRole('button', { name: '取消' }).click()

  const status = await page.evaluate(async () => (await fetch('/api/admin/v1/runtimes/configuration', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runtimeId: 'runtime-prototype-01', maxConcurrentWorkers: 9, schedulingStatus: 'accepting' }),
  })).status)
  expect(status).toBe(422)
})

test('RP-E2E-05 session lifetime, knowledge and model timeouts are edited in platform config', async ({ page }) => {
  await asAdmin(page, 'config-admin')
  await page.goto(`${adminUrl}/platform-config`)
  // 登录会话有效期沿用环境变量，是安全类参数：平台配置管理员不能修改。
  await expect(field(page, '登录会话有效期')).toHaveValue('12')
  await expect(field(page, '登录会话有效期')).toBeDisabled()
  await expect(page.getByRole('heading', { name: '外部服务', exact: true })).toBeVisible()
  await field(page, '知识库检索超时').fill('20')
  await expect(page.getByRole('note').filter({ hasText: '请输入 3～12 之间的整数' })).toBeVisible()
  await field(page, '知识库检索超时').fill('6')
  await field(page, '模型首个响应超时').fill('60')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '确认保存 2 项修改' })
  await expect(dialog.getByText('10 秒 → 6 秒')).toBeVisible()
  // 调低检索与模型超时有失败风险，需要先勾选已了解。
  await dialog.getByText('我已了解上面标出的影响').click()
  await dialog.getByRole('button', { name: '确认保存' }).click()
  await expect(page.getByText('已保存 2 项，已写入审计记录。')).toBeVisible()
  expect(await saveStatus(page, [{ key: 'session.ttl_hours', value: 24 }])).toBe(403)

  await page.getByRole('tab', { name: '总览' }).click()
  const config = page.getByRole('region', { name: '平台配置（本页修改）' })
  await expect(config.getByRole('row', { name: /登录会话有效期/ }).getByRole('cell', { name: '环境变量' })).toBeVisible()
  await expect(config.getByRole('row', { name: /知识库检索超时/ }).getByRole('cell', { name: '页面配置' })).toBeVisible()
  await expect(page.getByRole('listitem', { name: '知识库检索' }).getByText('12 秒', { exact: true })).toBeVisible()
  await expect(page.getByRole('listitem', { name: '模型请求' }).getByText('1 分钟', { exact: true })).toBeVisible()
  await expect(page.getByRole('listitem', { name: '发布试运行' })).toBeVisible()
  await expect(page.getByRole('listitem', { name: '自动任务与主动任务' }).getByText(/1 个已启用任务的预算超时大于 30 分钟/)).toBeVisible()
  await expect(page.getByText('暂不可修改')).toHaveCount(0)
})
