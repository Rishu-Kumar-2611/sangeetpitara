package com.roomsound.android.nearby

import java.io.InputStream
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import com.roomsound.android.room.Pcm16RelayPacketCodec

/** One ephemeral local room. No database, account service, STUN or cloud requests. */
class NearbyRoomHost(private val page: () -> InputStream, port: Int = 8765) : NearbyWSD(port), Closeable {
    val invite = UUID.randomUUID().toString()
    private val ownerKey = UUID.randomUUID().toString()
    val ownerEndpoint get() = "ws://127.0.0.1:$listeningPort/?owner=$ownerKey"
    private val lock = Any()
    private val peers = linkedSetOf<Peer>()
    private val members = linkedMapOf<String, Member>()
    private val history = ArrayDeque<JSONObject>()
    private val roomId = UUID.randomUUID().toString()
    private val code = (1..6).map { "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[SecureRandom().nextInt(32)] }.joinToString("")
    private var title = "Nearby Vibe"
    private var hostId: String? = null
    private var sourceId: String? = null
    private var epoch = 0L
    private var ended = false
    private val clock = Executors.newSingleThreadScheduledExecutor()
    private data class Member(val id: String, val guest: String, val secret: String, var name: String, var peer: Peer?, var disconnectedAt: Long = 0)
    private sealed class Out {
        data class Text(val value: String) : Out()
        data class Audio(val value: ByteArray) : Out()
        object Ping : Out()
    }
    private val requests = java.util.concurrent.ConcurrentHashMap.newKeySet<NanoHTTPD.ClientHandler>()
    private val readers = java.util.concurrent.ThreadPoolExecutor(0, 24, 30, TimeUnit.SECONDS,
        java.util.concurrent.SynchronousQueue<Runnable>(), { task -> Thread(task,"Nearby-Vibe-reader").apply { isDaemon = true } })
    init {
        setAsyncRunner(object : NanoHTTPD.AsyncRunner {
            override fun exec(handler: NanoHTTPD.ClientHandler) {
                requests.add(handler)
                try { readers.execute(handler) } catch (_: java.util.concurrent.RejectedExecutionException) { requests.remove(handler); handler.close() }
            }
            override fun closed(handler: NanoHTTPD.ClientHandler) { requests.remove(handler) }
            override fun closeAll() { requests.toList().forEach { it.close() }; requests.clear() }
        })
        clock.scheduleAtFixedRate({
            synchronized(lock) {
                val removed = members.values.removeAll { it.id != hostId && it.peer == null && System.currentTimeMillis() - it.disconnectedAt > 90_000 }
                if (removed) broadcast()
                peers.toList()
            }.forEach { p ->
                if (System.currentTimeMillis() - p.lastSeen > 90_000) p.disconnect() else p.controls.offer(Out.Ping)
            }
        }, 15, 15, TimeUnit.SECONDS)
    }
    fun startHosting() = start(30_000, false)
    override fun serveHttp(session: IHTTPSession): Response {
        if (session.method != Method.GET) return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, "text/plain", "GET only")
        if (session.uri == "/config") return newFixedLengthResponse("{\"iceServers\":[],\"mediaRelay\":{\"enabled\":true,\"mode\":\"pcm16\",\"sampleRate\":48000,\"channels\":1},\"nearby\":true}")
        if (session.uri != "/" && session.uri != "/index.html") return newFixedLengthResponse(Response.Status.NOT_FOUND,"text/plain","Not found")
        val authority = session.headers["host"].orEmpty().takeIf { it.matches(Regex("[0-9.]+:[0-9]+")) }
        return newChunkedResponse(Response.Status.OK,"text/html; charset=utf-8",page()).also {
            it.addHeader("Cache-Control","no-store")
            it.addHeader("Content-Security-Policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ${authority?.let { "ws://$it" }.orEmpty()}; base-uri 'none'; frame-ancestors 'none'")
            it.addHeader("Referrer-Policy","no-referrer")
        }
    }
    override fun openWebSocket(handshake: IHTTPSession): WebSocket = Peer(handshake)
    private fun memberJson(m: Member) = JSONObject().put("id",m.id).put("guestId",m.guest).put("name",m.name).put("role",if(m.id==hostId)"HOST" else "PARTICIPANT").put("online",m.peer!=null).put("isSource",m.id==sourceId)
    private fun state(m: Member) = JSONObject().put("room",JSONObject().put("id",roomId).put("code",code).put("name",title).put("status",if(ended)"ENDED" else "ACTIVE").put("hostId",hostId).put("activeSourceId",sourceId ?: JSONObject.NULL).put("activeSourceType",if(sourceId==null)JSONObject.NULL else "ANDROID_DEVICE_AUDIO").put("sourceStatus",if(sourceId==null)"NONE" else "LIVE").put("sourceEpoch",epoch)).put("self",memberJson(m)).put("members",JSONArray(members.values.map(::memberJson))).put("requests",JSONArray()).put("messages",JSONArray(history.toList()))
    private fun broadcast() { members.values.forEach { m -> m.peer?.text(JSONObject().put("type","state").put("state",state(m))) } }
    private fun error(p: Peer, message: String) = p.text(JSONObject().put("type","error").put("message",message))
    private fun command(p: Peer, json: JSONObject) = synchronized(lock) {
        if (ended) { error(p,"This nearby room has ended."); return@synchronized }
        val type = json.optString("type")
        if (type == "create-room" || type == "join-room") {
            if (p.member != null) { error(p,"Already in a room."); return@synchronized }
            val owner = p.owner
            if (type=="create-room" && (!owner || hostId!=null)) { error(p,"Only this phone can create its nearby room."); return@synchronized }
            if (type=="join-room" && (hostId==null || json.optString("code").uppercase()!=code)) { error(p,"Check the local room code."); return@synchronized }
            val guest=json.optString("guestId").take(80); val name=json.optString("displayName").trim().take(40)
            if(guest.isBlank() || name.isBlank()) { error(p,"Enter your name."); return@synchronized }
            val existing=members.values.find { it.guest==guest }
            val m = if(existing!=null) {
                if(existing.secret!=json.optString("reconnectSecret")) { error(p,"This identity is already connected."); return@synchronized }
                existing.peer?.disconnect(); existing
            } else {
                if(members.size>=10) { error(p,"Nearby room limit: 10 people."); return@synchronized }
                Member(UUID.randomUUID().toString(),guest,json.optString("reconnectSecret").takeIf { it.length in 32..80 } ?: UUID.randomUUID().toString(),name,p).also { members[it.id]=it }
            }
            m.name=name; m.peer=p; p.member=m
            if(type=="create-room") {hostId=m.id; title=json.optString("name","Nearby Vibe").take(60)}
            p.text(JSONObject().put("type","joined").put("reconnectSecret",m.secret).put("state",state(m))); broadcast(); return@synchronized
        }
        val m=p.member ?: run {error(p,"Join the nearby room first.");return@synchronized}
        when(type) {
            "chat" -> {
                val body=json.optString("text").trim().take(1000)
                if(body.isNotEmpty()) { val msg=JSONObject().put("id",UUID.randomUUID().toString()).put("kind","chat").put("senderId",m.id).put("senderName",m.name).put("text",body).put("createdAt",System.currentTimeMillis());history.addLast(msg);if(history.size>50)history.removeFirst();members.values.forEach { it.peer?.text(JSONObject().put("type","chat").put("message",msg)) } }
            }
            "start-source","takeover","stop-source" -> {
                if(m.id!=hostId || !p.owner) error(p,"The nearby host phone shares the music.")
                else {sourceId=if(type=="stop-source")null else m.id;epoch++;broadcast()}
            }
            "leave-room" -> {p.member=null;m.peer=null;if(m.id!=hostId)members.remove(m.id);if(m.id==sourceId){sourceId=null;epoch++};broadcast();p.disconnect()}
            "end-room" -> if(m.id==hostId && p.owner) {ended=true;members.values.forEach{it.peer?.text(JSONObject().put("type","room-ended").put("message","The host ended Nearby Vibe."))};sourceId=null;epoch++;broadcast()}
            else -> error(p,"Nearby Vibe currently supports host audio, listening and chat.")
        }
    }
    private fun audio(p: Peer, bytes: ByteArray) = synchronized(lock) {
        if(ended || p.member?.id!=sourceId || !p.owner || bytes.size>Pcm16RelayPacketCodec.MAX_FRAME_BYTES)return@synchronized
        val packet=runCatching { Pcm16RelayPacketCodec.decode(bytes) }.getOrNull() ?: return@synchronized
        if(packet.sourceEpoch!=epoch)return@synchronized
        members.values.forEach { m -> if(m.id!=sourceId) m.peer?.let { peer ->
            if(!peer.audio.offer(Out.Audio(bytes))) {peer.audio.poll();peer.audio.offer(Out.Audio(bytes))}
        } }
    }
    private inner class Peer(handshake: IHTTPSession) : WebSocket(handshake) {
        val owner=handshake.parameters["owner"]?.firstOrNull()==ownerKey && handshake.remoteIpAddress in setOf("127.0.0.1","::1")
        private val admitted=owner || handshake.parameters["invite"]?.firstOrNull()==invite
        var member: Member?=null
        val controls=ArrayBlockingQueue<Out>(16)
        val audio=ArrayBlockingQueue<Out>(200)
        @Volatile var lastSeen=System.currentTimeMillis()
        @Volatile var running=true
        private var writer: Thread?=null
        private var count=0;private var window=0L
        override fun onOpen() {
            synchronized(lock){if(!admitted || peers.size>=12){disconnect();return};peers.add(this)}
            writer=Thread({try {while(running){val out=controls.poll() ?: audio.poll(100,TimeUnit.MILLISECONDS) ?: continue;when(out){is Out.Text->send(out.value);is Out.Audio->send(out.value);Out.Ping->ping(byteArrayOf(1))}}}catch(_:Exception){disconnect()}},"Nearby-Vibe-writer").apply{isDaemon=true;start()}
        }
        fun text(json:JSONObject){if(!controls.offer(Out.Text(json.toString())))disconnect()}
        fun disconnect(){if(!running)return;running=false;writer?.interrupt();Thread({runCatching{close(WebSocketFrame.CloseCode.NormalClosure,"Nearby connection closed",false)}},"Nearby-Vibe-close").apply{isDaemon=true;start()}}
        override fun onMessage(message:WebSocketFrame) {
            lastSeen=System.currentTimeMillis()
            if(lastSeen-window>1000){window=lastSeen;count=0};if(++count>150){disconnect();return}
            if(message.opCode==WebSocketFrame.OpCode.Binary) audio(this,message.binaryPayload)
            else if(message.textPayload.length<=8192)runCatching{command(this,JSONObject(message.textPayload))}.onFailure{error(this,"Invalid nearby command.")}
            else disconnect()
        }
        override fun onPong(pong:WebSocketFrame){lastSeen=System.currentTimeMillis()}
        override fun onException(exception:IOException){disconnect()}
        override fun onClose(code:WebSocketFrame.CloseCode?,reason:String?,initiatedByRemote:Boolean){running=false;writer?.interrupt();synchronized(lock){peers.remove(this);member?.let{if(it.peer===this){it.peer=null;it.disconnectedAt=System.currentTimeMillis()}};broadcast()}}
    }
    override fun close(){clock.shutdownNow();synchronized(lock){peers.toList().forEach{it.disconnect()};members.clear()};stop();readers.shutdownNow()}
}
