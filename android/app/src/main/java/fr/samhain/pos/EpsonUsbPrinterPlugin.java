package fr.samhain.pos;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

import org.json.JSONObject;

@CapacitorPlugin(name = "EpsonUsbPrinter")
public class EpsonUsbPrinterPlugin extends Plugin {
    private static final String TAG = "EpsonUsbPrinter";
    private static final int EPSON_VENDOR_ID = 0x04B8;
    private static final int TRANSFER_TIMEOUT_MS = 4000;
    private static final byte[] FULL_CUT_COMMAND = new byte[]{0x1D, 0x56, 0x00};
    private String permissionCallId;
    private BroadcastReceiver permissionReceiver;

    @PluginMethod
    public void getDevices(PluginCall call) {
        UsbManager manager = getUsbManager();
        JSArray devices = new JSArray();
        for (UsbDevice device : manager.getDeviceList().values()) {
            devices.put(toJsDevice(manager, device));
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        Integer deviceId = call.getInt("deviceId");
        if (deviceId == null) {
            call.reject("deviceId manquant.", "USB_DEVICE_ID_REQUIRED");
            return;
        }

        UsbManager manager = getUsbManager();
        UsbDevice device = findDevice(manager, deviceId);
        if (device == null) {
            call.reject("Le périphérique USB n’est plus connecté.", "USB_DEVICE_NOT_FOUND");
            return;
        }

        if (manager.hasPermission(device)) {
            resolvePermission(call, manager, device, true);
            return;
        }

        if (permissionCallId != null) {
            call.reject("Une demande d’autorisation USB est déjà en cours.", "USB_PERMISSION_PENDING");
            return;
        }

        Context context = getContext();
        String permissionAction = context.getPackageName() + ".USB_PERMISSION";
        Intent permissionIntent = new Intent(permissionAction).setPackage(context.getPackageName());
        PendingIntent pendingIntent = PendingIntent.getBroadcast(
            context,
            0,
            permissionIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        permissionCallId = call.getCallbackId();
        call.setKeepAlive(true);
        bridge.saveCall(call);

        permissionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context receiverContext, Intent intent) {
                if (!permissionAction.equals(intent.getAction())) return;

                PluginCall pendingCall = bridge.getSavedCall(permissionCallId);
                UsbDevice grantedDevice = getUsbDeviceExtra(intent);
                boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);

                unregisterPermissionReceiver();
                permissionCallId = null;

                if (pendingCall == null) return;
                if (grantedDevice == null) {
                    pendingCall.reject("Android n’a pas retourné le périphérique USB.", "USB_PERMISSION_NO_DEVICE");
                } else {
                    resolvePermission(pendingCall, manager, grantedDevice, granted);
                }
                pendingCall.release(bridge);
            }
        };

