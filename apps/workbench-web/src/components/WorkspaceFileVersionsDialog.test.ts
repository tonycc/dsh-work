import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { WorkspaceFileVersion, WorkspaceFileVersionPage } from '@/types/domain'
import WorkspaceFileVersionsDialog from './WorkspaceFileVersionsDialog.vue'

// 反馈提示走 mock：本文件要断言「关闭/卸载后不得再弹提示」，不能依赖真实 ElMessage。
const notifyActionFailure = vi.hoisted(() => vi.fn())
vi.mock('@/utils/feedback', () => ({ notifyActionFailure }))

function version(overrides: Partial<WorkspaceFileVersion> = {}): WorkspaceFileVersion {
  return {
    versionNo: 3,
    fileId: 'file-3',
    logicalFileId: 'wfile-1',
    name: '库存明细.xlsx',
    type: 'XLSX',
    size: '12 KB',
    note: '补充 9 月数据',
    uploadedBy: '林岚',
    uploadedAt: '2026-09-12 09:00',
    scanStatus: 'clean',
    parseStatus: 'succeeded',
    current: true,
    canDownload: true,
    ...overrides,
  }
}

function versionPage(items: WorkspaceFileVersion[]): WorkspaceFileVersionPage {
  return {
    logicalFileId: 'wfile-1',
    name: '库存明细.xlsx',
    status: 'active',
    latestVersionNo: 2,
    versionCount: items.length,
    items,
  }
}

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(WorkspaceFileVersionsDialog, {
    props: {
      open: true,
      workspaceId: 'ws-team',
      logicalFileId: 'wfile-1',
      fileName: '库存明细.xlsx',
      canReference: true,
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('WorkspaceFileVersionsDialog 版本列表（TW-07 / 3-T9）', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'listWorkspaceFileVersions').mockResolvedValue(versionPage([version()]))
    vi.spyOn(workbenchApi, 'downloadWorkspaceFileVersion').mockResolvedValue(new Blob(['x']))
  })

  it('列出每个版本（含失败版本）并标注当前版本与服务端解析状态', async () => {
    vi.mocked(workbenchApi.listWorkspaceFileVersions).mockResolvedValue(versionPage([
      version({ versionNo: 3, fileId: 'file-3', current: false, parseStatus: 'failed', canDownload: true, note: null }),
      version({ versionNo: 2, fileId: 'file-2', current: true }),
      version({ versionNo: 1, fileId: 'file-1', current: false, note: null, size: '10 KB' }),
    ]))
    const wrapper = mountDialog()
    await flushPromises()

    expect(workbenchApi.listWorkspaceFileVersions).toHaveBeenCalledWith('ws-team', 'wfile-1')
    const rows = wrapper.findAll('[data-testid="file-versions-row"]')
    expect(rows).toHaveLength(3)
    // 版本号倒序 + 元信息（大小/上传人/时间/更新说明）。
    expect(rows[0]!.text()).toContain('V3')
    expect(rows[0]!.text()).toContain('12 KB')
    expect(rows[0]!.text()).toContain('林岚上传')
    expect(rows[0]!.text()).toContain('2026-09-12 09:00')
    // 失败版本照常列出并说明解析状态，而不是被过滤掉。
    expect(rows[0]!.find('[data-testid="file-versions-parse-status"]').text()).toBe('解析失败')
    expect(rows[1]!.find('[data-testid="file-versions-parse-status"]').text()).toBe('解析成功')
    // 当前版本只标在服务端 `current` 的那一行。
    expect(rows[0]!.find('[data-testid="file-versions-current"]').exists()).toBe(false)
    expect(rows[1]!.find('[data-testid="file-versions-current"]').exists()).toBe(true)
    expect(rows[2]!.find('[data-testid="file-versions-note"]').exists()).toBe(false)
  })

  it('加载中显示骨架，无版本显示空态', async () => {
    let resolvePage!: (value: WorkspaceFileVersionPage) => void
    vi.mocked(workbenchApi.listWorkspaceFileVersions).mockReturnValue(new Promise((resolve) => {
      resolvePage = resolve
    }))
    const wrapper = mountDialog()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="file-versions-skeleton"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-versions-empty"]').exists()).toBe(false)

    resolvePage(versionPage([]))
    await flushPromises()

    expect(wrapper.find('[data-testid="file-versions-skeleton"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-versions-empty"]').exists()).toBe(true)
  })

  it('加载失败就地报错，且「重试」真的重新请求', async () => {
    vi.mocked(workbenchApi.listWorkspaceFileVersions)
      .mockRejectedValueOnce(new Error('服务暂不可用'))
      .mockResolvedValueOnce(versionPage([version()]))
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.find('[data-testid="file-versions-error"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="file-versions-row"]')).toHaveLength(0)

    await wrapper.find('[data-testid="file-versions-retry"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceFileVersions).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="file-versions-error"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="file-versions-row"]')).toHaveLength(1)
  })

  it('下载入口只出现在服务端 canDownload 的版本上，并按版本号请求', async () => {
    vi.mocked(workbenchApi.listWorkspaceFileVersions).mockResolvedValue(versionPage([
      version({ versionNo: 2, fileId: 'file-2', canDownload: false }),
      version({ versionNo: 1, fileId: 'file-1', current: false }),
    ]))
    const wrapper = mountDialog()
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="file-versions-row"]')
    // 服务端说不可下载的版本不给下载入口，且用文案（而非颜色）说明。
    expect(rows[0]!.find('[data-testid="file-versions-download"]').exists()).toBe(false)
    expect(rows[0]!.text()).toContain('不可下载')
    expect(rows[1]!.find('[data-testid="file-versions-download"]').exists()).toBe(true)

    await rows[1]!.find('[data-testid="file-versions-download"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.downloadWorkspaceFileVersion).toHaveBeenCalledWith('ws-team', 'wfile-1', 1)
  })

  it('只有可下载且解析成功的版本提供「引用此版本」，并把该版本原样抛给宿主', async () => {
    const failed = version({ versionNo: 3, fileId: 'file-3', current: false, parseStatus: 'failed', canDownload: true })
    const pending = version({ versionNo: 2, fileId: 'file-2', current: false, parseStatus: 'pending', canDownload: false })
    const usable = version({ versionNo: 1, fileId: 'file-object-1', current: true })
    vi.mocked(workbenchApi.listWorkspaceFileVersions).mockResolvedValue(versionPage([failed, pending, usable]))
    const wrapper = mountDialog()
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="file-versions-row"]')
    // 失败/待解析版本不可引用（AC-13），即便对象可下载。
    expect(rows[0]!.find('[data-testid="file-versions-reference"]').exists()).toBe(false)
    expect(rows[1]!.find('[data-testid="file-versions-reference"]').exists()).toBe(false)
    expect(rows[2]!.find('[data-testid="file-versions-reference"]').exists()).toBe(true)

    await rows[2]!.find('[data-testid="file-versions-reference"]').trigger('click')

    const emitted = wrapper.emitted('reference')
    expect(emitted).toHaveLength(1)
    expect(emitted![0]![0]).toMatchObject({ versionNo: 1, fileId: 'file-object-1' })
  })

  it('归档空间（canReference=false）保留版本列表与下载，但不提供「引用此版本」', async () => {
    const wrapper = mountDialog({ canReference: false })
    await flushPromises()

    expect(wrapper.findAll('[data-testid="file-versions-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="file-versions-download"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-versions-reference"]').exists()).toBe(false)
  })

  it('弹窗具备可访问名称与带 aria-label 的关闭按钮', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const dialog = wrapper.find('[role="dialog"]')
    // 可访问名称经 aria-labelledby 指向头部元素（含「文件版本」与文件名），
    // 不用 Element Plus 由 title 派生的通用 aria-label。
    const labelledby = dialog.attributes('aria-labelledby')
    expect(labelledby).toBeTruthy()
    expect(wrapper.find(`[id="${labelledby}"]`).text()).toContain('文件版本')
    expect(dialog.attributes('aria-label')).toBeUndefined()
    expect(wrapper.find('[data-testid="file-versions-close"]').attributes('aria-label')).toBe('关闭文件版本')
  })
})

