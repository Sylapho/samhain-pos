package __APP_PACKAGE__

import java.time.Instant
import java.util.concurrent.Callable
import org.json.JSONArray
import org.json.JSONObject

class RoomOrderStore(private val database: SamhainPosDatabase) {
    private val orders = database.orderDao()
    private val printing = database.orderPrintingDao()
    private val ledger = database.salesLedgerDao()
    private val metadata = database.metadataDao()

    fun legacyMigrationStatus(): JSONObject =
        transaction {
            val state = currentMetadata()
            JSONObject().apply {
                put("completed", state.legacyMigrationCompleted)
                state.legacyMigrationCompletedAt?.let { put("completedAt", it) }
            }
        }

    fun createOrder(request: JSONObject, source: JSONObject): JSONObject =
        transaction {
            var state = currentMetadata()
            validateSequence(state.nextOrderSequence)
            validateSequence(state.nextReceiptSequence)
            validateSequence(state.nextJournalSequence)

            val order = JSONObject(request.toString())
            val orderPrefix = order.takeRequiredString("orderNumberPrefix")
            val receiptPrefix = order.takeRequiredString("receiptNumberPrefix")
            order.put("orderNumber", "$orderPrefix-${formatSequence(state.nextOrderSequence)}")
            order.put("receiptNumber", "$receiptPrefix-${formatSequence(state.nextReceiptSequence)}")
            validateOrder(order)
            if (state.lastClosureEnd != null && order.getString("paidAt") < state.lastClosureEnd) {
                throw IllegalStateException(
                    "Impossible d’enregistrer une vente dans une période déjà clôturée.",
                )
            }

            val immutable = immutableOrder(order)
            val entryWithoutHash =
                JSONObject().apply {
                    put("schemaVersion", 1)
                    put("id", "sale:${order.getString("id")}")
                    put("sequence", state.nextJournalSequence)
                    put("kind", "sale")
                    put("recordedAt", order.getString("createdAt"))
                    putNullable("previousHash", state.lastJournalHash)
                    put("source", JSONObject(source.toString()))
                    put("orderId", order.getString("id"))
                    put("order", immutable)
                }
            val hash = CanonicalJson.sha256(entryWithoutHash)
            val entry = JSONObject(entryWithoutHash.toString()).apply { put("hash", hash) }
            val integrity =
                JSONObject().apply {
                    put("algorithm", "SHA-256")
                    put("journalEntryId", entry.getString("id"))
                    put("journalSequence", state.nextJournalSequence)
                    put("hash", hash)
                }
            val stored = JSONObject(immutable.toString()).apply { put("integrity", integrity) }
            val technical = order.getJSONObject("printing")

            orders.insert(toOrderEntity(stored))
            printing.insert(toPrintingEntity(order.getString("id"), technical))
            ledger.insert(toLedgerEntity(entry))
            state =
                state.copy(
                    nextOrderSequence = state.nextOrderSequence + 1,
                    nextReceiptSequence = state.nextReceiptSequence + 1,
                    nextJournalSequence = state.nextJournalSequence + 1,
                    lastJournalHash = hash,
                )
            require(metadata.update(state) == 1) { "Mise à jour des séquences impossible." }
            hydrateOrder(stored, technical)
        }

    fun snapshot(): JSONObject =
        transaction {
            val state = currentMetadata()
            JSONObject().apply {
                put("metadata", metadataJson(state))
                put(
                    "orders",
                    JSONArray().also { result ->
                        orders.getAll().forEach { result.put(storedOrderJson(it)) }
                    },
                )
                put(
                    "technicalStates",
                    JSONArray().also { result ->
                        printing.getAll().forEach { entity ->
                            result.put(
                                JSONObject().apply {
                                    put("orderId", entity.orderId)
                                    put("printing", printingJson(entity))
                                },
                            )
                        }
                    },
                )
                put(
                    "entries",
                    JSONArray().also { result ->
                        ledger.getAll().forEach { result.put(JSONObject(it.payloadJson)) }
                    },
                )
            }
        }

