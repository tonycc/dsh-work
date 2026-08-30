import postgres, { type Sql } from 'postgres'

export type DatabaseClient = Sql<Record<string, unknown>>

export interface DatabaseConfiguration {
  url: string
  maxConnections?: number
  idleTimeoutSeconds?: number
  connectTimeoutSeconds?: number
}

export function createDatabase(configuration: DatabaseConfiguration): DatabaseClient {
  return postgres(configuration.url, {
    max: configuration.maxConnections ?? 10,
    idle_timeout: configuration.idleTimeoutSeconds ?? 20,
    connect_timeout: configuration.connectTimeoutSeconds ?? 10,
    prepare: false,
    onnotice: () => undefined,
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
