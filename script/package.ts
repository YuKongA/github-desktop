/* eslint-disable no-sync */

import * as cp from 'child_process'
import * as path from 'path'
import * as electronInstaller from 'electron-winstaller'
import { getProductName, getCompanyName } from '../app/package-info'
import {
  getDistPath,
  getOSXZipPath,
  getWindowsIdentifierName,
  getWindowsStandaloneName,
  getWindowsInstallerName,
  shouldMakeDelta,
  getUpdatesURL,
  isPublishable,
  getBundleSizes,
  getDistRoot,
  getDistArchitecture,
  getIconDirectory,
  getLinuxDebPath,
  getLinuxDebianArchitecture,
} from './dist-info'
import { isGitHubActions } from './build-platforms'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { getVersion } from '../app/package-info'
import { computeBundleHashSync } from '../app/src/lib/compute-bundle-hash'
import { rename } from 'fs/promises'
import { join } from 'path'
import { assertNonNullable } from '../app/src/lib/fatal-error'

const distPath = getDistPath()
const productName = getProductName()
const outputDir = getDistRoot()

const assertExistsSync = (path: string) => {
  if (!existsSync(path)) {
    throw new Error(`Expected ${path} to exist`)
  }
}

if (process.platform === 'darwin') {
  packageOSX()
} else if (process.platform === 'win32') {
  packageWindows()
} else if (process.platform === 'linux') {
  packageLinux()
} else {
  console.error(`I don't know how to package for ${process.platform} :(`)
  process.exit(1)
}

console.log('Writing bundle size info…')
writeFileSync(
  path.join(getDistRoot(), 'bundle-size.json'),
  JSON.stringify(getBundleSizes())
)

console.log('Writing bundle hash…')
writeFileSync(
  path.join(getDistRoot(), 'bundle-hash.json'),
  JSON.stringify({
    bundleHash: computeBundleHashSync(path.join(__dirname, '..', 'out')),
  })
)

function packageOSX() {
  const dest = getOSXZipPath()
  rmSync(dest, { recursive: true, force: true })

  console.log('Packaging for macOS…')
  cp.execSync(
    `ditto -ck --keepParent "${distPath}/${productName}.app" "${dest}"`
  )
}

function packageWindows() {
  const iconSource = join(getIconDirectory(), 'icon-logo.ico')

  if (!existsSync(iconSource)) {
    console.error(`expected setup icon not found at location: ${iconSource}`)
    process.exit(1)
  }

  const splashScreenPath = path.resolve(
    __dirname,
    '../app/static/logos/win32-installer-splash.gif'
  )

  if (!existsSync(splashScreenPath)) {
    console.error(
      `expected setup splash screen gif not found at location: ${splashScreenPath}`
    )
    process.exit(1)
  }

  const iconUrl = 'https://desktop.githubusercontent.com/app-icon.ico'

  const nugetPkgName = getWindowsIdentifierName()
  const options: electronInstaller.Options = {
    name: nugetPkgName,
    appDirectory: distPath,
    outputDirectory: outputDir,
    authors: getCompanyName(),
    iconUrl: iconUrl,
    setupIcon: iconSource,
    loadingGif: splashScreenPath,
    exe: `${nugetPkgName}.exe`,
    title: productName,
    setupExe: getWindowsStandaloneName(),
    setupMsi: getWindowsInstallerName(),
  }

  if (shouldMakeDelta()) {
    const url = new URL(getUpdatesURL())
    // Make sure Squirrel.Windows isn't affected by partially or completely
    // disabled releases.
    url.searchParams.set('bypassStaggeredRelease', '1')
    options.remoteReleases = url.toString()
  }

  if (isGitHubActions() && isPublishable()) {
    assertNonNullable(process.env.RUNNER_TEMP, 'Missing RUNNER_TEMP env var')

    const acsPath = join(process.env.RUNNER_TEMP, 'acs')
    const dlibPath = join(acsPath, 'bin', 'x64', 'Azure.CodeSigning.Dlib.dll')

    assertExistsSync(dlibPath)

    const metadataPath = join(acsPath, 'metadata.json')
    const acsMetadata = {
      Endpoint: 'https://wus3.codesigning.azure.net/',
      CodeSigningAccountName: 'GitHubInc',
      CertificateProfileName: 'GitHubInc',
      CorrelationId: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    }
    writeFileSync(metadataPath, JSON.stringify(acsMetadata))

    options.signWithParams = `/v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 /dlib "${dlibPath}" /dmdf "${metadataPath}"`
  }

  console.log('Packaging for Windows…')
  electronInstaller
    .createWindowsInstaller(options)
    .then(() => console.log(`Installers created in ${outputDir}`))
    .then(async () => {
      // electron-winstaller (more specifically Squirrel.Windows) doesn't let
      // us control the name of the nuget packages but we want them to include
      // the architecture similar to how the setup exe and msi do so we'll just
      // have to rename them here after the fact.
      const arch = getDistArchitecture()
      const prefix = `${getWindowsIdentifierName()}-${getVersion()}`

      for (const kind of shouldMakeDelta() ? ['full', 'delta'] : ['full']) {
        const from = join(outputDir, `${prefix}-${kind}.nupkg`)
        const to = join(outputDir, `${prefix}-${arch}-${kind}.nupkg`)

        console.log(`Renaming ${from} to ${to}`)
        await rename(from, to)
      }
    })
    .catch(e => {
      console.error(`Error packaging: ${e}`)
      process.exit(1)
    })
}

