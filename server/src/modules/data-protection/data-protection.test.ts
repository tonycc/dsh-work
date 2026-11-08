import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PlaceholderRestorer, deriveTenantKey, inspectMessageForSecrets, maskTexts } from './data-protection-masking.ts'
import { DataProtectionUnavailableError, type DataProtectionPolicy } from './data-protection-types.ts'

const policy: DataProtectionPolicy = { terms: [], allowlist: [] }
const tenantKey = deriveTenantKey(Buffer.alloc(32, 7), 'tenant-a')
const mask = (texts: string[], override: Partial<DataProtectionPolicy> = {}) => maskTexts(texts, { tenantKey, policy: { ...policy, ...override } })
const maskOne = (text: string, override: Partial<DataProtectionPolicy> = {}) => mask([text], override).texts[0]!
const term = (value: string, caseSensitive = false, wholeWord = false) => ({ value, caseSensitive, wholeWord })

describe('识别规则', () => {
  const secrets: [string, string][] = [
    ['OpenAI 风格密钥', 'key sk-abcdefghijklmnopqrstuvwx1234'],
    ['AWS', 'AKIAIOSFODNN7EXAMPLE'],
    ['GitHub', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl'],
    ['私钥块', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'],
  ]
  for (const [name, text] of secrets) {
    it(`识别 ${name}`, () => assert.equal(mask([text]).counts.secret, 1))
  }

  it('字段表述只遮盖取值', () => {
    assert.match(maskOne('密码为 Abc#2026x'), /^密码为 \{\{SECRET_[a-z2-7]{10}\}\}$/)
    assert.match(maskOne('token: abcd1234ef'), /^token: \{\{SECRET_/)
    assert.match(maskOne('{"password":"Abc#2026x","a":1}'), /^\{"password":"\{\{SECRET_[a-z2-7]{10}\}\}","a":1\}$/)
  })

  it('连接串只遮盖密码', () => {
    assert.match(maskOne('postgres://app:S3cretPw@db.local:5432/main'), /^postgres:\/\/app:\{\{SECRET_[a-z2-7]{10}\}\}@db\.local:5432\/main$/)
  })

  it('普通中文和非取值不算密钥', () => {
    for (const text of ['密码是否正确', '请重置密码。', 'token: undefined', 'password: ${DB_PASSWORD}', 'password: your_password', 'max_tokens: 4096']) {
      assert.equal(mask([text]).counts.secret, 0, text)
    }
  })

  it('手机号、身份证校验位、银行卡 Luhn、邮箱', () => {
    assert.equal(mask(['电话 13812345678']).counts.personal, 1)
    assert.equal(mask(['11010519491231002X']).counts.personal, 1)
    assert.equal(mask(['110105194912310021']).counts.personal, 0, '校验位错误')
    assert.equal(mask(['4111111111111111']).counts.personal, 1)
    assert.equal(mask(['4111 1111 1111 1111']).counts.personal, 1)
    assert.equal(mask(['4111111111111112']).counts.personal, 0, 'Luhn 错误')
    assert.equal(mask(['a.b@example.com']).counts.personal, 1)
  })

  it('标识符整体不参与匹配，值不能紧贴字母数字', () => {
    assert.equal(mask(['550e8400-e29b-41d4-a716-138123456780']).counts.personal, 0)
    assert.equal(mask(['ab13812345678cd']).counts.personal, 0)
    const hex = 'a'.repeat(10) + '13812345678' + 'b'.repeat(20)
    assert.equal(maskOne(`电话 13812345678 摘要 ${hex}`).includes(hex), true, '其他位置命中的值也不替换标识符内部')
  })

  it('字段的取值恰好是整个十六进制串时仍算命中', () => {
    assert.equal(mask([`password=${'ab12'.repeat(10)}`]).counts.secret, 1)
  })

  it('词表支持大小写与整词选项', () => {
    assert.equal(mask(['Project Falcon'], { terms: [term('falcon')] }).counts.term, 1)
    assert.equal(mask(['Project Falcon'], { terms: [term('falcon', true)] }).counts.term, 0)
    assert.equal(mask(['falcons'], { terms: [term('falcon', false, true)] }).counts.term, 0)
    assert.equal(mask(['falcon!'], { terms: [term('falcon', false, true)] }).counts.term, 1)
    assert.equal(mask(['客户华星科技'], { terms: [term('华星科技')] }).counts.term, 1)
  })

  it('白名单整值放行，不区分大小写', () => {
    assert.equal(mask(['a.b@example.com'], { allowlist: ['A.B@EXAMPLE.COM'] }).counts.personal, 0)
  })
})

describe('遮盖', () => {
  it('请求内全文遮盖：依赖上下文识别的值在其他位置单独出现时也遮盖', () => {
    const result = mask(['密码为 Abc#2026x', '刚才那个 Abc#2026x 不对'])
    const placeholder = [...result.placeholders.keys()][0]!
    assert.equal(result.texts[1], `刚才那个 ${placeholder} 不对`)
    assert.equal(result.counts.secret, 2)
  })

  it('占位符确定，换租户则不同', () => {
    const first = maskOne('13812345678')
    assert.equal(maskOne('13812345678'), first)
    const other = maskTexts(['13812345678'], { tenantKey: deriveTenantKey(Buffer.alloc(32, 7), 'tenant-b'), policy }).texts[0]
    assert.notEqual(other, first)
  })

  it('词表更新后下一次请求即生效', () => {
    assert.equal(mask(['华星科技']).counts.term, 0)
    assert.equal(mask(['华星科技'], { terms: [term('华星科技')] }).counts.term, 1)
  })

  it('短码碰撞时拒绝，错误信息不带取值', () => {
    assert.throws(
      () => maskTexts(['13812345678 13912345678'], { tenantKey, policy, shortCode: () => 'aaaaaaaaaa' }),
      (error: unknown) => error instanceof DataProtectionUnavailableError && error.code === 'DATA_POLICY_UNAVAILABLE' && !error.message.includes('138'),
    )
  })

  it('识别异常时失败即关闭', () => {
    const broken = { allowlist: [], get terms(): never { throw new Error('13812345678') } }
    assert.throws(() => maskTexts(['x'], { tenantKey, policy: broken }), DataProtectionUnavailableError)
  })

  it('原文中的占位符形式被转义，不计入命中，可还原', () => {
    const literal = '{{SECRET_abcdefghij}}'
    const result = mask([`解释 ${literal}`])
    assert.equal(result.counts.secret, 0)
    assert.equal(result.texts[0]!.includes(literal), false)
    const restorer = new PlaceholderRestorer(result.placeholders)
    assert.equal(restorer.push(result.texts[0]!) + restorer.flush(), `解释 ${literal}`)
  })
})

describe('输入预检', () => {
  it('只报告密钥，不因个人信息或词表拦截', () => {
    assert.equal(inspectMessageForSecrets('sk-abcdefghijklmnopqrstuvwx1234', policy).secretCount, 1)
    assert.equal(inspectMessageForSecrets('13812345678 华星科技', { terms: [term('华星科技')], allowlist: [] }).secretCount, 0)
  })

  it('白名单中的值不拦截', () => {
    assert.equal(inspectMessageForSecrets('密码为 Abc#2026x', { terms: [], allowlist: ['abc#2026x'] }).secretCount, 0)
  })
})

describe('流式还原', () => {
  const placeholders = new Map([['{{SECRET_abcdefghij}}', 'va"lue']])

  it('任意切分都能还原，普通文本不被扣住', () => {
    const text = '前 {{SECRET_abcdefghij}} 后 { {{ 末'
    for (let size = 1; size <= text.length; size += 1) {
      const restorer = new PlaceholderRestorer(placeholders)
      let output = ''
      for (let index = 0; index < text.length; index += size) output += restorer.push(text.slice(index, index + size))
      assert.equal(output + restorer.flush(), '前 va"lue 后 { {{ 末')
    }
    assert.equal(new PlaceholderRestorer(placeholders).push('普通文本'), '普通文本')
  })

  it('只扣住可能的占位符开头', () => {
    const restorer = new PlaceholderRestorer(placeholders)
    assert.equal(restorer.push('abc{{SEC'), 'abc')
    assert.equal(restorer.flush(), '{{SEC')
  })

  it('未知占位符原样保留，还原时按目标格式转义', () => {
    const restorer = new PlaceholderRestorer(placeholders, value => JSON.stringify(value).slice(1, -1))
    assert.equal(restorer.push('{{TERM_zzzzzzzzzz}}{{SECRET_abcdefghij}}') + restorer.flush(), '{{TERM_zzzzzzzzzz}}va\\"lue')
  })
})
