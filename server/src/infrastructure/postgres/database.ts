import postgres, { type Sql, type TransactionSql } from 'postgres'

export type DatabaseClient = Sql<Record<string, unknown>>
export type DatabaseTransaction = TransactionSql<Record<string, unknown>>

export interface DatabaseConfiguration {
  url: string
  maxConnections?: number
  idleTimeoutSeconds?: number
  connectTimeoutSeconds?: number
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
    prepare: false,
    onnotice: () => undefined,
    ...(configuration.debug ? { debug: configuration.debug } : {}),
  })
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
