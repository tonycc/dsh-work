/**
 * 架构与性能审核阶段零：热路径 SQL 条数基线。
 *
 * 在一次性库（`createThrowawayDatabase()`）上逐个调用审核报告中的热路径，用 `database.ts`
 * 的 `debug` 钩子统计每次调用实际执行的 SQL 条数；路径之间串行执行并清零计数，避免并发
 * 下无法归属。不接触任何共享库，不连接 DSH 或模型。
 *
 * 用法：
 *   pnpm bench:platform-baseline -- [--sessions 10] [--runs-per-session 5] [--out <path.md>]
 *
 * 读取 DSH_WORK_TEST_DATABASE_URL（PostgreSQL 维护库地址）。
 */

import { writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'

import { createDatabase, type DatabaseClient } from '../../server/src/infrastructure/postgres/database.ts'
import { createThrowawayDatabase } from '../../server/src/infrastructure/postgres/test-database.ts'
import { PostgresAuthorizationService } from '../../server/src/modules/authorization/postgres-authorization-service.ts'
import { loadIdentityConfiguration } from '../../server/src/modules/identity/config.ts'
import type { LocalIdentityConfiguration } from '../../server/src/modules/identity/types.ts'
import { IdentityAdministrationService } from '../../server/src/modules/identity/administration-service.ts'
import { LocalAuthService } from '../../server/src/modules/identity/local-auth-service.ts'
import { PostgresRunRepository } from '../../server/src/modules/run/postgres-run-repository.ts'
import { PostgresConversationRepository } from '../../server/src/modules/workbench/application/postgres-conversation-repository.ts'

const tenantId = 'tenant-dsh-work'
const agentVersionId = 'agent-version-dsh-work-assistant-1'
const origin = 'http://localhost:4174'

interface Options { sessions: number; runsPerSession: number; out: string | null }

function parseOptions(argv: string[]): Options {
  const options: Options = { sessions: 10, runsPerSession: 5, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    switch (argv[index]) {
      case '--sessions': options.sessions = positiveInteger('--sessions', value); index += 1; break
      case '--runs-per-session': options.runsPerSession = positiveInteger('--runs-per-session', value); index += 1; break
      case '--out': options.out = value ?? null; index += 1; break
      case '--': break
      default: throw new Error(`未知参数：${argv[index]}`)
    }
  }
  return options
}

function positiveInteger(name: string, value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是正整数：${value}`)
  return parsed
}

const countingConnections = 4

/** 计数客户端：每条语句执行前回调一次。 */
function countingClient(url: string) {
  let count = 0
  const client = createDatabase({ url, maxConnections: countingConnections, debug: () => { count += 1 } })
  return {
    client,
    async measure<T>(run: () => Promise<T>): Promise<{ queries: number; ms: number; value: T }> {
      count = 0
      const startedAt = performance.now()
      const value = await run()
      return { queries: count, ms: Math.round((performance.now() - startedAt) * 10) / 10, value }
    },
  }
}

function fakeRequest(method: string, cookie?: string): IncomingMessage {
  return { method, socket: {}, headers: { host: 'localhost:4174', origin, ...(cookie ? { cookie } : {}) } } as unknown as IncomingMessage
}

async function seedRuns(database: DatabaseClient, userId: string, options: Options) {
  const [workspace] = await database<{ id: string }[]>`
    select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${userId} limit 1
  `
  if (!workspace) throw new Error(`个人空间未建立：${userId}`)
  let runCount = 0
  for (let session = 0; session < options.sessions; session += 1) {
    const sessionId = `bench-session-${session}`
    await database`
      insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status, last_active_at)
      values (${sessionId}, ${tenantId}, ${workspace.id}, ${userId}, ${agentVersionId}, ${`基线会话 ${session}`}, 'active', now())
    `
    for (let turn = 0; turn < options.runsPerSession; turn += 1) {
      const runId = `bench-run-${session}-${turn}`
      const attemptId = `${runId}-attempt`
      await database.begin(async transaction => {
        await transaction`
          insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id)
          values (${runId}, ${tenantId}, ${sessionId}, ${userId}, ${`idem-${runId}`}, 'succeeded', ${attemptId})
        `
        await transaction`
          insert into run_attempts (id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status)
          values (${attemptId}, ${tenantId}, ${runId}, 1, 'runtime-local-01', ${transaction.json({})}, 'x', ${transaction.json({})}, 'succeeded')
        `
      })
      await database`
        insert into messages (id, tenant_id, session_id, run_id, role, content, sender_user_id)
        values (${`${runId}-u`}, ${tenantId}, ${sessionId}, ${runId}, 'user', ${`第 ${turn} 轮提问`}, ${userId}),
               (${`${runId}-a`}, ${tenantId}, ${sessionId}, ${runId}, 'assistant', ${'回答'.repeat(200)}, null)
      `
      // 接近本机实测（每个 Run 约 7 个事件，p50）：6 个事件，含 1 个 assistant.delta。
      const types = ['run.started', 'tool.started', 'tool.completed', 'assistant.delta', 'assistant.completed', 'run.completed']
      for (const [sequence, eventType] of types.entries()) {
        await database`
          insert into run_events (id, tenant_id, run_id, attempt_id, sequence, event_type, display_message, safe_metadata, trace_id, occurred_at)
          values (${`${runId}-e${sequence}`}, ${tenantId}, ${runId}, ${attemptId}, ${sequence + 1}, ${eventType}, ${eventType === 'assistant.delta' ? '回答' : ''},
                  ${database.json({})}, ${`trace-${runId}`}, now())
        `
      }
      runCount += 1
    }
  }
  return { workspaceId: workspace.id, runCount }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_platform_baseline', maxConnections: 4 })
  const counter = countingClient(throwaway.url)
  const rows: Array<{ path: string; queries: number; ms: number; note: string }> = []
  try {
    const config = loadIdentityConfiguration({
      DSH_WORK_AUTH_MODE: 'local', DSH_WORK_SESSION_SECRET: 'platform-baseline-secret-with-32-chars!!',
      DSH_WORK_WORKBENCH_ORIGINS: origin, DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4180',
    }) as LocalIdentityConfiguration
    const setup = new LocalAuthService(config, throwaway.client)
    const password = 'Baseline-Password-2026!'
    const adminId = (await setup.bootstrap({ username: 'baseline.admin@example.invalid', name: '基线管理员', password })).userId
    const userId = (await setup.createAccount({ username: 'baseline.user@example.invalid', name: '基线员工', password }, adminId)).userId
    await new IdentityAdministrationService(throwaway.client).grantRole({ userId, roleId: 'role-employee', actorId: adminId })
    await throwaway.client`update local_user_credentials set must_change_password = false where user_id = ${userId}`
    const login = await setup.login(fakeRequest('POST'), 'workbench', { username: 'baseline.user@example.invalid', password }) as { sessionCookie?: string }
    if (!login.sessionCookie) throw new Error('登录失败，未取得会话 Cookie')
    const cookie = login.sessionCookie.split(';')[0]!

    const seeded = await seedRuns(throwaway.client, userId, options)
    const auth = new LocalAuthService(config, counter.client)
    const authorization = new PostgresAuthorizationService(counter.client)
    const conversations = new PostgresConversationRepository(counter.client)
    const runs = new PostgresRunRepository(counter.client)

    // 预热：先打开计数客户端的全部连接。驱动每建一条新连接会执行内部类型查询，
    // 不预热时 listTasks 并发打开连接会把这些查询计入结果。
    await Promise.all(Array.from({ length: countingConnections }, () => counter.client`select pg_sleep(0.05)`))
    await auth.authenticateApi(fakeRequest('GET', cookie), 'workbench')

    const record = async (path: string, note: string, run: () => Promise<unknown>) => {
      const result = await counter.measure(run)
      rows.push({ path, queries: result.queries, ms: result.ms, note })
    }
    await record('authenticateApi（本地账号会话，GET）', '每个 API 请求一次', () => auth.authenticateApi(fakeRequest('GET', cookie), 'workbench'))
    await record('authorizeWorkbench（个人空间）', '多数业务路由再调一次；个人 SSE 有新事件时也调', () =>
      authorization.authorizeWorkbench({ userId, workspaceId: seeded.workspaceId, allowArchived: true }))
    await record(`listTasks（${seeded.runCount} 个 Run，${options.sessions} 个会话×${options.runsPerSession} 轮）`, 'GET /tasks 的仓储部分，不含路由层 attachListRoles', () =>
      conversations.listTasks(userId))
    const runId = 'bench-run-0-0'
    await record('SSE 单次轮询：readEventsAfterEvent + getRun', '每个打开的运行流每 250ms 一次', async () => {
      await runs.readEventsAfterEvent(tenantId, runId, `${runId}-e5`)
      await runs.getRun(tenantId, runId)
    })
    await record('getTask（单个 Run 详情）', 'POST /runs 返回 202 前也调一次；未接推荐与 Skill 草稿读取，生产个人会话至少再多 2 条', () => conversations.getTask(runId, userId))

    // 并发：生产连接池 max 10、调度锁常驻占 1 条，实际可用 9 条。
    const pooled = createDatabase({ url: throwaway.url, maxConnections: 9 })
    try {
      const pooledConversations = new PostgresConversationRepository(pooled)
      const perCall = rows.find(row => row.path.startsWith('listTasks'))?.queries ?? 0
      await pooledConversations.listTasks(userId)
      for (const concurrency of [1, 3, 5]) {
        const startedAt = performance.now()
        await Promise.all(Array.from({ length: concurrency }, () => pooledConversations.listTasks(userId)))
        rows.push({
          path: `listTasks 并发 ${concurrency}（连接池 9）`, queries: perCall * concurrency,
          ms: Math.round(performance.now() - startedAt), note: '墙钟耗时；SQL 条数按单次实测推算',
        })
      }
    } finally {
      await pooled.end().catch(() => undefined)
    }
  } finally {
    await counter.client.end().catch(() => undefined)
    await throwaway.dispose()
  }

  const lines = [
    `# 平台热路径 SQL 条数基线`,
    '',
    `测量时间：${new Date().toISOString()}；一次性库；路径串行执行，每条为预热后的单次调用。`,
    '',
    '| 路径 | SQL 条数 | 耗时 ms | 说明 |',
    '| --- | ---: | ---: | --- |',
    ...rows.map(row => `| ${row.path} | ${row.queries} | ${row.ms} | ${row.note} |`),
    '',
  ]
  const report = lines.join('\n')
  if (options.out) writeFileSync(options.out, report)
  console.log(report)
}

await main()
