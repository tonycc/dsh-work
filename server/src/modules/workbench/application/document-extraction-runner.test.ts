import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'

import { extractDocument } from './document-extractor.ts'
import { extractDocumentOffThread } from './document-extraction-runner.ts'

/** 最小的 ZIP（单个 deflate 条目），足够组成 DOCX。 */
function zip(entries: Record<string, string>) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8')
    const data = deflateRawSync(raw)
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

test('工作线程解析 DOCX 的结果与主线程一致', async () => {
  const docx = zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>安全库存不低于七天用量</w:t></w:r></w:p></w:body></w:document>' })
  let direct: unknown
  try { direct = extractDocument('库存.docx', docx) } catch (error) { direct = { error: (error as Error).message } }
  let offThread: unknown
  try { offThread = await extractDocumentOffThread('库存.docx', docx) } catch (error) { offThread = { error: (error as Error).message } }
  assert.deepEqual(offThread, direct)
})

test('工作线程里的解析错误带回原错误码', async () => {
  await assert.rejects(extractDocumentOffThread('损坏.pdf', Buffer.from('not a pdf')), (error: Error & { code?: string }) => {
    let expected: Error & { code?: string } | undefined
    try { extractDocument('损坏.pdf', Buffer.from('not a pdf')) } catch (cause) { expected = cause as Error & { code?: string } }
    return error.message === expected?.message && error.code === expected?.code
  })
})

test('纯文本仍在主线程解析', async () => {
  assert.equal((await extractDocumentOffThread('a.txt', Buffer.from('你好'))).text, '你好')
})
