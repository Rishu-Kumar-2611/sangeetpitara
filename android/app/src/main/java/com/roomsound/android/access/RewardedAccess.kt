package com.roomsound.android.access

import android.content.SharedPreferences
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Local persistence seam for the short-lived rewarded-access grant. */
interface RewardedAccessStore {
    fun readGrantExpiryMillis(): Long?
    fun writeGrantExpiryMillis(expiryMillis: Long)
}

class SharedPreferencesRewardedAccessStore(
    private val preferences: SharedPreferences,
    private val key: String = DEFAULT_EXPIRY_KEY,
) : RewardedAccessStore {
    override fun readGrantExpiryMillis(): Long? = preferences
        .getLong(key, 0L)
        .takeIf { it > 0L }

    override fun writeGrantExpiryMillis(expiryMillis: Long) {
        preferences.edit().putLong(key, expiryMillis).apply()
    }

    private companion object {
        const val DEFAULT_EXPIRY_KEY = "rewarded_access_expires_at"
    }
}

/**
 * The local six-hour capability gate. The grant is deliberately local to the
 * Android installation; it is not an account entitlement or a server token.
 */
class RewardedAccessGate(
    private val store: RewardedAccessStore,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
    private val grantDurationMillis: Long = ACCESS_DURATION_MILLIS,
) {
    init {
        require(grantDurationMillis > 0L) { "The rewarded-access duration must be positive." }
    }

    fun hasAccess(): Boolean = remainingMillis() > 0L

    fun remainingMillis(): Long {
        val expiry = store.readGrantExpiryMillis() ?: return 0L
        val remaining = expiry - nowMillis()
        if (remaining <= 0L) return 0L
        return remaining
    }

    fun grant(): Long {
        val now = nowMillis()
        val expiry = if (Long.MAX_VALUE - now < grantDurationMillis) {
            Long.MAX_VALUE
        } else {
            now + grantDurationMillis
        }
        store.writeGrantExpiryMillis(expiry)
        return expiry
    }

    companion object {
        const val ACCESS_DURATION_MILLIS = 6L * 60L * 60L * 1000L
    }
}

/** Callback contract shared by a real rewarded-ad adapter and the local demo. */
interface RewardedAccessListener {
    fun onCountdown(secondsRemaining: Int)
    fun onCompleted()
    fun onFailed(message: String)
}

interface RewardedAccessHandle {
    fun cancel()
}

/**
 * Provider-neutral rewarded-access seam. The Android build currently wires
 * the explicit local/demo provider below; no ad SDK is part of this module.
 */
interface RewardedAccessProvider {
    val displayName: String

    fun start(listener: RewardedAccessListener): RewardedAccessHandle

    fun close()
}

/**
 * Offline provider that emits a visible 30-second countdown and then invokes
 * the completion callback. It is intentionally a demo stand-in, not an ad SDK.
 */
class LocalDemoRewardedAccessProvider(
    private val durationSeconds: Int = DEMO_DURATION_SECONDS,
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "RoomSound-DemoRewardedAccess").apply { isDaemon = true }
    },
) : RewardedAccessProvider {
    init {
        require(durationSeconds > 0) { "The demo countdown duration must be positive." }
    }

    override val displayName: String = "Local/demo countdown (no ad SDK)"

    override fun start(listener: RewardedAccessListener): RewardedAccessHandle {
        val canceled = AtomicBoolean(false)
        val startedAtNanos = System.nanoTime()
        listener.onCountdown(durationSeconds)
        lateinit var future: ScheduledFuture<*>
        future = scheduler.scheduleAtFixedRate({
            if (canceled.get()) return@scheduleAtFixedRate
            val elapsedSeconds = ((System.nanoTime() - startedAtNanos) / NANOS_PER_SECOND).toInt()
            val remaining = durationSeconds - elapsedSeconds
            if (remaining <= 0) {
                if (canceled.compareAndSet(false, true)) listener.onCompleted()
                future.cancel(false)
            } else {
                listener.onCountdown(remaining)
            }
        }, 1L, 1L, TimeUnit.SECONDS)

        return object : RewardedAccessHandle {
            override fun cancel() {
                if (canceled.compareAndSet(false, true)) future.cancel(false)
            }
        }
    }

    override fun close() {
        scheduler.shutdownNow()
    }

    companion object {
        const val DEMO_DURATION_SECONDS = 30
        private const val NANOS_PER_SECOND = 1_000_000_000L
    }
}
