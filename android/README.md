# Voxara for Android

A native Android app that wraps the Voxara web client (the same client the
desktop app and the browser use) in a system WebView, with the parts a phone
needs around it: a launcher icon, `voxara://` and invite-link handling, the
microphone and camera permission bridge so calls work, an offline screen,
and HTTPS-only networking pinned to the system trust store.

The WebView only ever loads voxaraspace.com; any other link opens in the
phone's browser. Nothing here needs a Node build: the client is served live.

## Build

Needs a JDK 17, the Android SDK (platform 35, build-tools 35.0.0) and Gradle 8.11.

```bash
export JAVA_HOME=/path/to/jdk17 ANDROID_HOME=/path/to/android-sdk
cd android
gradle assembleRelease --no-daemon
# -> app/build/outputs/apk/release/app-release.apk
```

## Signing (once)

Android refuses to install an unsigned release, and every later update must
be signed with the same key or the phone treats it as a different app. The
key lives outside the repo:

```bash
keytool -genkeypair -v -keystore ~/android-release.jks -alias voxara \
  -keyalg RSA -keysize 4096 -validity 10000 -storepass CHANGE-ME -keypass CHANGE-ME \
  -dname "CN=Voxara, O=Voxara"
cat > ~/.pulse/android-signing.properties <<EOF
storeFile=/path/to/android-release.jks
storePassword=CHANGE-ME
keyAlias=voxara
keyPassword=CHANGE-ME
EOF
chmod 600 ~/android-release.jks ~/.pulse/android-signing.properties
```

Back the keystore up somewhere else: losing it means no existing
install can ever be updated.

## Installing without the Play Store

Users download the APK from voxaraspace.com/download/android, open it, and
allow "install from this source" once. Chrome and Android show an unknown-app
warning until the app is on the Play Store. Publishing there needs a Google
Play developer account (one-off fee) and the same signed APK, uploaded as an
app bundle: `gradle bundleRelease`.

## Limits

- Notifications arrive only while the app is open (no push service yet).
- Screen sharing is not available in Android WebView.
- Invite links open in the app only after Android verifies the domain, which
  needs `https://voxaraspace.com/.well-known/assetlinks.json` to list this
  app's signing certificate.
