package fr.samhain.pos

import java.time.Instant
import java.util.concurrent.Callable
import org.json.JSONArray
import org.json.JSONObject

class RoomCatalogStore(private val database: SamhainPosDatabase) {
    private val products = database.productDao()
    private val metadata = database.catalogMetadataDao()

    fun initialize(seed: JSONArray): JSONObject =
        transaction {
            if (metadata.get() != null) return@transaction initializationResult(false)
            var seeded = false
            if (products.count() == 0) {
                for (index in 0 until seed.length()) products.insert(toEntity(seed.getJSONObject(index)))
                seeded = true
            }
            metadata.insert(CatalogMetadataEntity(initializedAt = Instant.now().toString()))
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

    fun create(product: JSONObject): JSONObject {
        val entity = toEntity(product)
        products.insert(entity)
        return JSONObject(entity.productJson)
    }

    fun update(product: JSONObject): JSONObject {
        val entity = toEntity(product)
        require(products.findById(entity.id) != null) { "Ce produit n’existe plus dans le catalogue." }
        check(products.update(entity) == 1) { "Le produit n’a pas pu être modifié." }
        return JSONObject(entity.productJson)
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

    private fun <T> transaction(block: () -> T): T = database.runInTransaction(Callable { block() })
}

private fun JSONObject.requireCatalogText(key: String): String =
    getString(key).trim().also { require(it.isNotEmpty()) { "Le champ $key est requis." } }
