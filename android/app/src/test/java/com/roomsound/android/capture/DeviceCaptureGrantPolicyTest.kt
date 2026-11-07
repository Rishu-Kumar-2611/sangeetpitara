package com.roomsound.android.capture

import org.junit.Assert.*
import org.junit.Test

class DeviceCaptureGrantPolicyTest {
    @Test fun webAndNativeGrantsBothAllowTheApprovedPhoneToBeginConsent() {
        for(type in listOf("DEVICE_AUDIO","ANDROID_DEVICE_AUDIO")) for(status in listOf("STARTING","LIVE")) {
            assertTrue(DeviceCaptureGrantPolicy.ownsSlot("phone","phone",type,status))
        }
    }
    @Test fun anotherMembersGrantOrMissingApprovalCannotStartCapture() {
        assertFalse(DeviceCaptureGrantPolicy.ownsSlot("phone","laptop","DEVICE_AUDIO","STARTING"))
        assertFalse(DeviceCaptureGrantPolicy.ownsSlot(null,"phone","DEVICE_AUDIO","STARTING"))
        assertFalse(DeviceCaptureGrantPolicy.ownsSlot("phone",null,"DEVICE_AUDIO","LIVE"))
        assertFalse(DeviceCaptureGrantPolicy.ownsSlot("phone","phone","DEVICE_AUDIO","NONE"))
    }
    @Test fun arbitrarySourceTypesDoNotBecomeAndroidCapturePermissions() {
        for(type in listOf(null,"MICROPHONE","TEST_TONE","UNKNOWN")) {
            assertFalse(DeviceCaptureGrantPolicy.ownsSlot("phone","phone",type,"STARTING"))
        }
    }
}
