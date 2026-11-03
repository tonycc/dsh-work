import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 服务启动时从 `server/config` 读取的定义（DSH 配置、执行脚本、内置 Skill、Agent 预置等）必须随发布包交付。
 * 规则按目录而非逐项登记：`server/config` 下除测试文件外的每个文件都必须被打包脚本复制，新增配置不会被遗漏。
 */
export function serverConfigFiles(root) {
  const configRoot = resolve(root, 'server/config')
  if (!existsSync(configRoot)) return []
  return readdirSync(configRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && !/\.test\.[cm]?[jt]s$/.test(entry.name))
    .map(entry => `server/config/${join(entry.parentPath ?? entry.path, entry.name).slice(configRoot.length + 1).split('\\').join('/')}`)
    .sort()
}

/** 打包脚本中以 `${project_root}/…` 引用的源路径。 */
export function releaseCopySources(script) {
  return [...script.matchAll(/"\$\{project_root\}\/([^"$]+)"/g)].map(match => match[1].replace(/\/$/, ''))
}

/** 没有被任何复制源（文件本身或其上级目录）覆盖的配置文件。 */
export function uncoveredConfigFiles(root) {
  const sources = releaseCopySources(readFileSync(resolve(root, 'scripts/release/build-release.sh'), 'utf8'))
  return serverConfigFiles(root).filter(file => !sources.some(source => file === source || file.startsWith(`${source}/`)))
}

/** 发布包中缺少的配置文件。 */
export function missingBundleFiles(root, bundle) {
  return serverConfigFiles(root).filter(file => !existsSync(resolve(bundle, file)))
}
