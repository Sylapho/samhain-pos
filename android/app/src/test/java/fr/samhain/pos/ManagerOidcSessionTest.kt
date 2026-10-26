package fr.samhain.pos

import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ManagerOidcSessionTest {
    private class Transport(private val verify: () -> JSONObject) : ApiAuthTransport {
        override fun get(path: String, token: String?): JSONObject {
            assertEquals("/api/v1/auth/manager", path)
            assertEquals("test-manager-token", token)
            assertNotEquals(Looper.getMainLooper(), Looper.myLooper())
            return verify()
        }
        override fun post(path: String, token: String?, body: JSONObject): JSONObject = error("unexpected POST")
        override fun signed(path: String, token: String?, raw: String, nonce: String, signature: String): JSONObject = error("unexpected signed request")
    }

    @Test fun tokenCallbackVerifiesOnWorkerBeforeAcceptingCredential() {
        assertEquals(Looper.getMainLooper(), Looper.myLooper())
        val executor = Executors.newSingleThreadExecutor()
        val calls = AtomicInteger()
        val session = ManagerOidcSession(ApplicationProvider.getApplicationContext<Context>(), Transport {
            calls.incrementAndGet()
            JSONObject().put("authenticated", true)
        }, executor)
        val done = CountDownLatch(1)
        val result = AtomicReference<String>()
        try {
            assertFalse(session.isAuthenticated())
            session.verifyManager("test-manager-token", System.currentTimeMillis() + 60000, 0) {
                result.set(it.getString("status")); done.countDown()
            }
            assertTrue(done.await(5, TimeUnit.SECONDS))
            assertEquals(1, calls.get())
            assertEquals("authenticated", result.get())
            assertEquals("test-manager-token", session.token())
            assertTrue(session.isAuthenticated())
            session.logout()
            assertFalse(session.isAuthenticated())
        } finally { session.dispose(); executor.shutdownNow() }
    }

    @Test fun readingStatusDuringVerificationDoesNotCancelLogin() {
        val executor = Executors.newSingleThreadExecutor()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val done = CountDownLatch(1)
        val result = AtomicReference<String>()
        val session = ManagerOidcSession(ApplicationProvider.getApplicationContext<Context>(), Transport {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            JSONObject().put("authenticated", true)
        }, executor)
        try {
            session.verifyManager("test-manager-token", System.currentTimeMillis() + 60000, 0) {
                result.set(it.getString("status")); done.countDown()
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertFalse(session.isAuthenticated())
            release.countDown()
            assertTrue(done.await(5, TimeUnit.SECONDS))
            assertEquals("authenticated", result.get())
            assertTrue(session.isAuthenticated())
        } finally { release.countDown(); session.dispose(); executor.shutdownNow() }
    }

    @Test fun logoutDuringVerificationPreventsLateCredentialAcceptance() {
        val executor = Executors.newSingleThreadExecutor()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val done = CountDownLatch(1)
        val result = AtomicReference<String>()
        val session = ManagerOidcSession(ApplicationProvider.getApplicationContext<Context>(), Transport {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            JSONObject().put("authenticated", true)
        }, executor)
        try {
            session.verifyManager("test-manager-token", System.currentTimeMillis() + 60000, 0) {
                result.set(it.getString("status")); done.countDown()
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            session.logout()
            release.countDown()
            assertTrue(done.await(5, TimeUnit.SECONDS))
            assertEquals("authorization_denied", result.get())
            assertFalse(session.isAuthenticated())
            assertThrows(TabletAuthFailure::class.java) { session.token() }
        } finally { release.countDown(); session.dispose(); executor.shutdownNow() }
    }

    @Test fun serverRefusalDoesNotRetainCredential() {
        val executor = Executors.newSingleThreadExecutor()
        val session = ManagerOidcSession(ApplicationProvider.getApplicationContext<Context>(), Transport {
            JSONObject().put("authenticated", false)
        }, executor)
        val done = CountDownLatch(1)
        val result = AtomicReference<String>()
        try {
            session.verifyManager("test-manager-token", System.currentTimeMillis() + 60000, 0) {
                result.set(it.getString("status")); done.countDown()
            }
            assertTrue(done.await(5, TimeUnit.SECONDS))
            assertEquals("authorization_denied", result.get())
            assertThrows(TabletAuthFailure::class.java) { session.token() }
        } finally { session.dispose(); executor.shutdownNow() }
    }
}
