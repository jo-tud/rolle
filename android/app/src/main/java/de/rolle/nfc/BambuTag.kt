package de.rolle.nfc

import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Independently implemented from the documented wire format; never writes a tag. */
object BambuTag {
    fun keys(uid: ByteArray): List<ByteArray> {
        require(uid.size == 4) { "Keine unterstützte 4-Byte-Tag-UID" }
        val salt = byteArrayOf(0x9a.toByte(), 0x75, 0x9c.toByte(), 0xf2.toByte(),
            0xc4.toByte(), 0xf7.toByte(), 0xca.toByte(), 0xff.toByte(), 0x22, 0x2c,
            0xb9.toByte(), 0x76, 0x9b.toByte(), 0x41, 0xbc.toByte(), 0x96.toByte())
        fun hmac(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key, "HmacSHA256")); doFinal(data)
        }
        val prk = hmac(salt, uid)
        var previous = byteArrayOf()
        var output = byteArrayOf()
        for (i in 1..3) {
            previous = hmac(prk, previous + "RFID-A\u0000".toByteArray(Charsets.US_ASCII) + byteArrayOf(i.toByte()))
            output += previous
        }
        return (0..15).map { output.copyOfRange(it * 6, it * 6 + 6) }
    }

    data class Data(
        val trayUid: String, val tagUid: String, val variantId: String, val materialId: String,
        val type: String, val detailedType: String, val colorRgba: String, val colors: List<String>,
        val weightG: Int, val diameterMm: Float, val productionDate: String, val lengthM: Int
    )

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02X".format(it.toInt() and 255) }

    fun parse(blocks: Map<Int, ByteArray>, uid: ByteArray): Data {
        fun block(n: Int): ByteArray = blocks[n]?.also { require(it.size == 16) } ?: error("Block $n fehlt")
        fun text(n: Int, start: Int = 0, end: Int = 16): String {
            val bytes = block(n).copyOfRange(start, end)
            require(bytes.all { it == 0.toByte() || it.toInt() in 32..126 }) { "Unbekanntes Tag-Datenformat" }
            return String(bytes, Charsets.US_ASCII).trim('\u0000', ' ')
        }
        fun u16(n: Int, offset: Int): Int = ByteBuffer.wrap(block(n)).order(ByteOrder.LITTLE_ENDIAN).getShort(offset).toInt() and 65535
        fun color(bytes: ByteArray) = "#" + hex(bytes).lowercase()
        val variant = text(1, 0, 8)
        val material = text(1, 8, 16)
        val tray = hex(block(9))
        require(variant.matches(Regex("[A-Z0-9-]{1,8}")) && material.matches(Regex("GF[A-Z0-9]{3}")) &&
            tray.matches(Regex("[A-F0-9]{32}")) && tray != "0".repeat(32)) { "Kein unterstützter Bambu-Tag" }
        val diameter = ByteBuffer.wrap(block(5)).order(ByteOrder.LITTLE_ENDIAN).getFloat(8)
        val weight = u16(5, 4)
        require(diameter.isFinite() && diameter in 1f..4f && weight in 1..20000) { "Ungültige Filamentdaten" }
        val rgba = color(block(5).copyOfRange(0, 4))
        val colors = mutableListOf(rgba)
        if (u16(16, 0) == 2 && u16(16, 2) == 2) colors += color(block(16).copyOfRange(4, 8).reversedArray())
        return Data(tray.uppercase(), hex(uid), variant, material, text(2), text(4), rgba, colors,
            weight, diameter, text(12), u16(14, 4))
    }
}
