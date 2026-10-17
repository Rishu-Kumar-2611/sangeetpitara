plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}

// OneDrive and other sync tools can hold Gradle's generated directories while
// a task is replacing them. Keep the normal in-project layout by default, but
// allow CI or a local build to move only generated Android output elsewhere:
//   ./gradlew :app:assembleRelease -Proomsound.buildDir=/tmp/roomsound-android
//   $env:ROOMSOUND_BUILD_DIR = "$env:TEMP\\RoomSoundAndroidBuild"
val configuredBuildDir = providers.gradleProperty("roomsound.buildDir")
    .orElse(providers.environmentVariable("ROOMSOUND_BUILD_DIR"))
    .orNull

if (!configuredBuildDir.isNullOrBlank()) {
    val buildRoot = file(configuredBuildDir)
    layout.buildDirectory.set(buildRoot)
    subprojects {
        layout.buildDirectory.set(buildRoot.resolve(name))
    }
}
