package __APP_PACKAGE__

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets

internal enum class UsbPermissionResult {
    GRANTED,
    DENIED,
    DEVICE_DISCONNECTED,
    INCOMPLETE,
}

internal fun <T> resolvePermissionDevice(
    broadcastDevice: T?,
    requestedDeviceId: Int?,
    connectedDevicesById: Map<Int, T>,
): T? = broadcastDevice ?: requestedDeviceId?.let(connectedDevicesById::get)

internal fun classifyUsbPermissionResult(
    deviceAvailable: Boolean,
    hasPermission: Boolean,
    androidReportedGranted: Boolean,
): UsbPermissionResult =
    when {
        !deviceAvailable -> UsbPermissionResult.DEVICE_DISCONNECTED
        hasPermission -> UsbPermissionResult.GRANTED
        !androidReportedGranted -> UsbPermissionResult.DENIED
        else -> UsbPermissionResult.INCOMPLETE
    }

@CapacitorPlugin(name = "EpsonUsbPrinter")
class EpsonUsbPrinterPlugin : Plugin() {
    private var permissionCallId: String? = null
    private var permissionReceiver: BroadcastReceiver? = null
    private var permissionDeviceId: Int? = null

    @PluginMethod
    fun getDevices(call: PluginCall) {
        val manager = getUsbManager()
        val devices = JSArray()
        manager.deviceList.values.forEach { device ->
            devices.put(toJsDevice(manager, device))
        }
        call.resolve(JSObject().apply { put("devices", devices) })
    }

    @PluginMethod
    @Synchronized
    fun getStatus(call: PluginCall) {
        val deviceId = call.getInt("deviceId")
        if (deviceId == null) {
            call.reject("deviceId manquant.", "USB_DEVICE_ID_REQUIRED")
            return
        }

        val manager = getUsbManager()
        val device = findDevice(manager, deviceId)
        if (device == null) {
            call.reject("Le périphérique USB n’est plus connecté.", "USB_DEVICE_NOT_FOUND")
            return
        }
        if (!manager.hasPermission(device)) {
            call.reject("Autorisez d’abord l’accès USB à l’imprimante.", "USB_PERMISSION_REQUIRED")
            return
        }

        val printerInterface = findPrinterInterface(device)
        if (printerInterface == null) {
            call.reject(
                "Aucune sortie USB BULK compatible n’a été trouvée sur ce périphérique.",
                "USB_BULK_OUT_NOT_FOUND",
            )
            return
        }
        val inEndpoint = printerInterface.inEndpoint
        if (inEndpoint == null) {
            call.reject(
                "Aucune entrée USB BULK permettant de lire le statut de l’imprimante n’a été trouvée sur la même interface.",
                "USB_BULK_IN_NOT_FOUND",
            )
            return
        }

        val connection = manager.openDevice(device)
        if (connection == null) {
            call.reject("Android n’a pas pu ouvrir le périphérique USB.", "USB_OPEN_FAILED")
            return
        }

        var claimed = false
        try {
            claimed = connection.claimInterface(printerInterface.usbInterface, true)
            if (!claimed) {
                call.reject(
                    "Impossible de prendre le contrôle de l’interface USB de l’imprimante.",
                    "USB_CLAIM_FAILED",
                )
                return
            }

            val status =
                readHardwareStatus(
                    manager,
                    device,
                    connection,
                    printerInterface.outEndpoint,
                    inEndpoint,
                )
            call.resolve(status.toJsObject())
        } catch (error: PrinterStatusException) {
            call.reject(error.message, error.code, error)
        } catch (error: Exception) {
            call.reject(
                "Impossible de lire le statut matériel : ${error.message}",
                "USB_STATUS_ERROR",
                error,
            )
        } finally {
            if (claimed) connection.releaseInterface(printerInterface.usbInterface)
            connection.close()
        }
    }

