plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/** 默认服务器地址：CI 用仓库变量 DSH_ANDROID_BASE_URL 注入；登录页可改。 */
val defaultBaseUrl: String = providers.environmentVariable("DSH_ANDROID_BASE_URL")
    .orElse(providers.gradleProperty("dshBaseUrl"))
    .getOrElse("https://m.example.com:4174")

/** 签名：CI 从仓库机密解出 keystore 并通过环境变量传入；本地不配置时 release 不签名。 */
val keystorePath: String? = System.getenv("DSH_ANDROID_KEYSTORE_PATH")

android {
    namespace = "work.dsh.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "work.dsh.mobile"
        minSdk = 29
        targetSdk = 35
        versionCode = (System.getenv("DSH_ANDROID_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("DSH_ANDROID_VERSION_NAME") ?: "0.0.1"
        buildConfigField("String", "DEFAULT_BASE_URL", "\"$defaultBaseUrl\"")
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("DSH_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DSH_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("DSH_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
    lint {
        warningsAsErrors = false
        abortOnError = true
        checkDependencies = false
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.webkit)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
}
