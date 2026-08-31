const redacted = '[REDACTED]'
export type SafeJsonValue = null | boolean | number | string | SafeJsonValue[] | { [key: string]: SafeJsonValue }
const sensitiveKeys = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'secretvalue',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'credentialvalue',
  'privatekey',
])

export function sanitizeSafeMetadata(value: unknown): SafeJsonValue {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(item => sanitizeSafeMetadata(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? redacted : sanitizeSafeMetadata(child),
    ])) as { [key: string]: SafeJsonValue }
  }
  if (typeof value === 'string') return redactSensitiveText(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  return String(value)
}

export function redactSensitiveText(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@/]+@/gi, '$1[REDACTED]@')
    .replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
}

function isSensitiveKey(key: string) {
  return sensitiveKeys.has(key.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase())
}
