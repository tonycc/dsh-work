export interface FileSafetyScannerPort {
  scan(input: { name: string; mimeType: string; bytes: Buffer }): Promise<{ clean: boolean; reason?: string }>
}

/** MVP baseline scanner. Production deployments replace this port with the enterprise AV service. */
export class BaselineFileSafetyScanner implements FileSafetyScannerPort {
  async scan(input: { name: string; mimeType: string; bytes: Buffer }) {
    const bytes = input.bytes
    const executable =
      bytes.subarray(0, 2).toString('ascii') === 'MZ'
      || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || ['feedface', 'feedfacf', 'cafebabe'].includes(bytes.subarray(0, 4).toString('hex'))
    if (executable) return { clean: false, reason: '检测到可执行文件签名' }
    if (input.name.includes('\0') || input.mimeType.includes('x-msdownload')) {
      return { clean: false, reason: '文件元数据不安全' }
    }
    return { clean: true }
  }
}
