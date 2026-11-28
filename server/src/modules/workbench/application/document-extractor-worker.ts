import { parentPort, workerData } from 'node:worker_threads'

import { extractDocument } from './document-extractor.ts'

/** 在工作线程里解析上传文件，解压与大正则不占主线程的事件循环。 */
const { name, bytes } = workerData as { name: string; bytes: Uint8Array }
try {
  parentPort!.postMessage({ ok: true, result: extractDocument(name, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) })
} catch (cause) {
  const error = cause as Error & { code?: string }
  parentPort!.postMessage({ ok: false, message: error?.message ?? String(cause), code: error?.code })
}
