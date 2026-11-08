package com.roomsound.android.nearby

import com.roomsound.android.room.ChatContent
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
class NearbyRoomHost(private val page: () -> InputStream, private val port: Int = 8765, private val tlsFactory: javax.net.ssl.SSLServerSocketFactory? = null, private val certificatePem: String? = null) : NearbyWSD(port), Closeable {
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
    private var cohostId: String? = null
    private var sourceStatus = "NONE"
    private var sourceType = "ANDROID_DEVICE_AUDIO"
    private var sourceDeadline = 0L
    private val controlRequests = linkedMapOf<String, JSONObject>()
    private var secureServer: NearbyWSD? = null
    val securePort get() = secureServer?.listeningPort
    private var epoch = 0L
    private var ended = false
    private val clock = Executors.newSingleThreadScheduledExecutor()
    private data class Member(val id: String, val guest: String, val secret: String, var name: String, var peer: Peer?, var disconnectedAt: Long = 0, var lastVoiceAt: Long = 0)
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
                val now = System.currentTimeMillis()
                var changed = controlRequests.values.removeAll { it.optLong("expiresAt") <= now }
                val removed = members.values.filter { it.id != hostId && it.peer == null && now - it.disconnectedAt > 90_000 }.map { it.id }
                removed.forEach { remove(it) }; changed = changed || removed.isNotEmpty()
                if (sourceStatus == "STARTING" && now > sourceDeadline) { setSource(null); changed = true }
                if (changed) broadcast()
                peers.toList()
            }.forEach { p ->
                if (System.currentTimeMillis() - p.lastSeen > 90_000) p.disconnect() else p.controls.offer(Out.Ping)
            }
        }, 15, 15, TimeUnit.SECONDS)
    }
    fun startHosting() {
        start(30_000, false)
        try {
            tlsFactory?.let { factory ->
                secureServer = object : NearbyWSD(if (port == 0) 0 else port + 1) {
                    override fun serveHttp(session: IHTTPSession) = this@NearbyRoomHost.serveHttp(session)
                    override fun openWebSocket(handshake: IHTTPSession): WebSocket = Peer(handshake)
                }.also { server -> server.setAsyncRunner(object : NanoHTTPD.AsyncRunner {
                    override fun exec(handler: NanoHTTPD.ClientHandler) { requests.add(handler); try { readers.execute(handler) } catch (_: java.util.concurrent.RejectedExecutionException) { requests.remove(handler); handler.close() } }
                    override fun closed(handler: NanoHTTPD.ClientHandler) { requests.remove(handler) }
                    override fun closeAll() { requests.toList().forEach { it.close() } }
                }); server.makeSecure(factory, null); server.start(30_000, false) }
            }
        } catch (e: Exception) { close(); throw e }
    }
    override fun serveHttp(session: IHTTPSession): Response {
        if (session.method != Method.GET) return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, "text/plain", "GET only")
        if (session.uri == "/nearby-certificate" && certificatePem != null) return newFixedLengthResponse(Response.Status.OK,"application/x-pem-file",certificatePem).also { it.addHeader("Cache-Control","no-store") }
        if (session.uri == "/config") return newFixedLengthResponse("{\"iceServers\":[],\"mediaRelay\":{\"enabled\":true,\"mode\":\"pcm16\",\"sampleRate\":48000,\"channels\":1},\"chatFeatures\":{\"voiceMessages\":true,\"messageReplies\":true},\"nearby\":true}")
        if (session.uri != "/" && session.uri != "/index.html") return newFixedLengthResponse(Response.Status.NOT_FOUND,"text/plain","Not found")
        val authority = session.headers["host"].orEmpty().takeIf { it.matches(Regex("[0-9.]+:[0-9]+")) }
        return newChunkedResponse(Response.Status.OK,"text/html; charset=utf-8",page()).also {
            it.addHeader("Cache-Control","no-store")
            it.addHeader("Content-Security-Policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:; connect-src 'self' ${authority?.let { "ws://$it" }.orEmpty()}; base-uri 'none'; frame-ancestors 'none'")
            it.addHeader("Referrer-Policy","no-referrer")
        }
    }
    override fun openWebSocket(handshake: IHTTPSession): WebSocket = Peer(handshake)
    private fun moderator(m: Member) = m.id == hostId || m.id == cohostId
    private fun setSource(id: String?, status: String = "STARTING", type: String = "ANDROID_DEVICE_AUDIO") {
        sourceId = id; sourceStatus = if (id == null) "NONE" else status; epoch++
        sourceType = type
        sourceDeadline = System.currentTimeMillis() + 60_000
        peers.forEach { it.audio.clear() }
    }
    private fun remove(id: String) {
        members.remove(id); controlRequests.values.removeAll { it.optString("requesterId") == id }
        if (sourceId == id) setSource(null)
        if (cohostId == id) cohostId = null
    }
    private fun result(m: Member, request: JSONObject, status: String) {
        request.put("status",status)
        m.peer?.text(JSONObject().put("type","request-result").put("status",status).put("request",request))
    }
    private fun memberJson(m: Member) = JSONObject().put("id",m.id).put("guestId",m.guest).put("name",m.name).put("role",if(m.id==hostId)"HOST" else if(m.id==cohostId)"CO_HOST" else "PARTICIPANT").put("online",m.peer!=null).put("isSource",m.id==sourceId)
    private fun state(m: Member, includeVoiceData: Boolean = true) = JSONObject().put("room",JSONObject().put("id",roomId).put("code",code).put("name",title).put("status",if(ended)"ENDED" else "ACTIVE").put("hostId",hostId).put("cohostId",cohostId ?: JSONObject.NULL).put("activeSourceId",sourceId ?: JSONObject.NULL).put("activeSourceType",if(sourceId==null)JSONObject.NULL else sourceType).put("sourceStatus",sourceStatus).put("sourceEpoch",epoch)).put("self",memberJson(m)).put("members",JSONArray(members.values.map(::memberJson))).put("requests",JSONArray(controlRequests.values.toList())).put("messages",JSONArray(history.map { ChatContent.snapshot(it, includeVoiceData) }))
    private fun broadcast() { members.values.forEach { m -> m.peer?.text(JSONObject().put("type","state").put("state",state(m, false))) } }
    private fun error(p: Peer, message: String) = p.text(JSONObject().put("type","error").put("message",message))
    private fun command(p: Peer, json: JSONObject) = synchronized(lock) {
        if (ended) { error(p,"This nearby room has ended."); return@synchronized }
        val type = json.optString("type")
        val requestedSourceType = json.optString("sourceType","ANDROID_DEVICE_AUDIO")
        if(type in setOf("request-control","start-source","takeover","grant-source") && requestedSourceType !in setOf("ANDROID_DEVICE_AUDIO","DEVICE_AUDIO")) { error(p,"Only playback audio is supported."); return@synchronized }
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
        if (m.peer !== p) { error(p,"This connection was replaced."); return@synchronized }
        when(type) {
            "chat" -> {
                val clientId = json.optString("clientMessageId")
                val previous = history.find { clientId.isNotEmpty() && it.optString("senderId") == m.id && it.optString("clientMessageId") == clientId }
                if (previous != null) { p.text(JSONObject().put("type", "chat").put("message", previous)); return@synchronized }
                val msg = runCatching { ChatContent.build(json, history.toList()) }.getOrElse { error(p, it.message ?: "Invalid chat message."); return@synchronized }
                if (msg.has("voice")) {
                    if (System.currentTimeMillis() - m.lastVoiceAt < 5000) { error(p, "Please wait a few seconds before sending another recording."); return@synchronized }
                    m.lastVoiceAt = System.currentTimeMillis()
                }
                msg.put("id",UUID.randomUUID().toString()).put("kind","chat").put("senderId",m.id).put("senderName",m.name).put("createdAt",System.currentTimeMillis())
                history.addLast(msg); if (history.size > 50) history.removeFirst()
                for (expired in ChatContent.bound(history.toList())) members.values.forEach { it.peer?.text(JSONObject().put("type","chat").put("message",expired)) }
                members.values.forEach { it.peer?.text(JSONObject().put("type","chat").put("message",msg)) }
            }
            "request-control" -> {
                if (m.id == sourceId || controlRequests.values.any { it.optString("requesterId") == m.id && it.optString("status") == "PENDING" }) { error(p,"Already sharing or waiting for approval."); return@synchronized }
                controlRequests.values.removeAll { it.optString("requesterId") == m.id }
                val request = JSONObject().put("id",UUID.randomUUID().toString()).put("requesterId",m.id).put("requesterName",m.name).put("sourceType",requestedSourceType).put("note",json.optString("note").take(160)).put("status","PENDING").put("createdAt",System.currentTimeMillis()).put("expiresAt",System.currentTimeMillis()+120_000)
                controlRequests[request.getString("id")] = request
                members.values.forEach { it.peer?.text(JSONObject().put("type","control-requested").put("request",request)) }; broadcast()
            }
            "cancel-request" -> {
                val request = controlRequests[json.optString("requestId")]
                if (request?.optString("requesterId") == m.id) { controlRequests.remove(json.optString("requestId")); broadcast() }
            }
            "approve-request", "reject-request", "grant-source" -> {
                if (!moderator(m)) { error(p,"Only the host or co-host can manage audio control."); return@synchronized }
                val request = if(type == "grant-source") null else controlRequests[json.optString("requestId")]
                if(type != "grant-source" && (request == null || request.optString("status") != "PENDING" || request.optLong("expiresAt") <= System.currentTimeMillis())) { error(p,"That request has expired."); return@synchronized }
                val target = members[if(type == "grant-source") json.optString("memberId") else request!!.getString("requesterId")]
                if(target?.peer == null) { error(p,"That participant is no longer connected."); return@synchronized }
                val decision = if(type == "reject-request") "REJECTED" else "APPROVED"
                controlRequests.values.filter { it.optString("requesterId") == target.id && it.optString("status") == "PENDING" }.forEach { result(target,it,decision) }
                if(decision == "APPROVED") setSource(target.id,type=request?.optString("sourceType") ?: requestedSourceType)
                broadcast()
            }
            "assign-cohost" -> {
                if(m.id != hostId) { error(p,"Only the host can assign a co-host."); return@synchronized }
                val id = json.optString("memberId").takeIf { it.isNotEmpty() && it != "null" }
                if(id != null && (id == hostId || members[id]?.peer == null)) { error(p,"Choose a connected participant."); return@synchronized }
                cohostId = id; broadcast()
            }
            "remove-member" -> {
                val target = members[json.optString("memberId")]
                if(!moderator(m) || target == null || target.id == hostId || target.id == m.id || (target.id == cohostId && m.id != hostId)) { error(p,"You cannot remove that member."); return@synchronized }
                target.peer?.text(JSONObject().put("type","removed").put("message","Removed by the host.")); target.peer?.member = null; target.peer?.disconnect(); remove(target.id); broadcast()
            }
            "start-source", "takeover", "stop-source" -> {
                val allowed = if(type == "takeover") moderator(m) else moderator(m) || m.id == sourceId
                if(!allowed) error(p,"Ask the host for audio control first.")
                else { setSource(if(type=="stop-source") null else m.id,if(type=="start-source") "LIVE" else "STARTING",requestedSourceType); broadcast() }
            }
            "leave-room" -> {p.member=null;m.peer=null;m.disconnectedAt=System.currentTimeMillis();if(m.id!=hostId)remove(m.id);if(m.id==sourceId)setSource(null);broadcast();p.disconnect()}
            "end-room" -> if(m.id==hostId && p.owner) {ended=true;members.values.forEach{it.peer?.text(JSONObject().put("type","room-ended").put("message","The host ended Nearby Vibe."))};setSource(null);broadcast()}
            else -> error(p,"Unsupported nearby command.")
        }
    }
    private fun audio(p: Peer, bytes: ByteArray) = synchronized(lock) {
        if(ended || p.member == null || p.member?.peer !== p || p.member?.id!=sourceId || sourceStatus!="LIVE" || bytes.size>Pcm16RelayPacketCodec.MAX_FRAME_BYTES)return@synchronized
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
        private var largeWindow = 0L
        private var largeCount = 0
        val controls=ArrayBlockingQueue<Out>(16)
        val audio=ArrayBlockingQueue<Out>(200)
        @Volatile var lastSeen=System.currentTimeMillis()
        @Volatile var running=true
        private var writer: Thread?=null
        private var count=0;private var window=0L
        private val audioBudget = NearbyAudioBudget()
        override fun onOpen() {
            synchronized(lock){if(!admitted || peers.size>=12){disconnect();return};peers.add(this)}
            writer=Thread({try {while(running){val out=controls.poll() ?: audio.poll(100,TimeUnit.MILLISECONDS) ?: continue;when(out){is Out.Text->send(out.value);is Out.Audio->send(out.value);Out.Ping->ping(byteArrayOf(1))}}}catch(_:Exception){disconnect()}},"Nearby-Vibe-writer").apply{isDaemon=true;start()}
        }
        fun text(json:JSONObject){if(!controls.offer(Out.Text(json.toString())))disconnect()}
        fun disconnect(){if(!running)return;running=false;writer?.interrupt();Thread({runCatching{close(WebSocketFrame.CloseCode.NormalClosure,"Nearby connection closed",false)}},"Nearby-Vibe-close").apply{isDaemon=true;start()}}
        override fun onMessage(message:WebSocketFrame) {
            lastSeen=System.currentTimeMillis()
            if(message.opCode==WebSocketFrame.OpCode.Binary) {
                if(audioBudget.allow(message.binaryPayload.size,System.nanoTime()/1_000_000)) audio(this,message.binaryPayload)
            } else {
                if(lastSeen-window>1000){window=lastSeen;count=0};if(++count>150){disconnect();return}
                if (message.textPayload.length > 8192) {
                    if (member == null) { disconnect(); return }
                    if (lastSeen - largeWindow > 5000) { largeWindow = lastSeen; largeCount = 0 }
                    if (++largeCount > 2) { error(this,"Please wait before retrying this recording."); return }
                }
                if(message.textPayload.length<=300*1024)runCatching{command(this,JSONObject(message.textPayload))}.onFailure{error(this,"Invalid nearby command.")}
                else disconnect()
            }
        }
        override fun onPong(pong:WebSocketFrame){lastSeen=System.currentTimeMillis()}
        override fun onException(exception:IOException){disconnect()}
        override fun onClose(code:WebSocketFrame.CloseCode?,reason:String?,initiatedByRemote:Boolean){running=false;writer?.interrupt();synchronized(lock){peers.remove(this);member?.let{if(it.peer===this){it.peer=null;it.disconnectedAt=System.currentTimeMillis()}};broadcast()}}
    }
    override fun close(){clock.shutdownNow();synchronized(lock){peers.toList().forEach{it.disconnect()};members.clear()};secureServer?.stop();stop();readers.shutdownNow()}
}
