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
    private val checkoutIntents = database.checkoutIntentDao()

    fun legacyMigrationStatus(): JSONObject =
        transaction {
            val state = currentMetadata()
            JSONObject().apply {
                put("completed", state.legacyMigrationCompleted)
                state.legacyMigrationCompletedAt?.let { put("completedAt", it) }
            }
        }

    fun createOrder(request: JSONObject, source: JSONObject): JSONObject {
        val validatedRequest = JSONObject(request.toString())
        validateNewOrderRequest(validatedRequest)
        return transaction { createOrderInTransaction(validatedRequest, source) }
    }

    fun createCheckoutIntent(intent: JSONObject): JSONObject {
        val validated = JSONObject(intent.toString())
        validateCheckoutIntent(validated)
        require(validated.getString("status") == "pending_payment") {
            "Un nouvel encaissement doit être en attente de paiement."
        }
        return transaction {
            checkoutIntents.insert(toCheckoutIntentEntity(validated))
            validated
        }
    }

    fun checkoutIntents(): JSONObject =
        transaction {
            JSONObject().put(
                "intents",
                JSONArray().also { result ->
                    checkoutIntents.getAll().forEach { result.put(JSONObject(it.payloadJson)) }
                },
            )
        }

    fun markCheckoutPaymentToVerify(id: String, updatedAt: String): JSONObject =
        transitionCheckoutIntent(id, setOf("pending_payment", "payment_to_verify")) { intent ->
            requireIsoTimestamp(updatedAt, "updatedAt")
            intent.put("status", "payment_to_verify")
            intent.put("updatedAt", updatedAt)
        }

    fun confirmCheckoutPayment(id: String, confirmedAt: String): JSONObject =
        transitionCheckoutIntent(id, setOf("payment_to_verify", "payment_confirmed")) { intent ->
            requireIsoTimestamp(confirmedAt, "paymentConfirmedAt")
            intent.put("status", "payment_confirmed")
            if (!intent.has("paymentConfirmedAt")) intent.put("paymentConfirmedAt", confirmedAt)
            intent.put("updatedAt", confirmedAt)
        }

    fun abandonCheckoutIntent(id: String, abandonedAt: String): JSONObject =
        transitionCheckoutIntent(id, setOf("pending_payment", "payment_to_verify", "abandoned")) { intent ->
            requireIsoTimestamp(abandonedAt, "abandonedAt")
            intent.put("status", "abandoned")
            if (!intent.has("abandonedAt")) intent.put("abandonedAt", abandonedAt)
            intent.put("updatedAt", abandonedAt)
        }

    fun finalizeCheckoutIntent(id: String, updatedAt: String): JSONObject {
        requireIsoTimestamp(updatedAt, "updatedAt")
        return transaction {
            val entity = checkoutIntents.findById(id)
                ?: throw IllegalArgumentException("Encaissement local $id introuvable.")
            val intent = JSONObject(entity.payloadJson)
            validateCheckoutIntent(intent)
            if (intent.getString("status") == "finalized") {
                val orderId = intent.requireNonBlank("finalizedOrderId")
                val stored = orders.findById(orderId)
                    ?: throw IllegalStateException("La vente finalisée associée est introuvable.")
                val technical = printing.findByOrderId(orderId)
                    ?: throw IllegalStateException("L’état d’impression associé est introuvable.")
                return@transaction hydrateOrder(storedOrderJson(stored), printingJson(technical))
            }
            require(intent.getString("status") == "payment_confirmed") {
                "Le paiement doit être explicitement confirmé avant la vente."
            }
            val paidAt = intent.requireNonBlank("paymentConfirmedAt")
            val preparationRequired = requiresPreparation(intent.getJSONArray("cartSnapshot"))
            val customerReceipt =
                if (intent.getBoolean("printCustomerReceipt")) "pending" else "not_requested"
            val preparationTicket = if (preparationRequired) "pending" else "not_requested"
            val request =
                JSONObject().apply {
                    put("id", intent.getString("id"))
                    put("terminal", JSONObject(intent.getJSONObject("terminal").toString()))
                    put("paymentMethod", intent.getString("paymentMethod"))
                    put("paymentStatus", "paid")
                    put("paidAt", paidAt)
                    put("items", JSONArray(intent.getJSONArray("cartSnapshot").toString()))
                    put("itemCount", intent.getLong("itemCount"))
                    put("totalCents", intent.getLong("totalCents"))
                    put("createdAt", paidAt)
                    put("status", "confirmed")
                    put("orderNumberPrefix", intent.getString("orderNumberPrefix"))
                    put("receiptNumberPrefix", intent.getString("receiptNumberPrefix"))
                    put(
                        "printing",
                        JSONObject().apply {
                            put(
                                "status",
                                if (customerReceipt == "pending" || preparationTicket == "pending") {
                                    "pending"
                                } else {
                                    "printed"
                                },
                            )
                            put("customerReceipt", customerReceipt)
                            put("preparationTicket", preparationTicket)
                            put("attempts", 0)
                            put("updatedAt", paidAt)
                        },
                    )
                }
            validateNewOrderRequest(request)
            val order = createOrderInTransaction(request, intent.getJSONObject("ledgerSource"))
            intent.put("status", "finalized")
            intent.put("finalizedOrderId", order.getString("id"))
            intent.put("updatedAt", updatedAt)
            validateCheckoutIntent(intent)
            require(checkoutIntents.update(toCheckoutIntentEntity(intent)) == 1) {
                "Mise à jour de l'encaissement impossible."
            }
            order
        }
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
                    if (request.has("refundLines")) {
                        put("refundLines", JSONArray(request.getJSONArray("refundLines").toString()))
                    }
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

    private fun createOrderInTransaction(request: JSONObject, source: JSONObject): JSONObject {
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
        return hydrateOrder(stored, technical)
    }

    private fun transitionCheckoutIntent(
        id: String,
        allowedStatuses: Set<String>,
        update: (JSONObject) -> Unit,
    ): JSONObject =
        transaction {
            val entity = checkoutIntents.findById(id)
                ?: throw IllegalArgumentException("Encaissement local $id introuvable.")
            val intent = JSONObject(entity.payloadJson)
            validateCheckoutIntent(intent)
            require(intent.getString("status") in allowedStatuses) {
                "Transition impossible depuis l’état d’encaissement « ${intent.getString("status")} »."
            }
            update(intent)
            validateCheckoutIntent(intent)
            require(checkoutIntents.update(toCheckoutIntentEntity(intent)) == 1) {
                "Mise à jour de l'encaissement impossible."
            }
            intent
        }

    private fun toCheckoutIntentEntity(intent: JSONObject): CheckoutIntentEntity {
        validateCheckoutIntent(intent)
        return CheckoutIntentEntity(
            id = intent.getString("id"),
            status = intent.getString("status"),
            createdAt = intent.getString("createdAt"),
            updatedAt = intent.getString("updatedAt"),
            paymentMethod = intent.getString("paymentMethod"),
            totalCents = intent.getLong("totalCents"),
            finalizedOrderId = intent.optNullableString("finalizedOrderId"),
            payloadJson = intent.toString(),
        )
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
            val refundTotal = validateRefundLines(request, order, prior)
            require(delta == -refundTotal) {
                "Le montant du remboursement ne correspond pas aux lignes sélectionnées."
            }
            val alreadyRefunded =
                prior.filter { it.getJSONObject("correction").optString("type") == "refund" }
                    .sumOf { -it.getJSONObject("correction").getLong("amountDeltaCents") }
            require(alreadyRefunded - delta <= order.totalCents) {
                "Le cumul des remboursements dépasse le total de la vente."
            }
        }
    }

    private fun validateRefundLines(
        request: JSONObject,
        order: OrderEntity,
        prior: List<JSONObject>,
    ): Long {
        require(request.has("refundLines")) { "Les lignes du remboursement sont obligatoires." }
        require(
            prior.filter { it.getJSONObject("correction").optString("type") == "refund" }
                .none { !it.getJSONObject("correction").has("refundLines") },
        ) {
            "Cette vente contient un ancien remboursement sans détail de lignes. Un nouveau remboursement par article est impossible sans inventer les quantités restantes."
        }
        val originalById = mutableMapOf<String, JSONObject>()
        forEachObject(JSONArray(order.itemsJson)) { originalById[it.getString("lineId")] = it }
        val refundedById = mutableMapOf<String, Long>()
        prior.filter { it.getJSONObject("correction").optString("type") == "refund" }
            .forEach { entry ->
                forEachObject(entry.getJSONObject("correction").getJSONArray("refundLines")) { line ->
                    val id = line.getString("originalLineId")
                    refundedById[id] = (refundedById[id] ?: 0L) + line.requiredSafeLong("quantity")
                }
            }
        val requested = request.getJSONArray("refundLines")
        require(requested.length() > 0) { "Sélectionnez au moins un article à rembourser." }
        val seen = mutableSetOf<String>()
        var total = 0L
        for (index in 0 until requested.length()) {
            val line = requested.getJSONObject(index)
            val lineId = line.requireNonBlank("originalLineId")
            require(seen.add(lineId)) { "Chaque ligne de remboursement doit être unique et identifiable." }
            val quantity = line.requiredSafeLong("quantity")
            require(quantity > 0) { "La quantité remboursée doit être un entier strictement positif." }
            val original = originalById[lineId]
                ?: throw IllegalArgumentException("Ligne originale $lineId introuvable.")
            val sold = original.requiredSafeLong("quantity")
            require(quantity <= sold - (refundedById[lineId] ?: 0L)) {
                "La quantité remboursable restante est insuffisante pour « ${original.getString("name")} »."
            }
            val unitPrice = original.requiredSafeLong("unitPriceCents")
            val gross = Math.multiplyExact(unitPrice, quantity)
            val rate = original.requiredSafeLong("vatRate")
            val previousGross = Math.multiplyExact(unitPrice, refundedById[lineId] ?: 0L)
            val cumulativeGross = Math.addExact(previousGross, gross)
            val vat =
                Math.round(cumulativeGross.toDouble() * rate.toDouble() / (100.0 + rate.toDouble())) -
                    Math.round(previousGross.toDouble() * rate.toDouble() / (100.0 + rate.toDouble()))
            val canonical =
                JSONObject().apply {
                    put("originalLineId", lineId)
                    put("productId", original.getString("productId"))
                    put("productName", original.getString("name"))
                    put("quantity", quantity)
                    put("unitPriceCents", unitPrice)
                    put("vatRate", rate)
                    put("grossCents", gross)
                    put("vatCents", vat)
                }
            require(CanonicalJson.stringify(line) == CanonicalJson.stringify(canonical)) {
                "Les montants du remboursement ne correspondent pas à la vente originale."
            }
            total = Math.addExact(total, gross)
        }
        return total
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
            correction.optLong("amountDeltaCents") == request.optLong("amountDeltaCents") &&
            CanonicalJson.stringify(correction.opt("refundLines")) ==
                CanonicalJson.stringify(request.opt("refundLines"))
    }

    private fun sameClosureRequest(entry: JSONObject, request: JSONObject): Boolean {
        if (entry.optString("kind") != "closure") return false
        val closure = entry.getJSONObject("closure")
        return closure.optString("operationId") == request.optString("operationId") &&
            closure.optString("periodStart") == request.optString("periodStart") &&
            closure.optString("periodEnd") == request.optString("periodEnd")
    }

    private fun validateCheckoutIntent(intent: JSONObject) {
        val id = intent.requireNonBlank("id")
        val status = intent.getString("status")
        require(
            status in
                setOf(
                    "pending_payment",
                    "payment_to_verify",
                    "payment_confirmed",
                    "finalized",
                    "abandoned",
                ),
        ) { "État d’encaissement invalide." }
        val createdAt = intent.requireNonBlank("createdAt")
        requireIsoTimestamp(createdAt, "createdAt")
        requireIsoTimestamp(intent.requireNonBlank("updatedAt"), "updatedAt")
        val paymentConfirmedAt = intent.optNullableString("paymentConfirmedAt")
        paymentConfirmedAt?.let { requireIsoTimestamp(it, "paymentConfirmedAt") }
        val abandonedAt = intent.optNullableString("abandonedAt")
        abandonedAt?.let { requireIsoTimestamp(it, "abandonedAt") }
        require(status != "payment_confirmed" || paymentConfirmedAt != null) {
            "Un paiement confirmé doit conserver sa date de confirmation."
        }
        require(
            status != "finalized" ||
                (paymentConfirmedAt != null && intent.optNullableString("finalizedOrderId") != null),
        ) { "Un encaissement finalisé doit référencer sa vente et son paiement." }
        require(status != "abandoned" || abandonedAt != null) {
            "Un encaissement abandonné doit conserver sa date d'abandon."
        }
        require(intent.get("printCustomerReceipt") is Boolean) {
            "Le choix d'impression du ticket client doit être booléen."
        }
        val terminal = intent.getJSONObject("terminal")
        val ledgerTerminal = intent.getJSONObject("ledgerSource").getJSONObject("terminal")
        require(terminal.getString("terminalId") == ledgerTerminal.getString("terminalId")) {
            "La source du journal ne correspond pas au terminal de l'encaissement."
        }
        val validationRequest =
            JSONObject().apply {
                put("id", id)
                put("terminal", JSONObject(terminal.toString()))
                put("paymentMethod", intent.getString("paymentMethod"))
                put("paymentStatus", "paid")
                put("paidAt", paymentConfirmedAt ?: createdAt)
                put("items", JSONArray(intent.getJSONArray("cartSnapshot").toString()))
                put("itemCount", intent.getLong("itemCount"))
                put("totalCents", intent.getLong("totalCents"))
                put("createdAt", createdAt)
                put("status", "confirmed")
                put("orderNumberPrefix", intent.getString("orderNumberPrefix"))
                put("receiptNumberPrefix", intent.getString("receiptNumberPrefix"))
                put(
                    "printing",
                    JSONObject()
                        .put("status", "pending")
                        .put("customerReceipt", "pending")
                        .put("preparationTicket", "pending")
                        .put("attempts", 0)
                        .put("updatedAt", createdAt),
                )
            }
        validateNewOrderRequest(validationRequest)
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

    private fun validateNewOrderRequest(order: JSONObject) {
        order.requireNonBlank("id")
        val orderNumberPrefix = order.requireNonBlank("orderNumberPrefix")
        val receiptNumberPrefix = order.requireNonBlank("receiptNumberPrefix")
        val terminal = order.getJSONObject("terminal")
        terminal.requireNonBlank("terminalId")
        val terminalCode = terminal.requireNonBlank("terminalCode")
        require(terminalCode in setOf("A", "B", "C", "D")) {
            "Code terminal invalide."
        }
        require(orderNumberPrefix == terminalCode) {
            "Le préfixe de commande ne correspond pas au terminal."
        }
        require(receiptNumberPrefix.startsWith("R-$terminalCode-")) {
            "Le préfixe de reçu ne correspond pas au terminal."
        }
        terminal.requireNonBlank("displayName")
        require(order.getString("paymentMethod") in setOf("cash", "card")) {
            "Moyen de paiement invalide."
        }
        require(order.getString("paymentStatus") == "paid") { "État de paiement invalide." }
        require(order.getString("status") == "confirmed") { "État de commande invalide." }
        requireIsoTimestamp(order.requireNonBlank("createdAt"), "createdAt")
        requireIsoTimestamp(order.requireNonBlank("paidAt"), "paidAt")

        val items = order.getJSONArray("items")
        require(items.length() > 0) { "La commande doit contenir au moins une ligne." }
        val lineIds = mutableSetOf<String>()
        var expectedItemCount = 0L
        var expectedTotalCents = 0L
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            val lineId = item.requireNonBlank("lineId")
            require(lineIds.add(lineId)) { "L’identifiant de ligne $lineId est dupliqué." }
            item.requireNonBlank("productId")
            item.requireNonBlank("name")
            val quantity = item.requiredSafeLong("quantity")
            require(quantity > 0) { "La quantité de la ligne $lineId doit être strictement positive." }
            val unitPriceCents = item.requiredSafeLong("unitPriceCents")
            require(unitPriceCents >= 0) { "Le prix unitaire de la ligne $lineId est invalide." }
            require(item.requiredSafeLong("vatRate") in setOf(10L, 20L)) {
                "Le taux de TVA de la ligne $lineId n’est pas supporté."
            }

            val lineTotalCents = safeMultiply(quantity, unitPriceCents, "Le total de la ligne $lineId")
            expectedItemCount = safeAdd(expectedItemCount, quantity, "Le nombre total d’articles")
            expectedTotalCents = safeAdd(expectedTotalCents, lineTotalCents, "Le total de la commande")
        }

        val itemCount = order.requiredSafeLong("itemCount")
        val totalCents = order.requiredSafeLong("totalCents")
        require(itemCount in 1..Int.MAX_VALUE.toLong()) { "Le nombre total d’articles est invalide." }
        require(totalCents >= 0) { "Le total de la commande est invalide." }
        require(itemCount == expectedItemCount) {
            "Le nombre total d’articles ne correspond pas aux lignes."
        }
        require(totalCents == expectedTotalCents) {
            "Le total de la commande ne correspond pas aux lignes."
        }
        validatePrinting(order.getJSONObject("printing"))
    }

    private fun requireIsoTimestamp(value: String, field: String) {
        try {
            Instant.parse(value)
        } catch (error: Exception) {
            throw IllegalArgumentException("Le champ $field doit être un timestamp ISO valide.", error)
        }
    }

    private fun requiresPreparation(items: JSONArray): Boolean {
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            if (!item.has("requiresPreparation") || item.optBoolean("requiresPreparation", true)) {
                return true
            }
        }
        return false
    }

    private fun safeMultiply(left: Long, right: Long, label: String): Long {
        val result =
            try {
                Math.multiplyExact(left, right)
            } catch (error: ArithmeticException) {
                throw IllegalArgumentException("$label dépasse la plage entière sûre.", error)
            }
        require(result <= MAX_SAFE_INTEGER) { "$label dépasse la plage entière sûre." }
        return result
    }

    private fun safeAdd(left: Long, right: Long, label: String): Long {
        val result =
            try {
                Math.addExact(left, right)
            } catch (error: ArithmeticException) {
                throw IllegalArgumentException("$label dépasse la plage entière sûre.", error)
            }
        require(result <= MAX_SAFE_INTEGER) { "$label dépasse la plage entière sûre." }
        return result
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
    require(value.toDouble() == numeric && value in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) {
        "Le champ $key dépasse la précision entière prise en charge."
    }
    return value
}

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

private fun JSONObject.takeRequiredString(key: String): String =
    requireNonBlank(key).also { remove(key) }
