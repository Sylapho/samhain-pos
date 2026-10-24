package fr.samhain.pos

import android.util.JsonReader
import android.util.JsonToken
import java.io.StringReader
import org.json.JSONArray
import org.json.JSONObject

/** Android JSONObject alone accepts duplicate keys, trailing input and non-JSON syntax. */
internal object StrictApiJson {
    fun parse(raw: String): JSONObject = JsonReader(StringReader(raw)).use { reader ->
        reader.isLenient = false
        val value = read(reader, 0)
        require(reader.peek() == JsonToken.END_DOCUMENT && value is JSONObject)
        value
    }

    private fun read(reader: JsonReader, depth: Int): Any {
        require(depth <= 64)
        return when (reader.peek()) {
            JsonToken.BEGIN_OBJECT -> JSONObject().also { result ->
                reader.beginObject()
                val seen = mutableSetOf<String>()
                while (reader.hasNext()) {
                    val key = text(reader.nextName())
                    require(seen.add(key))
                    result.put(key, read(reader, depth + 1))
                }
                reader.endObject()
            }
            JsonToken.BEGIN_ARRAY -> JSONArray().also { result ->
                reader.beginArray()
                while (reader.hasNext()) result.put(read(reader, depth + 1))
                reader.endArray()
            }
            JsonToken.STRING -> text(reader.nextString())
            JsonToken.NUMBER -> {
                val number = java.math.BigDecimal(reader.nextString())
                require(number.abs() <= java.math.BigDecimal("9007199254740991"))
                number
            }
            JsonToken.BOOLEAN -> reader.nextBoolean()
            JsonToken.NULL -> { reader.nextNull(); JSONObject.NULL }
            else -> error("INVALID_JSON")
        }
    }

    private fun text(value: String): String {
        var index = 0
        while (index < value.length) {
            val char = value[index++]
            require(char != '\u0000' && !Character.isLowSurrogate(char))
            if (Character.isHighSurrogate(char)) require(index < value.length && Character.isLowSurrogate(value[index++]))
        }
        return value
    }
}
