import { describe, expect, it } from 'vitest'

import type { WorkspaceFileVersion } from '@/types/domain'
import {
  canReferenceVersion,
  describeVersionParseStatus,
  formatFileVersionLabel,
  toVersionFileReference,
} from './workspace-file-versions'

function version(overrides: Partial<WorkspaceFileVersion> = {}): WorkspaceFileVersion {
  return {
    versionNo: 2,
    fileId: 'file-2',
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

describe('workspace-file-versions 展示与引用口径', () => {
  it('把解析状态映射成不依赖颜色的中文文案', () => {
    expect(describeVersionParseStatus('succeeded')).toBe('解析成功')
    expect(describeVersionParseStatus('failed')).toBe('解析失败')
    expect(describeVersionParseStatus('pending')).toBe('处理中')
    // 越界值不得渲染空白（服务端闭集之外的脏数据）。
    expect(describeVersionParseStatus('unknown' as WorkspaceFileVersion['parseStatus'])).toBe('状态未知')
  })

  it('只有可下载且解析成功的版本才允许引用到对话', () => {
    expect(canReferenceVersion(version())).toBe(true)
    // 失败版本即便对象仍可下载，也不得进入新引用（AC-13）。
    expect(canReferenceVersion(version({ parseStatus: 'failed' }))).toBe(false)
    expect(canReferenceVersion(version({ parseStatus: 'pending' }))).toBe(false)
    // 服务端说不可下载时一律不可引用，前端不自行推断。
    expect(canReferenceVersion(version({ canDownload: false }))).toBe(false)
  })

  it('引用固定到该版本的不可变对象 id，而不是逻辑文件 id', () => {
    const reference = toVersionFileReference(version({ versionNo: 1, fileId: 'file-object-1' }))

    expect(reference.id).toBe('file-object-1')
    expect(reference.logicalFileId).toBe('wfile-1')
    expect(reference.name).toBe('库存明细.xlsx')
    expect(reference.size).toBe('12 KB')
    expect(reference.uploadedBy).toBe('林岚')
  })

  it('文件行版本标记只在服务端给出正整数版本号时渲染，多于一个版本才补总数', () => {
    expect(formatFileVersionLabel({ versionNo: 2, versionCount: 1 })).toBe('V2')
    expect(formatFileVersionLabel({ versionNo: 2, versionCount: 3 })).toBe('V2 · 共 3 个版本')
    // 个人空间文件或历史夹具没有版本字段：不渲染任何版本标记。
    expect(formatFileVersionLabel({})).toBe('')
    expect(formatFileVersionLabel({ versionNo: 0, versionCount: 0 })).toBe('')
    expect(formatFileVersionLabel({ versionNo: Number.NaN })).toBe('')
  })

  it('越界版本号不得渲染成指数或超出服务端 integer 范围的文案（规格评审 F1）', () => {
    // `Number.isInteger(1e21)` 为真，只查 isInteger 会渲染 `V1e+21`；服务端
    // version_no 是 PostgreSQL integer（≤ 2147483647），契约外的值一律不渲染。
    expect(formatFileVersionLabel({ versionNo: 1e21 })).toBe('')
    expect(formatFileVersionLabel({ versionNo: 1e21, versionCount: 3 })).toBe('')
    expect(formatFileVersionLabel({ versionNo: 2, versionCount: 1e21 })).toBe('V2')
    expect(formatFileVersionLabel({ versionNo: Number.MAX_SAFE_INTEGER + 2 })).toBe('')
    expect(formatFileVersionLabel({ versionNo: 2_147_483_648 })).toBe('')
    expect(formatFileVersionLabel({ versionNo: 2_147_483_647 })).toBe('V2147483647')
    expect(formatFileVersionLabel({ versionNo: -1 })).toBe('')
    expect(formatFileVersionLabel({ versionNo: 2.5 })).toBe('')
    expect(formatFileVersionLabel({ versionNo: Number.POSITIVE_INFINITY })).toBe('')
    expect(formatFileVersionLabel({ versionNo: '3' as unknown as number })).toBe('')
  })
})
