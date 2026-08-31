import assert from 'node:assert/strict'
import { test } from 'node:test'

import { redactSensitiveText, sanitizeSafeMetadata } from './safe-observability.ts'

test('safe metadata recursively redacts secret-bearing keys but preserves usage counters', () => {
  const sanitized = sanitizeSafeMetadata({
    toolName: 'read',
    inputTokens: 42,
    output_tokens: 9,
    nested: {
      apiKey: 'sensitive-value-123',
      access_token: 'access-value-456',
      credentialValue: 'credential-value-789',
    },
  })

  assert.deepEqual(sanitized, {
    toolName: 'read',
    inputTokens: 42,
    output_tokens: 9,
    nested: {
      apiKey: '[REDACTED]',
      access_token: '[REDACTED]',
      credentialValue: '[REDACTED]',
    },
  })
})

test('free-form audit text redacts bearer tokens, assignments and URL credentials', () => {
  const value = redactSensitiveText(
    'Authorization: Bearer bearer-value-123 api_key=key-value-456 password:pass-value https://user:pass-value@internal.example/path',
  )
  assert.doesNotMatch(value, /bearer-value|key-value|pass-value/)
  assert.match(value, /Bearer \[REDACTED\]/)
  assert.match(value, /api_key=\[REDACTED\]/)
  assert.match(value, /https:\/\/user:\[REDACTED\]@internal\.example/)
})
