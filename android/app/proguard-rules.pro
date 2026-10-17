# RoomSound production keep rules
-keep class org.webrtc.** { *; }
-keep class com.roomsound.android.** { *; }
-dontwarn org.webrtc.**
-keepattributes Signature, InnerClasses, EnclosingMethod
