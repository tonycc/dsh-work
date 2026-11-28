import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test'

// 全部浏览器套件共用这一份配置，每个套件是一个 Playwright project：
//   pnpm test:e2e                  P0 冒烟（project p0，不连接数据库）
//   pnpm test:e2e:<套件>           单个 P1 套件，例如 pnpm test:e2e:dingtalk
//   pnpm test:e2e:all              全部套件一次运行（CI），各套件在不同 worker 上并行
// 每个套件有自己的后端进程、Vite 与可丢弃数据库（P0 是内存夹具），端口互不重叠，所以套件之间可以并行；
// 套件内部仍按原来的方式串行（project 级 workers: 1），共享同一份夹具数据的用例不会互相干扰。
// 只启动被选中套件的服务：按命令行的 --project 过滤，没有 --project 时启动全部。

type App = 'admin' | 'workbench'
type Suite = {
  name: string
  /** 测试文件（相对 e2e/），P0 与 personal 用 testDir/testIgnore 另行指定。 */
  testMatch?: string
  testDir?: string
  testIgnore?: string[]
  retries?: number
  /** 后端夹具命令与健康检查地址。 */
  server: { command: string, url: string, timeout?: number, gracefulShutdown?: { signal: 'SIGTERM', timeout: number } }
  /** 需要的前端与就绪路径；baseURL 取第一个。 */
  apps: Array<{ app: App, port: string, readyPath: string, timeout?: number, command?: string }>
  /** 传给该套件全部进程的环境变量。 */
  env: Record<string, string>
}

// ---- P0：测试专用内存冒烟服务（scripts/testing/p0-smoke-server.ts），不读取 PostgreSQL 设置。
// 端口写回 process.env，测试 worker 也能读到（P0 用例用 DSH_WORK_ADMIN_PORT 拼管理端地址）。
const p0WorkbenchPort = process.env.DSH_WORK_WORKBENCH_PORT ||= '4274'
const p0AdminPort = process.env.DSH_WORK_ADMIN_PORT ||= '4280'
const p0ServerPort = process.env.DSH_WORK_SERVER_PORT ||= '4290'

const viteCommand = 'node node_modules/vite/bin/vite.js --host 127.0.0.1'
const fixtureCommand = (script: string, args = '') =>
  `node --env-file-if-exists=.env --experimental-strip-types scripts/testing/${script}${args ? ` ${args}` : ''}`
const port = (variable: string, fallback: string) => process.env[variable] ?? fallback
const sigterm = { signal: 'SIGTERM' as const, timeout: 10_000 }

/** 管理端 + 员工端都启动的身份类套件（本地账号、登录选项、钉钉）。 */
function identityEnvironment(adminPort: string, workbenchPort: string, serverPort: string) {
  return {
    DSH_WORK_SERVER_PORT: serverPort,
    DSH_WORK_ADMIN_PORT: adminPort,
    DSH_WORK_WORKBENCH_PORT: workbenchPort,
    VITE_ADMIN_URL: `http://localhost:${adminPort}`,
    VITE_WORKBENCH_URL: `http://localhost:${workbenchPort}`,
  }
}

/** MCP 管理与三个 Agent 套件共用同一个夹具，各自启动一份（各自的可丢弃数据库），互不共享数据。 */
function adminMcpSuite(name: string, testMatch: string, adminPort: string, serverPort: string): Suite {
  return {
    name,
    testMatch,
    server: { command: fixtureCommand('admin-mcp-connector-browser.ts'), url: `http://127.0.0.1:${serverPort}/health` },
    apps: [{ app: 'admin', port: adminPort, readyPath: '/connectors' }],
    env: { DSH_WORK_MCP_ADMIN_SERVER_PORT: serverPort, DSH_WORK_SERVER_PORT: serverPort, DSH_WORK_ADMIN_PORT: adminPort },
  }
}

