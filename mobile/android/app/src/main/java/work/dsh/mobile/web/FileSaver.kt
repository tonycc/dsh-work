package work.dsh.mobile.web

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.util.Base64
import android.widget.Toast

/** 把员工端交来的文件写入系统“下载”目录（Android 10+ 的 MediaStore，无需存储权限），再尝试用系统应用打开。 */
object FileSaver {
    fun save(context: Context, fileName: String, mimeType: String, base64: String) {
        val uri = runCatching { write(context, safeName(fileName), mimeType, Base64.decode(base64, Base64.DEFAULT)) }.getOrNull()
        if (uri == null) {
            Toast.makeText(context, "保存失败，请重试", Toast.LENGTH_SHORT).show()
            return
        }
        Toast.makeText(context, "已保存到“下载”：$fileName", Toast.LENGTH_SHORT).show()
        val open = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mimeType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(Intent.createChooser(open, "打开文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            // 没有能打开该类型的应用：文件已在“下载”里。
        }
    }

    /** 去掉路径分隔与控制字符；空名称用“下载文件”。 */
    fun safeName(fileName: String): String {
        val cleaned = fileName.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().take(120)
        return cleaned.ifEmpty { "下载文件" }
    }

    private fun write(context: Context, fileName: String, mimeType: String, bytes: ByteArray): Uri? {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
            put(MediaStore.Downloads.MIME_TYPE, mimeType)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
        resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return null
        resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        return uri
    }
}
