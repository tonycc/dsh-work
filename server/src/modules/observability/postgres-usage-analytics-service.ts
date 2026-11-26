import type { PendingQuery, Row } from 'postgres'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { RELEASE_TRIAL_PURPOSE, UNASSIGNED_DEPARTMENT } from '../../domain/model-usage.ts'
import {
  PAGE_VIEW_DEDUPE_MINUTES,
  PRODUCT_EVENT_RETENTION_DAYS,
  USAGE_PEOPLE_LIMIT,
  USAGE_RANGE_DAYS,
  type IdlePerson,
  type UsageAnalyticsQueryPort,
  type UsageEntry,
  type UsageFilter,
  type UsageOverview,
  type UsagePeople,
  type UsagePerson,
  type UsagePersonDetail,
  type UsageRange,
} from '../../domain/usage-analytics.ts'

const tenantId = 'tenant-dsh-work'
const PURGE_BATCH = 5_000
const UNKNOWN_AGENT = '未知 AI 同事'

export interface PageViewInput { page: string; inDingtalk: boolean }

interface PersonRow {
  userId: string; name: string; department: string; lastActiveAt: Date | null; activeDays: number; conversations: number
  runs: number; succeededRuns: number; finishedRuns: number; tokens: number; topAgent: string | null; topPage: string | null
}

const iso = (value: Date | string | null) => value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString()

function toPerson(row: PersonRow): UsagePerson {
  return {
    userId: row.userId, name: row.name, department: row.department, lastActiveAt: iso(row.lastActiveAt),
    activeDays: Number(row.activeDays), conversations: Number(row.conversations), runs: Number(row.runs),
    succeededRuns: Number(row.succeededRuns), finishedRuns: Number(row.finishedRuns), tokens: Number(row.tokens),
    topAgent: row.topAgent, topPage: row.topPage,
  }
}

/**
 * 运营概览的使用情况（OBS-S2）。员工活动 = 期间内本人发起的员工侧运行（对话、项目空间、定时任务、主动任务；
 * 不含发布试运行、管理助手与系统运行）、新建的员工端对话与员工端页面访问。时间按平台时区按天划分。
 */
export class PostgresUsageAnalyticsService implements UsageAnalyticsQueryPort {
  private readonly database: DatabaseClient
  private readonly timezone: string

  constructor(database: DatabaseClient, timezone: string) {
    this.database = database
    this.timezone = timezone
  }

  /** 记录页面访问；同一员工同一端同一页面 30 分钟内只记一次。 */
  async recordPageViews(userId: string, app: 'workbench' | 'admin', views: readonly PageViewInput[]): Promise<number> {
    let recorded = 0
    for (const view of views) {
      const result = await this.database`
        insert into product_events (tenant_id, user_id, app, page, in_dingtalk)
        select ${tenantId}, ${userId}, ${app}, ${view.page}, ${view.inDingtalk}
         where not exists (
           select 1 from product_events
            where tenant_id = ${tenantId} and user_id = ${userId} and app = ${app} and page = ${view.page}
              and occurred_at > now() - make_interval(mins => ${PAGE_VIEW_DEDUPE_MINUTES})
         )
      `
      recorded += result.count
    }
    return recorded
  }

