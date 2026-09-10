import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext } from './checks/context.mjs'
import { checkProject } from './checks/project.mjs'
import { checkContracts } from './checks/contracts.mjs'
import { checkRuntime } from './checks/runtime.mjs'
import { checkSecurity } from './checks/security.mjs'
import { checkTeamWorkspace1a } from './checks/team-workspace-1a.mjs'

const groups = { project: checkProject, contracts: checkContracts, runtime: checkRuntime, security: checkSecurity, 'team-workspace-1a': checkTeamWorkspace1a }

export function verify(root, selected = Object.keys(groups)) {
  return selected.map(name => {
    if (!Object.hasOwn(groups, name)) throw new Error(`Unknown verification group: ${name}`)
    const check = createContext(root)
    groups[name](check)
    return { name, failures: [...check.failures] }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(argument => argument !== '--')
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: pnpm verify [project|contracts|runtime|security|team-workspace-1a ...]\nWithout arguments, checks all groups. Does not run tests or contact external services.')
  } else if (args.some(name => !Object.hasOwn(groups, name))) {
    console.error('Unknown verification group. Use pnpm verify --help.')
    process.exitCode = 2
  } else {
    const results = verify(resolve(import.meta.dirname, '..'), args.length ? args : undefined)
    for (const { name, failures } of results) {
      if (failures.length) {
        console.error(`${name} 检查失败：\n${failures.map(message => `- ${message}`).join('\n')}`)
        process.exitCode = 1
      } else console.log(`${name} 静态检查通过`)
    }
  }
}
