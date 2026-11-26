import { describe, expect, it } from 'vitest'

import source from './main.ts?raw'

// 管理端同样接入升级后旧标签页的懒加载恢复（行为单测见员工端 src/utils/chunk-reload.test.ts）。
describe('admin main.ts', () => {
  it('installs chunk reload recovery on the router after the error reporter', () => {
    expect(source).toMatch(/import \{[^}]*\binstallChunkReloadRecovery\b[^}]*\} from '@dsh-work\/ui-core'/)
    expect(source.indexOf('installChunkReloadRecovery(router)')).toBeGreaterThan(source.indexOf('reporter.install(app)'))
  })
})
