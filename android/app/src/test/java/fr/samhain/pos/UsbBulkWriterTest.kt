package fr.samhain.pos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbBulkWriterTest {
    @Test
    fun `completes a document written in one transfer`() {
        val result = writeWithResponses(1_600, 1_600)

        assertEquals(UsbWriteStatus.COMPLETE, result.bytes.status)
        assertEquals(1_600, result.bytes.bytesWritten)
        assertEquals(1_600, result.bytes.totalBytes)
        assertEquals(listOf(WriteCall(0, 1_600)), result.calls)
    }

    @Test
    fun `continues at the exact offset after a positive partial write`() {
        val result = writeWithResponses(1_600, 900, 700)

        assertEquals(UsbWriteStatus.COMPLETE, result.bytes.status)
        assertEquals(1_600, result.bytes.bytesWritten)
        assertEquals(listOf(WriteCall(0, 1_600), WriteCall(900, 700)), result.calls)
    }

    @Test
    fun `reports no bytes sent when the first transfer makes no progress`() {
        val result = writeWithResponses(1_600, 0)

        assertEquals(UsbWriteStatus.NO_BYTES_SENT, result.bytes.status)
        assertEquals(0, result.bytes.bytesWritten)
        assertEquals(UsbWriteFailure.TRANSPORT_ERROR, result.bytes.failure)
    }

    @Test
    fun `reports an ambiguous partial document after progress then failure`() {
        val result = writeWithResponses(1_600, 900, -1)

        assertEquals(UsbWriteStatus.PARTIAL, result.bytes.status)
        assertEquals(900, result.bytes.bytesWritten)
        assertEquals(1_600, result.bytes.totalBytes)
        assertEquals(UsbWriteFailure.TRANSPORT_ERROR, result.bytes.failure)
    }

    @Test
    fun `reports disconnection while preserving confirmed progress`() {
        var connected = true
        var calls = 0
        val result =
            writeUsbBuffer(
                data = ByteArray(1_600),
                maxChunkSize = 1_600,
                isDeviceConnected = { connected },
            ) { _, _, _ ->
                calls += 1
                connected = false
                900
            }

        assertEquals(1, calls)
        assertEquals(UsbWriteStatus.PARTIAL, result.status)
        assertEquals(900, result.bytesWritten)
        assertEquals(UsbWriteFailure.DEVICE_DISCONNECTED, result.failure)
    }

    @Test
    fun `supports many small writes without gaps or duplicated offsets`() {
        val result = writeWithResponses(10, 2, 3, 1, 4)

        assertEquals(UsbWriteStatus.COMPLETE, result.bytes.status)
        assertEquals(
            listOf(WriteCall(0, 10), WriteCall(2, 8), WriteCall(5, 5), WriteCall(6, 4)),
            result.calls,
        )
    }

    @Test
    fun `stops immediately when the transport does not progress`() {
        var calls = 0
        val result =
            writeUsbBuffer(ByteArray(1_600), 1_600, { true }) { _, _, _ ->
                calls += 1
                0
            }

        assertEquals(1, calls)
        assertEquals(UsbWriteStatus.NO_BYTES_SENT, result.status)
    }

    @Test
    fun `chunks large buffers and never asks beyond the remaining bytes`() {
        val calls = mutableListOf<WriteCall>()
        val result =
            writeUsbBuffer(ByteArray(10), 4, { true }) { _, offset, length ->
                calls += WriteCall(offset, length)
                length
            }

        assertTrue(result.status == UsbWriteStatus.COMPLETE)
        assertEquals(listOf(WriteCall(0, 4), WriteCall(4, 4), WriteCall(8, 2)), calls)
    }

    private fun writeWithResponses(totalBytes: Int, vararg responses: Int): WriteResult {
        val calls = mutableListOf<WriteCall>()
        var responseIndex = 0
        val result =
            writeUsbBuffer(ByteArray(totalBytes), totalBytes, { true }) { _, offset, length ->
                calls += WriteCall(offset, length)
                responses[responseIndex++]
            }
        return WriteResult(result, calls)
    }

    private data class WriteCall(val offset: Int, val length: Int)

    private data class WriteResult(val bytes: UsbWriteResult, val calls: List<WriteCall>)
}
