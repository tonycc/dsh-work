import { handOffFileSave } from '../container/android'

/** 把下载到的文件存到本机：Android App 内交给原生，浏览器内用临时链接触发下载。 */
export async function saveBlobAsFile(blob: Blob, fileName: string) {
  if (await handOffFileSave(blob, fileName)) return
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
