import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { registerAdminRoutes } from './http/admin/routes.ts'
import { registerAgentRoutes } from './http/admin/agent-routes.ts'
import { registerSkillRoutes } from './http/admin/skill-routes.ts'
import { registerToolRoutes } from './http/admin/tool-routes.ts'
import { registerModelGovernanceRoutes } from './http/admin/model-routes.ts'
import { registerOperationsRoutes } from './http/admin/operations-routes.ts'
import { Router, envelope } from './http/router.ts'
import { registerWorkbenchRoutes } from './http/workbench/routes.ts'
import { registerConversationRoutes } from './http/workbench/conversation-routes.ts'
import { registerContentRoutes } from './http/workbench/content-routes.ts'
import { registerWorkbenchAgentRoutes } from './http/workbench/agent-routes.ts'
import { registerUnavailableWorkbenchCommandRoutes } from './http/workbench/unavailable-routes.ts'
import { registerOidcRoutes } from './http/auth-routes.ts'
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
import {
  preflightDshRuntime,
  resolveDshRuntimeInstallation,
  type DshRuntimeInstallation,
} from './modules/runtime/dsh-runtime-installation.ts'
import { PostgresContentService } from './modules/workbench/application/postgres-content-service.ts'
import { PostgresAgentService } from './modules/agent/postgres-agent-service.ts'
import { PostgresSkillService } from './modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from './modules/tool/postgres-tool-connector-service.ts'
import { PostgresKnowledgeService } from './modules/knowledge/postgres-knowledge-service.ts'
import { PostgresAuthorizationService } from './modules/authorization/postgres-authorization-service.ts'
import { loadIdentityConfiguration } from './modules/identity/config.ts'
import { OidcAuthService } from './modules/identity/auth-service.ts'
import { prototypeApiAuthenticator } from './modules/identity/prototype-authenticator.ts'

const port = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)
const host = process.env.DSH_WORK_SERVER_HOST ?? '127.0.0.1'

async function start() {
  const repository = new PrototypeRepository()
  const identityConfiguration = loadIdentityConfiguration()
  const databaseUrl = process.env.DSH_WORK_DATABASE_URL
  const database = databaseUrl ? createDatabase({ url: databaseUrl }) : null

  if (identityConfiguration.mode === 'oidc' && !database) {
    throw new Error('AI Hub OIDC 模式必须配置 DSH_WORK_DATABASE_URL 以保存服务端会话')
  }

  if (database) await runMigrations(database)
  const oidcAuthentication = identityConfiguration.mode === 'oidc' && database
    ? new OidcAuthService(identityConfiguration, database)
    : null
  const router = new Router({
    authenticateApi: oidcAuthentication
      ? (request, audience) => oidcAuthentication.authenticateApi(request, audience)
      : prototypeApiAuthenticator,
  })
  if (oidcAuthentication) registerOidcRoutes(router, oidcAuthentication)
  const modelRepository = database
    ? new PostgresModelGovernanceRepository(database)
    : new MemoryModelGovernanceRepository()

  let orchestration: RunOrchestrationService | null = null
  let dshInstallation: DshRuntimeInstallation | null = null
  if (database) {
    const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
    dshInstallation = await resolveDshRuntimeInstallation({ projectRoot })
    await preflightDshRuntime(dshInstallation)
    const runtime = new DshAcpRuntimeAdapter({
      runtimeId: 'runtime-local-01',
      runtimeRoot: resolve(projectRoot, '.runtime/dsh-attempts'),
      dshRepository: dshInstallation.home,
      runtimeVersion: dshInstallation.version,
      runtimeCommit: dshInstallation.commit,
      protocolVersion: dshInstallation.protocolVersion,
      launchMode: dshInstallation.launchMode,
      process: dshInstallation.process,
      permissionDecision: async () => 'allow_once',
    })
    const conversations = new PostgresConversationRepository(database)
    const content = new PostgresContentService(database, resolve(projectRoot, '.runtime/storage'))
    const runs = new PostgresRunRepository(database)
    const authorization = new PostgresAuthorizationService(database)
    const operations = new PostgresOperationsService(
      database,
      runtime,
      authorization,
      identityConfiguration.mode === 'oidc' ? 'ai-hub-oidc' : 'mock',
    )
    const runtimePolicy = await operations.getRuntimePolicy('runtime-local-01')
    await runtime.configureScheduling(runtimePolicy.schedulingStatus)
    const tools = new PostgresToolConnectorService(database, runtime, operations)
    const skills = new PostgresSkillService(database, operations, tools)
    const agents = new PostgresAgentService(database, operations, skills, tools)
    const knowledge = new PostgresKnowledgeService(database)
    orchestration = new RunOrchestrationService(
      runs,
      conversations,
      new ModelGovernanceService(modelRepository),
      runtime,
      content,
      operations,
      agents,
      knowledge,
      authorization,
    )
    const restartRecovery = await orchestration.recoverAfterServiceRestart()
    if (restartRecovery.failed > 0 || restartRecovery.resumedQueued > 0) {
      console.warn('service restart recovery completed', restartRecovery)
    }
    registerConversationRoutes(router, conversations, orchestration, runs, agents, authorization, operations)
    registerContentRoutes(router, content, authorization)
    registerOperationsRoutes(router, operations)
    registerAgentRoutes(router, agents)
    registerSkillRoutes(router, skills)
    registerToolRoutes(router, tools)
    registerWorkbenchAgentRoutes(router, agents, authorization)
  } else {
    registerUnavailableWorkbenchCommandRoutes(router)
  }
  registerWorkbenchRoutes(router, new WorkbenchQueryService(repository))
  registerAdminRoutes(router, new AdminQueryService(repository))
  registerModelGovernanceRoutes(router, new ModelGovernanceService(modelRepository))

  router.get('/health/live', () => ({
    status: 'ok',
    service: 'dsh-work',
    version: '0.1.0',
  }))

  router.get('/health', async () =>
    envelope('system', {
      service: 'dsh-work-server',
      status: 'ok',
      architecture: 'node-modular-monolith',
      persistence: database ? 'postgres-foundation' : 'prototype-memory',
      sso: identityConfiguration.mode === 'oidc' ? 'ai-hub-oidc' : 'mock',
      dshRuntime: dshInstallation ? {
        status: 'connected',
        version: dshInstallation.version,
        commit: dshInstallation.commit,
        protocolVersion: dshInstallation.protocolVersion,
        launchMode: dshInstallation.launchMode,
      } : 'not-configured',
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
