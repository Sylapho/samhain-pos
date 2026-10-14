package fr.samhain.pos

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Frozen vectors shared with the TS/SQL ingestion tests, using Android's actual JSONObject. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CanonicalJsonConformanceTest {
    @Test
    fun canonicalHashMatchesServerAndroidVector() {
        val value = JSONObject().put("previousHash", JSONObject.NULL)
            .put("n", 9007199254740991L).put("id", "é😀</x>/")
        assertEquals("""{"id":"é😀<\/x>\/","n":9007199254740991,"previousHash":null}""", CanonicalJson.stringify(value))
        assertEquals("97dedfa5fa794d60f77027e737c065e809e9fb68466f7b8e3db14207c53d784b", CanonicalJson.sha256(value))
    }

    @Test
    fun utf16KeysControlsAndLineSeparatorsRemainHistorical() {
        val value = JSONObject().put("\ue000", 1).put("😀", 2)
        assertEquals("{\"😀\":2,\"\ue000\":1}", CanonicalJson.stringify(value))
        assertEquals("{\"s\":\"é😀\u2028\u2029\\n\\u0001\"}",
            CanonicalJson.stringify(JSONObject().put("s", "é😀\u2028\u2029\n\u0001")))
    }
}
