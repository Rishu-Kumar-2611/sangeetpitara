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
        fun stateWhere(predicate: (JSONObject) -> Boolean): JSONObject {
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
            while(System.nanoTime()<deadline){val msg=json.poll(100,TimeUnit.MILLISECONDS)?:continue;val state=msg.optJSONObject("state")?:continue;if(predicate(state))return state}
            throw AssertionError("Expected nearby state was not received")
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

    @Test fun participantsNeedApprovalAndRevokedSourcesCannotSendAudio() {
        val http=OkHttpClient(); val host=NearbyRoomHost({"offline".byteInputStream()},0);val clients=mutableListOf<Client>()
        try {
            host.startHosting()
            val owner=Client(host.ownerEndpoint,http).also{clients+=it}
            owner.send("""{"type":"create-room","displayName":"Host","guestId":"host"}""")
            val created=owner.event("joined").getJSONObject("state");val hostId=created.getJSONObject("self").getString("id");val code=created.getJSONObject("room").getString("code")
            fun guest(name:String):Client=Client("ws://127.0.0.1:${host.listeningPort}/?invite=${host.invite}",http).also{clients+=it;it.send("""{"type":"join-room","code":"$code","displayName":"$name","guestId":"$name"}""")}
            val source=guest("DJ");val sourceId=source.event("joined").getJSONObject("state").getJSONObject("self").getString("id")
            val listener=guest("Listener");val listenerId=listener.event("joined").getJSONObject("state").getJSONObject("self").getString("id")
            owner.send("""{"type":"start-source"}""")
            val initial=source.stateWhere{it.getJSONObject("room").getString("sourceStatus")=="LIVE"}.getJSONObject("room").getLong("sourceEpoch")
            source.send("""{"type":"request-control","note":"My turn"}""")
            val alert=owner.event("control-requested").getJSONObject("request")
            assertEquals(com.roomsound.android.capture.RoomSessionCoordinator.DEVICE_AUDIO,alert.getString("sourceType"))
            val pending=owner.stateWhere{it.getJSONArray("requests").length()>0}.getJSONArray("requests").getJSONObject(0);val id=pending.getString("id")
            source.send("""{"type":"request-control"}""");source.event("error")
            listener.send("""{"type":"approve-request","requestId":"$id"}""");listener.event("error")
            owner.send("""{"type":"reject-request","requestId":"$id"}""");assertEquals("REJECTED",source.event("request-result").getString("status"))
            source.send("""{"type":"request-control"}""")
            val next=owner.stateWhere{s->(0 until s.getJSONArray("requests").length()).any{s.getJSONArray("requests").getJSONObject(it).getString("status")=="PENDING"}}.getJSONArray("requests").getJSONObject(0).getString("id")
            owner.send("""{"type":"approve-request","requestId":"$next"}""")
            source.stateWhere{it.getJSONObject("room").optString("activeSourceId")==sourceId&&it.getJSONObject("room").getString("sourceStatus")=="STARTING"}
            source.send("""{"type":"start-source"}""")
            val live=source.stateWhere{it.getJSONObject("room").optString("activeSourceId")==sourceId&&it.getJSONObject("room").getString("sourceStatus")=="LIVE"}.getJSONObject("room").getLong("sourceEpoch")
            val frame=Pcm16RelayPacketCodec.encode(ShortArray(960){1234},sourceEpoch=live,sequence=1)
            source.ws.send(ByteString.of(*frame));assertArrayEquals(frame,owner.binary.poll(3,TimeUnit.SECONDS)?.toByteArray());assertArrayEquals(frame,listener.binary.poll(3,TimeUnit.SECONDS)?.toByteArray())
            owner.ws.send(ByteString.of(*Pcm16RelayPacketCodec.encode(ShortArray(960),sourceEpoch=live,sequence=2)));assertNull(listener.binary.poll(150,TimeUnit.MILLISECONDS))
            source.ws.send(ByteString.of(*Pcm16RelayPacketCodec.encode(ShortArray(960),sourceEpoch=initial,sequence=3)));assertNull(owner.binary.poll(150,TimeUnit.MILLISECONDS))
            owner.send("""{"type":"assign-cohost","memberId":"$listenerId"}""")
            listener.stateWhere{it.getJSONObject("room").optString("cohostId")==listenerId}
            listener.send("""{"type":"takeover"}""");source.stateWhere{it.getJSONObject("room").optString("activeSourceId")==listenerId}
            source.ws.send(ByteString.of(*frame));assertNull(owner.binary.poll(150,TimeUnit.MILLISECONDS))
            owner.send("""{"type":"takeover"}""");owner.stateWhere{it.getJSONObject("room").optString("activeSourceId")==hostId&&it.getJSONObject("room").getString("sourceStatus")=="STARTING"}
            owner.send("""{"type":"grant-source","memberId":"$sourceId"}""");source.stateWhere{it.getJSONObject("room").optString("activeSourceId")==sourceId}
            source.send("""{"type":"leave-room"}""");owner.stateWhere{it.getJSONObject("room").isNull("activeSourceId")}
        } finally {clients.forEach{it.ws.cancel()};host.close();http.dispatcher.executorService.shutdownNow();http.connectionPool.evictAll()}
    }

    @Test fun nativePairingUsesTlsAndRejectsTheWrongCertificate() {
        val file=java.io.File.createTempFile("nearby-test-", ".p12");file.delete()
        val keytool=java.io.File(System.getProperty("java.home"),"bin/keytool"+if(System.getProperty("os.name").startsWith("Windows"))".exe" else "")
        val process=ProcessBuilder(keytool.path,"-genkeypair","-alias","nearby-test","-keyalg","RSA","-keysize","2048","-dname","CN=Nearby Test","-validity","2","-storetype","PKCS12","-keystore",file.path,"-storepass","test-only-password","-keypass","test-only-password").redirectErrorStream(true).start()
        process.inputStream.bufferedReader().readText();assertEquals(0,process.waitFor())
        val store=java.security.KeyStore.getInstance("PKCS12").apply{file.inputStream().use{load(it,"test-only-password".toCharArray())}}
        val managers=javax.net.ssl.KeyManagerFactory.getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm()).apply{init(store,"test-only-password".toCharArray())}
        val tls=javax.net.ssl.SSLContext.getInstance("TLS").apply{init(managers.keyManagers,null,null)}
        val pem="-----BEGIN CERTIFICATE-----\n"+java.util.Base64.getMimeEncoder().encodeToString(store.getCertificate("nearby-test").encoded)+"\n-----END CERTIFICATE-----\n"
        val host=NearbyRoomHost({"local".byteInputStream()},0,tls.serverSocketFactory,pem);val clients=mutableListOf<OkHttpClient>();val sockets=mutableListOf<Client>()
        try {
            host.startHosting()
            val pin=NearbyPairing.digest(store.getCertificate("nearby-test") as java.security.cert.X509Certificate)
            val pairing=NearbyPairing("127.0.0.1",host.securePort!!,host.invite,"ABC123",pin)
            val http=pairing.client().also{clients+=it}
            http.newCall(Request.Builder().url("http://127.0.0.1:${host.listeningPort}/nearby-certificate").build()).execute().use{assertEquals(pem,it.body!!.string())}
            http.newCall(Request.Builder().url("https://127.0.0.1:${host.securePort}/config").build()).execute().use{assertTrue(it.isSuccessful)}
            val owner=Client(host.ownerEndpoint,OkHttpClient().also{clients+=it}).also{sockets+=it}
            owner.send("""{"type":"create-room","displayName":"Host","guestId":"owner"}""")
            val code=owner.event("joined").getJSONObject("state").getJSONObject("room").getString("code")
            val guest=Client(pairing.endpoint,http).also{sockets+=it};guest.send("""{"type":"join-room","code":"$code","displayName":"Native","guestId":"native"}""");guest.event("joined")
            val memberId=owner.stateWhere{it.getJSONArray("members").length()==2}.getJSONArray("members").getJSONObject(1).getString("id")
            owner.send("""{"type":"grant-source","memberId":"$memberId"}""")
            guest.stateWhere{it.getJSONObject("room").optString("activeSourceId")==memberId}
            guest.send("""{"type":"start-source"}""")
            val epoch=guest.stateWhere{it.getJSONObject("room").getString("sourceStatus")=="LIVE"}.getJSONObject("room").getLong("sourceEpoch")
            val pcm=Pcm16RelayPacketCodec.encode(ShortArray(960){4567},sourceEpoch=epoch,sequence=1)
            guest.ws.send(ByteString.of(*pcm));assertArrayEquals(pcm,owner.binary.poll(3,TimeUnit.SECONDS)?.toByteArray())
            val wrong=pairing.copy(fingerprint="0".repeat(64)).client().also{clients+=it}
            assertThrows(java.io.IOException::class.java){wrong.newCall(Request.Builder().url("https://127.0.0.1:${host.securePort}/config").build()).execute().close()}
        } finally {sockets.forEach{it.ws.cancel()};host.close();clients.forEach{it.dispatcher.executorService.shutdownNow();it.connectionPool.evictAll()};file.delete()}
    }

    @Test fun pairingRejectsPublicAddressesAndIncompleteInvites() {
        val fragment="#invite=12345678-1234-1234-1234-123456789abc&code=ABC234&tls=8766&pin="+"a".repeat(64)
        assertEquals("192.168.43.1",NearbyPairing.parse("http://192.168.43.1:8765/$fragment").host)
        listOf("http://8.8.8.8:8765/$fragment","http://host.example:8765/$fragment","http://192.168.999.1/$fragment","http://user@192.168.43.1/$fragment","http://192.168.43.1/#code=ABC234").forEach{raw->assertThrows(IllegalArgumentException::class.java){NearbyPairing.parse(raw)}}
    }

    @Test fun recorderBacklogAndRepeatedPauseResumeKeepTheLocalRoomJoined() {
        val http=OkHttpClient();val host=NearbyRoomHost({"offline".byteInputStream()},0);val clients=mutableListOf<Client>()
        try {
            host.startHosting();val owner=Client(host.ownerEndpoint,http).also{clients+=it}
            owner.send("""{"type":"create-room","displayName":"Host","guestId":"host"}""")
            val code=owner.event("joined").getJSONObject("state").getJSONObject("room").getString("code")
            val listener=Client("ws://127.0.0.1:${host.listeningPort}/?invite=${host.invite}",http).also{clients+=it}
            listener.send("""{"type":"join-room","code":"$code","displayName":"Laptop","guestId":"laptop"}""");listener.event("joined")
            owner.send("""{"type":"start-source","sourceType":"ANDROID_DEVICE_AUDIO"}""")
            val room=listener.stateWhere{it.getJSONObject("room").getString("sourceStatus")=="LIVE"}.getJSONObject("room")
            assertEquals(com.roomsound.android.capture.RoomSessionCoordinator.DEVICE_AUDIO,room.getString("activeSourceType"))
            val epoch=room.getLong("sourceEpoch")
            repeat(160){owner.ws.send(ByteString.of(*Pcm16RelayPacketCodec.encode(ShortArray(960),sourceEpoch=epoch,sequence=it.toLong())))}
            repeat(160){assertNotNull("Recorder backlog disconnected the source",listener.binary.poll(5,TimeUnit.SECONDS))}
            repeat(6){cycle->
                val silence=Pcm16RelayPacketCodec.encode(ShortArray(960),sourceEpoch=epoch,sequence=(200+cycle*2).toLong())
                val resumed=Pcm16RelayPacketCodec.encode(ShortArray(960){2345},sourceEpoch=epoch,sequence=(201+cycle*2).toLong())
                owner.ws.send(ByteString.of(*silence));assertArrayEquals(silence,listener.binary.poll(3,TimeUnit.SECONDS)?.toByteArray())
                owner.ws.send(ByteString.of(*resumed));assertArrayEquals(resumed,listener.binary.poll(3,TimeUnit.SECONDS)?.toByteArray())
            }
            owner.send("""{"type":"chat","text":"Still hosting after six pause/play cycles"}""")
            assertTrue(listener.event("chat").getJSONObject("message").getString("text").startsWith("Still hosting"))
        } finally {clients.forEach{it.ws.cancel()};host.close();http.dispatcher.executorService.shutdownNow();http.connectionPool.evictAll()}
    }

    @Test fun excessiveAudioIsDroppedWithinABoundedBudgetAndCanRecover() {
        val budget=NearbyAudioBudget();var accepted=0
        repeat(400){if(budget.allow(1940,0))accepted++}
        assertTrue(accepted in 160..203)
        assertFalse(budget.allow(1940,0));assertTrue(budget.allow(1940,1000))
    }

    @Test fun localReconnectIdentityDoesNotExposeThePublicOrAnotherHostsCapability() {
        val pair=NearbyPairing("192.168.43.1",8766,"test-invite","ABC234","a".repeat(64));val master="private-master-capability"
        val secret=pair.reconnectSecret(master)
        assertEquals(64,secret.length);assertNotEquals(master,secret);assertEquals(secret,pair.reconnectSecret(master))
        assertNotEquals(secret,pair.copy(invite="another-invite").reconnectSecret(master))
        assertNotEquals(secret,pair.copy(fingerprint="b".repeat(64)).reconnectSecret(master))
    }
}
