import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { registerAdminRoutes } from './http/admin/routes.ts'
import { registerModelGovernanceRoutes } from './http/admin/model-routes.ts'
import { registerOperationsRoutes } from './http/admin/operations-routes.ts'
import { Router, envelope } from './http/router.ts'
import { registerWorkbenchRoutes } from './http/workbench/routes.ts'
import { registerConversationRoutes } from './http/workbench/conversation-routes.ts'
import { registerContentRoutes } from './http/workbench/content-routes.ts'
import { checkDatabase, createDatabase } from './infrastructure/postgres/database.ts'
import { runMigrations } from './infrastructure/postgres/migration-runner.ts'
import { PrototypeRepository } from './infrastructure/prototype/prototype-repository.ts'
import { AdminQueryService } from './modules/admin/application/admin-query-service.ts'
import { PostgresOperationsService } from './modules/admin/application/postgres-operations-service.ts'
import { MemoryModelGovernanceRepository } from './modules/model/memory-model-governance-repository.ts'
import { ModelGovernanceService } from './modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from './modules/model/postgres-model-governance-repository.ts'
import { WorkbenchQueryService } from './modules/workbench/application/workbench-query-service.ts'
import { PostgresConversationRepository } from './modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresRunRepository } from './modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from './modules/run/run-orchestration-service.ts'
import { DshAcpRuntimeAdapter } from './modules/runtime/dsh-acp-runtime-adapter.ts'
import { createManagedDshAcpProcessConfiguration } from './modules/runtime/dsh-acp-process-configuration.ts'
import { PostgresContentService } from './modules/workbench/application/postgres-content-service.ts'

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

  let orchestration: RunOrchestrationService | null = null
  if (database) {
    const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
    const dshRepository = resolve(projectRoot, '../deepseek-harness')
    const runtime = new DshAcpRuntimeAdapter({
      runtimeId: 'runtime-local-01',
      runtimeRoot: resolve(projectRoot, '.runtime/dsh-attempts'),
      dshRepository,
      process: createManagedDshAcpProcessConfiguration({ dshRepository, projectRoot }),
      permissionDecision: async () => 'allow_once',
    })
    const conversations = new PostgresConversationRepository(database)
    const content = new PostgresContentService(database, resolve(projectRoot, '.runtime/storage'))
    const runs = new PostgresRunRepository(database)
    const operations = new PostgresOperationsService(database)
    orchestration = new RunOrchestrationService(
      runs,
      conversations,
      new ModelGovernanceService(modelRepository),
      runtime,
      content,
      operations,
    )
    registerConversationRoutes(router, conversations, orchestration, runs)
    registerContentRoutes(router, content)
    registerOperationsRoutes(router, operations)
  }
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
      void (async () => {
        if (orchestration) await orchestration.close()
        if (database) await database.end()
        process.exit(0)
      })()
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

await start()
