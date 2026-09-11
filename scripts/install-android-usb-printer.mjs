import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const androidRoot = path.join(root, 'android')
const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml')
const projectBuildGradlePath = path.join(androidRoot, 'build.gradle')
const appBuildGradlePath = path.join(androidRoot, 'app', 'build.gradle')
const capacitorConfigPath = path.join(root, 'capacitor.config.ts')
const nativeTemplatesDir = path.join(root, 'native', 'android')
const nativeTestTemplatesDir = path.join(nativeTemplatesDir, 'tests')
const roomVersion = '2.8.5'
const kspVersion = '2.3.12'

function normalizeLineEndings(content, lineEnding) {
  return content.replace(/\r?\n/g, lineEnding)
}

if (!fs.existsSync(androidRoot) || !fs.existsSync(manifestPath)) {
  console.error('Projet Android introuvable. Lancez d’abord: pnpm android:add')
  process.exit(1)
}

const capacitorConfig = fs.readFileSync(capacitorConfigPath, 'utf8')
const appIdMatch = capacitorConfig.match(/appId\s*:\s*['"]([^'"]+)['"]/)
if (!appIdMatch) {
  console.error('Impossible de lire appId dans capacitor.config.ts')
  process.exit(1)
}

const appId = appIdMatch[1]
const packageDir = path.join(androidRoot, 'app', 'src', 'main', 'java', ...appId.split('.'))
const mainActivityKotlinPath = path.join(packageDir, 'MainActivity.kt')
const mainActivityJavaPath = path.join(packageDir, 'MainActivity.java')
const pluginJavaPath = path.join(packageDir, 'EpsonUsbPrinterPlugin.java')

fs.mkdirSync(packageDir, { recursive: true })

let projectBuildGradle = fs.readFileSync(projectBuildGradlePath, 'utf8')
const projectGradleLineEnding = projectBuildGradle.includes('\r\n') ? '\r\n' : '\n'
projectBuildGradle = projectBuildGradle.replace(
  "classpath 'com.android.tools.build:gradle:8.13.0'",
  "classpath 'com.android.tools.build:gradle:8.13.2'",
)
projectBuildGradle = projectBuildGradle.replace(
  /classpath ['"]org\.jetbrains\.kotlin:kotlin-gradle-plugin:[^'"]+['"]/,
  'classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion"',
)
if (!projectBuildGradle.includes('ext.kotlinVersion')) {
  projectBuildGradle = projectBuildGradle.replace(
    'buildscript {',
    "buildscript {\n    ext.kotlinVersion = '2.3.21'",
  )
}
if (!projectBuildGradle.includes('org.jetbrains.kotlin:kotlin-gradle-plugin')) {
  projectBuildGradle = projectBuildGradle.replace(
    /(^[ \t]*classpath ['"]com\.google\.gms:google-services:[^'"]+['"])/m,
    '$1\n        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion"',
  )
}
if (!projectBuildGradle.includes('com.google.devtools.ksp:symbol-processing-gradle-plugin')) {
  projectBuildGradle = projectBuildGradle.replace(
    /(^[ \t]*classpath "org\.jetbrains\.kotlin:kotlin-gradle-plugin:\$kotlinVersion")/m,
    `$1\n        classpath "com.google.devtools.ksp:symbol-processing-gradle-plugin:${kspVersion}"`,
  )
}
fs.writeFileSync(
  projectBuildGradlePath,
  normalizeLineEndings(projectBuildGradle, projectGradleLineEnding),
)

