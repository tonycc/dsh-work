import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { DatabaseClient } from './database.ts'
import { upgradePreflightChecks } from './team-workspace-upgrade-baseline.ts'

const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/

export interface AppliedMigration {
  version: string
  applied: boolean
}

export async function runMigrations(
  database: DatabaseClient,
  migrationsDirectory = resolve(import.meta.dirname, '../../../migrations'),
): Promise<AppliedMigration[]> {
  await database.unsafe(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `)

  const files = (await readdir(migrationsDirectory))
    .filter((file) => migrationPattern.test(file))
    .sort()
  const results: AppliedMigration[] = []

  for (const version of files) {
    const [existing] = await database<{ version: string }[]>`
      select version from schema_migrations where version = ${version}
    `
    if (existing) {
      results.push({ version, applied: false })
      continue
    }
    // AC-27：升级前置检查（例如 0022 依赖有效的 0013 个人空间基线）。失败时抛出并
    // 中止本次迁移，不写入 schema_migrations，杜绝「半升级」状态。
    const preflight = upgradePreflightChecks[version]
    if (preflight) await preflight(database)
    const sqlText = await readFile(resolve(migrationsDirectory, version), 'utf8')
    await database.begin(async (transaction) => {
      await transaction.unsafe(sqlText)
      await transaction`insert into schema_migrations (version) values (${version})`
    })
    results.push({ version, applied: true })
  }

  return results
}
