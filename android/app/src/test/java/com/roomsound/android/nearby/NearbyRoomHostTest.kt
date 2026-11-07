package com.roomsound.android.nearby

import okhttp3.*
import okio.ByteString
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import com.roomsound.android.room.Pcm16RelayPacketCodec

class NearbyRoomHostTest {
    private class Client(url:String, http:OkHttpClient) : WebSocketListener() {
        val json=LinkedBlockingQueue<JSONObject>()
        val binary=LinkedBlockingQueue<ByteString>()
        val opened=java.util.concurrent.CountDownLatch(1)
        val ws=http.newWebSocket(Request.Builder().url(url).build(),this)
        override fun onOpen(webSocket:WebSocket,response:Response){opened.countDown()}
        override fun onMessage(webSocket:WebSocket,text:String){json.offer(JSONObject(text))}
        override fun onMessage(webSocket:WebSocket,bytes:ByteString){binary.offer(bytes)}
        fun send(value:String){assertTrue(opened.await(3,TimeUnit.SECONDS));ws.send(value)}
        fun event(type:String):JSONObject {
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
            while(System.nanoTime()<deadline){val msg=json.poll(100,TimeUnit.MILLISECONDS)?:continue;if(msg.optString("type")==type)return msg}
            throw AssertionError("No nearby event: $type")
        }
    }
    @Test fun oversizedAndFragmentedFramesAreRejectedBeforePayloadAllocation() {
        val enormous = byteArrayOf(0x82.toByte(), 127, 0, 0, 0, 0, 0x10, 0, 0, 0)
        org.junit.Assert.assertThrows(java.io.IOException::class.java) {
            NearbyWSD.WebSocketFrame.read(enormous.inputStream())
        }
        org.junit.Assert.assertThrows(java.io.IOException::class.java) {
            NearbyWSD.WebSocketFrame.read(byteArrayOf(2, 0).inputStream())
        }
    }

    @Test fun localHostServesPageAndRelaysOnlyAuthorizedEpochWithoutCloud() {
        val http=OkHttpClient()
        val host=NearbyRoomHost({"<h1>Offline test page</h1>".byteInputStream()},0)
        val clients=mutableListOf<Client>()
        try {
            host.startHosting()
            val base="http://127.0.0.1:${host.listeningPort}"
            http.newCall(Request.Builder().url(base).build()).execute().use{assertTrue(it.body!!.string().contains("Offline test page"))}
            http.newCall(Request.Builder().url("$base/config").build()).execute().use{assertTrue(JSONObject(it.body!!.string()).getJSONObject("mediaRelay").getBoolean("enabled"))}
            val owner=Client(host.ownerEndpoint,http).also{clients+=it}
            owner.send("""{"type":"create-room","name":"Offline test","displayName":"Host","guestId":"host"}""")
            val created=owner.event("joined");val code=created.getJSONObject("state").getJSONObject("room").getString("code")
            val guest=Client("ws://127.0.0.1:${host.listeningPort}/?invite=${host.invite}",http).also{clients+=it}
            guest.send("""{"type":"join-room","code":"$code","displayName":"Friend","guestId":"friend"}""");guest.event("joined")
            guest.send("""{"type":"start-source"}""");assertTrue(guest.event("error").getString("message").contains("host"))
            owner.send("""{"type":"start-source"}""")
            var epoch=0L
            repeat(8){if(epoch==0L){val state=guest.event("state").getJSONObject("state").getJSONObject("room");if(state.getString("sourceStatus")=="LIVE")epoch=state.getLong("sourceEpoch")}}
            assertTrue(epoch>0)
            val frame=Pcm16RelayPacketCodec.encode(ShortArray(960){(it*7).toShort()},sourceEpoch=epoch,sequence=1)
            owner.ws.send(ByteString.of(*frame))
            assertArrayEquals(frame,guest.binary.poll(3,TimeUnit.SECONDS)?.toByteArray())
            guest.ws.send(ByteString.of(*frame));assertNull(owner.binary.poll(150,TimeUnit.MILLISECONDS))
            val stale=Pcm16RelayPacketCodec.encode(ShortArray(960),sourceEpoch=epoch-1,sequence=2)
            owner.ws.send(ByteString.of(*stale));assertNull(guest.binary.poll(150,TimeUnit.MILLISECONDS))
            guest.send("""{"type":"chat","text":"offline hello"}""");assertEquals("offline hello",owner.event("chat").getJSONObject("message").getString("text"))
            owner.send("""{"type":"end-room"}""");guest.event("room-ended")
        } finally {clients.forEach{it.ws.cancel()};host.close();http.dispatcher.executorService.shutdownNow();http.connectionPool.evictAll()}
    }
}
