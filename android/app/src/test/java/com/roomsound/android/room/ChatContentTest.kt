package com.roomsound.android.room

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class ChatContentTest {
    private fun recording(): JSONObject = JSONObject().put("mimeType", "audio/mp4").put("durationMs", 1200).put("data", Base64.getEncoder().encodeToString(byteArrayOf(0,0,0,24)+"ftypisom".toByteArray()+ByteArray(16)))
    @Test fun validatesRecordingsBeforeTheyReachTheRoom() {
        assertEquals("audio/mp4", ChatContent.voice(recording()).getString("mimeType"))
        assertThrows(IllegalArgumentException::class.java) { ChatContent.voice(recording().put("durationMs", 31_000)) }
        assertThrows(IllegalArgumentException::class.java) { ChatContent.voice(recording().put("mimeType", "text/html")) }
        assertThrows(IllegalArgumentException::class.java) { ChatContent.voice(recording().put("data", Base64.getEncoder().encodeToString("<script>invalid</script>".toByteArray()))) }
    }
    @Test fun replySnapshotCannotForgeTheSenderOrCopyVoiceData() {
        val original = JSONObject().put("id","one").put("kind","chat").put("senderName","Friend").put("text","Original").put("voice",recording())
        val reply = ChatContent.build(JSONObject().put("text","Reply").put("replyToId","one").put("replyTo",JSONObject().put("senderName","Forged")), listOf(original)).getJSONObject("replyTo")
        assertEquals("Friend", reply.getString("senderName")); assertEquals("Voice message",reply.getString("text")); assertFalse(reply.has("voice"))
        assertThrows(IllegalArgumentException::class.java) { ChatContent.build(JSONObject().put("text","Reply").put("replyToId","other-room"),listOf(original)) }
    }
    @Test fun parsingKeepsRepliesAndRecordingsForNativeChat() {
        val input=JSONObject().put("id","message").put("kind","chat").put("text","Voice message").put("voice",recording()).put("replyTo",JSONObject().put("id","one").put("senderName","Friend").put("text","Original"))
        val parsed=parseChatMessage(input)
        assertEquals("one", parsed.replyTo?.id); assertEquals("audio/mp4", parsed.voice?.mimeType); assertNotNull(parsed.voice?.data)
    }
    @Test fun lightweightStateKeepsCachedVoiceAndExpiryRemovesIt() {
        val original=parseChatMessage(JSONObject().put("id","voice").put("voice",recording()))
        val reference=original.copy(voice=original.voice!!.copy(data=null,referenceOnly=true))
        assertEquals(original.voice!!.data,mergeChatVoiceReferences(listOf(original),listOf(reference)).single().voice?.data)
        val expired=reference.copy(voice=reference.voice!!.copy(referenceOnly=false,unavailable=true))
        assertNull(mergeChatVoiceReferences(listOf(original),listOf(expired)).single().voice?.data)
        assertFalse(original.voice.toString().contains(original.voice.data!!))
    }
}