    @PluginMethod
    @Synchronized
    fun requestPermission(call: PluginCall) {
        val deviceId = call.getInt("deviceId")
        if (deviceId == null) {
            call.reject("deviceId manquant.", "USB_DEVICE_ID_REQUIRED")
            return
        }

        val manager = getUsbManager()
        val device = findDevice(manager, deviceId)
        if (device == null) {
            call.reject("Le périphérique USB n’est plus connecté.", "USB_DEVICE_NOT_FOUND")
            return
        }

        if (manager.hasPermission(device)) {
            resolvePermission(call, manager, device, true)
            return
        }

        if (permissionCallId != null) {
            call.reject("Une demande d’autorisation USB est déjà en cours.", "USB_PERMISSION_PENDING")
            return
        }

        val permissionAction = "${context.packageName}.USB_PERMISSION"
        val permissionIntent = Intent(permissionAction).setPackage(context.packageName)
        val pendingIntent =
            PendingIntent.getBroadcast(
                context,
                0,
                permissionIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        permissionCallId = call.callbackId
        permissionDeviceId = deviceId
        call.setKeepAlive(true)
        bridge.saveCall(call)

        val receiver =
            object : BroadcastReceiver() {
                override fun onReceive(receiverContext: Context, intent: Intent) {
                    if (intent.action != permissionAction) return

                    val pendingCall = permissionCallId?.let(bridge::getSavedCall)
                    val requestedDeviceId = permissionDeviceId
                    val broadcastDevice = getUsbDeviceExtra(intent)
                    val androidReportedGranted =
                        intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    val resolvedDevice =
                        resolvePermissionDevice(
                            broadcastDevice,
                            requestedDeviceId,
                            manager.deviceList.values.associateBy { it.deviceId },
                        )
                    val permissionResult =
                        classifyUsbPermissionResult(
                            deviceAvailable = resolvedDevice != null,
                            hasPermission =
                                resolvedDevice?.let(manager::hasPermission) ?: false,
                            androidReportedGranted = androidReportedGranted,
                        )

                    clearPermissionRequestState()

                    if (pendingCall == null) return
                    try {
                        when (permissionResult) {
                            UsbPermissionResult.GRANTED ->
                                resolvePermission(pendingCall, manager, resolvedDevice!!, true)
                            UsbPermissionResult.DENIED ->
                                resolvePermission(pendingCall, manager, resolvedDevice!!, false)
                            UsbPermissionResult.DEVICE_DISCONNECTED ->
                                pendingCall.reject(
                                    "L’imprimante a été débranchée pendant la demande d’autorisation USB. Rebranchez-la puis réessayez.",
                                    "USB_PERMISSION_DEVICE_DISCONNECTED",
                                )
                            UsbPermissionResult.INCOMPLETE ->
                                pendingCall.reject(
                                    "Android a indiqué que l’autorisation USB était accordée, mais elle n’est pas disponible. Réessayez après avoir rebranché l’imprimante.",
                                    "USB_PERMISSION_INCOMPLETE",
                                )
                        }
                    } finally {
                        pendingCall.release(bridge)
                    }
                }
            }
        permissionReceiver = receiver

        try {
            val filter = IntentFilter(permissionAction)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                context.registerReceiver(receiver, filter)
            }

            manager.requestPermission(device, pendingIntent)
        } catch (error: Exception) {
            clearPermissionRequestState()
            call.reject(
                "La demande d’autorisation USB n’a pas pu être lancée. Vérifiez la connexion de l’imprimante puis réessayez.",
                "USB_PERMISSION_REQUEST_FAILED",
                error,
            )
            call.release(bridge)
        }
    }

    @PluginMethod
    @Synchronized
    fun printTest(call: PluginCall) {
        val deviceId = call.getInt("deviceId")
        if (deviceId == null) {
            call.reject("deviceId manquant.", "USB_DEVICE_ID_REQUIRED")
            return
        }

        val manager = getUsbManager()
        val device = findDevice(manager, deviceId)
        if (device == null) {
            call.reject("Le périphérique USB n’est plus connecté.", "USB_DEVICE_NOT_FOUND")
            return
        }
        if (!manager.hasPermission(device)) {
            call.reject("Autorisez d’abord l’accès USB à l’imprimante.", "USB_PERMISSION_REQUIRED")
            return
        }

        val printerInterface = findPrinterInterface(device)
        if (printerInterface == null) {
            call.reject(
                "Aucune sortie USB BULK compatible n’a été trouvée sur ce périphérique.",
                "USB_BULK_OUT_NOT_FOUND",
            )
            return
        }
        val inEndpoint = printerInterface.inEndpoint
        if (inEndpoint == null) {
            call.reject(
                "Le statut matériel ne peut pas être lu : entrée USB BULK absente.",
                "USB_BULK_IN_NOT_FOUND",
            )
            return
        }

        val connection = manager.openDevice(device)
        if (connection == null) {
            call.reject("Android n’a pas pu ouvrir le périphérique USB.", "USB_OPEN_FAILED")
            return
        }

        var claimed = false
        try {
            claimed = connection.claimInterface(printerInterface.usbInterface, true)
            if (!claimed) {
                call.reject(
                    "Impossible de prendre le contrôle de l’interface USB de l’imprimante.",
                    "USB_CLAIM_FAILED",
                )
                return
            }

            val hardwareStatus =
                readHardwareStatus(
                    manager,
                    device,
                    connection,
                    printerInterface.outEndpoint,
                    inEndpoint,
                )
            val readinessError = hardwareStatus.readinessError
            if (readinessError != null) {
                call.reject(readinessError.message, readinessError.code)
                return
            }

            val ticket = buildTestTicket()
            val transfer =
                writeUsbData(
                    manager,
                    device,
                    connection,
                    printerInterface.outEndpoint,
                    ticket,
                )
            if (transfer.status != UsbWriteStatus.COMPLETE) {
                call.reject(
                    transferFailureMessage(transfer),
                    if (transfer.status == UsbWriteStatus.PARTIAL) {
                        "USB_TRANSFER_PARTIAL"
                    } else {
                        "USB_TRANSFER_FAILED"
                    },
                )
                return
            }

            call.resolve(
                JSObject().apply {
                    put("ok", true)
                    put("bytesWritten", transfer.bytesWritten)
                    put("device", toJsDevice(manager, device))
                },
            )
        } catch (error: PrinterStatusException) {
            call.reject(error.message, error.code, error)
        } catch (error: Exception) {
            call.reject(
                "Erreur pendant l’impression USB : ${error.message}",
                "USB_PRINT_ERROR",
                error,
            )
        } finally {
            if (claimed) connection.releaseInterface(printerInterface.usbInterface)
            connection.close()
        }
    }

