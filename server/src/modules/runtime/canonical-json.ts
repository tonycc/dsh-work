import { createHash } from 'node:crypto'

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => normalize(item))
  if (value === null || typeof value !== 'object') return value

  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key]
    if (item !== undefined) normalized[key] = normalize(item)
  }
  return normalized
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