    fun compareAndSetPrinting(
        orderId: String,
        expected: JSONObject,
        replacement: JSONObject,
    ): JSONObject =
        transaction {
            val stored = orders.findById(orderId)
                ?: throw IllegalArgumentException("Commande locale $orderId introuvable.")
            val current = printing.findByOrderId(orderId)
                ?: throw IllegalStateException("État d’impression $orderId introuvable.")
            if (CanonicalJson.stringify(printingJson(current)) != CanonicalJson.stringify(expected)) {
                return@transaction JSONObject().put("updated", false)
            }
            validatePrinting(replacement)
            require(printing.update(toPrintingEntity(orderId, replacement)) == 1) {
                "Mise à jour de l’état d’impression impossible."
            }
            JSONObject().apply {
                put("updated", true)
                put("order", hydrateOrder(storedOrderJson(stored), replacement))
            }
        }

    fun importLegacySnapshot(snapshot: JSONObject): JSONObject =
        transaction {
            val current = currentMetadata()
            if (current.legacyMigrationCompleted) {
                return@transaction importResult(0, 0)
            }
            val incomingOrders = snapshot.getJSONArray("orders")
            val incomingTechnical = snapshot.getJSONArray("technicalStates")
            val incomingEntries = snapshot.getJSONArray("entries")
            val incomingMetadata = snapshot.getJSONObject("metadata")
            validateSequence(incomingMetadata.requiredSafeLong("nextOrderSequence"))
            validateSequence(incomingMetadata.requiredSafeLong("nextReceiptSequence"))
            validateSequence(incomingMetadata.requiredSafeLong("nextJournalSequence"))
            var importedOrders = 0
            var importedEntries = 0
            val embeddedPrinting = mutableMapOf<String, JSONObject>()

            forEachObject(incomingOrders) { incoming ->
                val normalized = JSONObject(incoming.toString())
                val orderId = normalized.getString("id")
                normalized.optJSONObject("printing")?.let {
                    embeddedPrinting[orderId] = JSONObject(it.toString())
                    normalized.remove("printing")
                }
                val existing = orders.findById(orderId)
                if (existing == null) {
                    orders.insert(toOrderEntity(normalized))
                    importedOrders += 1
                } else if (
                    CanonicalJson.stringify(storedOrderJson(existing)) !=
                        CanonicalJson.stringify(normalized)
                ) {
                    throw IllegalStateException(
                        "Conflit de migration : l’UUID $orderId existe avec un contenu différent.",
                    )
                }
            }

            val importedTechnicalIds = mutableSetOf<String>()
            forEachObject(incomingTechnical) { technical ->
                val orderId = technical.getString("orderId")
                importedTechnicalIds += orderId
                importPrinting(orderId, technical.getJSONObject("printing"))
            }
            embeddedPrinting.forEach { (orderId, state) ->
                if (orderId !in importedTechnicalIds) importPrinting(orderId, state)
            }
            forEachObject(incomingOrders) { incoming ->
                val orderId = incoming.getString("id")
                if (printing.findByOrderId(orderId) == null) {
                    importPrinting(orderId, unknownPrinting(incoming.getString("createdAt")))
                }
            }

            forEachObject(incomingEntries) { entry ->
                validateLedgerEntryHash(entry)
                val entryId = entry.getString("id")
                val existingById = ledger.findById(entryId)
                val existingBySequence = ledger.findBySequence(entry.getLong("sequence"))
                if (existingById != null) {
                    if (
                        CanonicalJson.stringify(JSONObject(existingById.payloadJson)) !=
                            CanonicalJson.stringify(entry)
                    ) {
                        throw IllegalStateException(
                            "Conflit de migration : l’entrée $entryId a un contenu différent.",
                        )
                    }
                } else {
                    if (existingBySequence != null) {
                        throw IllegalStateException(
                            "Conflit de migration : la séquence ${entry.getLong("sequence")} est déjà utilisée.",
                        )
                    }
                    ledger.insert(toLedgerEntity(entry))
                    importedEntries += 1
                }
            }
            validateStoredLedgerChain()

            val allEntries = ledger.getAll()
            val latest = allEntries.lastOrNull()
            val nextJournal =
                maxOf(
                    current.nextJournalSequence,
                    incomingMetadata.requiredSafeLong("nextJournalSequence"),
                    (latest?.sequence ?: 0) + 1,
                )
            val migrated =
                current.copy(
                    nextOrderSequence =
                        maxOf(
                            current.nextOrderSequence,
                            incomingMetadata.requiredSafeLong("nextOrderSequence"),
                        ),
                    nextReceiptSequence =
                        maxOf(
                            current.nextReceiptSequence,
                            incomingMetadata.requiredSafeLong("nextReceiptSequence"),
                        ),
                    nextJournalSequence = nextJournal,
                    lastJournalHash = latest?.hash ?: current.lastJournalHash,
                    lastClosureEnd =
                        maxIso(current.lastClosureEnd, incomingMetadata.optNullableString("lastClosureEnd")),
                    legacyMigrationCompleted = true,
                    legacyMigrationCompletedAt = Instant.now().toString(),
                )
            require(metadata.update(migrated) == 1) { "Finalisation de la migration impossible." }
            importResult(importedOrders, importedEntries)
        }

