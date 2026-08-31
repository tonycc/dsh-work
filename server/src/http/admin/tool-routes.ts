import type { ToolDefinition } from '../../domain/types.ts'
import type { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { envelope, readJsonBody, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerToolRoutes(router: Router, service: PostgresToolConnectorService) {
  router.get(`${basePath}/tools`, async () => envelope('admin', await service.getTools(), 'postgres'))
  router.patch(`${basePath}/tools/status`, async request => envelope(
    'admin',
    await service.setToolStatus(await readJsonBody<{
      toolId: string
      status: 'available' | 'disabled'
      actor: string
    }>(request)),
    'postgres',
  ))
  router.patch(`${basePath}/tools/permissions`, async request => envelope(
    'admin',
    await service.updateToolPermissions(await readJsonBody<{
      toolId: string
      allowedRoles: string[]
      dataScopes: string[]
      approvalPolicy: ToolDefinition['approvalPolicy']
      actor: string
    }>(request)),
    'postgres',
  ))
  router.get(`${basePath}/connectors`, async () => envelope('admin', await service.getConnectors(), 'postgres'))
  router.post(`${basePath}/connectors/check`, async request => envelope(
    'admin',
    await service.checkConnector(await readJsonBody<{ connectorId: string; actor: string }>(request)),
    'postgres',
  ))
}
