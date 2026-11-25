import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 只允许 Harness home 的 `.env` 设置的代理变量（DSH app-boot 的 HOME_LAYER_PROXY_NAMES，按大写比较）。 */
const PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'])

/** DSH 实际使用的 Harness home：启动环境中的 `DSH_HOME`，否则 `~/.dsh`（DSH home-paths 的默认值）。 */
export function dshHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_HOME']?.trim()
  return configured ? configured : join(homedir(), '.dsh')
}

/**
 * 读取网页方案 6.3：DSH 在每次启动时读取 `$DSH_HOME/.env`，其中的代理会让 `web_fetch` 对域名跳过公网地址校验。
 * 平台启动 DSH 时不传代理变量（ACP 启动只继承白名单环境变量），因此只需检查这个文件。
 * 文件不存在视为无代理；其他读取错误视为有代理（失败即关闭，本次不装配读取网页）。
 */
export async function dshHomeProxyConfigured(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  let content: string
  try {
    content = await readFile(join(dshHomeDirectory(env), '.env'), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  return content.split(/\r?\n/).some(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || !PROXY_NAMES.has(match[1]!.toUpperCase())) return false
    const value = match[2]!.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    return value.length > 0
  })
}
