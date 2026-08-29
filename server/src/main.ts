import { createServer } from 'node:http'

import { registerAdminRoutes } from './http/admin/routes.ts'
import { Router, envelope } from './http/router.ts'
import { registerWorkbenchRoutes } from './http/workbench/routes.ts'
import { PrototypeRepository } from './infrastructure/prototype/prototype-repository.ts'
import { AdminQueryService } from './modules/admin/application/admin-query-service.ts'
import { WorkbenchQueryService } from './modules/workbench/application/workbench-query-service.ts'

const port = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)
const host = process.env.DSH_WORK_SERVER_HOST ?? '127.0.0.1'

const repository = new PrototypeRepository()
const router = new Router()

registerWorkbenchRoutes(router, new WorkbenchQueryService(repository))
registerAdminRoutes(router, new AdminQueryService(repository))

router.get('/health', () =>
  envelope('system', {
    service: 'dsh-work-server',
    status: 'ok',
    architecture: 'node-modular-monolith',
    persistence: 'prototype-memory',
    sso: 'mock',
    dshRuntime: 'not-connected',
    database: 'not-configured',
  }),
)

createServer((request, response) => void router.handle(request, response)).listen(port, host, () => {
  console.log(`dsh-work server listening on http://${host}:${port}`)
})