    @PluginMethod
    @Synchronized
    fun printJob(call: PluginCall) {
        val deviceId = call.getInt("deviceId")
        val steps = call.getArray("steps")
        if (deviceId == null) {
            call.reject("deviceId manquant.", "USB_DEVICE_ID_REQUIRED")
            return
        }
        if (steps == null || steps.length() == 0) {
            call.reject("La séquence d’impression est vide.", "USB_PRINT_JOB_INVALID")
            return
        }

        val manager = getUsbManager()
        val device = findDevice(manager, deviceId)
        if (device == null) {
            call.reject("Le périphérique USB n’est plus connecté.", "USB_DEVICE_NOT_FOUND")
            return
        }
        if (!manager.hasPermission(device)) {
            call.reject("Autorisez d’abord l’accès USB à l’imprimante.", "USB_PERMISSION_REQUIRED")
            return
        }

        val printerInterface = findPrinterInterface(device)
        if (printerInterface == null) {
            call.reject(
                "Aucune sortie USB BULK compatible n’a été trouvée sur ce périphérique.",
                "USB_BULK_OUT_NOT_FOUND",
            )
            return
        }
        val inEndpoint = printerInterface.inEndpoint
        if (inEndpoint == null) {
            call.reject(
                "Le statut matériel ne peut pas être lu : entrée USB BULK absente.",
                "USB_BULK_IN_NOT_FOUND",
            )
            return
        }

        val connection = manager.openDevice(device)
        if (connection == null) {
            call.reject("Android n’a pas pu ouvrir le périphérique USB.", "USB_OPEN_FAILED")
            return
        }

        var claimed = false
        var customerReceiptPrinted = false
        var bytesWritten = 0
        val completedDocuments = JSArray()
        val unknownDocuments = JSArray()
        val warnings = JSArray()

        try {
            claimed = connection.claimInterface(printerInterface.usbInterface, true)
            if (!claimed) {
                rejectPrintJob(
                    call,
                    completedDocuments,
                    "Impossible de prendre le contrôle de l’interface USB de l’imprimante.",
                    "USB_CLAIM_FAILED",
                )
                return
            }

            val hardwareStatus =
                readHardwareStatus(
                    manager,
                    device,
                    connection,
                    printerInterface.outEndpoint,
                    inEndpoint,
                )
            val readinessError = hardwareStatus.readinessError
            if (readinessError != null) {
                rejectPrintJob(
                    call,
                    completedDocuments,
                    readinessError.message,
                    readinessError.code,
                )
                return
            }

            for (index in 0 until steps.length()) {
                val step = steps.getJSONObject(index)
                val type = step.optString("type", "")

                if (type == "document") {
                    val documentType = step.optString("documentType", "")
                    val encodedData = step.optString("dataBase64", "")
                    if (encodedData.isEmpty()) {
                        rejectPrintJob(
                            call,
                            completedDocuments,
                            "Le document à imprimer est vide.",
                            "USB_PRINT_JOB_INVALID",
                        )
                        return
                    }

                    val data = Base64.decode(encodedData, Base64.DEFAULT)
                    val transfer =
                        writeUsbData(
                            manager,
                            device,
                            connection,
                            printerInterface.outEndpoint,
                            data,
                        )
                    if (transfer.status != UsbWriteStatus.COMPLETE) {
                        if (transfer.status == UsbWriteStatus.PARTIAL) {
                            unknownDocuments.put(documentType)
                        }
                        val code =
                            if (documentType == "customerReceipt") {
                                if (transfer.status == UsbWriteStatus.PARTIAL) {
                                    "USB_CUSTOMER_RECEIPT_WRITE_PARTIAL"
                                } else {
                                    "USB_CUSTOMER_RECEIPT_WRITE_FAILED"
                                }
                            } else {
                                if (transfer.status == UsbWriteStatus.PARTIAL) {
                                    "USB_PREPARATION_WRITE_PARTIAL"
                                } else {
                                    "USB_PREPARATION_WRITE_FAILED"
                                }
                            }
                        val prefix =
                            when {
                                transfer.status == UsbWriteStatus.PARTIAL &&
                                    documentType == "customerReceipt" ->
                                    "L’envoi du ticket client a été interrompu. "
                                transfer.status == UsbWriteStatus.PARTIAL && customerReceiptPrinted ->
                                    "Le ticket client a été imprimé, mais l’envoi du ticket de préparation a été interrompu. "
                                transfer.status == UsbWriteStatus.PARTIAL ->
                                    "L’envoi du ticket de préparation a été interrompu. "
                                documentType == "customerReceipt" ->
                                    "L’impression du ticket client a échoué. "
                                customerReceiptPrinted ->
                                    "Le ticket client a été imprimé, mais le ticket de préparation a échoué. "
                                else -> "L’impression du ticket de préparation a échoué. "
                            }
                        rejectPrintJob(
                            call,
                            completedDocuments,
                            prefix + transferFailureMessage(transfer),
                            code,
                            unknownDocuments,
                            transfer,
                        )
                        return
                    }

                    bytesWritten += transfer.bytesWritten
                    completedDocuments.put(documentType)
                    if (documentType == "customerReceipt") customerReceiptPrinted = true
                    continue
                }

                if (type == "cut") {
                    val afterDocument = step.optString("afterDocument", "")
                    val feedLines = maxOf(0, step.optInt("feedLines", 4))
                    val feed = repeatedLineFeeds(feedLines)
                    val feedTransfer =
                        writeUsbData(
                            manager,
                            device,
                            connection,
                            printerInterface.outEndpoint,
                            feed,
                        )
                    val cutTransfer =
                        if (feedTransfer.status == UsbWriteStatus.COMPLETE) {
                            writeUsbData(
                                manager,
                                device,
                                connection,
                                printerInterface.outEndpoint,
                                FULL_CUT_COMMAND,
                            )
                        } else {
                            null
                        }

                    if (
                        feedTransfer.status == UsbWriteStatus.COMPLETE &&
                        cutTransfer?.status == UsbWriteStatus.COMPLETE
                    ) {
                        bytesWritten += feedTransfer.bytesWritten + cutTransfer.bytesWritten
                        continue
                    }

                    val fallback = buildCutFallback()
                    val fallbackTransfer =
                        writeUsbData(
                            manager,
                            device,
                            connection,
                            printerInterface.outEndpoint,
                            fallback,
                        )
                    if (fallbackTransfer.status != UsbWriteStatus.COMPLETE) {
                        val code =
                            if (afterDocument == "customerReceipt") {
                                "USB_CUSTOMER_CUT_FAILED"
                            } else {
                                "USB_PREPARATION_CUT_FAILED"
                            }
                        rejectPrintJob(
                            call,
                            completedDocuments,
                            "La coupe a échoué et la séparation visuelle de secours n’a pas pu être imprimée.",
                            code,
                            unknownDocuments,
                            fallbackTransfer,
                        )
                        return
                    }

                    bytesWritten +=
                        feedTransfer.bytesWritten +
                        (cutTransfer?.bytesWritten ?: 0) +
                        fallbackTransfer.bytesWritten
                    val warning =
                        "Coupe indisponible après $afterDocument : séparation visuelle imprimée."
                    warnings.put(warning)
                    Log.w(TAG, warning)
                    continue
                }

                rejectPrintJob(
                    call,
                    completedDocuments,
                    "Étape d’impression inconnue : $type",
                    "USB_PRINT_JOB_INVALID",
                )
                return
            }

            call.resolve(
                JSObject().apply {
                    put("ok", true)
                    put("bytesWritten", bytesWritten)
                    put("completedDocuments", completedDocuments)
                    put("unknownDocuments", unknownDocuments)
                    put("warnings", warnings)
                    put("device", toJsDevice(manager, device))
                },
            )
        } catch (error: PrinterStatusException) {
            rejectPrintJob(call, completedDocuments, error.message, error.code)
        } catch (_: IllegalArgumentException) {
            rejectPrintJob(
                call,
                completedDocuments,
                "Le contenu ESC/POS reçu est invalide.",
                "USB_PRINT_JOB_INVALID",
            )
        } catch (error: Exception) {
            rejectPrintJob(
                call,
                completedDocuments,
                "Erreur pendant la séquence d’impression USB : ${error.message}",
                "USB_PRINT_ERROR",
            )
        } finally {
            if (claimed) connection.releaseInterface(printerInterface.usbInterface)
            connection.close()
        }
    }

