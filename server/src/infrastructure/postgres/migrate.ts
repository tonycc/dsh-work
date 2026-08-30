import { createDatabase } from './database.ts'
import { runMigrations } from './migration-runner.ts'

const databaseUrl = process.env.DSH_WORK_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_DATABASE_URL 未配置')

const database = createDatabase({ url: databaseUrl, maxConnections: 1 })
try {
  const results = await runMigrations(database)
  for (const result of results) {
    console.log(`${result.applied ? 'applied' : 'skipped'} ${result.version}`)
  }
} finally {
  await database.end()
}
