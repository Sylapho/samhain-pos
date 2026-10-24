package net.openid.appauth.internal

/** AppAuth 0.11.1 can log OAuth state and exception details. Disable its logger in all builds. */
internal object AppAuthLogPolicy {
    fun install() {
        Logger.setInstance(Logger(object : Logger.LogWrapper {
            override fun isLoggable(tag: String, level: Int) = false
            override fun println(level: Int, tag: String, message: String) {}
            override fun getStackTraceString(error: Throwable) = ""
        }))
    }
}