    private fun rejectPrintJob(
        call: PluginCall,
        completedDocuments: JSArray,
        message: String,
        code: String,
        unknownDocuments: JSArray = JSArray(),
        transfer: UsbWriteResult? = null,
    ) {
        val progress =
            JSObject().apply {
                put("completedDocuments", completedDocuments)
                put("unknownDocuments", unknownDocuments)
                if (transfer != null) put("transfer", transfer.toJsObject())
            }
        call.reject(message, code, null, progress)
    }

    override fun handleOnDestroy() {
        val callId = permissionCallId
        clearPermissionRequestState()
        if (callId != null) {
            bridge.getSavedCall(callId)?.let { pendingCall ->
                pendingCall.reject(
                    "La demande USB a été interrompue car l’application a été fermée.",
                    "USB_PERMISSION_INTERRUPTED",
                )
                pendingCall.release(bridge)
            }
        }
        super.handleOnDestroy()
    }

    private fun getUsbManager(): UsbManager =
        context.getSystemService(Context.USB_SERVICE) as UsbManager

    private fun findDevice(manager: UsbManager, deviceId: Int): UsbDevice? =
        manager.deviceList.values.firstOrNull { it.deviceId == deviceId }

    private fun toJsDevice(manager: UsbManager, device: UsbDevice): JSObject =
        JSObject().apply {
            put("deviceId", device.deviceId)
            put("deviceName", device.deviceName)
            put("vendorId", device.vendorId)
            put("productId", device.productId)
            put("manufacturerName", safeManufacturerName(device))
            put("productName", safeProductName(device))
            put("serialNumber", safeSerialNumber(manager, device))
            put("epson", device.vendorId == EPSON_VENDOR_ID)
            put("hasPermission", manager.hasPermission(device))
            val printerInterface = findPrinterInterface(device)
            put("hasBulkOutEndpoint", printerInterface != null)
            put("hasBulkInEndpoint", printerInterface?.inEndpoint != null)
            put("hasPrinterClassInterface", printerInterface?.isPrinterClass == true)
        }