function packageLinux() {
  const stagingDir = join(outputDir, `.github-desktop-deb-${process.pid}`)
  const debPath = getLinuxDebPath()
  const applicationDir = join(stagingDir, 'usr', 'lib', 'github-desktop')
  const binaryDir = join(stagingDir, 'usr', 'bin')
  const desktopEntryDir = join(stagingDir, 'usr', 'share', 'applications')
  const iconDir = join(
    stagingDir,
    'usr',
    'share',
    'icons',
    'hicolor',
    '512x512',
    'apps'
  )
  const controlDir = join(stagingDir, 'DEBIAN')

  rmSync(stagingDir, { recursive: true, force: true })
  rmSync(debPath, { force: true })

  try {
    mkdirSync(applicationDir, { recursive: true })
    mkdirSync(binaryDir, { recursive: true })
    mkdirSync(desktopEntryDir, { recursive: true })
    mkdirSync(iconDir, { recursive: true })
    mkdirSync(controlDir, { recursive: true })

    cpSync(distPath, applicationDir, {
      recursive: true,
      verbatimSymlinks: true,
    })
    writeFileSync(
      join(binaryDir, 'github-desktop'),
      `#!/bin/sh\n` +
        `set -eu\n` +
        `desktop_environment="${'${XDG_CURRENT_DESKTOP:-}'}:${'${DESKTOP_SESSION:-}'}:${'${KDE_FULL_SESSION:-}'}"\n` +
        `case "$desktop_environment" in\n` +
        `  *KDE*|*kde*|*Plasma*|*plasma*|*:true)\n` +
        `    case ":${'${GTK_MODULES:-}'}:" in\n` +
        `      *:appmenu-gtk-module:*) ;;\n` +
        `      ::) GTK_MODULES=appmenu-gtk-module ;;\n` +
        `      *) GTK_MODULES="${'${GTK_MODULES}'}:appmenu-gtk-module" ;;\n` +
        `    esac\n` +
        `    export GTK_MODULES\n` +
        `    export UBUNTU_MENUPROXY="${'${UBUNTU_MENUPROXY:-1}'}"\n` +
        `    set -- --ozone-platform=x11 "$@"\n` +
        `    ;;\n` +
        `esac\n` +
        `exec "$(dirname "$0")/../lib/github-desktop/desktop" "$@"\n`,
      { mode: 0o755 }
    )
    cpSync(
      join(__dirname, '../app/static/linux/icon-logo.png'),
      join(iconDir, 'github-desktop.png')
    )

    writeFileSync(
      join(desktopEntryDir, 'github-desktop.desktop'),
      `[Desktop Entry]\n` +
        `Name=GitHub Desktop\n` +
        `Comment=Simple collaboration from your desktop\n` +
        `Exec=github-desktop %U\n` +
        `Icon=github-desktop\n` +
        `Terminal=false\n` +
        `Type=Application\n` +
        `Categories=Development;RevisionControl;\n` +
        `MimeType=x-scheme-handler/x-github-client;x-scheme-handler/x-github-desktop-auth;\n` +
        `StartupWMClass=GitHub Desktop\n`
    )

    writeFileSync(
      join(controlDir, 'control'),
      `Package: github-desktop\n` +
        `Version: ${getDebianVersion(getVersion())}\n` +
        `Section: devel\n` +
        `Priority: optional\n` +
        `Architecture: ${getLinuxDebianArchitecture()}\n` +
        `Depends: appmenu-gtk3-module, ca-certificates, libasound2 | libasound2t64, libc6, libdrm2, libgbm1, libgtk-3-0 | libgtk-3-0t64, libnspr4, libnss3, libsecret-1-0, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libxss1, libxtst6, xdg-utils\n` +
        `Maintainer: GitHub, Inc. <opensource+desktop@github.com>\n` +
        `Description: Simple collaboration from your desktop\n` +
        ` GitHub Desktop is a desktop client for GitHub.\n`
    )

    normalizePackagePermissions(stagingDir)

    console.log('Packaging for Linux (.deb)…')
    cp.execFileSync(
      'dpkg-deb',
      ['--build', '--root-owner-group', stagingDir, debPath],
      { stdio: 'inherit' }
    )
    console.log(`Debian package created at ${debPath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'Unable to create the Linux package because dpkg-deb was not found. Install the dpkg package and try again.'
      )
    }
    throw error
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

function normalizePackagePermissions(directory: string) {
  chmodSync(directory, 0o755)

  for (const entry of readdirSync(directory)) {
    const entryPath = join(directory, entry)
    const stats = lstatSync(entryPath)

    if (stats.isSymbolicLink()) {
      continue
    }

    if (stats.isDirectory()) {
      normalizePackagePermissions(entryPath)
    } else if (stats.isFile()) {
      chmodSync(entryPath, stats.mode & 0o111 ? 0o755 : 0o644)
    }
  }
}

function getDebianVersion(version: string) {
  const [release, prerelease] = version.split('-', 2)
  return prerelease === undefined
    ? release
    : `${release}~${prerelease.replaceAll('-', '.')}`
}
