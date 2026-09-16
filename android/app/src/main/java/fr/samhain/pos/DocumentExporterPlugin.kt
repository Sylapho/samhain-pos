package fr.samhain.pos

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

@CapacitorPlugin(name = "DocumentExporter")
class DocumentExporterPlugin : Plugin() {
    private val ioExecutor = Executors.newSingleThreadExecutor()
    @Volatile private var exportInProgress = false

    @PluginMethod
    fun saveJson(call: PluginCall) {
        synchronized(this) {
            if (exportInProgress) {
                call.reject(
                    "Un enregistrement de sauvegarde est déjà en cours.",
                    "DESTINATION_UNAVAILABLE",
                )
                return
            }
            exportInProgress = true
        }

        val fileName = call.getString("fileName")?.takeIf { it.isNotBlank() }
        val content = call.getString("content")
        if (fileName == null || content == null) {
            exportInProgress = false
            call.reject("Le nom du fichier et son contenu sont requis.", "DESTINATION_UNAVAILABLE")
            return
        }

        val intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/json"
                putExtra(Intent.EXTRA_TITLE, fileName)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
        try {
            startActivityForResult(call, intent, "handleDocumentCreated")
        } catch (error: ActivityNotFoundException) {
            exportInProgress = false
            call.reject(
                "Aucun sélecteur de document Android n’est disponible.",
                "DOCUMENT_PICKER_UNAVAILABLE",
                error,
            )
        } catch (error: Exception) {
            exportInProgress = false
            call.reject(
                "Le sélecteur de document Android n’a pas pu être ouvert.",
                "DOCUMENT_PICKER_UNAVAILABLE",
                error,
            )
        }
    }

    @ActivityCallback
    private fun handleDocumentCreated(call: PluginCall?, result: ActivityResult) {
        if (call == null) {
            exportInProgress = false
            return
        }
        if (result.resultCode == Activity.RESULT_CANCELED) {
            exportInProgress = false
            call.resolve(JSObject().put("status", "cancelled"))
            return
        }
        if (result.resultCode != Activity.RESULT_OK) {
            exportInProgress = false
            call.reject("La destination Android n’est pas disponible.", "DESTINATION_UNAVAILABLE")
            return
        }
        val uri = result.data?.data
        if (uri == null) {
            exportInProgress = false
            call.reject("Android n’a retourné aucune destination.", "DESTINATION_UNAVAILABLE")
            return
        }

        val requestedFileName = call.getString("fileName").orEmpty()
        val content = call.getString("content").orEmpty()
        ioExecutor.execute {
            try {
                val bytes = content.toByteArray(StandardCharsets.UTF_8)
                writeDocument(uri, bytes)
                val rereadBytes = readDocument(uri)
                val rereadContent = String(rereadBytes, StandardCharsets.UTF_8)
                call.resolve(
                    JSObject()
                        .put("status", "created")
                        .put("uri", uri.toString())
                        .put("fileName", queryDisplayName(uri) ?: requestedFileName)
                        .put("content", rereadContent)
                        .put("bytesWritten", bytes.size),
                )
            } catch (error: DocumentExportException) {
                call.reject(error.message, error.exportCode, error.exportCause)
            } catch (error: Exception) {
                call.reject(
                    "La sauvegarde n’a pas pu être vérifiée après écriture.",
                    "READ_FAILED",
                    error,
                )
            } finally {
                exportInProgress = false
            }
        }
    }

    private fun writeDocument(uri: Uri, bytes: ByteArray) {
        try {
            val output =
                context.contentResolver.openOutputStream(uri, "wt")
                    ?: throw IOException("Flux d’écriture indisponible.")
            output.use {
                it.write(bytes)
                it.flush()
            }
        } catch (error: SecurityException) {
            throwDocumentError(error, "Android a refusé l’écriture.", "PERMISSION_DENIED")
        } catch (error: Exception) {
            throwDocumentError(error, "Le fichier de sauvegarde n’a pas pu être écrit.", "WRITE_FAILED")
        }
    }

    private fun readDocument(uri: Uri): ByteArray {
        try {
            val input =
                context.contentResolver.openInputStream(uri)
                    ?: throw IOException("Flux de lecture indisponible.")
            return input.use { it.readBytes() }
        } catch (error: SecurityException) {
            throwDocumentError(error, "Android a refusé la relecture.", "PERMISSION_DENIED")
        } catch (error: Exception) {
            throwDocumentError(error, "Le fichier écrit n’a pas pu être relu.", "READ_FAILED")
        }
    }

    private fun throwDocumentError(error: Exception, message: String, code: String): Nothing {
        throw DocumentExportException(message, code, error)
    }

    private fun queryDisplayName(uri: Uri): String? {
        var cursor: Cursor? = null
        return try {
            cursor =
                context.contentResolver.query(
                    uri,
                    arrayOf(OpenableColumns.DISPLAY_NAME),
                    null,
                    null,
                    null,
                )
            if (cursor?.moveToFirst() == true) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) cursor.getString(index) else null
            } else {
                null
            }
        } catch (_: Exception) {
            null
        } finally {
            cursor?.close()
        }
    }

    override fun handleOnDestroy() {
        ioExecutor.shutdown()
        super.handleOnDestroy()
    }

    private class DocumentExportException(
        override val message: String,
        val exportCode: String,
        val exportCause: Exception,
    ) : RuntimeException(message, exportCause)
}
