package fr.samhain.pos

import androidx.sqlite.db.SupportSQLiteDatabase
import java.text.Normalizer
import java.util.Locale

internal fun normalizedCategoryLabel(label: String): String =
    Normalizer.normalize(label, Normalizer.Form.NFD).replace(Regex("\\p{M}"), "")
        .lowercase(Locale.ROOT).trim().replace(Regex("[\\s\\p{Z}]+"), " ")

// Seeds are shared by migration and restart repair; existing rows always win.
internal fun seedMissingCategories(db: SupportSQLiteDatabase) {
    val existingIds = mutableSetOf<String>()
    val existingNames = mutableSetOf<String>()
    var nextOrder = 0
    db.query("SELECT id, normalized_label, display_order FROM categories").use { cursor ->
        while (cursor.moveToNext()) {
            existingIds.add(cursor.getString(0))
            existingNames.add(cursor.getString(1))
            nextOrder = maxOf(nextOrder, cursor.getInt(2) + 1)
        }
    }
    fun ensure(id: String, name: String, active: Boolean, order: Int) {
        if (existingIds.contains(id)) return
        var label = name
        while (existingNames.contains(normalizedCategoryLabel(label))) label += " ($id)"
        db.execSQL("INSERT INTO categories (id, label, normalized_label, active, display_order) VALUES (?, ?, ?, ?, ?)",
            arrayOf<Any>(id, label, normalizedCategoryLabel(label), if (active) 1 else 0, order))
        existingIds.add(id)
        existingNames.add(normalizedCategoryLabel(label))
        nextOrder = maxOf(nextOrder, order + 1)
    }
    listOf(
        "menus" to "Menus", "assiettes" to "Assiettes", "desserts" to "Desserts",
        "boissons-chaudes" to "Boissons chaudes", "bieres" to "Bières", "sans-alcool" to "Sans alcool",
    ).forEachIndexed { index, (id, label) -> ensure(id, label, true, index) }
    db.query("SELECT DISTINCT category_id FROM products ORDER BY category_id").use { cursor ->
        while (cursor.moveToNext()) {
            val id = cursor.getString(0)
            // Unknown historical references stay stored, without inventing a commercial name.
            ensure(id, id, false, nextOrder)
        }
    }
}
