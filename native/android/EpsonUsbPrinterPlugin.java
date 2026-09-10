package __APP_PACKAGE__;

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
import android.os.SystemClock;
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
    private static final int STATUS_READ_TIMEOUT_MS = 1500;
    private static final byte[] STATUS_COMMANDS = new byte[]{
        0x10, 0x04, 0x02,
        0x10, 0x04, 0x03,
        0x10, 0x04, 0x04
    };
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
    public synchronized void getStatus(PluginCall call) {
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

        PrinterUsbInterface printerInterface = findPrinterInterface(device);
        if (printerInterface == null || printerInterface.outEndpoint == null) {
            call.reject("Aucune sortie USB BULK compatible n’a été trouvée sur ce périphérique.", "USB_BULK_OUT_NOT_FOUND");
            return;
        }
        if (printerInterface.inEndpoint == null) {
            call.reject("Aucune entrée USB BULK permettant de lire le statut de l’imprimante n’a été trouvée sur la même interface.", "USB_BULK_IN_NOT_FOUND");
            return;
        }

        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) {
            call.reject("Android n’a pas pu ouvrir le périphérique USB.", "USB_OPEN_FAILED");
            return;
        }

        boolean claimed = false;
        try {
            claimed = connection.claimInterface(printerInterface.usbInterface, true);
            if (!claimed) {
                call.reject("Impossible de prendre le contrôle de l’interface USB de l’imprimante.", "USB_CLAIM_FAILED");
                return;
            }

            HardwareStatus status = readHardwareStatus(manager, device, connection, printerInterface);
            call.resolve(status.toJsObject());
        } catch (PrinterStatusException error) {
            call.reject(error.getMessage(), error.code, error);
        } catch (Exception error) {
            call.reject("Impossible de lire le statut matériel : " + error.getMessage(), "USB_STATUS_ERROR", error);
        } finally {
            if (claimed) connection.releaseInterface(printerInterface.usbInterface);
            connection.close();
        }
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
    public synchronized void printTest(PluginCall call) {
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

        PrinterUsbInterface printerInterface = findPrinterInterface(device);
        if (printerInterface == null || printerInterface.outEndpoint == null) {
            call.reject("Aucune sortie USB BULK compatible n’a été trouvée sur ce périphérique.", "USB_BULK_OUT_NOT_FOUND");
            return;
        }
        if (printerInterface.inEndpoint == null) {
            call.reject("Le statut matériel ne peut pas être lu : entrée USB BULK absente.", "USB_BULK_IN_NOT_FOUND");
            return;
        }

        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) {
            call.reject("Android n’a pas pu ouvrir le périphérique USB.", "USB_OPEN_FAILED");
            return;
        }

        boolean claimed = false;
        try {
            claimed = connection.claimInterface(printerInterface.usbInterface, true);
            if (!claimed) {
                call.reject("Impossible de prendre le contrôle de l’interface USB de l’imprimante.", "USB_CLAIM_FAILED");
                return;
            }

            HardwareStatus hardwareStatus = readHardwareStatus(manager, device, connection, printerInterface);
            PrinterReadinessError readinessError = hardwareStatus.getReadinessError();
            if (readinessError != null) {
                call.reject(readinessError.message, readinessError.code);
                return;
            }

            byte[] ticket = buildTestTicket();
            int written = connection.bulkTransfer(printerInterface.outEndpoint, ticket, ticket.length, TRANSFER_TIMEOUT_MS);
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
        } catch (PrinterStatusException error) {
            call.reject(error.getMessage(), error.code, error);
        } catch (Exception error) {
            call.reject("Erreur pendant l’impression USB : " + error.getMessage(), "USB_PRINT_ERROR", error);
        } finally {
            if (claimed) connection.releaseInterface(printerInterface.usbInterface);
            connection.close();
        }
    }

    @PluginMethod
    public synchronized void printJob(PluginCall call) {
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

        PrinterUsbInterface printerInterface = findPrinterInterface(device);
        if (printerInterface == null || printerInterface.outEndpoint == null) {
            call.reject("Aucune sortie USB BULK compatible n’a été trouvée sur ce périphérique.", "USB_BULK_OUT_NOT_FOUND");
            return;
        }
        if (printerInterface.inEndpoint == null) {
            call.reject("Le statut matériel ne peut pas être lu : entrée USB BULK absente.", "USB_BULK_IN_NOT_FOUND");
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
            claimed = connection.claimInterface(printerInterface.usbInterface, true);
            if (!claimed) {
                rejectPrintJob(call, completedDocuments, "Impossible de prendre le contrôle de l’interface USB de l’imprimante.", "USB_CLAIM_FAILED");
                return;
            }

            HardwareStatus hardwareStatus = readHardwareStatus(manager, device, connection, printerInterface);
            PrinterReadinessError readinessError = hardwareStatus.getReadinessError();
            if (readinessError != null) {
                rejectPrintJob(call, completedDocuments, readinessError.message, readinessError.code);
                return;
            }

            for (int index = 0; index < steps.length(); index++) {
                JSONObject step = steps.getJSONObject(index);
                String type = step.optString("type", "");

                if ("document".equals(type)) {
                    String documentType = step.optString("documentType", "");
                    String encodedData = step.optString("dataBase64", "");
                    if (encodedData.isEmpty()) {
                        rejectPrintJob(call, completedDocuments, "Le document à imprimer est vide.", "USB_PRINT_JOB_INVALID");
                        return;
                    }

                    byte[] data = Base64.decode(encodedData, Base64.DEFAULT);
                    int written = connection.bulkTransfer(printerInterface.outEndpoint, data, data.length, TRANSFER_TIMEOUT_MS);
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
                        rejectPrintJob(call, completedDocuments, prefix + transferFailureMessage(written, data.length), code);
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
                    int feedWritten = connection.bulkTransfer(printerInterface.outEndpoint, feed, feed.length, TRANSFER_TIMEOUT_MS);
                    int cutWritten = feedWritten == feed.length
                        ? connection.bulkTransfer(printerInterface.outEndpoint, FULL_CUT_COMMAND, FULL_CUT_COMMAND.length, TRANSFER_TIMEOUT_MS)
                        : -1;

                    if (feedWritten == feed.length && cutWritten == FULL_CUT_COMMAND.length) {
                        bytesWritten += feedWritten + cutWritten;
                        continue;
                    }

                    byte[] fallback = buildCutFallback();
                    int fallbackWritten = connection.bulkTransfer(printerInterface.outEndpoint, fallback, fallback.length, TRANSFER_TIMEOUT_MS);
                    if (fallbackWritten != fallback.length) {
                        String code = "customerReceipt".equals(afterDocument)
                            ? "USB_CUSTOMER_CUT_FAILED"
                            : "USB_PREPARATION_CUT_FAILED";
                        rejectPrintJob(call, completedDocuments, "La coupe a échoué et la séparation visuelle de secours n’a pas pu être imprimée.", code);
                        return;
                    }

                    bytesWritten += Math.max(feedWritten, 0) + Math.max(cutWritten, 0) + fallbackWritten;
                    String warning = "Coupe indisponible après " + afterDocument + " : séparation visuelle imprimée.";
                    warnings.put(warning);
                    Log.w(TAG, warning);
                    continue;
                }

                rejectPrintJob(call, completedDocuments, "Étape d’impression inconnue : " + type, "USB_PRINT_JOB_INVALID");
                return;
            }

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("bytesWritten", bytesWritten);
            result.put("completedDocuments", completedDocuments);
            result.put("warnings", warnings);
            result.put("device", toJsDevice(manager, device));
            call.resolve(result);
        } catch (PrinterStatusException error) {
            rejectPrintJob(call, completedDocuments, error.getMessage(), error.code);
        } catch (IllegalArgumentException error) {
            rejectPrintJob(call, completedDocuments, "Le contenu ESC/POS reçu est invalide.", "USB_PRINT_JOB_INVALID");
        } catch (Exception error) {
            rejectPrintJob(call, completedDocuments, "Erreur pendant la séquence d’impression USB : " + error.getMessage(), "USB_PRINT_ERROR");
        } finally {
            if (claimed) connection.releaseInterface(printerInterface.usbInterface);
            connection.close();
        }
    }


    private void rejectPrintJob(PluginCall call, JSArray completedDocuments, String message, String code) {
        JSObject progress = new JSObject();
        progress.put("completedDocuments", completedDocuments);
        call.reject(message, code, null, progress);
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
        PrinterUsbInterface printerInterface = findPrinterInterface(device);
        result.put("hasBulkOutEndpoint", printerInterface != null && printerInterface.outEndpoint != null);
        result.put("hasBulkInEndpoint", printerInterface != null && printerInterface.inEndpoint != null);
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

    private PrinterUsbInterface findPrinterInterface(UsbDevice device) {
        PrinterUsbInterface pairedInterface = null;
        PrinterUsbInterface outOnlyInterface = null;
        for (int interfaceIndex = 0; interfaceIndex < device.getInterfaceCount(); interfaceIndex++) {
            UsbInterface usbInterface = device.getInterface(interfaceIndex);
            UsbEndpoint outEndpoint = null;
            UsbEndpoint inEndpoint = null;
            for (int endpointIndex = 0; endpointIndex < usbInterface.getEndpointCount(); endpointIndex++) {
                UsbEndpoint endpoint = usbInterface.getEndpoint(endpointIndex);
                if (endpoint.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
                if (endpoint.getDirection() == UsbConstants.USB_DIR_OUT) outEndpoint = endpoint;
                if (endpoint.getDirection() == UsbConstants.USB_DIR_IN) inEndpoint = endpoint;
            }
            if (outEndpoint != null && inEndpoint != null) {
                PrinterUsbInterface candidate = new PrinterUsbInterface(usbInterface, outEndpoint, inEndpoint);
                if (usbInterface.getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) {
                    return candidate;
                }
                if (pairedInterface == null) pairedInterface = candidate;
            }
            if (outEndpoint != null && outOnlyInterface == null) {
                outOnlyInterface = new PrinterUsbInterface(usbInterface, outEndpoint, null);
            }
        }
        return pairedInterface != null ? pairedInterface : outOnlyInterface;
    }

    private HardwareStatus readHardwareStatus(
        UsbManager manager,
        UsbDevice device,
        UsbDeviceConnection connection,
        PrinterUsbInterface printerInterface
    ) throws PrinterStatusException {
        int written = connection.bulkTransfer(
            printerInterface.outEndpoint,
            STATUS_COMMANDS,
            STATUS_COMMANDS.length,
            TRANSFER_TIMEOUT_MS
        );
        if (written != STATUS_COMMANDS.length) {
            ensureDeviceStillAvailable(manager, device);
            throw new PrinterStatusException(
                written < 0
                    ? "Impossible d’envoyer la demande de statut à l’imprimante."
                    : "Demande de statut USB incomplète (" + written + "/" + STATUS_COMMANDS.length + " octets).",
                written < 0 ? "USB_STATUS_WRITE_FAILED" : "USB_STATUS_WRITE_PARTIAL"
            );
        }

        byte[] response = new byte[3];
        int received = 0;
        long deadline = SystemClock.elapsedRealtime() + STATUS_READ_TIMEOUT_MS;
        while (received < response.length) {
            int timeout = (int) Math.max(1, deadline - SystemClock.elapsedRealtime());
            int read = connection.bulkTransfer(
                printerInterface.inEndpoint,
                response,
                received,
                response.length - received,
                timeout
            );
            if (read <= 0) {
                ensureDeviceStillAvailable(manager, device);
                String code = received == 0 ? "USB_STATUS_NO_RESPONSE" : "USB_STATUS_RESPONSE_PARTIAL";
                String message = received == 0
                    ? "L’imprimante n’a pas répondu à la demande de statut matériel."
                    : "Réponse de statut USB incomplète (" + received + "/" + response.length + " octets).";
                throw new PrinterStatusException(message, code);
            }
            received += read;
            if (SystemClock.elapsedRealtime() >= deadline && received < response.length) {
                throw new PrinterStatusException(
                    "Réponse de statut USB incomplète (" + received + "/" + response.length + " octets).",
                    "USB_STATUS_RESPONSE_PARTIAL"
                );
            }
        }

        int offline = response[0] & 0xFF;
        int error = response[1] & 0xFF;
        int paper = response[2] & 0xFF;
        validateStatusByte(offline, "DLE EOT 2");
        validateStatusByte(error, "DLE EOT 3");
        validateStatusByte(paper, "DLE EOT 4");
        validatePaperSensorBits(paper);
        return new HardwareStatus(offline, error, paper);
    }

    private void ensureDeviceStillAvailable(UsbManager manager, UsbDevice device) throws PrinterStatusException {
        UsbDevice currentDevice = findDevice(manager, device.getDeviceId());
        if (currentDevice == null) {
            throw new PrinterStatusException("L’imprimante a été débranchée pendant la lecture du statut.", "USB_DEVICE_NOT_FOUND");
        }
        if (!manager.hasPermission(currentDevice)) {
            throw new PrinterStatusException("L’autorisation USB a été perdue pendant la lecture du statut.", "USB_PERMISSION_REQUIRED");
        }
    }

    private void validateStatusByte(int value, String command) throws PrinterStatusException {
        // Epson garantit 0xx1xx10b pour chaque réponse DLE EOT.
        if ((value & 0x93) != 0x12) {
            throw new PrinterStatusException(
                "Réponse ESC/POS inattendue pour " + command + " : " + toHex(value) + ".",
                "USB_STATUS_UNEXPECTED_RESPONSE"
            );
        }
    }

    private void validatePaperSensorBits(int paper) throws PrinterStatusException {
        int nearEnd = paper & 0x0C;
        int paperEnd = paper & 0x60;
        if ((nearEnd != 0 && nearEnd != 0x0C) || (paperEnd != 0 && paperEnd != 0x60)) {
            throw new PrinterStatusException(
                "Réponse ESC/POS incohérente pour les capteurs papier : " + toHex(paper) + ".",
                "USB_STATUS_UNEXPECTED_RESPONSE"
            );
        }
    }

    private String toHex(int value) {
        return String.format("0x%02X", value & 0xFF);
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

    private static final class PrinterUsbInterface {
        final UsbInterface usbInterface;
        final UsbEndpoint outEndpoint;
        final UsbEndpoint inEndpoint;

        PrinterUsbInterface(UsbInterface usbInterface, UsbEndpoint outEndpoint, UsbEndpoint inEndpoint) {
            this.usbInterface = usbInterface;
            this.outEndpoint = outEndpoint;
            this.inEndpoint = inEndpoint;
        }
    }

    private static final class PrinterStatusException extends Exception {
        final String code;

        PrinterStatusException(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    private static final class PrinterReadinessError {
        final String message;
        final String code;

        PrinterReadinessError(String message, String code) {
            this.message = message;
            this.code = code;
        }
    }

    private static final class HardwareStatus {
        final int offline;
        final int error;
        final int paper;

        HardwareStatus(int offline, int error, int paper) {
            this.offline = offline;
            this.error = error;
            this.paper = paper;
        }

        boolean isCoverOpen() { return (offline & 0x04) != 0; }
        boolean isPaperFeedButtonPressed() { return (offline & 0x08) != 0; }
        boolean isPaperOut() { return (offline & 0x20) != 0 || (paper & 0x60) == 0x60; }
        boolean isOfflineError() { return (offline & 0x40) != 0; }
        boolean isRecoverableError() { return (error & 0x04) != 0; }
        boolean isCutterError() { return (error & 0x08) != 0; }
        boolean isUnrecoverableError() { return (error & 0x20) != 0; }
        boolean isAutoRecoverableError() { return (error & 0x40) != 0; }
        boolean isPaperNearEnd() { return (paper & 0x0C) == 0x0C; }

        boolean hasError() {
            return isOfflineError()
                || isRecoverableError()
                || isCutterError()
                || isUnrecoverableError()
                || isAutoRecoverableError();
        }

        boolean isOnline() {
            return !isCoverOpen() && !isPaperFeedButtonPressed() && !isPaperOut() && !hasError();
        }

        PrinterReadinessError getReadinessError() {
            if (isCoverOpen()) {
                return new PrinterReadinessError("Le capot de l’imprimante est ouvert. Fermez-le puis réessayez.", "USB_PRINTER_COVER_OPEN");
            }
            if (isPaperOut()) {
                return new PrinterReadinessError("L’imprimante n’a plus de papier. Remettez un rouleau puis réessayez.", "USB_PRINTER_PAPER_OUT");
            }
            if (hasError()) {
                return new PrinterReadinessError("L’imprimante signale une erreur matérielle. Vérifiez le papier, le cutter et les voyants.", "USB_PRINTER_HARDWARE_ERROR");
            }
            if (!isOnline()) {
                return new PrinterReadinessError("L’imprimante ne répond pas comme prête. Vérifiez-la puis réessayez.", "USB_PRINTER_OFFLINE");
            }
            return null;
        }

        JSObject toJsObject() {
            JSObject result = new JSObject();
            result.put("connected", true);
            result.put("online", isOnline());
            result.put("paperOut", isPaperOut());
            result.put("paperNearEnd", isPaperNearEnd());
            result.put("coverOpen", isCoverOpen());
            result.put("error", hasError());
            result.put("cutterError", isCutterError());
            result.put("recoverableError", isRecoverableError());
            result.put("unrecoverableError", isUnrecoverableError());
            result.put("autoRecoverableError", isAutoRecoverableError());
            JSObject raw = new JSObject();
            raw.put("offline", offline);
            raw.put("error", error);
            raw.put("paper", paper);
            result.put("raw", raw);
            return result;
        }
    }
}
