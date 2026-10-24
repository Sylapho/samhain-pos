package __APP_PACKAGE__

import android.net.Uri
import java.io.FilterOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import net.openid.appauth.connectivity.ConnectionBuilder

/** AppAuth keeps TLS validation; this adds finite transport and response bounds. */
internal object OidcConnectionBuilder : ConnectionBuilder {
    private val deadlines = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "samhain-oidc-timeout").apply { isDaemon = true }
    }
    override fun openConnection(uri: Uri): HttpURLConnection {
        require(uri.scheme == "https" && uri.userInfo == null && uri.fragment == null)
        val real = URL(uri.toString()).openConnection() as HttpsURLConnection
        real.instanceFollowRedirects = false
        real.connectTimeout = 15000; real.readTimeout = 15000
        val deadline = deadlines.schedule({ real.disconnect() }, 30, java.util.concurrent.TimeUnit.SECONDS)
        return object : HttpURLConnection(real.url) {
            override fun connect() = real.connect()
            override fun usingProxy() = real.usingProxy()
            override fun disconnect() { deadline.cancel(false); real.disconnect() }
            override fun setRequestMethod(value: String) { real.requestMethod = value }
            override fun setRequestProperty(name: String, value: String) = real.setRequestProperty(name, value)
            override fun getRequestProperty(name: String): String? = real.getRequestProperty(name)
            override fun setDoOutput(value: Boolean) { real.doOutput = value }
            override fun setDoInput(value: Boolean) { real.doInput = value }
            override fun getResponseCode() = real.responseCode
            override fun getOutputStream(): OutputStream = object : FilterOutputStream(real.outputStream) {
                private var count = 0
                override fun write(value: Int) { if (++count > 16384) throw IOException("OIDC request bound"); out.write(value) }
                override fun write(bytes: ByteArray, offset: Int, length: Int) {
                    if (count + length > 16384) throw IOException("OIDC request bound")
                    count += length; out.write(bytes, offset, length)
                }
            }
            private fun bounded(input: InputStream?): InputStream {
                if (input == null) { disconnect(); throw IOException("OIDC response absent") }
                try {
                    val bytes = input.use {
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(4096)
                        while (true) {
                            val size = it.read(buffer)
                            if (size < 0) break
                            if (output.size() + size > 65536) throw IOException("OIDC response bound")
                            output.write(buffer, 0, size)
                        }
                        output.toByteArray()
                    }
                    if (bytes.size > 65536) throw IOException("OIDC response bound")
                    return java.io.ByteArrayInputStream(bytes)
                } finally { disconnect() }
            }
            override fun getInputStream(): InputStream = bounded(real.inputStream)
            override fun getErrorStream(): InputStream = bounded(real.errorStream)
        }
    }
}
