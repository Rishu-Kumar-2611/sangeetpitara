import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

dependencyLocking {
    lockAllConfigurations()
}

fun configuredValue(name: String): String? = providers.gradleProperty(name)
    .orElse(providers.environmentVariable(name))
    .orNull
    ?.trim()
    ?.takeIf { it.isNotEmpty() }

val releaseProperties = Properties().apply {
    rootProject.file("../release.properties").inputStream().use { load(it) }
}

fun String.asBuildConfigStringLiteral(): String = buildString {
    append('"')
    for (character in this@asBuildConfigStringLiteral) {
        when (character) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> append(character)
        }
    }
    append('"')
}

// Public routing configuration, not a credential. Explicit LAN, staging, or
// release values supplied through ROOMSOUND_DEFAULT_ENDPOINT still win.
val localPreviewBuild = configuredValue("ROOMSOUND_PREVIEW_BUILD") == "1"
val configuredDefaultEndpoint = configuredValue("ROOMSOUND_DEFAULT_ENDPOINT")
    ?: "wss://sangeet-pitaraa.onrender.com"
// Invite links https://<site>/join/CODE open the app for the default room server.
val inviteLinkHost = Regex("^wss://([^/:]+)").find(configuredDefaultEndpoint)?.groupValues?.get(1)
    ?: "sangeet-pitaraa.onrender.com"
// The release workflow derives both from the pushed v<major>.<minor>.<patch> tag.
val configuredVersionName = configuredValue("ROOMSOUND_VERSION_NAME")
    ?: releaseProperties.getProperty("VERSION_NAME", "1.1.25")
val configuredVersionCode = configuredValue("ROOMSOUND_VERSION_CODE")?.toInt()
    ?: releaseProperties.getProperty("VERSION_CODE", "10125").toInt()
// GitHub repository whose latest release the app checks for an update notice.
val configuredReleasesRepository = configuredValue("ROOMSOUND_RELEASES_REPOSITORY")
    ?: "Rishu-Kumar-2611/sangeetpitara"
val releaseKeystorePath = configuredValue("ROOMSOUND_KEYSTORE")
val releaseKeystorePassword = configuredValue("ROOMSOUND_KEYSTORE_PASSWORD")
val releaseKeyAlias = configuredValue("ROOMSOUND_KEY_ALIAS")
val releaseKeyPassword = configuredValue("ROOMSOUND_KEY_PASSWORD")
val releaseSigningConfigured = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { it != null }
val resolvedReleaseKeystore = releaseKeystorePath?.let(::file)

android {
    namespace = "com.roomsound.android"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.roomsound.android"
        // Invite links https://<site>/join/CODE open the app for the default room server.
        manifestPlaceholders["inviteHost"] = inviteLinkHost
        manifestPlaceholders["previewAppLabel"] = if (localPreviewBuild) "SangeetPitara Preview" else "SangeetPitara"
        minSdk = 29
        targetSdk = 36
        versionCode = configuredVersionCode
        versionName = configuredVersionName
        buildConfigField(
            "String",
            "ROOMSOUND_DEFAULT_ENDPOINT",
            configuredDefaultEndpoint.asBuildConfigStringLiteral(),
        )
        buildConfigField("String", "ROOMSOUND_INVITE_HOST", inviteLinkHost.asBuildConfigStringLiteral())
        buildConfigField(
            "String",
            "ROOMSOUND_RELEASES_REPOSITORY",
            configuredReleasesRepository.asBuildConfigStringLiteral(),
        )
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // Force Java 17 toolchain even if a JDK 27 is on PATH
    java {
        toolchain {
            languageVersion.set(JavaLanguageVersion.of(17))
        }
    }
    kotlin {
        jvmToolchain(17)
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = resolvedReleaseKeystore
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            if (localPreviewBuild) { applicationIdSuffix = ".preview"; versionNameSuffix = "-preview" }
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

val validateRoomSoundReleaseSigning = tasks.register("validateRoomSoundReleaseSigning") {
    doLast {
        if (!releaseSigningConfigured) {
            throw GradleException(
                "Release signing is not configured. Set ROOMSOUND_KEYSTORE, " +
                    "ROOMSOUND_KEYSTORE_PASSWORD, ROOMSOUND_KEY_ALIAS, and " +
                    "ROOMSOUND_KEY_PASSWORD as Gradle properties or environment variables.",
            )
        }
        check(resolvedReleaseKeystore?.isFile == true) {
            "Release keystore does not exist: ${resolvedReleaseKeystore?.path}"
        }
    }
}

// Debug builds stay usable without private signing material. Any release
// lifecycle task must validate the explicitly supplied local/CI credentials.
tasks.matching { it.name == "preReleaseBuild" || it.name == "validateSigningRelease" }
    .configureEach { dependsOn(validateRoomSoundReleaseSigning) }

// Publish a clearly named installable artifact without renaming the package or
// changing the normal Gradle output layout. Previous APKs remain available.
tasks.register<Copy>("exportDebugApk") {
    dependsOn("assembleDebug")
    from(project.layout.buildDirectory.file("outputs/apk/debug/app-debug.apk"))
    into(rootProject.layout.projectDirectory.dir("artifacts"))
    rename { "SangeetPitara-debug.apk" }
}

// Public APKs are no longer committed under downloads/: a pushed v* tag makes
// .github/workflows/release.yml build, sign and publish them to GitHub Releases.

dependencies {
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    // JSON signaling/control uses the platform org.json APIs. OkHttp is used
    // only for the native RoomSound WebSocket client.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Public WebRTC Android fork with JavaAudioDeviceModule audio-buffer injection.
    implementation("io.github.webrtc-sdk:android:150.7871.01")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// Keep the Android guide identical to the website, with no network dependency.
val bundleUserManual = tasks.register<Sync>("bundleUserManual") {
    from(rootProject.layout.projectDirectory.dir("..")) {
        include("guide.html", "guide.js", "guide/**", "privacy.html", "terms.html")
        include("styles.css", "themes.css", "themes.js", "fonts/**")
        include("branding/sangeetpitara/05-diya-eighth-note.svg")
        into("manual")
    }
    into(layout.buildDirectory.dir("generated/manualAssets"))
}
android.sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/manualAssets"))
tasks.named("preBuild").configure { dependsOn(bundleUserManual) }