const localAuth = {
  admin: port('DSH_WORK_LOCAL_AUTH_ADMIN_PORT', '4680'),
  workbench: port('DSH_WORK_LOCAL_AUTH_WORKBENCH_PORT', '4674'),
  server: port('DSH_WORK_LOCAL_AUTH_SERVER_PORT', '4690'),
}
const loginOptions = {
  admin: port('DSH_WORK_LOGIN_OPTIONS_ADMIN_PORT', '4780'),
  workbench: port('DSH_WORK_LOGIN_OPTIONS_WORKBENCH_PORT', '4774'),
  server: port('DSH_WORK_LOGIN_OPTIONS_SERVER_PORT', '4790'),
}
const dingtalk = {
  admin: port('DSH_WORK_DINGTALK_E2E_ADMIN_PORT', '4681'),
  workbench: port('DSH_WORK_DINGTALK_E2E_WORKBENCH_PORT', '4675'),
  server: port('DSH_WORK_DINGTALK_E2E_SERVER_PORT', '4691'),
  fake: port('DSH_WORK_DINGTALK_E2E_FAKE_PORT', '4699'),
}

export const suites: Suite[] = [
  {
    name: 'p0',
    testIgnore: ['**/personal-integration/**', '**/*.integration.spec.ts'],
    // P0 用例通过 POST /api/testing/p0/reset 重置同一份内存夹具，套件内必须串行（见 project 级 workers）。
    retries: process.env.CI ? 1 : 0,
    server: { command: 'node --experimental-strip-types scripts/testing/p0-smoke-server.ts', url: `http://localhost:${p0ServerPort}/health`, timeout: 30_000 },
    apps: [
      { app: 'workbench', port: p0WorkbenchPort, readyPath: '/workbench', timeout: 30_000, command: 'pnpm dev:workbench' },
      { app: 'admin', port: p0AdminPort, readyPath: '/overview', timeout: 30_000, command: 'pnpm dev:admin' },
    ],
    env: {
      NODE_ENV: 'development',
      DSH_WORK_WORKBENCH_PORT: p0WorkbenchPort,
      DSH_WORK_ADMIN_PORT: p0AdminPort,
      DSH_WORK_SERVER_PORT: p0ServerPort,
      VITE_ADMIN_URL: `http://localhost:${p0AdminPort}`,
      VITE_WORKBENCH_URL: `http://localhost:${p0WorkbenchPort}`,
      VITE_ADMIN_API_BASE_URL: '/api/admin/v1',
      VITE_WORKBENCH_API_BASE_URL: '/api/workbench/v1',
    },
  },
  {
    name: 'local-auth',
    testMatch: 'local-auth.integration.spec.ts',
    server: { command: fixtureCommand('local-auth-browser.ts'), url: `http://127.0.0.1:${localAuth.server}/health`, gracefulShutdown: sigterm },
    apps: [
      { app: 'admin', port: localAuth.admin, readyPath: '/login' },
      { app: 'workbench', port: localAuth.workbench, readyPath: '/login' },
    ],
    env: {
      DSH_WORK_LOCAL_AUTH_ADMIN_PORT: localAuth.admin,
      DSH_WORK_LOCAL_AUTH_WORKBENCH_PORT: localAuth.workbench,
      DSH_WORK_LOCAL_AUTH_SERVER_PORT: localAuth.server,
      ...identityEnvironment(localAuth.admin, localAuth.workbench, localAuth.server),
    },
  },
  {
    name: 'login-options',
    testMatch: 'login-options.integration.spec.ts',
    server: { command: fixtureCommand('local-auth-browser.ts', '--accounts'), url: `http://127.0.0.1:${loginOptions.server}/health`, gracefulShutdown: sigterm },
    apps: [
      { app: 'admin', port: loginOptions.admin, readyPath: '/login' },
      { app: 'workbench', port: loginOptions.workbench, readyPath: '/login' },
    ],
    env: {
      // 夹具脚本复用本地账号套件，按 DSH_WORK_LOCAL_AUTH_* 读取端口。
      DSH_WORK_LOCAL_AUTH_ADMIN_PORT: loginOptions.admin,
      DSH_WORK_LOCAL_AUTH_WORKBENCH_PORT: loginOptions.workbench,
      DSH_WORK_LOCAL_AUTH_SERVER_PORT: loginOptions.server,
      ...identityEnvironment(loginOptions.admin, loginOptions.workbench, loginOptions.server),
    },
  },
  {
    // 假钉钉开放平台 HTTP 服务（e2e/catalog/dingtalk.md），不是真实钉钉验收。
    name: 'dingtalk',
    testMatch: 'dingtalk.integration.spec.ts',
    server: { command: fixtureCommand('dingtalk-browser.ts'), url: `http://127.0.0.1:${dingtalk.server}/health`, gracefulShutdown: sigterm },
    apps: [
      { app: 'admin', port: dingtalk.admin, readyPath: '/login' },
      { app: 'workbench', port: dingtalk.workbench, readyPath: '/login' },
    ],
    env: {
      DSH_WORK_DINGTALK_E2E_ADMIN_PORT: dingtalk.admin,
      DSH_WORK_DINGTALK_E2E_WORKBENCH_PORT: dingtalk.workbench,
      DSH_WORK_DINGTALK_E2E_SERVER_PORT: dingtalk.server,
      DSH_WORK_DINGTALK_E2E_FAKE_PORT: dingtalk.fake,
      ...identityEnvironment(dingtalk.admin, dingtalk.workbench, dingtalk.server),
    },
  },
  (() => {
    const web = port('DSH_WORK_PERSONAL_WEB_PORT', '4374')
    const server = port('DSH_WORK_PERSONAL_SERVER_PORT', '4390')
    return {
      name: 'personal',
      testDir: './e2e/personal-integration',
      server: { command: 'node --experimental-strip-types scripts/testing/personal-workbench-browser.ts', url: `http://127.0.0.1:${server}/health` },
      apps: [{ app: 'workbench', port: web, readyPath: '/workbench' }],
      env: { DSH_WORK_SERVER_PORT: server, DSH_WORK_WORKBENCH_PORT: web },
    } satisfies Suite
  })(),
  (() => {
    // 专用可丢弃 PostgreSQL、测试身份与合成 Runtime；不连接真实 DSH/模型。
    const web = port('DSH_WORK_PROJECT_SPACE_WEB_PORT', '4376')
    const server = port('DSH_WORK_PROJECT_SPACE_SERVER_PORT', '4394')
    return {
      name: 'project-space',
      testMatch: 'project-space.integration.spec.ts',
      server: { command: fixtureCommand('project-space-browser.ts'), url: `http://127.0.0.1:${server}/health`, timeout: 90_000 },
      apps: [{ app: 'workbench', port: web, readyPath: '/workbench' }],
      env: { DSH_WORK_PROJECT_SPACE_SERVER_PORT: server, DSH_WORK_SERVER_PORT: server, DSH_WORK_WORKBENCH_PORT: web },
    } satisfies Suite
  })(),
  adminMcpSuite('mcp-admin', 'admin-mcp-connector.integration.spec.ts',
    port('DSH_WORK_MCP_ADMIN_WEB_PORT', '4380'), port('DSH_WORK_MCP_ADMIN_SERVER_PORT', '4392')),
  (() => {
    const web = port('DSH_WORK_SKILL_REVIEW_WEB_PORT', '4384')
    const server = port('DSH_WORK_SKILL_REVIEW_SERVER_PORT', '4395')
    return {
      name: 'skill-review',
      testMatch: 'skill-submission-review.integration.spec.ts',
      server: { command: fixtureCommand('skill-submission-review-browser.ts'), url: `http://127.0.0.1:${server}/health` },
      apps: [{ app: 'admin', port: web, readyPath: '/skills/review' }],
      env: { DSH_WORK_SKILL_REVIEW_SERVER_PORT: server, DSH_WORK_SERVER_PORT: server, DSH_WORK_ADMIN_PORT: web },
    } satisfies Suite
  })(),
  (() => {
    const web = port('DSH_WORK_AUTOMATION_WEB_PORT', '4375')
    const server = port('DSH_WORK_AUTOMATION_SERVER_PORT', '4391')
    return {
      name: 'automation',
      testMatch: 'automation.integration.spec.ts',
      server: { command: fixtureCommand('automation-workbench-browser.ts'), url: `http://127.0.0.1:${server}/health` },
      apps: [{ app: 'workbench', port: web, readyPath: '/automations' }],
      env: { DSH_WORK_AUTOMATION_SERVER_PORT: server, DSH_WORK_SERVER_PORT: server, DSH_WORK_WORKBENCH_PORT: web },
    } satisfies Suite
  })(),
  adminMcpSuite('agent-principal', 'agent-principal.integration.spec.ts',
    port('DSH_WORK_AGENT_PRINCIPAL_WEB_PORT', '4381'), port('DSH_WORK_AGENT_PRINCIPAL_SERVER_PORT', '4396')),
  adminMcpSuite('agent-capabilities', 'agent-capabilities.integration.spec.ts',
    port('DSH_WORK_AGENT_CAPABILITIES_WEB_PORT', '4382'), port('DSH_WORK_AGENT_CAPABILITIES_SERVER_PORT', '4397')),
  adminMcpSuite('agent-routines', 'agent-routines.integration.spec.ts',
    port('DSH_WORK_AGENT_ROUTINES_WEB_PORT', '4383'), port('DSH_WORK_AGENT_ROUTINES_SERVER_PORT', '4398')),
]