    fun recordCorrection(request: JSONObject): JSONObject =
        transaction {
            val operationId = request.requireNonBlank("operationId")
            val entryId = "correction:$operationId"
            ledger.findById(entryId)?.let { existing ->
                val existingJson = JSONObject(existing.payloadJson)
                if (!sameCorrectionRequest(existingJson, request)) {
                    throw IllegalStateException(
                        "Cette clé d’opération appartient déjà à une autre correction.",
                    )
                }
                return@transaction existingJson
            }
            val orderId = request.getString("originalOrderId")
            val order = orders.findById(orderId)
                ?: throw IllegalArgumentException("Commande locale $orderId introuvable.")
            val entries = ledger.getAll().map { JSONObject(it.payloadJson) }
            validateCorrection(request, order, entries)
            var state = currentMetadata()
            if (state.lastClosureEnd != null && request.getString("recordedAt") < state.lastClosureEnd) {
                throw IllegalStateException("Impossible de corriger une période déjà clôturée.")
            }
            val correction =
                JSONObject().apply {
                    put("operationId", operationId)
                    put("originalOrderId", order.id)
                    put("originalOrderNumber", order.orderNumber)
                    put("originalReceiptNumber", order.receiptNumber)
                    put("type", request.getString("type"))
                    put("reason", request.getString("reason"))
                    put("amountDeltaCents", request.getLong("amountDeltaCents"))
                    put("paymentMethod", order.paymentMethod)
                    putNullable("originalSaleHash", order.integrityHash)
                }
            val withoutHash = baseLedgerEntry(entryId, "correction", request, state).apply {
                put("correction", correction)
            }
            val entry = sealLedgerEntry(withoutHash)
            ledger.insert(toLedgerEntity(entry))
            state = appendMetadata(state, entry)
            require(metadata.update(state) == 1)
            entry
        }

    fun closePeriod(request: JSONObject): JSONObject =
        transaction {
            val operationId = request.requireNonBlank("operationId")
            val entryId = "closure:$operationId"
            ledger.findById(entryId)?.let { existing ->
                val existingJson = JSONObject(existing.payloadJson)
                if (!sameClosureRequest(existingJson, request)) {
                    throw IllegalStateException(
                        "Cette clé d’opération appartient déjà à une autre clôture.",
                    )
                }
                return@transaction existingJson
            }
            val periodStart = request.getString("periodStart")
            val periodEnd = request.getString("periodEnd")
            val recordedAt = request.getString("recordedAt")
            require(periodStart < periodEnd) { "La fin de période doit être postérieure à son début." }
            require(periodEnd <= recordedAt) { "Une période future ne peut pas être clôturée." }
            var state = currentMetadata()
            if (state.lastClosureEnd != null && periodStart != state.lastClosureEnd) {
                throw IllegalStateException(
                    "La nouvelle clôture doit commencer à la fin de la précédente.",
                )
            }
            val entries = ledger.getAll().map { JSONObject(it.payloadJson) }
            val closure =
                JSONObject().apply {
                    put("operationId", operationId)
                    put("periodStart", periodStart)
                    put("periodEnd", periodEnd)
                    put("totals", closureTotals(entries, periodStart, periodEnd))
                }
            val withoutHash = baseLedgerEntry(entryId, "closure", request, state).apply {
                put("closure", closure)
            }
            val entry = sealLedgerEntry(withoutHash)
            ledger.insert(toLedgerEntity(entry))
            state = appendMetadata(state, entry).copy(lastClosureEnd = periodEnd)
            require(metadata.update(state) == 1)
            entry
        }

