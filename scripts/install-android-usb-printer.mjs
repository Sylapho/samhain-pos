import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const androidRoot = path.join(root, 'android')
const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml')
const capacitorConfigPath = path.join(root, 'capacitor.config.ts')
const pluginTemplatePath = path.join(root, 'native', 'android', 'EpsonUsbPrinterPlugin.java')

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
const mainActivityPath = path.join(packageDir, 'MainActivity.java')
const pluginPath = path.join(packageDir, 'EpsonUsbPrinterPlugin.java')

fs.mkdirSync(packageDir, { recursive: true })

const pluginTemplate = fs.readFileSync(pluginTemplatePath, 'utf8')
fs.writeFileSync(pluginPath, pluginTemplate.replaceAll('__APP_PACKAGE__', appId))

if (!fs.existsSync(mainActivityPath)) {
  console.error(`MainActivity.java introuvable: ${mainActivityPath}`)
  process.exit(1)
}

let mainActivity = fs.readFileSync(mainActivityPath, 'utf8')

if (!mainActivity.includes('import android.os.Bundle;')) {
  mainActivity = mainActivity.replace(/(package\s+[^;]+;\s*)/, '$1\nimport android.os.Bundle;\n')
}

if (/public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}/s.test(mainActivity)) {
  mainActivity = mainActivity.replace(
    /public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}/s,
    `public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(EpsonUsbPrinterPlugin.class);\n        super.onCreate(savedInstanceState);\n    }\n}`,
  )
} else if (mainActivity.includes('super.onCreate(savedInstanceState);')) {
  // Capacitor construit et charge le Bridge pendant super.onCreate().
  // Un plugin local doit donc être enregistré AVANT cet appel.
  mainActivity = mainActivity.replace(/\s*registerPlugin\(EpsonUsbPrinterPlugin\.class\);/g, '')
  mainActivity = mainActivity.replace(
    /(^[ \t]*)super\.onCreate\(savedInstanceState\);/m,
    '$1registerPlugin(EpsonUsbPrinterPlugin.class);\n$1super.onCreate(savedInstanceState);',
  )
} else {
  console.error('MainActivity.java a une structure inattendue. Enregistrez EpsonUsbPrinterPlugin.class avant super.onCreate().')
  process.exit(1)
}

fs.writeFileSync(mainActivityPath, mainActivity)

let manifest = fs.readFileSync(manifestPath, 'utf8')
if (!manifest.includes('android.hardware.usb.host')) {
  manifest = manifest.replace(
    /<manifest([^>]*)>/,
    '<manifest$1>\n\n    <uses-feature android:name="android.hardware.usb.host" android:required="false" />',
  )
  fs.writeFileSync(manifestPath, manifest)
}

console.log('✓ Plugin EpsonUsbPrinter installé dans le projet Android')
console.log(`  ${pluginPath}`)
console.log('✓ MainActivity enregistre le plugin')
console.log('✓ AndroidManifest déclare USB host')
