import { randomUUID } from 'node:crypto'

import { createDatabase, type DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'

/**
 * Throwaway per-suite database for PostgreSQL integration tests.
 *
 * Suites that connect straight to DSH_WORK_TEST_DATABASE_URL share one
 * long-lived development database, so rows accumulate across runs and between
 * suites. That makes absolute-count assertions ("every seeded grant has exactly
 * one matching source") and full-list queries read leftovers from earlier runs,
 * and it lets two suites running concurrently see each other's in-flight rows.
 * CI starts from an empty service container so it hides the problem; local runs
 * drift and eventually fail.
 *
 * Every suite should create its own database from the `postgres` maintenance
 * database, run the real migration chain, and drop it afterwards. This helper
 * keeps that pattern in one place.
 */
export interface ThrowawayDatabase {
  /** URL of the created database (use for a second connection or a spawned process). */
  url: string
  client: DatabaseClient
  name: string
  /** Closes the suite connection and drops the database. Safe to call once, in `after`. */
  dispose(): Promise<void>
}

export interface ThrowawayDatabaseOptions {
  /** Distinct prefix per suite, e.g. `dsh_work_m5_capacity_test`. */
  namePrefix: string
  maxConnections?: number
  /** Skips the migration chain when the suite drives migrations itself. */
  migrate?: boolean
  /** Alternative migrations directory (e.g. an upgrade baseline snapshot). */
  migrationsDirectory?: string
}

/** Resolves the configured maintenance URL, failing loudly when it is absent. */
export function requireMaintenanceUrl(databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL): string {
  if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')
  return databaseUrl
}

export async function createThrowawayDatabase(options: ThrowawayDatabaseOptions): Promise<ThrowawayDatabase> {
  const maintenanceUrl = requireMaintenanceUrl()
  const name = `${options.namePrefix}_${randomUUID().replaceAll('-', '')}`
  const adminUrl = new URL(maintenanceUrl)
  adminUrl.pathname = '/postgres'
  const admin = createDatabase({ url: adminUrl.toString(), maxConnections: 2 })
  await admin.unsafe(`create database "${name}"`)

  const testUrl = new URL(maintenanceUrl)
  testUrl.pathname = `/${name}`
  const url = testUrl.toString()
  const client = createDatabase({ url, maxConnections: options.maxConnections ?? 6 })
  if (options.migrate !== false) await runMigrations(client, options.migrationsDirectory)

  return {
    url,
    client,
    name,
    async dispose() {
      // `with (force)` terminates stragglers (a suite that opened its own
      // connection), so disposal never hangs on a lingering client.
      await client.end().catch(() => undefined)
      await admin.unsafe(`drop database "${name}" with (force)`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    },
  }
}