    fun restoreSnapshot(snapshot: JSONObject): JSONObject =
        transaction {
            require(orders.count() == 0 && ledger.count() == 0) {
                "La restauration exige une base locale vide."
            }
            val snapshotOrders = snapshot.getJSONArray("orders")
            val technicalStates = snapshot.getJSONArray("technicalStates")
            val entries = snapshot.getJSONArray("entries")
            val embeddedPrinting = mutableMapOf<String, JSONObject>()
            forEachObject(snapshotOrders) {
                it.optJSONObject("printing")?.let { state ->
                    embeddedPrinting[it.getString("id")] = JSONObject(state.toString())
                }
                orders.insert(toOrderEntity(it))
            }
            val technicalOrderIds = mutableSetOf<String>()
            forEachObject(technicalStates) {
                val orderId = it.getString("orderId")
                technicalOrderIds += orderId
                printing.insert(toPrintingEntity(orderId, it.getJSONObject("printing")))
            }
            forEachObject(snapshotOrders) {
                val orderId = it.getString("id")
                if (orderId !in technicalOrderIds) {
                    printing.insert(
                        toPrintingEntity(
                            orderId,
                            embeddedPrinting[orderId] ?: unknownPrinting(it.getString("createdAt")),
                        ),
                    )
                }
            }
            forEachObject(entries) { ledger.insert(toLedgerEntity(it)) }
            validateStoredLedgerChain()
            val sourceMetadata = snapshot.getJSONObject("metadata")
            val current = currentMetadata()
            require(
                metadata.update(
                    current.copy(
                        nextOrderSequence = sourceMetadata.requiredSafeLong("nextOrderSequence"),
                        nextReceiptSequence = sourceMetadata.requiredSafeLong("nextReceiptSequence"),
                        nextJournalSequence = sourceMetadata.requiredSafeLong("nextJournalSequence"),
                        lastJournalHash = sourceMetadata.optNullableString("lastJournalHash"),
                        lastClosureEnd = sourceMetadata.optNullableString("lastClosureEnd"),
                    ),
                ) == 1,
            )
            JSONObject().apply {
                put("restoredOrders", snapshotOrders.length())
                put("restoredEntries", entries.length())
            }
        }

    private fun currentMetadata(): PosMetadataEntity {
        metadata.insertIfMissing(PosMetadataEntity())
        return metadata.get() ?: throw IllegalStateException("Métadonnées Room introuvables.")
    }

    private fun immutableOrder(order: JSONObject): JSONObject =
        JSONObject(order.toString()).apply {
            remove("printing")
            remove("integrity")
        }

    private fun hydrateOrder(stored: JSONObject, technical: JSONObject): JSONObject =
        JSONObject(stored.toString()).apply { put("printing", JSONObject(technical.toString())) }

    private fun storedOrderJson(entity: OrderEntity): JSONObject =
        JSONObject(entity.immutablePayloadJson).apply {
            if (entity.integrityHash != null) {
                put(
                    "integrity",
                    JSONObject().apply {
                        put("algorithm", entity.integrityAlgorithm)
                        put("journalEntryId", entity.integrityEntryId)
                        put("journalSequence", entity.integritySequence)
                        put("hash", entity.integrityHash)
                    },
                )
            }
        }

    private fun toOrderEntity(stored: JSONObject): OrderEntity {
        val immutable = immutableOrder(stored)
        validateOrder(immutable)
        val terminal = immutable.optJSONObject("terminal")
        val integrity = stored.optJSONObject("integrity")
        return OrderEntity(
            id = immutable.getString("id"),
            orderNumber = immutable.getString("orderNumber"),
            receiptNumber = immutable.getString("receiptNumber"),
            terminalId = terminal?.optNullableString("terminalId"),
            terminalCode = terminal?.optNullableString("terminalCode"),
            terminalName = terminal?.optNullableString("displayName"),
            registerName = immutable.optNullableString("registerName"),
            createdAt = immutable.getString("createdAt"),
            paidAt = immutable.getString("paidAt"),
            paymentMethod = immutable.getString("paymentMethod"),
            paymentStatus = immutable.getString("paymentStatus"),
            itemCount = immutable.requiredSafeLong("itemCount").toInt(),
            totalCents = immutable.requiredSafeLong("totalCents"),
            status = immutable.getString("status"),
            itemsJson = immutable.getJSONArray("items").toString(),
            immutablePayloadJson = immutable.toString(),
            integrityAlgorithm = integrity?.optNullableString("algorithm"),
            integrityEntryId = integrity?.optNullableString("journalEntryId"),
            integritySequence = integrity?.optLong("journalSequence")?.takeIf { integrity.has("journalSequence") },
            integrityHash = integrity?.optNullableString("hash"),
        )
    }

