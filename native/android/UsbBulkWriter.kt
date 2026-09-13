package __APP_PACKAGE__

internal enum class UsbWriteStatus {
    COMPLETE,
    NO_BYTES_SENT,
    PARTIAL,
}

internal enum class UsbWriteFailure {
    DEVICE_DISCONNECTED,
    TRANSPORT_ERROR,
}

internal data class UsbWriteResult(
    val status: UsbWriteStatus,
    val bytesWritten: Int,
    val totalBytes: Int,
    val failure: UsbWriteFailure? = null,
)

/**
 * Advances only by the byte count confirmed by the USB transport. A non-positive result stops the
 * transfer immediately so a stalled Android endpoint cannot create an infinite retry loop.
 */
internal fun writeUsbBuffer(
    data: ByteArray,
    maxChunkSize: Int,
    isDeviceConnected: () -> Boolean,
    writeChunk: (data: ByteArray, offset: Int, length: Int) -> Int,
): UsbWriteResult {
    require(maxChunkSize > 0) { "maxChunkSize doit être strictement positif." }

    var offset = 0
    while (offset < data.size) {
        if (!isDeviceConnected()) {
            return failedWriteResult(offset, data.size, UsbWriteFailure.DEVICE_DISCONNECTED)
        }

        val requestedLength = minOf(maxChunkSize, data.size - offset)
        val written =
            try {
                writeChunk(data, offset, requestedLength)
            } catch (_: Exception) {
                return failedWriteResult(
                    offset,
                    data.size,
                    if (isDeviceConnected()) {
                        UsbWriteFailure.TRANSPORT_ERROR
                    } else {
                        UsbWriteFailure.DEVICE_DISCONNECTED
                    },
                )
            }

        if (written <= 0 || written > requestedLength) {
            return failedWriteResult(
                offset,
                data.size,
                if (isDeviceConnected()) {
                    UsbWriteFailure.TRANSPORT_ERROR
                } else {
                    UsbWriteFailure.DEVICE_DISCONNECTED
                },
            )
        }
        offset += written
    }

    return UsbWriteResult(UsbWriteStatus.COMPLETE, offset, data.size)
}

private fun failedWriteResult(
    bytesWritten: Int,
    totalBytes: Int,
    failure: UsbWriteFailure,
): UsbWriteResult =
    UsbWriteResult(
        status = if (bytesWritten == 0) UsbWriteStatus.NO_BYTES_SENT else UsbWriteStatus.PARTIAL,
        bytesWritten = bytesWritten,
        totalBytes = totalBytes,
        failure = failure,
    )
