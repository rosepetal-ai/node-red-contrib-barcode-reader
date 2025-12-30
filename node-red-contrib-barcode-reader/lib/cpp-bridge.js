/**
 * Platform-aware loader for the native barcode addon.
 *
 * Loading order:
 * 1) Platform-specific prebuilt package
 * 2) Local build (development)
 * 3) Build from source (if build tools and system deps are present)
 * 4) Error with guidance
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

function detectPlatform() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'linux') {
    return detectMusl() ? `linuxmusl-${arch}` : `linux-${arch}`;
  }

  return `${platform}-${arch}`;
}

function detectMusl() {
  try {
    if (fs.existsSync('/etc/alpine-release')) {
      return true;
    }

    if (
      fs.existsSync('/lib/ld-musl-x86_64.so.1') ||
      fs.existsSync('/lib/ld-musl-aarch64.so.1')
    ) {
      return true;
    }

    const lddOutput = execSync('ldd --version 2>&1 || true', {
      encoding: 'utf8',
      timeout: 5000
    });
    return lddOutput.toLowerCase().includes('musl');
  } catch {
    return false;
  }
}

function tryRequire(request) {
  try {
    return require(request);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

function tryLoadFromPackage(platformId) {
  const packageNames = [
    `@rosepetal/node-red-contrib-barcode-reader-${platformId}`,
    `@rosepetal/barcode-${platformId}`
  ];

  const candidatePaths = [
    'lib/addon.node',
    'build/Release/barcode.node',
    'barcode.node'
  ];

  for (const pkg of packageNames) {
    const direct = tryRequire(pkg);
    if (direct) {
      return direct;
    }

    for (const relPath of candidatePaths) {
      const loaded = tryRequire(`${pkg}/${relPath}`);
      if (loaded) {
        return loaded;
      }
    }
  }

  return null;
}

function tryLoadFromLocalBuild() {
  const localPaths = [
    path.join(__dirname, '../../barcode-engine/build/Release/barcode.node'),
    path.join(__dirname, '../../barcode-engine/build/Release/addon.node'),
    path.join(__dirname, '../../../barcode-engine/build/Release/barcode.node'),
    path.join(__dirname, '../../../barcode-engine/build/Release/addon.node')
  ];

  for (const addonPath of localPaths) {
    if (fs.existsSync(addonPath)) {
      return require(addonPath);
    }
  }

  return null;
}

function hasSystemDeps() {
  const zbarHeader =
    fs.existsSync('/usr/include/zbar.h') ||
    fs.existsSync('/usr/local/include/zbar.h');

  const zxingHeader =
    fs.existsSync('/usr/include/ZXing/ReadBarcode.h') ||
    fs.existsSync('/usr/local/include/ZXing/ReadBarcode.h');

  const opencvHeader =
    fs.existsSync('/usr/include/opencv4/opencv2/opencv.hpp') ||
    fs.existsSync('/usr/local/include/opencv4/opencv2/opencv.hpp');

  return zbarHeader && zxingHeader && opencvHeader;
}

function canRunNodeGyp() {
  try {
    execSync('node-gyp --version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function tryBuildFromSource() {
  try {
    const enginePaths = [
      path.join(__dirname, '../../barcode-engine'),
      path.join(__dirname, '../../../barcode-engine')
    ];

    let engineDir = null;
    for (const p of enginePaths) {
      if (fs.existsSync(path.join(p, 'binding.gyp'))) {
        engineDir = p;
        break;
      }
    }

    if (!engineDir) {
      return null;
    }

    if (!hasSystemDeps() || !canRunNodeGyp()) {
      return null;
    }

    console.log('barcode-engine: Prebuilt addon not found, attempting to build from source...');
    execSync('npm run rebuild', {
      cwd: engineDir,
      stdio: 'inherit',
      timeout: 300000
    });

    const addonPath = path.join(engineDir, 'build', 'Release', 'barcode.node');
    if (fs.existsSync(addonPath)) {
      return require(addonPath);
    }

    return null;
  } catch (err) {
    console.warn('barcode: Build from source failed:', err.message);
    return null;
  }
}

function loadAddon() {
  const platformId = detectPlatform();

  let addon = tryLoadFromPackage(platformId);
  if (addon) {
    return addon;
  }

  addon = tryLoadFromLocalBuild();
  if (addon) {
    return addon;
  }

  addon = tryBuildFromSource();
  if (addon) {
    return addon;
  }

  const supportedPlatforms = [
    'linux-x64',
    'linux-arm64',
    'linuxmusl-x64'
  ];

  throw new Error(
    'Could not load the barcode native addon.\n\n' +
    `Detected platform: ${platformId}\n` +
    `Supported prebuilt platforms: ${supportedPlatforms.join(', ')}\n\n` +
    'Possible solutions:\n' +
    '1. Reinstall to fetch the prebuilt binary for your platform.\n' +
    '2. For unsupported platforms or development:\n' +
    '   - Install system deps: libzbar-dev, libzxing-dev, libopencv-dev\n' +
    '   - Install build tools: build-essential, python3, node-gyp\n' +
    '   - Run: cd barcode-engine && npm run rebuild\n'
  );
}

module.exports = loadAddon();