    private fun printingJson(entity: OrderPrintingEntity): JSONObject =
        JSONObject().apply {
            put("status", entity.status)
            put("customerReceipt", entity.customerReceipt)
            put("preparationTicket", entity.preparationTicket)
            put("attempts", entity.attempts)
            put("updatedAt", entity.updatedAt)
            entity.lastError?.let { put("lastError", it) }
        }

    private fun toPrintingEntity(orderId: String, value: JSONObject): OrderPrintingEntity {
        validatePrinting(value)
        return OrderPrintingEntity(
            orderId = orderId,
            status = value.getString("status"),
            customerReceipt = value.getString("customerReceipt"),
            preparationTicket = value.getString("preparationTicket"),
            attempts = value.requiredSafeLong("attempts").toInt(),
            updatedAt = value.getString("updatedAt"),
            lastError = value.optNullableString("lastError"),
        )
    }

    private fun importPrinting(orderId: String, value: JSONObject) {
        val existing = printing.findByOrderId(orderId)
        if (existing == null) {
            printing.insert(toPrintingEntity(orderId, value))
        } else if (
            CanonicalJson.stringify(printingJson(existing)) != CanonicalJson.stringify(value)
        ) {
            throw IllegalStateException(
                "Conflit de migration : l’état d’impression de $orderId est différent.",
            )
        }
    }

    private fun toLedgerEntity(entry: JSONObject): SalesLedgerEntity {
        validateLedgerEntryHash(entry)
        return SalesLedgerEntity(
            id = entry.getString("id"),
            sequence = entry.requiredSafeLong("sequence"),
            kind = entry.getString("kind"),
            recordedAt = entry.getString("recordedAt"),
            previousHash = entry.optNullableString("previousHash"),
            sourceTerminalId =
                entry.optJSONObject("source")?.optJSONObject("terminal")
                    ?.optNullableString("terminalId"),
            orderId =
                entry.optNullableString("orderId")
                    ?: entry.optJSONObject("correction")?.optNullableString("originalOrderId"),
            hash = entry.getString("hash"),
            payloadJson = entry.toString(),
        )
    }

    private fun validateLedgerEntryHash(entry: JSONObject) {
        val withoutHash = JSONObject(entry.toString())
        val hash = withoutHash.takeRequiredString("hash")
        require(CanonicalJson.sha256(withoutHash) == hash) {
            "Empreinte invalide pour l’entrée ${entry.optString("id")}"
        }
    }

    private fun validateStoredLedgerChain() {
        var previousHash: String? = null
        ledger.getAll().forEachIndexed { index, entity ->
            require(entity.sequence == index.toLong() + 1) {
                "Séquence de journal incohérente à l’entrée ${entity.id}."
            }
            require(entity.previousHash == previousHash) {
                "Chaînage de journal incohérent à l’entrée ${entity.id}."
            }
            validateLedgerEntryHash(JSONObject(entity.payloadJson))
            previousHash = entity.hash
        }
    }

    private fun baseLedgerEntry(
        id: String,
        kind: String,
        request: JSONObject,
        state: PosMetadataEntity,
    ): JSONObject =
        JSONObject().apply {
            put("schemaVersion", 1)
            put("id", id)
            put("sequence", state.nextJournalSequence)
            put("kind", kind)
            put("recordedAt", request.getString("recordedAt"))
            putNullable("previousHash", state.lastJournalHash)
            put("source", JSONObject(request.getJSONObject("source").toString()))
        }

    private fun sealLedgerEntry(withoutHash: JSONObject): JSONObject =
        JSONObject(withoutHash.toString()).apply { put("hash", CanonicalJson.sha256(withoutHash)) }

