package de.rolle.nfc

import org.junit.Assert.*
import org.junit.Test

class BambuTagTest {
    private fun dump(uid: String): ByteArray = javaClass.getResourceAsStream("/rfid/$uid.bin")!!.readBytes()
    private fun blocks(data: ByteArray) = (0 until data.size / 16).associateWith { data.copyOfRange(it * 16, it * 16 + 16) }

    @Test fun keysMatchAllSixteenSectorTrailersOfRealTags() {
        for (id in listOf("FEE749BC", "FA7D96A6", "B4959ED6", "943A53D4")) {
            val data = dump(id)
            val keys = BambuTag.keys(data.copyOfRange(0, 4))
            assertEquals(16, keys.size)
            for (sector in 0..15) assertArrayEquals("$id sector $sector", data.copyOfRange((sector * 4 + 3) * 16, (sector * 4 + 3) * 16 + 6), keys[sector])
        }
    }
    @Test fun parsesBlackPlaFromRealDumpIncludingBinaryTrayIdentity() {
        val dump = dump("FEE749BC")
        val tag = BambuTag.parse(blocks(dump), dump.copyOfRange(0, 4))
        assertEquals("FEE749BC", tag.tagUid)
        assertEquals("2F9DAEB30109430EB0DF2BFB3F5D03B5", tag.trayUid)
        assertEquals("A00-K0", tag.variantId)
        assertEquals("GFA00", tag.materialId)
        assertEquals("PLA", tag.type)
        assertEquals("PLA Basic", tag.detailedType)
        assertEquals("#000000ff", tag.colorRgba)
        assertEquals(1000, tag.weightG)
        assertEquals(1.75f, tag.diameterMm)
        assertEquals("2026_05_17_08_44", tag.productionDate)
        assertTrue(tag.lengthM > 0)
    }
    @Test fun parsesSilkAndSecondColorInReverseByteOrder() {
        val dump = dump("FA7D96A6")
        val tag = BambuTag.parse(blocks(dump), dump.copyOfRange(0, 4))
        assertEquals("PLA Silk", tag.detailedType)
        assertEquals("#eaec ebff".replace(" ", ""), tag.colorRgba)
        val dual = blocks(dump).toMutableMap()
        dual[16] = byteArrayOf(2,0,2,0, -1, 0x33, 0x22, 0x11, 0,0,0,0,0,0,0,0)
        assertEquals(listOf(tag.colorRgba, "#112233ff"), BambuTag.parse(dual, dump.copyOfRange(0,4)).colors)
    }
    @Test fun bothPhysicalSidesHaveTheSameTrayIdentity() {
        val a = dump("B4959ED6"); val b = dump("943A53D4")
        val first = BambuTag.parse(blocks(a), a.copyOfRange(0,4))
        val second = BambuTag.parse(blocks(b), b.copyOfRange(0,4))
        assertNotEquals(first.tagUid, second.tagUid)
        assertEquals(first.trayUid, second.trayUid)
        assertEquals(first.variantId, second.variantId)
    }
    @Test fun rejectsUnsupportedUidAndMalformedBlocks() {
        assertThrows(IllegalArgumentException::class.java) { BambuTag.keys(byteArrayOf(1,2,3)) }
        assertThrows(IllegalStateException::class.java) { BambuTag.parse(emptyMap(), byteArrayOf(1,2,3,4)) }
        val data = dump("FEE749BC")
        val broken = blocks(data).toMutableMap()
        broken[5] = ByteArray(16)
        assertThrows(IllegalArgumentException::class.java) { BambuTag.parse(broken, data.copyOfRange(0,4)) }
    }
}
