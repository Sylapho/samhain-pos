package __APP_PACKAGE__

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

internal interface CredentialVault {
    fun read(): JSONObject?
    fun write(value: JSONObject)
    fun clear()
}

internal interface InstallationSigner {
    fun publicKey(): String
    fun sign(message: ByteArray): String
}

internal class GcmCredentials(private val key: () -> SecretKey) {
    fun encrypt(value: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return byteArrayOf(1) + cipher.iv + cipher.doFinal(value)
    }

    fun decrypt(value: ByteArray): ByteArray {
        require(value.size >= 30 && value[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, value.copyOfRange(1,13)))
        return cipher.doFinal(value.copyOfRange(13,value.size))
    }
}

internal class TabletCredentialVault(context: Context, keyProvider: (() -> SecretKey)? = null) : CredentialVault {
    private val file = AtomicFile(File(context.noBackupFilesDir,"tablet-auth-v1.enc"))
    private val keys by lazy { KeyStore.getInstance("AndroidKeyStore").apply { load(null) } }
    private val crypto = GcmCredentials {
        if (keyProvider != null) keyProvider() else {
          if (!keys.containsAlias(AES_ALIAS)) {
            // A missing key with existing ciphertext is never silently replaced.
            require(!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists())
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(AES_ALIAS,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            }.generateKey()
          }
          keys.getKey(AES_ALIAS,null) as SecretKey
        }
    }

    override fun read(): JSONObject? = synchronized(FILE_LOCK) {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return@synchronized null
        JSONObject(crypto.decrypt(file.openRead().use { it.readBytes() }).toString(Charsets.UTF_8)).also {
            require(it.getInt("schemaVersion") == 1)
        }
    }

    override fun write(value: JSONObject) = synchronized(FILE_LOCK) {
        val encrypted = crypto.encrypt(value.toString().toByteArray(Charsets.UTF_8))
        val stream = file.startWrite()
        try { stream.write(encrypted); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }

    override fun clear() = synchronized(FILE_LOCK) { file.delete() }

    companion object {
        private const val AES_ALIAS = "samhain.tablet.credentials.v1"
        private val FILE_LOCK = Any()
    }
}

internal class KeystoreInstallationSigner : InstallationSigner {
    private val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun ensureKey() {
        if (!keys.containsAlias(ALIAS)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA,"AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setKeySize(2048).setDigests(KeyProperties.DIGEST_SHA256)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1).build())
            }.generateKeyPair()
        }
    }
    override fun publicKey(): String {
        ensureKey()
        return Base64.encodeToString(keys.getCertificate(ALIAS).publicKey.encoded,Base64.NO_WRAP)
    }
    override fun sign(message: ByteArray): String {
        // Signing an enrolled request must never regenerate a lost key.
        require(keys.containsAlias(ALIAS))
        val signature = Signature.getInstance("SHA256withRSA")
        signature.initSign(keys.getKey(ALIAS,null) as java.security.PrivateKey)
        signature.update(message)
        return Base64.encodeToString(signature.sign(),Base64.NO_WRAP)
    }
    companion object { private const val ALIAS = "samhain.tablet.possession.v1" }
}
