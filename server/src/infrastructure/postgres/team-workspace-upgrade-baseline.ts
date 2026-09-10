import type { DatabaseClient } from './database.ts'

/**
 * AC-27 / plan 6.4：团队工作空间迁移（0022）以「完整且有效的 0013 个人空间基线」为前置
 * 条件。升级前核对 0013 的个人空间唯一索引与空间非空约束；缺失时停止本次升级，按既有
 * 迁移／数据恢复流程处理，不另建一套个人空间回填逻辑。
 *
 * 检查在 0022 应用之前（同一迁移链中 0013 已先行应用）执行：全新安装时 0013 刚建好基线，
 * 检查天然通过；已有环境升级时若基线被破坏则直接中止，不写入 schema_migrations。
 */
export const PERSONAL_WORKSPACE_UNIQUE_INDEX = 'one_personal_workspace_per_user'
export const PERSONAL_WORKSPACE_STATUS_CONSTRAINT = 'personal_workspaces_stay_active'
export const PROTECTED_NOT_NULL_COLUMNS = ['sessions', 'file_objects', 'artifacts'] as const
export const PERSONAL_WORKSPACE_GUARD_TRIGGERS = [
  'users_personal_workspace_provisioning',
  'personal_workspace_membership_guard',
] as const

export interface PersonalWorkspaceBaselineReport {
  uniqueIndexPresent: boolean
  activeOnlyConstraintPresent: boolean
  missingNotNullColumns: string[]
  missingGuardTriggers: string[]
}

export async function inspectPersonalWorkspaceBaseline(
  database: DatabaseClient,
): Promise<PersonalWorkspaceBaselineReport> {
  const [indexRow] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from pg_class c
      join pg_index i on i.indexrelid = c.oid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = ${PERSONAL_WORKSPACE_UNIQUE_INDEX}
       and i.indisunique
  `
  const [constraintRow] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from pg_constraint
     where conname = ${PERSONAL_WORKSPACE_STATUS_CONSTRAINT}
  `
  const nullableRows = await database<{ tableName: string }[]>`
    select table_name as "tableName"
      from information_schema.columns
     where table_schema = 'public'
       and column_name = 'workspace_id'
       and table_name in ${database([...PROTECTED_NOT_NULL_COLUMNS])}
       and is_nullable = 'YES'
     order by table_name
  `
  const triggerRows = await database<{ triggerName: string }[]>`
    select tgname as "triggerName"
      from pg_trigger
     where not tgisinternal
       and tgname in ${database([...PERSONAL_WORKSPACE_GUARD_TRIGGERS])}
  `
  const presentTriggers = new Set(triggerRows.map(row => row.triggerName))
  return {
    uniqueIndexPresent: (indexRow?.count ?? 0) > 0,
    activeOnlyConstraintPresent: (constraintRow?.count ?? 0) > 0,
    missingNotNullColumns: nullableRows.map(row => row.tableName),
    missingGuardTriggers: PERSONAL_WORKSPACE_GUARD_TRIGGERS.filter(name => !presentTriggers.has(name)),
  }
}

export async function assertPersonalWorkspaceBaseline(database: DatabaseClient): Promise<void> {
  const report = await inspectPersonalWorkspaceBaseline(database)
  const problems: string[] = []
  if (!report.uniqueIndexPresent) problems.push(`缺少唯一索引 ${PERSONAL_WORKSPACE_UNIQUE_INDEX}`)
  if (!report.activeOnlyConstraintPresent) problems.push(`缺少约束 ${PERSONAL_WORKSPACE_STATUS_CONSTRAINT}`)
  if (report.missingNotNullColumns.length) {
    problems.push(`workspace_id 未设非空：${report.missingNotNullColumns.join('、')}`)
  }
  if (report.missingGuardTriggers.length) {
    problems.push(`缺少 0013 保护触发器：${report.missingGuardTriggers.join('、')}`)
  }
  if (problems.length) {
    throw new Error(
      `0013 个人空间数据基线不完整（${problems.join('；')}），已停止 0022 团队工作空间升级。`
      + '请按既有迁移／数据恢复流程修复 0013 基线后重试，不要另建个人空间回填逻辑。',
    )
  }
}

/**
 * 迁移应用前的升级前置检查表。键为迁移文件名；只有在该迁移尚未应用时才会执行。
 */
export const upgradePreflightChecks: Record<string, (database: DatabaseClient) => Promise<void>> = {
  '0022_team_workspace_authorization.sql': assertPersonalWorkspaceBaseline,
}
