#!/usr/bin/env bash
set -euo pipefail

ZXING_VERSION="${ZXING_VERSION:-2.3.0}"
BUILD_DIR="${BUILD_DIR:-${1:-/tmp/zxing-build}}"
INSTALL_DIR="${INSTALL_DIR:-${2:-$HOME/zxing-static}}"

JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1)}"

echo "Building ZXing-cpp ${ZXING_VERSION} (static)"
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

if [ ! -d "zxing-cpp" ]; then
  git clone --depth 1 --branch "v${ZXING_VERSION}" https://github.com/zxing-cpp/zxing-cpp.git
fi

echo "Configuring ZXing..."
cmake -S zxing-cpp -B zxing-cpp/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="${INSTALL_DIR}" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DZXING_BUILD_EXAMPLES=OFF \
  -DZXING_BUILD_BLACKBOX_TESTS=OFF \
  -DZXING_BUILD_UNIT_TESTS=OFF

echo "Building ZXing..."
cmake --build zxing-cpp/build --config Release --parallel "${JOBS}"

echo "Installing ZXing..."
cmake --install zxing-cpp/build --config Release

if [ ! -f "${INSTALL_DIR}/lib/libZXing.a" ] && [ -f "${INSTALL_DIR}/lib/libZXingCore.a" ]; then
  ln -s "libZXingCore.a" "${INSTALL_DIR}/lib/libZXing.a"
fi

echo "=========================================="
echo "ZXing-cpp ${ZXING_VERSION} built successfully!"
echo ""
echo "Static libraries installed to: ${INSTALL_DIR}"
