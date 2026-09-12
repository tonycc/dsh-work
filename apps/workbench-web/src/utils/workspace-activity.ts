import type { WorkspaceActivityItem, WorkspaceActivityKind, WorkspaceFile } from '@/types/domain'
import { formatActivityTime } from './activity-time'

/**
 * 团队动态展示项（TW-08 / design §2.9）。
 *
 * 服务端动态只带 id 引用，不带名称。文件类动态的名称由这里从「成员本来就能读」
 * 的空间文件列表解析：命中则带上 `fileName`，否则保持 `undefined`，由
 * `describeWorkspaceActivity` 显示中性占位——绝不让 `objectId` 冒充名称。
 */
export interface WorkspaceActivityDisplayItem {
  id: string
  kind: WorkspaceActivityKind
  actorDisplayName: string
  safeMetadata: Record<string, unknown>
  /** 解析出的文件名；解析不到时省略。 */
  fileName?: string
  /** 相对时间或日期（design §4 的「相对／绝对时间」）。 */
  time: string
  /** 原始 ISO 时间，供 `<time datetime>` 提供机器可读值（design §4）。 */
  occurredAt: string
}

/**
 * 在已加载的空间文件列表中解析动态对象对应的文件名。
 *
 * 团队共享文件按逻辑文件聚合（`logicalFileId`），动态的 `objectId` 即逻辑文件
 * id；同时兼容 TW-07 之前直接落在 `file_objects` 上的历史移除动态（`id`）。
 */
export function resolveActivityFileName(objectId: string, files: WorkspaceFile[]): string | undefined {
  if (!objectId || !Array.isArray(files)) return undefined
  const matched = files.find(file => file.logicalFileId === objectId || file.id === objectId)
  return matched?.name
}

/** 把服务端动态装配成右栏摘要与「查看全部」抽屉共用的展示项。 */
export function buildActivityDisplayItems(
  items: WorkspaceActivityItem[],
  files: WorkspaceFile[],
): WorkspaceActivityDisplayItem[] {
  // 响应越界（`items` 不是数组）时返回空列表，而不是让渲染期抛错掀翻整个详情页。
  if (!Array.isArray(items)) return []
  const readableFiles = Array.isArray(files) ? files : []
  return items.map((item) => {
    const fileName = item.objectType === 'file' ? resolveActivityFileName(item.objectId, readableFiles) : undefined
    return {
      id: item.id,
      kind: item.kind,
      actorDisplayName: item.actorDisplayName,
      safeMetadata: item.safeMetadata ?? {},
      ...(fileName ? { fileName } : {}),
      time: formatActivityTime(item.occurredAt),
      occurredAt: item.occurredAt,
    }
  })
}
