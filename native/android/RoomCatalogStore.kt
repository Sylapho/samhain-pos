package __APP_PACKAGE__

import java.time.Instant
import java.util.concurrent.Callable
import org.json.JSONArray
import org.json.JSONObject

class RoomCatalogStore(private val database: SamhainPosDatabase) {
    private val products = database.productDao()
    private val categories = database.categoryDao()
    private val metadata = database.catalogMetadataDao()
    private val distribution = database.catalogDistributionDao()

    fun snapshot(): JSONObject = database.runInTransaction(Callable {
        val state = distribution.get()
        JSONObject().put("products", productsJson()).put("categories", getCategories().getJSONArray("categories"))
            .put("revision", state?.revision ?: 0).put("distribution", state?.stateJson?.let { JSONObject(it) } ?: JSONObject.NULL)
    })

    fun commit(snapshot: JSONObject): JSONObject = transaction {
        require((distribution.get()?.revision ?: 0) == snapshot.getLong("revision")) { "CATALOG_CHANGED" }
        if (snapshot.optBoolean("activation")) {
            require(database.checkoutIntentDao().getAll().none { it.status !in setOf("finalized", "abandoned") }) {
                "Un paiement doit être terminé avant l’activation."
            }
        }
        val state = snapshot.getJSONObject("distribution")
        for (field in listOf("active", "pending")) state.optJSONObject(field)?.let { envelope ->
            val hash = java.security.MessageDigest.getInstance("SHA-256")
                .digest(envelope.getString("payload").toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
            require(hash == envelope.getString("sha256")) { "Catalogue corrompu." }
        }
        val nextCategories = snapshot.getJSONArray("categories")
        val ids = (0 until nextCategories.length()).map { nextCategories.getJSONObject(it).getString("id") }.toSet()
        require(categories.getAll().all { it.id in ids }) { "Une catégorie locale ne peut pas être supprimée." }
        // Release unique labels within this transaction to permit a legitimate label swap.
        categories.getAll().forEach { categories.update(it.copy(normalizedLabel = "\u0000" + it.id)) }
        for (index in 0 until nextCategories.length()) {
            val row = nextCategories.getJSONObject(index)
            val id = row.requireCatalogText("id")
            val label = row.requireCatalogText("label")
            val entity = CategoryEntity(id, label, normalizedCategoryLabel(label), row.getBoolean("active"), row.getInt("displayOrder"))
            require(entity.displayOrder >= 0)
            if (categories.findById(id) == null) categories.insert(entity) else check(categories.update(entity) == 1)
        }
        val nextProducts = snapshot.getJSONArray("products")
        val productIds = (0 until nextProducts.length()).map { nextProducts.getJSONObject(it).getString("id") }.toSet()
        require(products.getAll().all { it.id in productIds }) { "Un produit local ne peut pas être supprimé." }
        for (index in 0 until nextProducts.length()) {
            val entity = toEntity(nextProducts.getJSONObject(index))
            require(entity.categoryId in ids) { "La catégorie n’existe pas." }
            if (products.findById(entity.id) == null) products.insert(entity) else check(products.update(entity) == 1)
        }
        distribution.put(CatalogDistributionEntity(revision = snapshot.getLong("revision"), stateJson = state.toString()))
        JSONObject().put("updated", true)
    }

    fun initialize(seed: JSONArray): JSONObject =
        transaction {
            var seeded = false
            if (metadata.get() == null && products.count() == 0) {
                for (index in 0 until seed.length()) products.insert(toEntity(seed.getJSONObject(index)))
                seeded = true
            }
            if (metadata.get() == null) metadata.insert(CatalogMetadataEntity(initializedAt = Instant.now().toString()))
            if (distribution.get()?.stateJson == null) seedMissingCategories(database.openHelper.writableDatabase)
            initializationResult(seeded)
        }

    fun getAll(): JSONObject = JSONObject().put("products", productsJson())

    fun getSellable(): JSONObject =
        JSONObject().put(
            "products",
            JSONArray().apply {
                products.getSellable().forEach { put(JSONObject(it.productJson)) }
            },
        )

    fun create(product: JSONObject): JSONObject = transaction {
        val entity = toEntity(product)
        validateCategoryReference(entity, null)
        products.insert(entity)
        JSONObject(entity.productJson)
    }

    fun update(product: JSONObject): JSONObject = transaction {
        val entity = toEntity(product)
        val previous = products.findById(entity.id) ?: throw IllegalArgumentException("Ce produit n’existe plus dans le catalogue.")
        validateCategoryReference(entity, previous)
        check(products.update(entity) == 1) { "Le produit n’a pas pu être modifié." }
        JSONObject(entity.productJson)
    }

    fun getCategories(): JSONObject = JSONObject().put("categories", JSONArray().apply {
        categories.getAll().forEach { put(categoryJson(it)) }
    })

    fun createCategory(source: JSONObject): JSONObject = transaction {
        val id = source.requireCatalogText("id")
        require(categories.findById(id) == null) { "Cet identifiant de catégorie existe déjà." }
        val label = checkedLabel(source.getString("label"), id)
        val entity = CategoryEntity(id, label, normalizedCategoryLabel(label), true,
            (categories.getAll().maxOfOrNull { it.displayOrder } ?: -1) + 1)
        categories.insert(entity)
        categoryJson(entity)
    }

    fun updateCategory(id: String, label: String): JSONObject = transaction {
        val previous = categories.findById(id) ?: throw IllegalArgumentException("Cette catégorie n’existe plus.")
        val name = checkedLabel(label, id)
        val updated = previous.copy(label = name, normalizedLabel = normalizedCategoryLabel(name))
        check(categories.update(updated) == 1)
        categoryJson(updated)
    }

    fun setCategoryActive(id: String, active: Boolean): JSONObject = transaction {
        val previous = categories.findById(id) ?: throw IllegalArgumentException("Cette catégorie n’existe plus.")
        val updated = previous.copy(active = active)
        check(categories.update(updated) == 1)
        categoryJson(updated)
    }

    fun reorderCategories(ids: JSONArray): JSONObject = transaction {
        val existing = categories.getAll()
        val orderedIds = (0 until ids.length()).map { ids.getString(it) }
        require(orderedIds.size == existing.size && orderedIds.toSet() == existing.map { it.id }.toSet()) {
            "La liste des catégories a changé. Rechargez-la avant de réorganiser."
        }
        orderedIds.forEachIndexed { index, id ->
            check(categories.update(existing.first { it.id == id }.copy(displayOrder = index)) == 1)
        }
        getCategories()
    }

    private fun checkedLabel(value: String, id: String): String {
        val label = value.trim().replace(Regex("[\\s\\p{Z}]+"), " ")
        require(label.isNotEmpty()) { "Le nom de la catégorie est requis." }
        require(categories.getAll().none { it.id != id && it.normalizedLabel == normalizedCategoryLabel(label) }) {
            "Une catégorie porte déjà ce nom."
        }
        return label
    }

    private fun categoryJson(category: CategoryEntity): JSONObject = JSONObject()
        .put("id", category.id).put("label", category.label)
        .put("active", category.active).put("displayOrder", category.displayOrder)

    private fun validateCategoryReference(product: ProductEntity, previous: ProductEntity?) {
        val category = categories.findById(product.categoryId) ?: throw IllegalArgumentException("La catégorie n’existe pas.")
        require(category.active || previous?.categoryId == product.categoryId) {
            "Choisissez une catégorie active pour cette affectation."
        }
    }

    private fun initializationResult(initialized: Boolean): JSONObject =
        JSONObject().put("initialized", initialized).put("products", productsJson())

    private fun productsJson(): JSONArray =
        JSONArray().apply { products.getAll().forEach { put(JSONObject(it.productJson)) } }

    private fun toEntity(source: JSONObject): ProductEntity {
        val product = JSONObject(source.toString())
        val id = product.requireCatalogText("id")
        val name = product.requireCatalogText("name")
        val categoryId = product.requireCatalogText("categoryId")
        val availability = product.requireCatalogText("availability")
        require(availability == "available" || availability == "sold-out") {
            "La disponibilité du produit est invalide."
        }
        val vatRate = product.getInt("vatRate")
        require(vatRate == 10 || vatRate == 20) { "Le taux de TVA est invalide." }
        val displayOrder = product.getInt("displayOrder")
        require(displayOrder >= 0) { "L’ordre d’affichage est invalide." }
        val priceCents =
            if (product.has("priceCents") && !product.isNull("priceCents")) {
                product.getLong("priceCents").also { require(it >= 0) { "Le prix est invalide." } }
            } else null
        require(priceCents != null || product.optJSONArray("variants")?.length()?.let { it > 0 } == true) {
            "Un prix ou une variante est requis."
        }
        return ProductEntity(
            id = id,
            name = name,
            categoryId = categoryId,
            priceCents = priceCents,
            vatRate = vatRate,
            availability = availability,
            active = product.getBoolean("active"),
            displayOrder = displayOrder,
            productJson = product.toString(),
        )
    }

    private fun <T> transaction(block: () -> T): T = database.runInTransaction(Callable {
        val result = block()
        val state = distribution.get() ?: CatalogDistributionEntity()
        distribution.put(state.copy(revision = state.revision + 1))
        result
    })
}

private fun JSONObject.requireCatalogText(key: String): String =
    getString(key).trim().also { require(it.isNotEmpty()) { "Le champ $key est requis." } }
