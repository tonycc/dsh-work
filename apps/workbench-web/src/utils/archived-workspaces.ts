import type { TaskRun, Workspace } from '@/types/domain'

/**
 * 3-T3：判断一次运行所属的空间是否处于归档只读态。
 *
 * 只依据服务端返回的 `workspace.type` 与 `status`，不按空间名或创建者猜；找不到
 * 空间时按「不可判定」处理（返回 false），避免因列表尚未加载而误禁用动作。
 *
 * 用途：会话删除属执行轨，归档空间必须拒绝（服务端 403），前端据此隐藏入口。
 */
export function isTaskInArchivedWorkspace(
  task: Pick<TaskRun, 'workspaceId'>,
  workspaces: Workspace[],
): boolean {
  const workspace = workspaces.find(item => item.id === task.workspaceId)
  return workspace?.type === 'team' && workspace.status === 'archived'
}
