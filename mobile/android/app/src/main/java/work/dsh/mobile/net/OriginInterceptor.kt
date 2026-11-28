package work.dsh.mobile.net

import okhttp3.Interceptor
import okhttp3.Response

/**
 * 服务端对写请求校验 `Origin` 必须是已登记的员工端地址（request-security.ts）。
 * 原生请求统一带上服务器地址的 Origin；读请求不需要。
 */
class OriginInterceptor(private val origin: String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.method in safeMethods) return chain.proceed(request)
        return chain.proceed(request.newBuilder().header("Origin", origin).build())
    }

    private companion object {
        val safeMethods = setOf("GET", "HEAD", "OPTIONS")
    }
}
