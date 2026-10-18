FROM eclipse-temurin:17-jdk-jammy AS android-build

ARG ANDROID_SDK_ROOT=/opt/android-sdk
ARG ANDROID_CMDLINE_TOOLS_VERSION=11076708
ARG ANDROID_BUILD_TOOLS_VERSION=35.0.0

ENV ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT}
ENV ANDROID_HOME=${ANDROID_SDK_ROOT}
ENV PATH=${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools:${PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "${ANDROID_SDK_ROOT}/cmdline-tools" \
    && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" \
        -o /tmp/android-command-line-tools.zip \
    && unzip -q /tmp/android-command-line-tools.zip -d "${ANDROID_SDK_ROOT}/cmdline-tools" \
    && mv "${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools" "${ANDROID_SDK_ROOT}/cmdline-tools/latest" \
    && rm /tmp/android-command-line-tools.zip

RUN yes | sdkmanager --licenses >/dev/null \
    && sdkmanager \
        "platform-tools" \
        "platforms;android-35" \
        "build-tools;${ANDROID_BUILD_TOOLS_VERSION}"

WORKDIR /app/android
COPY android/gradlew ./gradlew
COPY android/gradle ./gradle
COPY android/settings.gradle.kts android/build.gradle.kts android/gradle.properties ./
COPY android/app ./app
RUN chmod +x ./gradlew \
    && ./gradlew :app:assembleDebug --no-daemon --console=plain \
    && test -f app/build/outputs/apk/debug/app-debug.apk

FROM node:22.14.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm test && npm run check

ENV NODE_ENV=production
EXPOSE 4173
CMD ["npm", "start"]
