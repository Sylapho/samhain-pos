package __APP_PACKAGE__

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SupabaseConfigurationTest {
    private fun build(config: String, mode: String = "android-test") =
        """{"schemaVersion":1,"mode":"$mode","supabase":$config}"""

    @Test fun absentAndMalformedConfigurationNeverThrow() {
        assertEquals("not_configured", SupabaseConfiguration.parse(build("""{"status":"not_configured"}""")).status)
        for (json in listOf("", "{}", "{broken", build("""{"status":"configured"}"""))) {
            val config = SupabaseConfiguration.parse(json)
            assertEquals("invalid", config.status)
            assertNull(config.url)
            assertNull(config.publishableKey)
        }
    }

    @Test fun validPublicConfigIsAvailableWithoutWebViewOrAuth() {
        val config = SupabaseConfiguration.parse(build("""{"status":"configured","environment":"test","url":"https://test.supabase.co","publishableKey":"sb_publishable_fixture"}"""))
        assertEquals("configured", config.status)
        assertEquals("https://test.supabase.co", config.url)
        assertEquals("sb_publishable_fixture", config.publishableKey)
    }

    @Test fun refusesSecretsHttpAndTestProjectInProduction() {
        val valid = """{"status":"configured","environment":"test","url":"https://test.supabase.co","publishableKey":"sb_publishable_fixture"}"""
        for (json in listOf(build(valid, "production"), build(valid.replace("https:", "http:")), build(valid.replace("sb_publishable_fixture", "sb_secret_fixture")), build(valid.replace("https://test.supabase.co", "https://user:pass@test.supabase.co")))) {
            assertEquals("invalid", SupabaseConfiguration.parse(json).status)
        }
    }
}
