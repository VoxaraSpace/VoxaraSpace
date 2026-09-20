import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The version follows the desktop app's version so a report from a phone
// says which build of the web client it wraps. versionCode is the build serial.
val desktopPackage = groovy.json.JsonSlurper().parse(file("../../client/package.json")) as Map<*, *>

android {
    namespace = "com.voxara.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.voxara.app"
        minSdk = 26
        targetSdk = 35
        versionCode = (desktopPackage["buildSerial"] as Number).toInt()
        versionName = desktopPackage["version"] as String
    }

    signingConfigs {
        // Release signing: a keystore outside the repo, described by
        // ~/.pulse/android-signing.properties (see android/README.md).
        create("release") {
            val props = Properties()
            val f = File(System.getProperty("user.home"), ".pulse/android-signing.properties")
            if (f.exists()) {
                f.inputStream().use { props.load(it) }
                storeFile = file(props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug { applicationIdSuffix = ".debug" }
    }
    buildFeatures { buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
}
