package fr.samhain.pos

import java.math.BigDecimal
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

object CanonicalJson {
    fun stringify(value: Any?): String =
        when (value) {
            null, JSONObject.NULL -> "null"
            is String -> JSONObject.quote(value)
            is Boolean -> value.toString()
            is Number -> canonicalNumber(value)
            is JSONArray ->
                (0 until value.length()).joinToString(
                    separator = ",",
                    prefix = "[",
                    postfix = "]",
                ) {
                    stringify(value.get(it))
                }
            is JSONObject ->
                value.keys().asSequence().toList().sorted().joinToString(
                    separator = ",",
                    prefix = "{",
                    postfix = "}",
                ) { key -> "${JSONObject.quote(key)}:${stringify(value.get(key))}" }
            else -> throw IllegalArgumentException("Type JSON non pris en charge: ${value::class.java.name}")
        }

    fun sha256(value: JSONObject): String =
        MessageDigest.getInstance("SHA-256")
            .digest(stringify(value).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    private fun canonicalNumber(value: Number): String {
        val decimal = BigDecimal(value.toString())
        require(decimal.toDouble().isFinite()) { "Nombre JSON invalide." }
        return decimal.stripTrailingZeros().toPlainString()
    }
}
