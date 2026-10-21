package com.roomsound.android.transport

import java.io.Closeable

/** Small output contract exercised by the real relay writer in plain JVM tests. */
internal interface Pcm16RelayAudioOutput : Closeable {
    /** Actual writable PCM capacity, not getMinBufferSize's estimated minimum. */
    val bufferCapacityBytes: Int
    fun write(bytes: ByteArray, offset: Int, count: Int, blocking: Boolean): Int
    fun play(primedBytes: Int)
    fun setVolume(volume: Float)

    /**
     * Called concurrently with write. Must interrupt a blocked write and make
     * room for one racing (at most 20 ms) write. Never wait for the writer here.
     * Control calls/close are serialized; close runs only after write returns.
     */
    fun interrupt()
}
