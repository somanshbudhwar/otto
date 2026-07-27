const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * Applies an ad-hoc code signature to the packaged .app.
 *
 * Otto ships without a Developer ID certificate. Electron's prebuilt binary
 * arrives ad-hoc signed, but electron-builder invalidates that signature when
 * it renames the executable and injects app.asar — and macOS on Apple Silicon
 * refuses to launch a bundle whose signature is *broken* (a different failure
 * from being merely unsigned, and one `xattr -cr` cannot clear).
 *
 * Signing with `-` re-establishes a valid ad-hoc signature, which satisfies the
 * loader without a certificate. This is not notarisation: first launch still
 * needs right-click -> Open to clear Gatekeeper quarantine.
 */
exports.default = async function adHocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)

  // --deep is the right tool for a blanket re-sign of every nested helper and
  // framework; Apple deprecates it for real signing, not for ad-hoc.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })

  console.log(`  • ad-hoc signed ${appName} (${context.arch === 1 ? 'x64' : 'arm64'})`)
}