let appBuildGradle = fs.readFileSync(appBuildGradlePath, 'utf8')
const appGradleLineEnding = appBuildGradle.includes('\r\n') ? '\r\n' : '\n'
appBuildGradle = appBuildGradle.replace(
  /^[ \t]*kotlinOptions\s*\{\r?\n[ \t]*jvmTarget\s*=\s*['"]21['"]\r?\n[ \t]*\}\r?\n?/gm,
  '',
)
if (!appBuildGradle.includes("apply plugin: 'org.jetbrains.kotlin.android'")) {
  appBuildGradle = appBuildGradle.replace(
    "apply plugin: 'com.android.application'",
    "apply plugin: 'com.android.application'\napply plugin: 'org.jetbrains.kotlin.android'",
  )
}
if (!appBuildGradle.includes("apply plugin: 'com.google.devtools.ksp'")) {
  appBuildGradle = appBuildGradle.replace(
    "apply plugin: 'org.jetbrains.kotlin.android'",
    "apply plugin: 'org.jetbrains.kotlin.android'\napply plugin: 'com.google.devtools.ksp'",
  )
}
if (!appBuildGradle.includes('org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21')) {
  appBuildGradle = appBuildGradle.replace(
    /\nrepositories\s*\{/,
    '\n\nkotlin {\n    compilerOptions {\n        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21\n    }\n}\n\nrepositories {',
  )
}
if (!appBuildGradle.includes('room.schemaLocation')) {
  appBuildGradle = appBuildGradle.replace(
    /\nrepositories\s*\{/,
    '\n\nksp {\n    arg("room.schemaLocation", "${projectDir}/schemas")\n}\n\nrepositories {',
  )
}
if (!appBuildGradle.includes('unitTests.includeAndroidResources = true')) {
  appBuildGradle = appBuildGradle.replace(
    /(^[ \t]*buildTypes\s*\{)/m,
    '    testOptions {\n        unitTests.includeAndroidResources = true\n    }\n$1',
  )
}
const roomDependencies = [
  `    implementation "androidx.room:room-runtime:${roomVersion}"`,
  `    ksp "androidx.room:room-compiler:${roomVersion}"`,
  `    testImplementation "androidx.room:room-testing:${roomVersion}"`,
  '    testImplementation "androidx.test:core:1.7.0"',
  '    testImplementation "org.robolectric:robolectric:4.16.1"',
]
for (const dependency of roomDependencies) {
  if (!appBuildGradle.includes(dependency.trim())) {
    appBuildGradle = appBuildGradle.replace(/dependencies\s*\{/, `dependencies {\n${dependency}`)
  }
}
fs.writeFileSync(appBuildGradlePath, normalizeLineEndings(appBuildGradle, appGradleLineEnding))

for (const templateName of fs
  .readdirSync(nativeTemplatesDir)
  .filter((name) => name.endsWith('.kt'))) {
  const templatePath = path.join(nativeTemplatesDir, templateName)
  const destinationPath = path.join(packageDir, templateName)
  const template = fs.readFileSync(templatePath, 'utf8')
  fs.writeFileSync(destinationPath, template.replaceAll('__APP_PACKAGE__', appId))
}
if (fs.existsSync(nativeTestTemplatesDir)) {
  const testPackageDir = path.join(androidRoot, 'app', 'src', 'test', 'java', ...appId.split('.'))
  fs.mkdirSync(testPackageDir, { recursive: true })
  for (const templateName of fs
    .readdirSync(nativeTestTemplatesDir)
    .filter((name) => name.endsWith('.kt'))) {
    const template = fs.readFileSync(path.join(nativeTestTemplatesDir, templateName), 'utf8')
    fs.writeFileSync(
      path.join(testPackageDir, templateName),
      template.replaceAll('__APP_PACKAGE__', appId),
    )
  }
}
if (fs.existsSync(pluginJavaPath)) fs.rmSync(pluginJavaPath)

if (!fs.existsSync(mainActivityKotlinPath)) {
  if (!fs.existsSync(mainActivityJavaPath)) {
    console.error(`MainActivity introuvable dans: ${packageDir}`)
    process.exit(1)
  }

  const generatedJavaActivity = fs.readFileSync(mainActivityJavaPath, 'utf8')
  if (
    !/public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}/s.test(
      generatedJavaActivity,
    )
  ) {
    console.error(
      'MainActivity.java contient du code personnalisé. Migrez-le manuellement vers MainActivity.kt avant de relancer le script.',
    )
    process.exit(1)
  }

  fs.writeFileSync(
    mainActivityKotlinPath,
    `package ${appId}\n\nimport android.os.Bundle\nimport com.getcapacitor.BridgeActivity\n\nclass MainActivity : BridgeActivity() {\n    override fun onCreate(savedInstanceState: Bundle?) {\n        registerPlugin(EpsonUsbPrinterPlugin::class.java)\n        registerPlugin(OrderStoragePlugin::class.java)\n        super.onCreate(savedInstanceState)\n    }\n}\n`,
  )
  fs.rmSync(mainActivityJavaPath)
}

if (fs.existsSync(mainActivityJavaPath)) {
  console.error(
    'MainActivity.java et MainActivity.kt existent simultanément. Supprimez ou migrez explicitement la version Java.',
  )
  process.exit(1)
}

let mainActivity = fs.readFileSync(mainActivityKotlinPath, 'utf8')
const mainActivityLineEnding = mainActivity.includes('\r\n') ? '\r\n' : '\n'

if (/class\s+MainActivity\s*:\s*BridgeActivity\(\)\s*\{\s*\}/s.test(mainActivity)) {
  mainActivity = mainActivity.replace(
    /class\s+MainActivity\s*:\s*BridgeActivity\(\)\s*\{\s*\}/s,
    `class MainActivity : BridgeActivity() {\n    override fun onCreate(savedInstanceState: Bundle?) {\n        registerPlugin(EpsonUsbPrinterPlugin::class.java)\n        registerPlugin(OrderStoragePlugin::class.java)\n        super.onCreate(savedInstanceState)\n    }\n}`,
  )
} else if (mainActivity.includes('super.onCreate(savedInstanceState)')) {
  // Capacitor construit et charge le Bridge pendant super.onCreate().
  // Un plugin local doit donc être enregistré AVANT cet appel.
  mainActivity = mainActivity.replace(
    /^[ \t]*registerPlugin\((?:EpsonUsbPrinterPlugin|OrderStoragePlugin)::class\.java\)\r?\n/gm,
    '',
  )
  mainActivity = mainActivity.replace(
    /(^[ \t]*)super\.onCreate\(savedInstanceState\)/m,
    '$1registerPlugin(EpsonUsbPrinterPlugin::class.java)\n$1registerPlugin(OrderStoragePlugin::class.java)\n$1super.onCreate(savedInstanceState)',
  )
} else {
  console.error(
    'MainActivity.kt a une structure inattendue. Enregistrez EpsonUsbPrinterPlugin::class.java avant super.onCreate().',
  )
  process.exit(1)
}

fs.writeFileSync(mainActivityKotlinPath, normalizeLineEndings(mainActivity, mainActivityLineEnding))

let manifest = fs.readFileSync(manifestPath, 'utf8')
if (!manifest.includes('android.hardware.usb.host')) {
  manifest = manifest.replace(
    /<manifest([^>]*)>/,
    '<manifest$1>\n\n    <uses-feature android:name="android.hardware.usb.host" android:required="false" />',
  )
  fs.writeFileSync(manifestPath, manifest)
}

console.log('✓ Plugins Kotlin et persistance Room installés dans le projet Android')
console.log(`  ${packageDir}`)
console.log('✓ Gradle compile les sources Kotlin en bytecode JVM 21')
console.log(`✓ Room ${roomVersion} / KSP ${kspVersion} configurés sans migration destructive`)
console.log('✓ MainActivity Kotlin enregistre les plugins une seule fois')
console.log('✓ AndroidManifest déclare USB host')
