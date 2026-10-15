package __APP_PACKAGE__

import java.security.MessageDigest
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

/** Transport quoting is independent of Android's financial ledger quoting. */
internal object SyncProtocol {
    const val MAX_BODY = 1048576
    const val MAX_PAYLOAD = 262144
    private val hashPattern = Regex("[0-9a-f]{64}")
    private val uuidPattern = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

    fun canonical(value: Any?): String = when(value) {
        null, JSONObject.NULL -> "null"
        is String -> quote(value)
        is Boolean -> value.toString()
        is Number -> java.math.BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { quote(it) + ":" + canonical(value.get(it)) }
        else -> error("INVALID_PAYLOAD")
    }

    private fun quote(value: String): String = buildString {
        append('"')
        value.forEach { c -> when(c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if(c.code < 32) append("\\u%04x".format(c.code)) else append(c)
        } }
        append('"')
    }

    fun sha(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun ledgerProfile(payload: JSONObject): String {
        val unsigned = JSONObject(payload.toString()).apply { remove("hash") }
        val hash = payload.getString("hash")
        if (CanonicalJson.sha256(unsigned) == hash) return "android-ledger-v1"
        if (sha(canonical(unsigned)) == hash) return "ts-ledger-v1"
        error("CANONICALIZATION_UNSUPPORTED")
    }

    fun event(row: OutboxEntry): JSONObject = JSONObject().apply {
        put("eventId", row.eventId); put("eventType",row.eventType)
        put("ledgerSchemaVersion", if(row.sequence == null) JSONObject.NULL else 1)
        put("sourceTerminalId", row.sourceTerminalId ?: JSONObject.NULL)
        put("sequence", row.sequence ?: JSONObject.NULL); put("hash",row.hash ?: JSONObject.NULL)
        put("previousHash",row.previousHash ?: JSONObject.NULL)
        put("ledgerCanonicalization",row.ledgerCanonicalization ?: JSONObject.NULL)
        put("payloadCanonical",row.payloadCanonical)
        put("transportFingerprint",row.transportFingerprint ?: JSONObject.NULL)
    }

    fun fingerprint(row: OutboxEntry, scope: JSONObject): String {
        val value = event(row).apply { remove("transportFingerprint") }
        listOf("organizationId","festivalId","chainId").forEach { value.put(it,scope.get(it)) }
        value.put("protocolVersion",1)
        return sha(canonical(value))
    }

    fun envelope(scope: JSONObject, requestId: String): JSONObject = JSONObject().apply {
        put("protocolVersion",1); put("requestId",requestId)
        listOf("organizationId","festivalId","chainId","installationId","enrollmentGeneration").forEach { put(it,scope.get(it)) }
    }

    fun validateContext(request: JSONObject, response: JSONObject) {
        require(safeSequence(response.get("protocolVersion")) == 1L)
        listOf("requestId","organizationId","festivalId","chainId").forEach { require(response.get(it) == request.get(it)) }
    }

    fun safeSequence(value: Any): Long {
        require(value is Number)
        val decimal = java.math.BigDecimal(value.toString())
        val n = decimal.longValueExact()
        require(n in 0..9007199254740991L)
        return n
    }

    fun validateHead(head: JSONObject) {
        val sequence = safeSequence(head.get("sequence"))
        require(if(sequence == 0L) head.get("hash") == JSONObject.NULL else hashPattern.matches(head.getString("hash")))
    }

    fun validateAck(request: JSONObject, response: JSONObject): Map<String, JSONObject> {
        validateContext(request,response)
        require(response.get("committed") == true)
        val head = response.getJSONObject("serverHead")
        validateHead(head)
        val sent = request.getJSONArray("events")
        val acks = response.getJSONArray("acknowledgements")
        require(acks.length() == sent.length())
        val byId = mutableMapOf<String,JSONObject>()
        for(i in 0 until acks.length()) {
            val ack = acks.getJSONObject(i)
            require(byId.put(ack.getString("eventId"),ack) == null)
            require(ack.getString("status") in setOf("accepted","already_present"))
            require(uuidPattern.matches(ack.getString("receiptId")))
            val received = ack.getString("serverReceivedAt")
            require(received.endsWith("Z")); Instant.parse(received)
            require(hashPattern.matches(ack.getString("transportFingerprint")))
        }
        for(i in 0 until sent.length()) {
            val event = sent.getJSONObject(i)
            val ack = byId[event.getString("eventId")] ?: error("INVALID_ACK")
            listOf("sequence","hash","transportFingerprint").forEach { field ->
                require(if(field == "sequence" && event.get(field) != JSONObject.NULL) safeSequence(ack.get(field)) == safeSequence(event.get(field)) else ack.get(field) == event.get(field))
            }
            if(event.get("sequence") != JSONObject.NULL) {
                val seq = safeSequence(ack.get("sequence"))
                require(hashPattern.matches(ack.getString("hash")))
                val headSeq = safeSequence(head.get("sequence"))
                require(headSeq >= seq)
                if(headSeq == seq) require(head.get("hash") == ack.get("hash"))
            } else require(ack.get("hash") == JSONObject.NULL)
        }
        return byId
    }
}
