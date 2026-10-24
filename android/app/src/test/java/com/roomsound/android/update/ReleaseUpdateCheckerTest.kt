package com.roomsound.android.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseUpdateCheckerTest {
    @Test
    fun comparesSemanticVersionsNumericallyWithOrWithoutPrefix() {
        assertTrue(ReleaseVersion.isNewer("v1.0.2", "1.0.1"))
        assertTrue(ReleaseVersion.isNewer("1.10.0", "1.9.9"))
        assertTrue(ReleaseVersion.isNewer("v2.0.0", "1.99.99"))
        assertFalse(ReleaseVersion.isNewer("v1.0.1", "1.0.1"))
        assertFalse(ReleaseVersion.isNewer("v1.0.0", "1.0.1"))
    }

    @Test
    fun unparseableVersionsNeverClaimAnUpdate() {
        assertFalse(ReleaseVersion.isNewer("v1.0.2-beta", "1.0.1"))
        assertFalse(ReleaseVersion.isNewer("latest", "1.0.1"))
        assertFalse(ReleaseVersion.isNewer("v1.0.2", "1.0.1-debug"))
        assertFalse(ReleaseVersion.isNewer("v99999999999.0.0", "1.0.1"))
    }

    @Test
    fun readsTagNameFromGitHubResponse() {
        val json = """{"url":"x","tag_name": "v1.0.2","name":"SangeetPitara 1.0.2","draft":false}"""
        assertEquals("v1.0.2", ReleaseVersion.latestTag(json))
        assertNull(ReleaseVersion.latestTag("""{"message":"Not Found"}"""))
    }

    @Test
    fun reportsOnlyANewerReleaseWithTheFixedApkAsset() {
        val newer = ReleaseUpdateChecker("owner/repo", "1.0.1") { """{"tag_name":"v1.1.0"}""" }.check()
        assertEquals(AvailableUpdate("v1.1.0", "https://github.com/owner/repo/releases/latest/download/SangeetPitara.apk"), newer)
        assertNull(ReleaseUpdateChecker("owner/repo", "1.1.0") { """{"tag_name":"v1.1.0"}""" }.check())
    }

    @Test
    fun networkFailuresAreSilent() {
        assertNull(ReleaseUpdateChecker("owner/repo", "1.0.1") { null }.check())
        assertNull(ReleaseUpdateChecker("owner/repo", "1.0.1") { throw java.io.IOException("offline") }.check())
    }
}
