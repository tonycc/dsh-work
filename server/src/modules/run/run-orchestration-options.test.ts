import assert from 'node:assert/strict'
import test from 'node:test'

import { RunOrchestrationService } from './run-orchestration-service.ts'

type Arguments = ConstructorParameters<typeof RunOrchestrationService>

// 运行参数 RP-S1：自动任务并发传函数时每次调度读取最新值；传数字或不传时保持固定值（默认 2）。
test('the automation lane limit is read on every schedule when given as a function', () => {
  const stub = {} as never
  const build = (options?: Arguments[9]) => new RunOrchestrationService(stub, stub, stub, stub, stub, stub, stub, stub, stub, options)
  const deps = (service: RunOrchestrationService) => (service as unknown as { deps: { automationMaxConcurrent: number } }).deps

  let limit = 3
  const live = deps(build({ automationMaxConcurrent: () => limit }))
  assert.equal(live.automationMaxConcurrent, 3)
  limit = 5
  assert.equal(live.automationMaxConcurrent, 5)
  assert.equal(deps(build({ automationMaxConcurrent: 4 })).automationMaxConcurrent, 4)
  assert.equal(deps(build()).automationMaxConcurrent, 2)
})
