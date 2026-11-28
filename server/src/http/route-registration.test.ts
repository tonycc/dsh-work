import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { Router } from './router.ts'
import { decideAdminRouteAccess } from '../domain/admin-permissions.ts'

// Route registration guards: main.ts registers routes only through register*Routes functions,
// every route lives under /api/{admin,workbench}/v1 or /auth, and every admin route has a
// permission owner. Health probes (/health*) are operational endpoints registered inline.

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8')

/** Callable, chainable stand-in for every service: registration only stores handlers. */
const stub: unknown = new Proxy(function () {}, {
  get: (_target, property) => (property === 'then' ? undefined : stub),
  apply: () => stub,
})

async function applicationRoutes() {
  const router = new Router()
  const registrations = [...mainSource.matchAll(/import \{([^}]*)\} from '\.\/http\/([^']+)'/g)]
  for (const [, names, file] of registrations) {
    const module = await import(new URL(`./${file}`, import.meta.url).href) as Record<string, (...args: unknown[]) => void>
    for (const name of names!.split(',').map(item => item.trim()).filter(item => /^register\w+Routes$/.test(item))) {
      module[name]!(router, ...Array.from({ length: 12 }, () => stub))
    }
  }
  return router.listRoutes()
}

test('main.ts registers routes only through register*Routes functions, apart from health probes', () => {
  const inline = [...mainSource.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*['`]([^'`]+)/g)].map(match => match[1]!)
  assert.ok(inline.length > 0)
  assert.deepEqual(inline.filter(path => !path.startsWith('/health')), [])
})

test('every registered route lives under the admin, workbench or auth prefixes', async () => {
  const routes = await applicationRoutes()
  assert.ok(routes.length > 200, `only ${routes.length} routes registered; route discovery is broken`)
  const other = routes
    .filter(({ path }) => !path.startsWith('/api/admin/v1/') && !path.startsWith('/api/workbench/v1/') && !path.startsWith('/auth/'))
    .map(({ method, path }) => `${method} ${path}`)
  assert.deepEqual(other, [], 'routes outside /api/{admin,workbench}/v1 and /auth')
})

test('every registered admin-audience route has a permission owner (功能规则第 13 节：未登记路径默认拒绝)', async () => {
  const unowned = (await applicationRoutes())
    .filter(({ path }) => path.startsWith('/api/admin/v1/'))
    .filter(({ method, path }) => !decideAdminRouteAccess(['admin:*'], path.replace(/:[A-Za-z_]\w*/g, 'x'), method).allowed)
    .map(({ method, path }) => `${method} ${path}`)
  assert.deepEqual(unowned, [])
})