describe('WorkspaceFileVersionsDialog 竞态与可访问性（评审 P1/P2/nit）', () => {
  it('关闭对话框后晚到的失败不得再弹提示（评审 P2）', async () => {
    let rejectRequest!: (reason: unknown) => void
    vi.spyOn(workbenchApi, 'listWorkspaceFileVersions').mockImplementation(
      () => new Promise((_resolve, reject) => { rejectRequest = reject }),
    )
    notifyActionFailure.mockClear()
    const wrapper = mountDialog()

    await wrapper.setProps({ open: false })
    rejectRequest(new Error('boom'))
    await flushPromises()

    // 关闭即作废在途请求：既不写状态，也不弹失败提示。
    expect(notifyActionFailure).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="file-versions-error"]').exists()).toBe(false)
  })

  it('切换逻辑文件时立即清空上一个文件的版本，不留残影（评审 P1）', async () => {
    vi.spyOn(workbenchApi, 'listWorkspaceFileVersions').mockImplementation(async (_ws: string, logicalFileId: string) =>
      versionPage([version({ logicalFileId, versionNo: logicalFileId === 'wfile-a' ? 7 : 2, fileId: `file-${logicalFileId}` })]))
    const wrapper = mountDialog({ logicalFileId: 'wfile-a' })
    await flushPromises()

    expect(wrapper.find('[data-testid="file-versions-dialog"]').text()).toContain('V7')
    let pending: Promise<unknown> | null = null
    vi.mocked(workbenchApi.listWorkspaceFileVersions).mockImplementation((_ws: string, logicalFileId: string) => {
      pending = new Promise(resolve => setTimeout(() => resolve(versionPage([
        version({ logicalFileId, versionNo: 2, fileId: 'file-b2' }),
      ])), 10))
      return pending as never
    })

    await wrapper.setProps({ logicalFileId: 'wfile-b' })
    // 新响应到达之前，不得还显示 A 的版本行。
    expect(wrapper.find('[data-testid="file-versions-dialog"]').text()).not.toContain('V7')
    await pending
    await flushPromises()
    expect(wrapper.find('[data-testid="file-versions-dialog"]').text()).toContain('V2')
  })

  it('对话框的可访问名称包含文件名，便于屏幕阅读器区分同名对话框（评审 nit）', async () => {
    vi.spyOn(workbenchApi, 'listWorkspaceFileVersions').mockResolvedValue(versionPage([version()]))
    const wrapper = mountDialog({ fileName: '库存明细.xlsx' })
    await flushPromises()

    // Element Plus 在传 `title` 时只写死 aria-label='文件版本'，因此本组件不传 title，
    // 由 aria-labelledby 指向同时包含「文件版本」与文件名的头部元素。
    const dialog = wrapper.find('[role="dialog"]')
    const labelledby = dialog.attributes('aria-labelledby')
    expect(labelledby).toBeTruthy()
    const labelled = wrapper.find(`[id="${labelledby}"]`)
    expect(labelled.exists()).toBe(true)
    expect(labelled.text()).toContain('文件版本')
    expect(labelled.text()).toContain('库存明细.xlsx')
  })
})