        IntentFilter filter = new IntentFilter(permissionAction);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            //noinspection UnspecifiedRegisterReceiverFlag
            context.registerReceiver(permissionReceiver, filter);
        }

        manager.requestPermission(device, pendingIntent);
    }

    @PluginMethod
    public void printTest(PluginCall call) {
        Integer deviceId = call.getInt("deviceId");
        if (deviceId == null) {
            call.reject("deviceId manquant.", "USB_DEVICE_ID_REQUIRED");
            return;
        }

        UsbManager manager = getUsbManager();
        UsbDevice device = findDevice(manager, deviceId);
        if (device == null) {
            call.reject("Le périphérique USB n’est plus connecté.", "USB_DEVICE_NOT_FOUND");
            return;
        }
        if (!manager.hasPermission(device)) {
            call.reject("Autorisez d’abord l’accès USB à l’imprimante.", "USB_PERMISSION_REQUIRED");
            return;
        }

        InterfaceEndpoint output = findBulkOutEndpoint(device);
        if (output == null) {
            call.reject("Aucune sortie USB BULK compatible n’a été trouvée sur ce périphérique.", "USB_BULK_OUT_NOT_FOUND");
            return;
        }

        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) {
            call.reject("Android n’a pas pu ouvrir le périphérique USB.", "USB_OPEN_FAILED");
            return;
        }

        boolean claimed = false;
        try {
            claimed = connection.claimInterface(output.usbInterface, true);
            if (!claimed) {
                call.reject("Impossible de prendre le contrôle de l’interface USB de l’imprimante.", "USB_CLAIM_FAILED");
                return;
            }

            byte[] ticket = buildTestTicket();
            int written = connection.bulkTransfer(output.endpoint, ticket, ticket.length, TRANSFER_TIMEOUT_MS);
            if (written < 0) {
                call.reject("Le transfert USB a échoué. Essayez de débrancher puis rebrancher l’imprimante.", "USB_TRANSFER_FAILED");
                return;
            }
            if (written != ticket.length) {
                call.reject("Le transfert USB est incomplet (" + written + "/" + ticket.length + " octets).", "USB_TRANSFER_PARTIAL");
                return;
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("bytesWritten", written);
            result.put("device", toJsDevice(manager, device));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Erreur pendant l’impression USB : " + error.getMessage(), "USB_PRINT_ERROR", error);
        } finally {
            if (claimed) connection.releaseInterface(output.usbInterface);
            connection.close();
        }
    }

    @PluginMethod
    public void printJob(PluginCall call) {
        Integer deviceId = call.getInt("deviceId");
        JSArray steps = call.getArray("steps");
        if (deviceId == null) {
            call.reject("deviceId manquant.", "USB_DEVICE_ID_REQUIRED");
            return;
        }
        if (steps == null || steps.length() == 0) {
            call.reject("La séquence d’impression est vide.", "USB_PRINT_JOB_INVALID");
            return;
        }

        UsbManager manager = getUsbManager();
        UsbDevice device = findDevice(manager, deviceId);
        if (device == null) {
            call.reject("Le périphérique USB n’est plus connecté.", "USB_DEVICE_NOT_FOUND");
            return;
        }
        if (!manager.hasPermission(device)) {
            call.reject("Autorisez d’abord l’accès USB à l’imprimante.", "USB_PERMISSION_REQUIRED");
            return;
        }

        InterfaceEndpoint output = findBulkOutEndpoint(device);
        if (output == null) {
            call.reject("Aucune sortie USB BULK compatible n’a été trouvée sur ce périphérique.", "USB_BULK_OUT_NOT_FOUND");
            return;
        }

        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) {
            call.reject("Android n’a pas pu ouvrir le périphérique USB.", "USB_OPEN_FAILED");
            return;
        }

        boolean claimed = false;
        boolean customerReceiptPrinted = false;
        int bytesWritten = 0;
        JSArray completedDocuments = new JSArray();
        JSArray warnings = new JSArray();

        try {
            claimed = connection.claimInterface(output.usbInterface, true);
            if (!claimed) {
                call.reject("Impossible de prendre le contrôle de l’interface USB de l’imprimante.", "USB_CLAIM_FAILED");
                return;
            }

            for (int index = 0; index < steps.length(); index++) {
                JSONObject step = steps.getJSONObject(index);
                String type = step.optString("type", "");

                if ("document".equals(type)) {
                    String documentType = step.optString("documentType", "");
                    String encodedData = step.optString("dataBase64", "");
                    if (encodedData.isEmpty()) {
                        call.reject("Le document à imprimer est vide.", "USB_PRINT_JOB_INVALID");
                        return;
                    }

                    byte[] data = Base64.decode(encodedData, Base64.DEFAULT);
                    int written = connection.bulkTransfer(output.endpoint, data, data.length, TRANSFER_TIMEOUT_MS);
                    if (written != data.length) {
                        String code = "customerReceipt".equals(documentType)
                            ? "USB_CUSTOMER_RECEIPT_WRITE_FAILED"
                            : "USB_PREPARATION_WRITE_FAILED";
                        String prefix;
                        if ("customerReceipt".equals(documentType)) {
                            prefix = "L’impression du ticket client a échoué. ";
                        } else if (customerReceiptPrinted) {
                            prefix = "Le ticket client a été imprimé, mais le ticket de préparation a échoué. ";
                        } else {
                            prefix = "L’impression du ticket de préparation a échoué. ";
                        }
                        call.reject(prefix + transferFailureMessage(written, data.length), code);
                        return;
                    }

                    bytesWritten += written;
                    completedDocuments.put(documentType);
                    if ("customerReceipt".equals(documentType)) customerReceiptPrinted = true;
                    continue;
                }

                if ("cut".equals(type)) {
                    String afterDocument = step.optString("afterDocument", "");
                    int feedLines = Math.max(0, step.optInt("feedLines", 4));
                    byte[] feed = repeatedLineFeeds(feedLines);
                    int feedWritten = connection.bulkTransfer(output.endpoint, feed, feed.length, TRANSFER_TIMEOUT_MS);
                    int cutWritten = feedWritten == feed.length
                        ? connection.bulkTransfer(output.endpoint, FULL_CUT_COMMAND, FULL_CUT_COMMAND.length, TRANSFER_TIMEOUT_MS)
                        : -1;

                    if (feedWritten == feed.length && cutWritten == FULL_CUT_COMMAND.length) {
                        bytesWritten += feedWritten + cutWritten;
                        continue;
                    }

                    byte[] fallback = buildCutFallback();
                    int fallbackWritten = connection.bulkTransfer(output.endpoint, fallback, fallback.length, TRANSFER_TIMEOUT_MS);
                    if (fallbackWritten != fallback.length) {
                        String code = "customerReceipt".equals(afterDocument)
                            ? "USB_CUSTOMER_CUT_FAILED"
                            : "USB_PREPARATION_CUT_FAILED";
                        call.reject("La coupe a échoué et la séparation visuelle de secours n’a pas pu être imprimée.", code);
                        return;
                    }

                    bytesWritten += Math.max(feedWritten, 0) + Math.max(cutWritten, 0) + fallbackWritten;
                    String warning = "Coupe indisponible après " + afterDocument + " : séparation visuelle imprimée.";
                    warnings.put(warning);
                    Log.w(TAG, warning);
                    continue;
                }

                call.reject("Étape d’impression inconnue : " + type, "USB_PRINT_JOB_INVALID");
                return;
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("bytesWritten", bytesWritten);
            result.put("completedDocuments", completedDocuments);
            result.put("warnings", warnings);
            result.put("device", toJsDevice(manager, device));
            call.resolve(result);
        } catch (IllegalArgumentException error) {
            call.reject("Le contenu ESC/POS reçu est invalide.", "USB_PRINT_JOB_INVALID", error);
        } catch (Exception error) {
            call.reject("Erreur pendant la séquence d’impression USB : " + error.getMessage(), "USB_PRINT_ERROR", error);
        } finally {
            if (claimed) connection.releaseInterface(output.usbInterface);
            connection.close();
        }
    }


    @Override
    protected void handleOnDestroy() {
        unregisterPermissionReceiver();
        if (permissionCallId != null) {
            PluginCall pendingCall = bridge.getSavedCall(permissionCallId);
            if (pendingCall != null) {
                pendingCall.reject("La demande USB a été interrompue car l’application a été fermée.", "USB_PERMISSION_INTERRUPTED");
                pendingCall.release(bridge);
            }
            permissionCallId = null;
        }
        super.handleOnDestroy();
    }

    private UsbManager getUsbManager() {
        return (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
    }

    private UsbDevice findDevice(UsbManager manager, int deviceId) {
        for (UsbDevice device : manager.getDeviceList().values()) {
            if (device.getDeviceId() == deviceId) return device;
        }
        return null;
    }

    private JSObject toJsDevice(UsbManager manager, UsbDevice device) {
        JSObject result = new JSObject();
        result.put("deviceId", device.getDeviceId());
        result.put("deviceName", device.getDeviceName());
        result.put("vendorId", device.getVendorId());
        result.put("productId", device.getProductId());
        result.put("manufacturerName", safeManufacturerName(device));
        result.put("productName", safeProductName(device));
        result.put("epson", device.getVendorId() == EPSON_VENDOR_ID);
        result.put("hasPermission", manager.hasPermission(device));
        result.put("hasBulkOutEndpoint", findBulkOutEndpoint(device) != null);
        return result;
    }

    private String safeManufacturerName(UsbDevice device) {
        try { return device.getManufacturerName(); }
        catch (SecurityException ignored) { return null; }
    }

    private String safeProductName(UsbDevice device) {
        try { return device.getProductName(); }
        catch (SecurityException ignored) { return null; }
    }

    private InterfaceEndpoint findBulkOutEndpoint(UsbDevice device) {
        for (int interfaceIndex = 0; interfaceIndex < device.getInterfaceCount(); interfaceIndex++) {
            UsbInterface usbInterface = device.getInterface(interfaceIndex);
            for (int endpointIndex = 0; endpointIndex < usbInterface.getEndpointCount(); endpointIndex++) {
                UsbEndpoint endpoint = usbInterface.getEndpoint(endpointIndex);
                if (endpoint.getDirection() == UsbConstants.USB_DIR_OUT && endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                    return new InterfaceEndpoint(usbInterface, endpoint);
                }
            }
        }
        return null;
    }

    private byte[] buildTestTicket() throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.write(new byte[]{0x1B, 0x40}); // ESC @ : initialise
        bytes.write(new byte[]{0x1B, 0x61, 0x01}); // centre
        bytes.write(new byte[]{0x1B, 0x45, 0x01}); // gras
        writeAscii(bytes, "SAMHAIN\n");
        bytes.write(new byte[]{0x1B, 0x45, 0x00});
        writeAscii(bytes, "TEST IMPRESSION USB\n\n");
        bytes.write(new byte[]{0x1B, 0x61, 0x00}); // gauche
        writeAscii(bytes, "Burger Samhain            16,00 EUR\n");
        writeAscii(bytes, "Cafe                       1,50 EUR\n");
        writeAscii(bytes, "------------------------------------------\n");
        bytes.write(new byte[]{0x1B, 0x45, 0x01});
        writeAscii(bytes, "TOTAL                     17,50 EUR\n");
        bytes.write(new byte[]{0x1B, 0x45, 0x00});
        writeAscii(bytes, "\nCaisse A\nCommande TEST-A001\n");
        writeAscii(bytes, "USB-C -> USB-B\n");
        writeAscii(bytes, "\n\n\n\n");
        bytes.write(new byte[]{0x1D, 0x56, 0x00}); // GS V 0 : coupe
        return bytes.toByteArray();
    }

    private void writeAscii(ByteArrayOutputStream bytes, String text) throws IOException {
        bytes.write(text.getBytes(StandardCharsets.US_ASCII));
    }

    private byte[] repeatedLineFeeds(int count) {
        byte[] feeds = new byte[count];
        for (int index = 0; index < count; index++) feeds[index] = 0x0A;
        return feeds;
    }

    private byte[] buildCutFallback() {
        return "\n------------------------------------------\n\n\n\n".getBytes(StandardCharsets.US_ASCII);
    }

    private String transferFailureMessage(int written, int expected) {
        if (written < 0) return "Le transfert USB a échoué.";
        return "Le transfert USB est incomplet (" + written + "/" + expected + " octets).";
    }

    private void resolvePermission(PluginCall call, UsbManager manager, UsbDevice device, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("device", toJsDevice(manager, device));
        call.resolve(result);
    }

    @SuppressWarnings("deprecation")
    private UsbDevice getUsbDeviceExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class);
        }
        return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
    }

    private void unregisterPermissionReceiver() {
        if (permissionReceiver == null) return;
        try {
            getContext().unregisterReceiver(permissionReceiver);
        } catch (IllegalArgumentException ignored) {
            // Déjà désenregistré.
        }
        permissionReceiver = null;
    }

    private static final class InterfaceEndpoint {
        final UsbInterface usbInterface;
        final UsbEndpoint endpoint;

        InterfaceEndpoint(UsbInterface usbInterface, UsbEndpoint endpoint) {
            this.usbInterface = usbInterface;
            this.endpoint = endpoint;
        }
    }
}
