plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.roomsound.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.roomsound.android"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // JSON signaling/control uses the platform org.json APIs. OkHttp is used
    // only for the native RoomSound WebSocket client.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Public WebRTC Android fork with JavaAudioDeviceModule audio-buffer injection.
    implementation("io.github.webrtc-sdk:android:150.7871.01")

    testImplementation("junit:junit:4.13.2")
}