  async purgeExpired(): Promise<{ removed: number }> {
    let removed = 0
    for (;;) {
      const result = await this.database`
        delete from product_events where id in (
          select id from product_events
           where tenant_id = ${tenantId} and occurred_at < now() - make_interval(days => ${PRODUCT_EVENT_RETENTION_DAYS})
           limit ${PURGE_BATCH}
        )
      `
      removed += result.count
      if (result.count < PURGE_BATCH) return { removed }
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  async overview(filter: UsageFilter): Promise<UsageOverview> {
    const sql = this.database
    const tz = this.timezone
    const days = USAGE_RANGE_DAYS[filter.range]
    const scope = this.scope(filter)
    const [windowRows, totals, daily, agents, pages, entries, failures, departments, options] = await Promise.all([
      sql<{ from: string; to: string }[]>`
        select to_char(now() at time zone ${tz} - make_interval(days => ${days - 1}), 'YYYY-MM-DD') as "from",
               to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as "to"
      `,
      sql<UsageOverview['totals'][]>`
        ${scope}
        select (select count(*) from people)::integer as employees,
               (select count(distinct user_id) from activity)::integer as "activeEmployees",
               0::float8 as "averageDailyActive",
               (select count(*) from employee_sessions)::integer as "newConversations",
               (select count(*) from employee_runs)::integer as runs,
               (select count(*) from employee_runs where status = 'succeeded')::integer as "succeededRuns",
               (select count(*) from employee_runs where status in ('succeeded', 'failed', 'cancelled'))::integer as "finishedRuns",
               (select coalesce(sum(mu.input_tokens + mu.output_tokens), 0) from model_usage_events mu
                  join employee_runs r on r.id = mu.run_id where mu.tenant_id = ${tenantId})::float8 as tokens,
               (select count(distinct user_id) from employee_views where in_dingtalk)::integer as "dingtalkEmployees"
      `,
      sql<{ day: string; activeEmployees: number; runs: number }[]>`
        ${scope},
        days as (
          select to_char(d, 'YYYY-MM-DD') as day
            from generate_series((now() at time zone ${tz})::date - ${days - 1}::integer, (now() at time zone ${tz})::date, interval '1 day') d
        )
        select days.day,
               (select count(distinct user_id) from activity a where to_char(a.at at time zone ${tz}, 'YYYY-MM-DD') = days.day)::integer as "activeEmployees",
               (select count(*) from employee_runs r where to_char(r.created_at at time zone ${tz}, 'YYYY-MM-DD') = days.day)::integer as runs
          from days order by days.day
      `,
      sql<{ name: string; runs: number; people: number }[]>`
        ${scope}
        select agent_name as name, count(*)::integer as runs, count(distinct user_id)::integer as people
          from employee_runs group by agent_name order by runs desc, name limit 10
      `,
      sql<{ page: string; people: number; views: number }[]>`
        ${scope}
        select page, count(distinct user_id)::integer as people, count(*)::integer as views
          from employee_views group by page order by people desc, views desc, page limit 10
      `,
      sql<{ entry: UsageEntry; runs: number }[]>`
        ${scope}
        select entry, count(*)::integer as runs from employee_runs group by entry order by runs desc
      `,
      sql<{ code: string; runs: number }[]>`
        ${scope}
        select coalesce(error_code, 'UNKNOWN') as code, count(*)::integer as runs
          from employee_runs where status = 'failed' group by 1 order by runs desc limit 8
      `,
      sql<{ name: string; employees: number; activeEmployees: number }[]>`
        ${scope}
        select p.department as name, count(*)::integer as employees,
               count(*) filter (where exists (select 1 from activity a where a.user_id = p.user_id))::integer as "activeEmployees"
          from people p group by p.department order by employees desc, name
      `,
      sql<{ name: string }[]>`
        select distinct coalesce(nullif(btrim(department_id), ''), ${UNASSIGNED_DEPARTMENT}) as name
          from users where tenant_id = ${tenantId} and status = 'active' order by 1
      `,
    ])
    const totalsRow = totals[0]!
    const averageDailyActive = daily.length
      ? Math.round(daily.reduce((sum, item) => sum + item.activeEmployees, 0) / daily.length * 10) / 10
      : 0
    return {
      range: filter.range,
      from: windowRows[0]!.from,
      to: windowRows[0]!.to,
      totals: { ...totalsRow, tokens: Number(totalsRow.tokens), averageDailyActive },
      daily: [...daily],
      agents: [...agents],
      pages: [...pages],
      entries: [...entries],
      failures: [...failures],
      departments: [...departments],
      departmentOptions: options.map(row => row.name),
    }
  }

  async people(filter: UsageFilter): Promise<UsagePeople> {
    const sql = this.database
    const scope = this.scope(filter)
    const [active, idle] = await Promise.all([
      this.personRows(filter),
      sql<(Omit<IdlePerson, 'createdAt' | 'lastActiveAt'> & { createdAt: Date; lastActiveAt: Date | null })[]>`
        ${scope}
        select p.user_id as "userId", p.name, p.department, p.created_at as "createdAt",
               greatest(
                 (select max(created_at) from runs r where r.tenant_id = ${tenantId} and r.requested_by = p.user_id),
                 (select max(created_at) from sessions s where s.tenant_id = ${tenantId} and s.created_by = p.user_id and s.audience = 'workbench'),
                 (select max(occurred_at) from product_events e where e.tenant_id = ${tenantId} and e.user_id = p.user_id and e.app = 'workbench')
               ) as "lastActiveAt"
          from people p
         where not exists (select 1 from activity a where a.user_id = p.user_id)
         order by "lastActiveAt" asc nulls first, p.name
         limit ${USAGE_PEOPLE_LIMIT}
      `,
    ])
    return {
      active,
      idle: idle.map(row => ({ ...row, createdAt: iso(row.createdAt)!, lastActiveAt: iso(row.lastActiveAt) })),
    }
  }

  async person(userId: string, range: UsageRange): Promise<UsagePersonDetail | null> {
    const sql = this.database
    const tz = this.timezone
    const days = USAGE_RANGE_DAYS[range]
    const filter: UsageFilter = { range }
    const [summary] = await this.personRows(filter, userId)
    if (!summary) return null
    const scope = this.scope(filter, userId)
    const [daily, pages, entries] = await Promise.all([
      sql<{ day: string; runs: number }[]>`
        ${scope},
        days as (
          select to_char(d, 'YYYY-MM-DD') as day
            from generate_series((now() at time zone ${tz})::date - ${days - 1}::integer, (now() at time zone ${tz})::date, interval '1 day') d
        )
        select days.day,
               (select count(*) from employee_runs r where to_char(r.created_at at time zone ${tz}, 'YYYY-MM-DD') = days.day)::integer as runs
          from days order by days.day
      `,
      sql<{ page: string; views: number }[]>`
        ${scope}
        select page, count(*)::integer as views from employee_views group by page order by views desc, page limit 10
      `,
      sql<{ entry: UsageEntry; runs: number }[]>`
        ${scope}
        select entry, count(*)::integer as runs from employee_runs group by entry order by runs desc
      `,
    ])
    return { ...summary, daily: [...daily], pages: [...pages], entries: [...entries] }
  }

  private async personRows(filter: UsageFilter, userId?: string): Promise<UsagePerson[]> {
    const sql = this.database
    const tz = this.timezone
    const rows = await sql<PersonRow[]>`
      ${this.scope(filter, userId)}
      select p.user_id as "userId", p.name, p.department,
             (select max(at) from activity a where a.user_id = p.user_id) as "lastActiveAt",
             (select count(distinct to_char(a.at at time zone ${tz}, 'YYYY-MM-DD')) from activity a where a.user_id = p.user_id)::integer as "activeDays",
             (select count(*) from employee_sessions s where s.user_id = p.user_id)::integer as conversations,
             (select count(*) from employee_runs r where r.user_id = p.user_id)::integer as runs,
             (select count(*) from employee_runs r where r.user_id = p.user_id and r.status = 'succeeded')::integer as "succeededRuns",
             (select count(*) from employee_runs r where r.user_id = p.user_id and r.status in ('succeeded', 'failed', 'cancelled'))::integer as "finishedRuns",
             (select coalesce(sum(mu.input_tokens + mu.output_tokens), 0) from model_usage_events mu
                join employee_runs r on r.id = mu.run_id where mu.tenant_id = ${tenantId} and r.user_id = p.user_id)::float8 as tokens,
             (select agent_name from employee_runs r where r.user_id = p.user_id
               group by agent_name order by count(*) desc, agent_name limit 1) as "topAgent",
             (select page from employee_views v where v.user_id = p.user_id
               group by page order by count(*) desc, page limit 1) as "topPage"
        from people p
       where exists (select 1 from activity a where a.user_id = p.user_id)
       order by "lastActiveAt" desc nulls last, p.name
       limit ${USAGE_PEOPLE_LIMIT}
    `
    return rows.map(toPerson)
  }

  /** 公共 CTE：员工、期间内的员工侧运行、新建对话、页面访问与合并后的活动。 */
  private scope(filter: UsageFilter, userId?: string): PendingQuery<Row[]> {
    const sql = this.database
    const tz = this.timezone
    const days = USAGE_RANGE_DAYS[filter.range]
    const department = sql`coalesce(nullif(btrim(u.department_id), ''), ${UNASSIGNED_DEPARTMENT})`
    return sql`
      with bounds as (
        select (date_trunc('day', now() at time zone ${tz}) - make_interval(days => ${days - 1})) at time zone ${tz} as from_at
      ),
      people as (
        select u.id as user_id, u.display_name as name, ${department} as department, u.created_at
          from users u
         where u.tenant_id = ${tenantId} and u.status = 'active'
           ${filter.department ? sql`and ${department} = ${filter.department}` : sql``}
           ${userId ? sql`and u.id = ${userId}` : sql``}
      ),
      employee_runs as (
        select r.id, r.requested_by as user_id, r.status, r.created_at, ra.error_code,
               case when t.source_type = 'automation' then 'automation'
                    when t.source_type = 'agent_routine' then 'routine'
                    when w.workspace_type = 'team' then 'project'
                    else 'personal' end as entry,
               coalesce(ag.name, ${UNKNOWN_AGENT}) as agent_name
          from runs r
          join people p on p.user_id = r.requested_by
          left join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
          left join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = r.current_attempt_id
          left join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
          left join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
          left join agent_versions av on av.tenant_id = r.tenant_id
                 and av.id = coalesce(ra.manifest->>'agent_version_id', s.agent_version_id)
          left join agents ag on ag.tenant_id = av.tenant_id and ag.id = av.agent_id
         where r.tenant_id = ${tenantId} and r.created_at >= (select from_at from bounds)
           and coalesce(ra.manifest->>'purpose', '') <> ${RELEASE_TRIAL_PURPOSE}
           and (s.audience = 'workbench' or t.source_type in ('automation', 'agent_routine'))
      ),
      employee_sessions as (
        select s.id, s.created_by as user_id, s.created_at
          from sessions s join people p on p.user_id = s.created_by
         where s.tenant_id = ${tenantId} and s.audience = 'workbench' and s.created_at >= (select from_at from bounds)
           -- 发布试运行的会话不是员工对话。
           and not exists (
             select 1 from runs tr join run_attempts ta on ta.tenant_id = tr.tenant_id and ta.run_id = tr.id
              where tr.tenant_id = s.tenant_id and tr.session_id = s.id and ta.manifest->>'purpose' = ${RELEASE_TRIAL_PURPOSE}
           )
      ),
      employee_views as (
        select e.user_id, e.page, e.in_dingtalk, e.occurred_at
          from product_events e join people p on p.user_id = e.user_id
         where e.tenant_id = ${tenantId} and e.app = 'workbench' and e.occurred_at >= (select from_at from bounds)
      ),
      activity as (
        select user_id, created_at as at from employee_runs
        union all select user_id, created_at from employee_sessions
        union all select user_id, occurred_at from employee_views
      )
    `
  }
}
