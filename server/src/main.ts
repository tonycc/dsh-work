import { createServer } from 'node:http'

import { registerAdminRoutes } from './http/admin/routes.ts'
import { registerModelGovernanceRoutes } from './http/admin/model-routes.ts'
import { Router, envelope } from './http/router.ts'
import { registerWorkbenchRoutes } from './http/workbench/routes.ts'
import { checkDatabase, createDatabase } from './infrastructure/postgres/database.ts'
import { runMigrations } from './infrastructure/postgres/migration-runner.ts'
import { PrototypeRepository } from './infrastructure/prototype/prototype-repository.ts'
import { AdminQueryService } from './modules/admin/application/admin-query-service.ts'
import { MemoryModelGovernanceRepository } from './modules/model/memory-model-governance-repository.ts'
import { ModelGovernanceService } from './modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from './modules/model/postgres-model-governance-repository.ts'
import { WorkbenchQueryService } from './modules/workbench/application/workbench-query-service.ts'

const port = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)
const host = process.env.DSH_WORK_SERVER_HOST ?? '127.0.0.1'

async function start() {
  const repository = new PrototypeRepository()
  const router = new Router()
  const databaseUrl = process.env.DSH_WORK_DATABASE_URL
  const database = databaseUrl ? createDatabase({ url: databaseUrl }) : null

  if (database) await runMigrations(database)
  const modelRepository = database
    ? new PostgresModelGovernanceRepository(database)
    : new MemoryModelGovernanceRepository()

  registerWorkbenchRoutes(router, new WorkbenchQueryService(repository))
  registerAdminRoutes(router, new AdminQueryService(repository))
  registerModelGovernanceRoutes(router, new ModelGovernanceService(modelRepository))

  router.get('/health', async () =>
    envelope('system', {
      service: 'dsh-work-server',
      status: 'ok',
      architecture: 'node-modular-monolith',
      persistence: database ? 'postgres-foundation' : 'prototype-memory',
      sso: 'mock',
      dshRuntime: 'poc-validated',
      database: database ? await checkDatabase(database) : 'not-configured',
    }, database ? 'postgres' : 'prototype-memory'),
  )

  const server = createServer((request, response) => void router.handle(request, response))
  server.listen(port, host, () => {
    console.log(`dsh-work server listening on http://${host}:${port}`)
  })

  const shutdown = () => {
    server.close(() => {
      if (database) void database.end().finally(() => process.exit(0))
      else process.exit(0)
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

await start()