/** 命令行 --project 选中的套件名（支持 --project a b、--project=a 与 * 通配，大小写不敏感）；没有则为全部。 */
export function selectedSuites(argv = process.argv): Suite[] {
  const patterns: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument.startsWith('--project=')) patterns.push(argument.slice('--project='.length))
    else if (argument === '--project') {
      while (argv[index + 1] && !argv[index + 1].startsWith('-')) patterns.push(argv[++index])
    }
  }
  if (!patterns.length) return suites
  const matchers = patterns.flatMap(value => value.split(',')).map(pattern =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'))
  const chosen = suites.filter(suite => matchers.some(matcher => matcher.test(suite.name)))
  return chosen.length ? chosen : suites
}

function webServers(suite: Suite): NonNullable<PlaywrightTestConfig['webServer']> {
  const reuseExistingServer = false
  return [
    { command: suite.server.command, url: suite.server.url, env: suite.env, reuseExistingServer, timeout: suite.server.timeout ?? 60_000, ...(suite.server.gracefulShutdown ? { gracefulShutdown: suite.server.gracefulShutdown } : {}) },
    ...suite.apps.map(app => ({
      command: app.command ?? viteCommand,
      ...(app.command ? {} : { cwd: `apps/${app.app}-web` }),
      url: `http://localhost:${app.port}${app.readyPath}`,
      // 同一应用的多个 Vite 可能同时运行，依赖预构建缓存按套件分开（apps/*/node_modules/.vite-e2e/<套件>）。
      env: { ...suite.env, DSH_WORK_VITE_CACHE_DIR: `node_modules/.vite-e2e/${suite.name}` },
      reuseExistingServer,
      timeout: app.timeout ?? 60_000,
    })),
  ]
}

const chromium = {
  ...devices['Desktop Chrome'],
  launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  // 每个套件 1 个 worker（见 projects[].workers），多个套件同时运行。CI 机器 4 核。
  workers: process.env.CI ? 4 : '50%',
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: suites.map(suite => ({
    name: suite.name,
    workers: 1,
    ...(suite.testDir ? { testDir: suite.testDir } : {}),
    ...(suite.testMatch ? { testMatch: suite.testMatch } : {}),
    ...(suite.testIgnore ? { testIgnore: suite.testIgnore } : {}),
    ...(suite.retries !== undefined ? { retries: suite.retries } : {}),
    use: {
      ...chromium,
      baseURL: `http://localhost:${suite.apps[0].port}`,
      ...(suite.name === 'p0' ? { video: 'retain-on-failure' as const } : {}),
    },
  })),
  webServer: selectedSuites().flatMap(webServers),
})