    private fun safeManufacturerName(device: UsbDevice): String? =
        try {
            device.manufacturerName
        } catch (_: SecurityException) {
            null
        }

    private fun safeProductName(device: UsbDevice): String? =
        try {
            device.productName
        } catch (_: SecurityException) {
            null
        }

    private fun safeSerialNumber(manager: UsbManager, device: UsbDevice): String? {
        if (!manager.hasPermission(device)) return null
        return try {
            device.serialNumber
        } catch (_: SecurityException) {
            null
        }
    }

    private fun findPrinterInterface(device: UsbDevice): PrinterUsbInterface? {
        var printerClassPairedInterface: PrinterUsbInterface? = null
        var printerClassOutOnlyInterface: PrinterUsbInterface? = null
        var pairedInterface: PrinterUsbInterface? = null
        var outOnlyInterface: PrinterUsbInterface? = null
        for (interfaceIndex in 0 until device.interfaceCount) {
            val usbInterface = device.getInterface(interfaceIndex)
            var outEndpoint: UsbEndpoint? = null
            var inEndpoint: UsbEndpoint? = null
            for (endpointIndex in 0 until usbInterface.endpointCount) {
                val endpoint = usbInterface.getEndpoint(endpointIndex)
                if (endpoint.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                if (endpoint.direction == UsbConstants.USB_DIR_OUT) outEndpoint = endpoint
                if (endpoint.direction == UsbConstants.USB_DIR_IN) inEndpoint = endpoint
            }
            if (outEndpoint != null && inEndpoint != null) {
                val candidate =
                    PrinterUsbInterface(
                        usbInterface,
                        outEndpoint,
                        inEndpoint,
                        usbInterface.interfaceClass == UsbConstants.USB_CLASS_PRINTER,
                    )
                if (usbInterface.interfaceClass == UsbConstants.USB_CLASS_PRINTER) {
                    if (printerClassPairedInterface == null) {
                        printerClassPairedInterface = candidate
                    }
                } else if (pairedInterface == null) {
                    pairedInterface = candidate
                }
            }
            if (outEndpoint != null) {
                val candidate =
                    PrinterUsbInterface(
                        usbInterface,
                        outEndpoint,
                        null,
                        usbInterface.interfaceClass == UsbConstants.USB_CLASS_PRINTER,
                    )
                if (usbInterface.interfaceClass == UsbConstants.USB_CLASS_PRINTER) {
                    if (printerClassOutOnlyInterface == null) {
                        printerClassOutOnlyInterface = candidate
                    }
                } else if (outOnlyInterface == null) {
                    outOnlyInterface = candidate
                }
            }
        }
        return printerClassPairedInterface ?: pairedInterface ?: printerClassOutOnlyInterface
            ?: outOnlyInterface
    }

    private fun readHardwareStatus(
        manager: UsbManager,
        device: UsbDevice,
        connection: UsbDeviceConnection,
        outEndpoint: UsbEndpoint,
        inEndpoint: UsbEndpoint,
    ): HardwareStatus {
        val transfer = writeUsbData(manager, device, connection, outEndpoint, STATUS_COMMANDS)
        if (transfer.status != UsbWriteStatus.COMPLETE) {
            throw PrinterStatusException(
                transferFailureMessage(transfer, "la demande de statut"),
                if (transfer.status == UsbWriteStatus.PARTIAL) {
                    "USB_STATUS_WRITE_PARTIAL"
                } else {
                    "USB_STATUS_WRITE_FAILED"
                },
            )
        }

        val response = ByteArray(3)
        var received = 0
        val deadline = SystemClock.elapsedRealtime() + STATUS_READ_TIMEOUT_MS
        while (received < response.size) {
            val timeout = maxOf(1L, deadline - SystemClock.elapsedRealtime()).toInt()
            val read =
                connection.bulkTransfer(
                    inEndpoint,
                    response,
                    received,
                    response.size - received,
                    timeout,
                )
            if (read <= 0) {
                ensureDeviceStillAvailable(manager, device)
                val code =
                    if (received == 0) "USB_STATUS_NO_RESPONSE" else "USB_STATUS_RESPONSE_PARTIAL"
                val message =
                    if (received == 0) {
                        "L’imprimante n’a pas répondu à la demande de statut matériel."
                    } else {
                        "Réponse de statut USB incomplète ($received/${response.size} octets)."
                    }
                throw PrinterStatusException(message, code)
            }
            received += read
            if (SystemClock.elapsedRealtime() >= deadline && received < response.size) {
                throw PrinterStatusException(
                    "Réponse de statut USB incomplète ($received/${response.size} octets).",
                    "USB_STATUS_RESPONSE_PARTIAL",
                )
            }
        }

        val offline = response[0].toInt() and 0xFF
        val error = response[1].toInt() and 0xFF
        val paper = response[2].toInt() and 0xFF
        validateStatusByte(offline, "DLE EOT 2")
        validateStatusByte(error, "DLE EOT 3")
        validateStatusByte(paper, "DLE EOT 4")
        validatePaperSensorBits(paper)
        return HardwareStatus(offline, error, paper)
    }

    private fun ensureDeviceStillAvailable(manager: UsbManager, device: UsbDevice) {
        val currentDevice = findDevice(manager, device.deviceId)
        if (currentDevice == null) {
            throw PrinterStatusException(
                "L’imprimante a été débranchée pendant la lecture du statut.",
                "USB_DEVICE_NOT_FOUND",
            )
        }
        if (!manager.hasPermission(currentDevice)) {
            throw PrinterStatusException(
                "L’autorisation USB a été perdue pendant la lecture du statut.",
                "USB_PERMISSION_REQUIRED",
            )
        }
    }

    private fun validateStatusByte(value: Int, command: String) {
        // Epson garantit 0xx1xx10b pour chaque réponse DLE EOT.
        if (value and 0x93 != 0x12) {
            throw PrinterStatusException(
                "Réponse ESC/POS inattendue pour $command : ${toHex(value)}.",
                "USB_STATUS_UNEXPECTED_RESPONSE",
            )
        }
    }

    private fun validatePaperSensorBits(paper: Int) {
        val nearEnd = paper and 0x0C
        val paperEnd = paper and 0x60
        if ((nearEnd != 0 && nearEnd != 0x0C) || (paperEnd != 0 && paperEnd != 0x60)) {
            throw PrinterStatusException(
                "Réponse ESC/POS incohérente pour les capteurs papier : ${toHex(paper)}.",
                "USB_STATUS_UNEXPECTED_RESPONSE",
            )
        }
    }

    private fun toHex(value: Int): String = String.format("0x%02X", value and 0xFF)

    private fun buildTestTicket(): ByteArray {
        val bytes = ByteArrayOutputStream()
        bytes.write(byteArrayOf(0x1B, 0x40)) // ESC @ : initialise
        bytes.write(byteArrayOf(0x1B, 0x61, 0x01)) // centre
        bytes.write(byteArrayOf(0x1B, 0x45, 0x01)) // gras
        writeAscii(bytes, "SAMHAIN\n")
        bytes.write(byteArrayOf(0x1B, 0x45, 0x00))
        writeAscii(bytes, "TEST IMPRESSION USB\n\n")
        bytes.write(byteArrayOf(0x1B, 0x61, 0x00)) // gauche
        writeAscii(bytes, "Burger Samhain            16,00 EUR\n")
        writeAscii(bytes, "Cafe                       1,50 EUR\n")
        writeAscii(bytes, "------------------------------------------\n")
        bytes.write(byteArrayOf(0x1B, 0x45, 0x01))
        writeAscii(bytes, "TOTAL                     17,50 EUR\n")
        bytes.write(byteArrayOf(0x1B, 0x45, 0x00))
        writeAscii(bytes, "\nCaisse A\nCommande TEST-A001\n")
        writeAscii(bytes, "USB-C -> USB-B\n")
        writeAscii(bytes, "\n\n\n\n")
        bytes.write(byteArrayOf(0x1D, 0x56, 0x00)) // GS V 0 : coupe
        return bytes.toByteArray()
    }

    private fun writeAscii(bytes: ByteArrayOutputStream, text: String) {
        bytes.write(text.toByteArray(StandardCharsets.US_ASCII))
    }

    private fun repeatedLineFeeds(count: Int): ByteArray = ByteArray(count) { 0x0A }

    private fun buildCutFallback(): ByteArray =
        "\n------------------------------------------\n\n\n\n"
            .toByteArray(StandardCharsets.US_ASCII)

    private fun writeUsbData(
        manager: UsbManager,
        device: UsbDevice,
        connection: UsbDeviceConnection,
        endpoint: UsbEndpoint,
        data: ByteArray,
    ): UsbWriteResult =
        writeUsbBuffer(
            data = data,
            maxChunkSize = USB_WRITE_CHUNK_SIZE,
            isDeviceConnected = { findDevice(manager, device.deviceId) != null },
        ) { buffer, offset, length ->
            connection.bulkTransfer(endpoint, buffer, offset, length, TRANSFER_TIMEOUT_MS)
        }

    private fun transferFailureMessage(
        transfer: UsbWriteResult,
        subject: String = "le document",
    ): String {
        val progress = "${transfer.bytesWritten}/${transfer.totalBytes} octets"
        if (transfer.failure == UsbWriteFailure.DEVICE_DISCONNECTED) {
            return "L’imprimante a été débranchée pendant le transfert de $subject ($progress)."
        }
        return if (transfer.status == UsbWriteStatus.PARTIAL) {
            "Le transfert USB de $subject s’est interrompu après $progress. Le résultat imprimé doit être vérifié."
        } else {
            "Le transfert USB de $subject a échoué avant l’envoi du premier octet."
        }
    }

    private fun UsbWriteResult.toJsObject(): JSObject =
        JSObject().apply {
            put(
                "status",
                when (status) {
                    UsbWriteStatus.COMPLETE -> "complete"
                    UsbWriteStatus.NO_BYTES_SENT -> "no_bytes_sent"
                    UsbWriteStatus.PARTIAL -> "partial"
                },
            )
            put("bytesWritten", bytesWritten)
            put("totalBytes", totalBytes)
            if (failure != null) {
                put(
                    "failureKind",
                    when (failure) {
                        UsbWriteFailure.DEVICE_DISCONNECTED -> "device_disconnected"
                        UsbWriteFailure.TRANSPORT_ERROR -> "transport_error"
                    },
                )
            }
        }

    private fun resolvePermission(
        call: PluginCall,
        manager: UsbManager,
        device: UsbDevice,
        granted: Boolean,
    ) {
        call.resolve(
            JSObject().apply {
                put("granted", granted)
                put("device", toJsDevice(manager, device))
            },
        )
    }

    @Suppress("DEPRECATION")
    private fun getUsbDeviceExtra(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }

    private fun unregisterPermissionReceiver() {
        val receiver = permissionReceiver ?: return
        try {
            context.unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
            // Déjà désenregistré.
        }
        permissionReceiver = null
    }

    private fun clearPermissionRequestState() {
        unregisterPermissionReceiver()
        permissionCallId = null
        permissionDeviceId = null
    }

    private data class PrinterUsbInterface(
        val usbInterface: UsbInterface,
        val outEndpoint: UsbEndpoint,
        val inEndpoint: UsbEndpoint?,
        val isPrinterClass: Boolean,
    )

    private class PrinterStatusException(
        override val message: String,
        val code: String,
    ) : Exception(message)

    private data class PrinterReadinessError(
        val message: String,
        val code: String,
    )

    private class HardwareStatus(
        private val offline: Int,
        private val error: Int,
        private val paper: Int,
    ) {
        private val isCoverOpen: Boolean
            get() = offline and 0x04 != 0

        private val isPaperFeedButtonPressed: Boolean
            get() = offline and 0x08 != 0

        private val isPaperOut: Boolean
            get() = offline and 0x20 != 0 || paper and 0x60 == 0x60

        private val isOfflineError: Boolean
            get() = offline and 0x40 != 0

        private val isRecoverableError: Boolean
            get() = error and 0x04 != 0

        private val isCutterError: Boolean
            get() = error and 0x08 != 0

        private val isUnrecoverableError: Boolean
            get() = error and 0x20 != 0

        private val isAutoRecoverableError: Boolean
            get() = error and 0x40 != 0

        private val isPaperNearEnd: Boolean
            get() = paper and 0x0C == 0x0C

        private val hasError: Boolean
            get() =
                isOfflineError ||
                    isRecoverableError ||
                    isCutterError ||
                    isUnrecoverableError ||
                    isAutoRecoverableError

        private val isOnline: Boolean
            get() = !isCoverOpen && !isPaperFeedButtonPressed && !isPaperOut && !hasError

        val readinessError: PrinterReadinessError?
            get() =
                when {
                    isCoverOpen ->
                        PrinterReadinessError(
                            "Le capot de l’imprimante est ouvert. Fermez-le puis réessayez.",
                            "USB_PRINTER_COVER_OPEN",
                        )
                    isPaperOut ->
                        PrinterReadinessError(
                            "L’imprimante n’a plus de papier. Remettez un rouleau puis réessayez.",
                            "USB_PRINTER_PAPER_OUT",
                        )
                    hasError ->
                        PrinterReadinessError(
                            "L’imprimante signale une erreur matérielle. Vérifiez le papier, le cutter et les voyants.",
                            "USB_PRINTER_HARDWARE_ERROR",
                        )
                    !isOnline ->
                        PrinterReadinessError(
                            "L’imprimante ne répond pas comme prête. Vérifiez-la puis réessayez.",
                            "USB_PRINTER_OFFLINE",
                        )
                    else -> null
                }

        fun toJsObject(): JSObject =
            JSObject().apply {
                put("connected", true)
                put("online", isOnline)
                put("paperOut", isPaperOut)
                put("paperNearEnd", isPaperNearEnd)
                put("coverOpen", isCoverOpen)
                put("error", hasError)
                put("cutterError", isCutterError)
                put("recoverableError", isRecoverableError)
                put("unrecoverableError", isUnrecoverableError)
                put("autoRecoverableError", isAutoRecoverableError)
                put(
                    "raw",
                    JSObject().apply {
                        put("offline", offline)
                        put("error", error)
                        put("paper", paper)
                    },
                )
            }
    }

    private companion object {
        const val TAG = "EpsonUsbPrinter"
        const val EPSON_VENDOR_ID = 0x04B8
        const val TRANSFER_TIMEOUT_MS = 4_000
        const val STATUS_READ_TIMEOUT_MS = 1_500
        const val USB_WRITE_CHUNK_SIZE = 16 * 1024
        val STATUS_COMMANDS =
            byteArrayOf(
                0x10,
                0x04,
                0x02,
                0x10,
                0x04,
                0x03,
                0x10,
                0x04,
                0x04,
            )
        val FULL_CUT_COMMAND = byteArrayOf(0x1D, 0x56, 0x00)
    }
}
