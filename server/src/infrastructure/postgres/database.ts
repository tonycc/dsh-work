import postgres, { type Sql, type TransactionSql } from 'postgres'

export type DatabaseClient = Sql<Record<string, unknown>>
export type DatabaseTransaction = TransactionSql<Record<string, unknown>>

export interface DatabaseConfiguration {
  url: string
  maxConnections?: number
  idleTimeoutSeconds?: number
  connectTimeoutSeconds?: number
  /** 是否使用服务端预编译语句（postgres.js `prepare`）。默认开启，可复用执行计划。 */
  prepare?: boolean
  /** 单条语句超时（毫秒）；0 表示不限制。默认不限制，由服务端入口按环境变量设置。 */
  statementTimeoutMs?: number
  /** 等锁超时（毫秒）；0 表示不限制。默认不限制，由服务端入口按环境变量设置。 */
  lockTimeoutMs?: number
  /**
   * 查询级观测钩子（诊断与性能基线用）。每个语句执行前触发一次，参数为连接号与 SQL。
   * 典型用途：统计语句数、定位 N+1；不要在钩子里执行查询。
   */
  debug?: (connection: number, query: string) => void
}

export function createDatabase(configuration: DatabaseConfiguration): DatabaseClient {
  return postgres(configuration.url, {
    max: configuration.maxConnections ?? 10,
    idle_timeout: configuration.idleTimeoutSeconds ?? 20,
    connect_timeout: configuration.connectTimeoutSeconds ?? 10,
    prepare: configuration.prepare ?? true,
    onnotice: () => undefined,
    connection: {
      ...(configuration.statementTimeoutMs ? { statement_timeout: configuration.statementTimeoutMs } : {}),
      ...(configuration.lockTimeoutMs ? { lock_timeout: configuration.lockTimeoutMs } : {}),
    },
    ...(configuration.debug ? { debug: configuration.debug } : {}),
  })
}

/** 服务端连接池默认值：单机部署也需要给 SSE 轮询、事件落库与后台清扫留出余量。 */
export const DEFAULT_SERVER_POOL_SIZE = 30
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000

/**
 * 服务端主进程的连接池参数（环境变量可覆盖）：
 * - `DSH_WORK_DATABASE_POOL_SIZE`：连接数上限，1～200，默认 30；
 * - `DSH_WORK_DATABASE_STATEMENT_TIMEOUT_MS`：单条语句超时，0 关闭，默认 30000；
 * - `DSH_WORK_DATABASE_LOCK_TIMEOUT_MS`：等锁超时，0 关闭，默认 10000；
 * - `DSH_WORK_DATABASE_PREPARE`：`false` 关闭预编译语句（例如经 PgBouncer 事务池连接时），默认开启。
 * 取值非法时启动失败，避免静默回落到意外的值。
 */
export function serverDatabaseConfiguration(url: string, environment: Record<string, string | undefined> = process.env): DatabaseConfiguration {
  return {
    url,
    maxConnections: integerSetting(environment, 'DSH_WORK_DATABASE_POOL_SIZE', DEFAULT_SERVER_POOL_SIZE, 1, 200),
    statementTimeoutMs: integerSetting(environment, 'DSH_WORK_DATABASE_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS, 0, 3_600_000),
    lockTimeoutMs: integerSetting(environment, 'DSH_WORK_DATABASE_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS, 0, 3_600_000),
    prepare: booleanSetting(environment, 'DSH_WORK_DATABASE_PREPARE', true),
  }
}

function integerSetting(environment: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number) {
  const raw = environment[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}～${max} 之间的整数，当前为「${raw}」`)
  }
  return value
}

function booleanSetting(environment: Record<string, string | undefined>, name: string, fallback: boolean) {
  const raw = environment[name]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new Error(`${name} 只能是 true 或 false，当前为「${environment[name]}」`)
}

export async function checkDatabase(database: DatabaseClient) {
  const startedAt = performance.now()
  const [result] = await database<{ database: string; serverVersion: string }[]>`
    select current_database() as database,
           current_setting('server_version') as "serverVersion"
  `
  return {
    ok: true as const,
    database: result?.database ?? 'unknown',
    serverVersion: result?.serverVersion ?? 'unknown',
    latencyMs: Math.round(performance.now() - startedAt),
  }
}
