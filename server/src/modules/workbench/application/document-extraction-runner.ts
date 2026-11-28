import { extname } from 'node:path'
import { Worker } from 'node:worker_threads'

import { extractDocument, type DocumentExtractionResult } from './document-extractor.ts'

/** 需要解压与扫描二进制结构的格式放到工作线程；纯文本与 CSV 解析很轻，留在主线程。 */
const offThreadExtensions = new Set(['.pdf', '.docx', '.xlsx'])
// 与源码同扩展名：开发时直接跑 .ts，构建产物里是 .js。
const workerUrl = new URL(`./document-extractor-worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url)

type WorkerReply = { ok: true; result: DocumentExtractionResult } | { ok: false; message: string; code?: string }

/**
 * 解析上传文件。PDF / DOCX / XLSX 在独立工作线程中执行（同步 inflate 与正则提取最多处理几十 MB），
 * 主线程期间照常处理其他请求；结果与错误（含 code）与直接调用 extractDocument 一致。
 */
export async function extractDocumentOffThread(name: string, bytes: Buffer): Promise<DocumentExtractionResult> {
  if (!offThreadExtensions.has(extname(name).toLowerCase())) return extractDocument(name, bytes)
  const reply = await new Promise<WorkerReply>((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { name, bytes } })
    let settled = false
    worker.once('message', (message: WorkerReply) => { settled = true; resolve(message) })
    worker.once('error', error => { settled = true; reject(error) })
    worker.once('exit', code => {
      if (!settled) reject(new Error(`文件解析线程异常退出（${code}）`))
    })
  })
  if (reply.ok) return reply.result
  const error = new Error(reply.message) as Error & { code?: string }
  if (reply.code !== undefined) error.code = reply.code
  throw error
}
