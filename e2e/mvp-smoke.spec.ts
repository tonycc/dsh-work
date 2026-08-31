import { expect, test } from '@playwright/test'

test('employee can open the workbench and enter a team workspace', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/workbench')

  await expect(page).toHaveTitle(/工作台 · dsh-work/)
  await expect(page.getByRole('heading', { name: /dsh-work，我帮你/ })).toBeVisible()
  await expect(page.getByLabel('对话输入')).toBeVisible()
  await expect(page.getByRole('button', { name: '发送消息' })).toBeDisabled()
  await expect(page.getByLabel('当前活动')).toHaveCount(0)
  await expect(page.getByRole('group', { name: '选择工作模式' })).toHaveCount(0)
  await expect(page.getByLabel('选择执行模式')).toHaveCount(0)
  await expect(page.getByLabel('选择数据权限范围')).toHaveCount(0)
  await expect(page.getByLabel('选择 Agent')).toHaveCount(0)

  const commonTasks = page.getByRole('navigation', { name: '常用任务' })
  await expect(commonTasks.getByRole('button')).toHaveCount(4)
  await commonTasks.getByRole('button', { name: '分析文件' }).click()
  await expect(page.getByLabel('对话输入')).toHaveValue('分析我上传的文件，概括主要指标、异常项和需要跟进的问题。')

  await page.getByRole('button', { name: '工作空间', exact: true }).click()
  await expect(page).toHaveURL(/\/workspaces$/)
  await expect(page.getByRole('heading', { name: '工作空间', exact: true })).toBeVisible()
  await expect(page.getByText('供应链经营分析', { exact: true })).toBeVisible()

  await page.getByText('供应链经营分析', { exact: true }).first().click()
  await expect(page).toHaveURL(/\/workspaces\/ws-supply/)
  await expect(page.getByRole('tab', { name: /对话/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: /共享文件/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /成果/ })).toBeVisible()
})

test('administrator can navigate governance modules and switch capability tabs', async ({ page }) => {
  await page.goto('http://127.0.0.1:4180/capabilities')

  await expect(page).toHaveTitle(/Skill 与工具 · dsh-work/)
  await expect(page.getByText('管理平台', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: /Skill 中心/ })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('tab', { name: /连接器状态/ }).click()
  await expect(page.getByRole('tab', { name: /连接器状态/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: '全部检查' })).toBeVisible()

  await page.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await expect(page).toHaveURL(/\/runtimes$/)
  await expect(page.getByText('Runtimes', { exact: true }).first()).toBeVisible()
})
