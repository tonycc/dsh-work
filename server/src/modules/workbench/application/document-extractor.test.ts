import assert from 'node:assert/strict'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { describe, it } from 'node:test'

import { extractDocument } from './document-extractor.ts'

describe('document extractor', () => {
  it('preserves quoted CSV fields and reports the row count', () => {
    const result = extractDocument('inventory.csv', Buffer.from('物料,说明,库存\nA-01,"华东,成品",120\n'))
    assert.equal(result.detectedType, 'csv')
    assert.equal(result.rowCount, 2)
    assert.match(result.text, /A-01\t华东,成品\t120/)
  })

  it('extracts DOCX paragraph text from a valid Office container', () => {
    const bytes = createStoredZip({
      'word/document.xml': Buffer.from(
        '<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>供应链风险</w:t></w:r></w:p><w:p><w:r><w:t>缺料 3 项</w:t></w:r></w:p></w:body></w:document>',
      ),
    })
    const result = extractDocument('report.docx', bytes)
    assert.equal(result.detectedType, 'docx')
    assert.match(result.text, /供应链风险\n缺料 3 项/)
  })

  it('extracts shared and numeric XLSX cells', () => {
    const bytes = createStoredZip({
      'xl/sharedStrings.xml': Buffer.from('<sst><si><t>物料</t></si><si><t>A-01</t></si></sst>'),
      'xl/worksheets/sheet1.xml': Buffer.from(
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>库存</v></c></row><row><c t="s"><v>1</v></c><c><v>120</v></c></row></sheetData></worksheet>',
      ),
    })
    const result = extractDocument('inventory.xlsx', bytes)
    assert.equal(result.detectedType, 'xlsx')
    assert.equal(result.sheetCount, 1)
    assert.match(result.text, /物料\t库存/)
    assert.match(result.text, /A-01\t120/)
  })

  it('extracts basic PDF text operators and rejects disguised PDFs', () => {
    const result = extractDocument('report.pdf', Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (Inventory risk) Tj ET\n%%EOF', 'latin1'))
    assert.equal(result.detectedType, 'pdf')
    assert.equal(result.pageCount, 1)
    assert.match(result.text, /Inventory risk/)
    assert.throws(() => extractDocument('fake.pdf', Buffer.from('not a pdf')), /PDF 文件签名无效/)
  })

  it('rejects invalid UTF-8 and unterminated CSV quotes with actionable codes', () => {
    assert.throws(() => extractDocument('binary.txt', Buffer.from([0xff, 0xfe, 0x00])), errorWithCode('TEXT_BINARY_CONTENT'))
    assert.throws(() => extractDocument('broken.csv', Buffer.from('name,value\n"broken,1')), errorWithCode('CSV_QUOTE_INVALID'))
  })

  it('rejects compressed Office and PDF payloads before they can expand without bounds', () => {
    const oversizedOfficeXml = Buffer.alloc(32 * 1024 * 1024 + 1, 0x41)
    const office = createZip({ 'word/document.xml': oversizedOfficeXml }, 8)
    assert.throws(() => extractDocument('bomb.docx', office), errorWithCode('ZIP_ENTRY_TOO_LARGE'))

    const oversizedPdfStream = deflateSync(Buffer.alloc(8 * 1024 * 1024 + 1, 0x41))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj <</Filter /FlateDecode>>\nstream\n', 'latin1'),
      oversizedPdfStream,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ])
    assert.throws(() => extractDocument('bomb.pdf', pdf), errorWithCode('PDF_DECOMPRESSED_SIZE_LIMIT_EXCEEDED'))
  })
})

function errorWithCode(code: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === code
}

function createStoredZip(entries: Record<string, Buffer>) {
  return createZip(entries, 0)
}

function createZip(entries: Record<string, Buffer>, method: 0 | 8) {
  const localParts: Buffer[] = []
  const directoryParts: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name)
    const checksum = crc32(content)
    const payload = method === 8 ? deflateRawSync(content) : content
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, payload)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(method, 10)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(payload.length, 20)
    directory.writeUInt32LE(content.length, 24)
    directory.writeUInt16LE(nameBytes.length, 28)
    directory.writeUInt32LE(offset, 42)
    directoryParts.push(directory, nameBytes)
    offset += local.length + nameBytes.length + payload.length
  }
  const directory = Buffer.concat(directoryParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, directory, end])
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