    private fun appendMetadata(
        state: PosMetadataEntity,
        entry: JSONObject,
    ): PosMetadataEntity =
        state.copy(
            nextJournalSequence = entry.getLong("sequence") + 1,
            lastJournalHash = entry.getString("hash"),
        )

    private fun validateCorrection(
        request: JSONObject,
        order: OrderEntity,
        entries: List<JSONObject>,
    ) {
        val reason = request.requireNonBlank("reason")
        require(reason == request.getString("reason")) { "Le motif de correction est invalide." }
        val type = request.getString("type")
        require(type in setOf("cancellation", "refund", "adjustment")) {
            "Type de correction invalide."
        }
        val delta = request.requiredSafeLong("amountDeltaCents")
        require(type == "cancellation" || delta != 0L) {
            "Le montant de correction doit être un entier valide en centimes."
        }
        require(type !in setOf("cancellation", "refund") || delta < 0) {
            "Une annulation ou un remboursement doit diminuer le total encaissé."
        }
        require(type != "cancellation" || delta == -order.totalCents) {
            "Une annulation doit compenser exactement le total de la vente."
        }
        val prior =
            entries.filter {
                it.optString("kind") == "correction" &&
                    it.getJSONObject("correction").optString("originalOrderId") == order.id
            }
        require(prior.none { it.getJSONObject("correction").optString("type") == "cancellation" }) {
            "Cette vente a déjà été annulée."
        }
        require(type != "cancellation" || prior.isEmpty()) {
            "Une vente partiellement corrigée ne peut pas être annulée intégralement."
        }
        if (type == "refund") {
            val alreadyRefunded =
                prior.filter { it.getJSONObject("correction").optString("type") == "refund" }
                    .sumOf { -it.getJSONObject("correction").getLong("amountDeltaCents") }
            require(alreadyRefunded - delta <= order.totalCents) {
                "Le cumul des remboursements dépasse le total de la vente."
            }
        }
    }

    private fun closureTotals(
        entries: List<JSONObject>,
        start: String,
        end: String,
    ): JSONObject {
        var saleCount = 0
        var gross = 0L
        var correctionCount = 0
        var corrections = 0L
        var cumulative = 0L
        var cash = 0L
        var card = 0L
        entries.forEach { entry ->
            when (entry.getString("kind")) {
                "sale" -> {
                    val order = entry.getJSONObject("order")
                    val paidAt = order.getString("paidAt")
                    val total = order.getLong("totalCents")
                    if (paidAt < end) cumulative += total
                    if (paidAt >= start && paidAt < end) {
                        saleCount += 1
                        gross += total
                        if (order.getString("paymentMethod") == "cash") cash += total else card += total
                    }
                }
                "correction" -> {
                    val correction = entry.getJSONObject("correction")
                    val recordedAt = entry.getString("recordedAt")
                    val delta = correction.getLong("amountDeltaCents")
                    if (recordedAt < end) cumulative += delta
                    if (recordedAt >= start && recordedAt < end) {
                        correctionCount += 1
                        corrections += delta
                        if (correction.getString("paymentMethod") == "cash") cash += delta else card += delta
                    }
                }
            }
        }
        return JSONObject().apply {
            put("saleCount", saleCount)
            put("grossSalesCents", gross)
            put("correctionCount", correctionCount)
            put("correctionTotalCents", corrections)
            put("netTotalCents", gross + corrections)
            put("cumulativeNetTotalCents", cumulative)
            put("paymentTotalsCents", JSONObject().put("cash", cash).put("card", card))
        }
    }

    private fun sameCorrectionRequest(entry: JSONObject, request: JSONObject): Boolean {
        if (entry.optString("kind") != "correction") return false
        val correction = entry.getJSONObject("correction")
        return correction.optString("operationId") == request.optString("operationId") &&
            correction.optString("originalOrderId") == request.optString("originalOrderId") &&
            correction.optString("type") == request.optString("type") &&
            correction.optString("reason") == request.optString("reason") &&
            correction.optLong("amountDeltaCents") == request.optLong("amountDeltaCents")
    }

    private fun sameClosureRequest(entry: JSONObject, request: JSONObject): Boolean {
        if (entry.optString("kind") != "closure") return false
        val closure = entry.getJSONObject("closure")
        return closure.optString("operationId") == request.optString("operationId") &&
            closure.optString("periodStart") == request.optString("periodStart") &&
            closure.optString("periodEnd") == request.optString("periodEnd")
    }

