import type { DataProtectionCategory, DataProtectionPolicy, DataProtectionTerm } from './data-protection-types.ts'

export interface DetectedValue {
  value: string
  category: DataProtectionCategory
}

interface Rule {
  category: DataProtectionCategory
  pattern: RegExp
  /** 取值的捕获组；缺省为整个匹配。 */
  group?: number
  validate?: (value: string) => boolean
}

/** 值两侧不能紧贴字母或数字（方案 5.3 误报控制）。 */
const START = '(?<![A-Za-z0-9])'
const END = '(?![A-Za-z0-9])'

/** 示例、变量引用等不是真实取值，字段上下文规则不认定为密钥（命中会拦截消息，宁可少报这些明显的非取值）。 */
const NON_VALUES = new Set(['null', 'undefined', 'none', 'true', 'false', 'password', 'example', 'placeholder', 'string', 'required', 'optional'])

function isFieldValue(value: string): boolean {
  if (/^[$<{%]/.test(value) || /^your/i.test(value) || /^([x*.])\1+$/i.test(value)) return false
  return !NON_VALUES.has(value.toLowerCase())
}

function isIdentityCard(value: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const sum = weights.reduce((total, weight, index) => total + weight * Number(value[index]), 0)
  return '10X98765432'[sum % 11] === value[17]?.toUpperCase()
}

function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2
    sum += digit
  }
  return sum % 10 === 0
}

/** 按类别优先级排列：同一个值命中多条规则时取最前的类别。 */
const SECRET_RULES: readonly Rule[] = [
  { category: 'secret', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { category: 'secret', pattern: new RegExp(`${START}(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|dshwg_[A-Za-z0-9_-]{20,})${END}`, 'g') },
  { category: 'secret', pattern: new RegExp(`${START}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}${END}`, 'g') },
  { category: 'secret', pattern: new RegExp(`${START}Bearer\\s+([A-Za-z0-9._~+/-]{16,}=*)`, 'gi'), group: 1, validate: isFieldValue },
  // 连接串只遮盖其中的密码，保留主机与库名供模型理解。
  { category: 'secret', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi, group: 1, validate: isFieldValue },
  // 中英文字段表述：只取值部分；值限 ASCII，“密码是否正确”这样的普通中文不会命中。
  { category: 'secret', pattern: new RegExp(`(?:${START}(?:password|passwd|pwd|passphrase|secret|api[_-]?key|access[_-]?key|token)|密码|口令|密钥|令牌)["'”]?\\s*(?:[:：=]|为|是)\\s*["'“]?((?:(?!["'\`,;])[!-~]){6,})`, 'gi'), group: 1, validate: isFieldValue },
]

const PERSONAL_RULES: readonly Rule[] = [
  { category: 'personal', pattern: new RegExp(`${START}[1-9]\\d{5}(?:18|19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]${END}`, 'g'), validate: isIdentityCard },
  { category: 'personal', pattern: new RegExp(`${START}1[3-9]\\d{9}${END}`, 'g') },
  { category: 'personal', pattern: new RegExp(`${START}\\d{16,19}${END}`, 'g'), validate: passesLuhn },
  { category: 'personal', pattern: new RegExp(`${START}\\d{4}(?:[ -]\\d{4}){3}(?:[ -]?\\d{1,3})?${END}`, 'g'), validate: passesLuhn },
  // 连接串里的 user:密码@主机 不是邮箱。
  { category: 'personal', pattern: new RegExp(`${START}(?<!:\\/\\/[^\\s/@]*)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}${END}`, 'g') },
]

/** UUID、长十六进制串（内容摘要、缓存键等）整体不参与匹配（方案 5.3）。 */
const IDENTIFIER_PATTERN = new RegExp(`${START}(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,})${END}`, 'gi')

export function identifierRanges(text: string): [number, number][] {
  return [...text.matchAll(IDENTIFIER_PATTERN)].map(match => [match.index, match.index + match[0].length])
}

/** 只有严格落在标识符内部的片段才排除；取值恰好就是整个标识符时（如 password=<hex>）仍算命中。 */
export function isIdentifierFragment(ranges: readonly [number, number][], start: number, end: number): boolean {
  return ranges.some(([from, to]) => start >= from && end <= to && (start !== from || end !== to))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function termAlternative(term: DataProtectionTerm): string {
  const escaped = escapeRegExp(term.value)
  return term.wholeWord ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])` : escaped
}

/** 词表合并为一条多模式表达式（长词在前），避免按词逐个扫描全文。 */
function termRules(terms: readonly DataProtectionTerm[]): Rule[] {
  const usable = terms.filter(term => term.value.length > 0).sort((a, b) => b.value.length - a.value.length)
  const build = (items: DataProtectionTerm[], flags: string): Rule[] => items.length === 0
    ? []
    : [{ category: 'term', pattern: new RegExp(items.map(termAlternative).join('|'), flags) }]
  return [...build(usable.filter(term => term.caseSensitive), 'gu'), ...build(usable.filter(term => !term.caseSensitive), 'giu')]
}

function collect(text: string, rules: readonly Rule[], policy: DataProtectionPolicy, found: Map<string, DataProtectionCategory>): void {
  const ranges = identifierRanges(text)
  const allowed = new Set(policy.allowlist.map(value => value.toLowerCase()))
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[rule.group ?? 0]
      if (!value || found.has(value) || allowed.has(value.toLowerCase())) continue
      if (rule.validate && !rule.validate(value)) continue
      const start = rule.group ? match.index + match[0].lastIndexOf(value) : match.index
      if (isIdentifierFragment(ranges, start, start + value.length)) continue
      found.set(value, rule.category)
    }
  }
}

/** 收集一段文本中命中的值，追加到 found（先出现的类别优先）。 */
export function detectInto(text: string, policy: DataProtectionPolicy, found: Map<string, DataProtectionCategory>): void {
  collect(text, [...SECRET_RULES, ...PERSONAL_RULES, ...termRules(policy.terms)], policy, found)
}

/** 只查密钥类别，供输入预检使用（D10）。 */
export function detectSecrets(text: string, policy: DataProtectionPolicy): DetectedValue[] {
  const found = new Map<string, DataProtectionCategory>()
  collect(text, SECRET_RULES, policy, found)
  return [...found].map(([value, category]) => ({ value, category }))
}
