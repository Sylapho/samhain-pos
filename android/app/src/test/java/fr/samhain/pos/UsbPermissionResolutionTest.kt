package fr.samhain.pos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class UsbPermissionResolutionTest {
    @Test
    fun `uses broadcast device when Android provides it`() {
        val broadcastDevice = TestDevice(99)
        val requestedDevice = TestDevice(42)

        val resolved =
            resolvePermissionDevice(
                broadcastDevice = broadcastDevice,
                requestedDeviceId = requestedDevice.id,
                connectedDevicesById = mapOf(requestedDevice.id to requestedDevice),
            )

        assertSame(broadcastDevice, resolved)
    }

    @Test
    fun `falls back to requested device when broadcast omits device`() {
        val requestedDevice = TestDevice(42)

        val resolved =
            resolvePermissionDevice(
                broadcastDevice = null,
                requestedDeviceId = requestedDevice.id,
                connectedDevicesById = mapOf(requestedDevice.id to requestedDevice),
            )

        assertSame(requestedDevice, resolved)
    }

    @Test
    fun `reports disconnected when requested device is no longer connected`() {
        val resolved =
            resolvePermissionDevice<TestDevice>(
                broadcastDevice = null,
                requestedDeviceId = 42,
                connectedDevicesById = emptyMap(),
            )

        assertEquals(null, resolved)
        assertEquals(
            UsbPermissionResult.DEVICE_DISCONNECTED,
            classifyUsbPermissionResult(
                deviceAvailable = false,
                hasPermission = false,
                androidReportedGranted = false,
            ),
        )
    }

    @Test
    fun `trusts actual permission when Android result omits or denies it`() {
        assertEquals(
            UsbPermissionResult.GRANTED,
            classifyUsbPermissionResult(
                deviceAvailable = true,
                hasPermission = true,
                androidReportedGranted = false,
            ),
        )
    }

    @Test
    fun `keeps a real denial distinct from an incomplete Android result`() {
        assertEquals(
            UsbPermissionResult.DENIED,
            classifyUsbPermissionResult(
                deviceAvailable = true,
                hasPermission = false,
                androidReportedGranted = false,
            ),
        )
        assertEquals(
            UsbPermissionResult.INCOMPLETE,
            classifyUsbPermissionResult(
                deviceAvailable = true,
                hasPermission = false,
                androidReportedGranted = true,
            ),
        )
    }

    private data class TestDevice(val id: Int)
}