    private fun validateOrder(order: JSONObject) {
        order.requireNonBlank("id")
        order.requireNonBlank("orderNumber")
        order.requireNonBlank("receiptNumber")
        order.requireNonBlank("createdAt")
        order.requireNonBlank("paidAt")
        require(order.getString("paymentMethod") in setOf("cash", "card")) {
            "Moyen de paiement invalide."
        }
        require(order.getString("paymentStatus") == "paid") { "État de paiement invalide." }
        require(order.getString("status") == "confirmed") { "État de commande invalide." }
        val itemCount = order.requiredSafeLong("itemCount")
        val totalCents = order.requiredSafeLong("totalCents")
        require(itemCount in 0..Int.MAX_VALUE && totalCents >= 0) {
            "Totaux de commande invalides."
        }
        order.getJSONArray("items")
    }

    private fun validatePrinting(value: JSONObject) {
        require(value.getString("status") in setOf("pending", "partial", "printed", "failed", "unknown")) {
            "État global d’impression invalide."
        }
        val documentStates = setOf("not_requested", "pending", "printed", "failed", "unknown")
        require(value.getString("customerReceipt") in documentStates)
        require(value.getString("preparationTicket") in documentStates)
        val attempts = value.requiredSafeLong("attempts")
        require(attempts in 0..Int.MAX_VALUE)
        value.requireNonBlank("updatedAt")
    }

    private fun metadataJson(value: PosMetadataEntity): JSONObject =
        JSONObject().apply {
            put("nextOrderSequence", value.nextOrderSequence)
            put("nextReceiptSequence", value.nextReceiptSequence)
            put("nextJournalSequence", value.nextJournalSequence)
            putNullable("lastJournalHash", value.lastJournalHash)
            value.lastClosureEnd?.let { put("lastClosureEnd", it) }
        }

    private fun importResult(importedOrders: Int, importedEntries: Int): JSONObject =
        JSONObject().apply {
            put("importedOrders", importedOrders)
            put("importedEntries", importedEntries)
            put("totalOrders", orders.count())
            put("totalEntries", ledger.count())
        }

    private fun unknownPrinting(createdAt: String): JSONObject =
        JSONObject().apply {
            put("status", "unknown")
            put("customerReceipt", "unknown")
            put("preparationTicket", "unknown")
            put("attempts", 0)
            put("updatedAt", createdAt)
            put("lastError", "État d’impression antérieur inconnu.")
        }

    private fun formatSequence(sequence: Long): String = sequence.toString().padStart(4, '0')

    private fun validateSequence(sequence: Long) {
        require(sequence in 1 until 9_007_199_254_740_991L) { "Séquence locale invalide." }
    }

    private fun maxIso(left: String?, right: String?): String? =
        when {
            left == null -> right
            right == null -> left
            left >= right -> left
            else -> right
        }

    private fun <T> transaction(block: () -> T): T =
        database.runInTransaction(Callable { block() })

    private fun forEachObject(array: JSONArray, action: (JSONObject) -> Unit) {
        for (index in 0 until array.length()) action(array.getJSONObject(index))
    }
}

private fun JSONObject.putNullable(key: String, value: String?) {
    put(key, value ?: JSONObject.NULL)
}

private fun JSONObject.optNullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else getString(key)

private fun JSONObject.requireNonBlank(key: String): String =
    getString(key).also { require(it.isNotBlank()) { "Le champ $key est requis." } }

private fun JSONObject.requiredSafeLong(key: String): Long {
    val raw = get(key)
    require(raw is Number) { "Le champ $key doit être un nombre." }
    val numeric = raw.toDouble()
    require(numeric.isFinite() && numeric % 1.0 == 0.0) {
        "Le champ $key doit être un entier fini."
    }
    val value = numeric.toLong()
    require(value.toDouble() == numeric && value in -9_007_199_254_740_990L..9_007_199_254_740_990L) {
        "Le champ $key dépasse la précision entière prise en charge."
    }
    return value
}

private fun JSONObject.takeRequiredString(key: String): String =
    requireNonBlank(key).also { remove(key) }
