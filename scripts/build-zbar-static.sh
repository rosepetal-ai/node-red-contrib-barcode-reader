#!/usr/bin/env bash
set -euo pipefail

ZBAR_REF="${ZBAR_REF:-0.23.93}"
ZBAR_BRANCH="${ZBAR_BRANCH:-master}"
ZBAR_REPO="${ZBAR_REPO:-https://github.com/mchehab/zbar.git}"
ZBAR_FALLBACK_REPO="${ZBAR_FALLBACK_REPO:-https://github.com/ZBar/ZBar.git}"
BUILD_DIR="${BUILD_DIR:-${1:-/tmp/zbar-build}}"
INSTALL_DIR="${INSTALL_DIR:-${2:-$HOME/zbar-static}}"

JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1)}"

echo "Building ZBar (static)"
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

clone_with_ref() {
  local repo="$1"
  local ref="$2"

  rm -rf zbar-src
  if [[ "${ref}" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    git clone --depth 1 --branch "${ZBAR_BRANCH}" "${repo}" zbar-src
    if ! git -C zbar-src rev-parse --verify "${ref}^{commit}" >/dev/null 2>&1; then
      git -C zbar-src fetch --depth 1 origin "${ref}"
    fi
    git -C zbar-src checkout --detach "${ref}"
  else
    git clone --depth 1 --branch "${ref}" "${repo}" zbar-src
  fi
}

clone_with_fallbacks() {
  local repo="$1"
  shift
  local refs=("$@")

  for ref in "${refs[@]}"; do
    if [ -n "${ref}" ]; then
      echo "Trying ${repo} @ ${ref}"
      if clone_with_ref "${repo}" "${ref}"; then
        return 0
      fi
    fi
  done

  echo "Falling back to default ZBar branch..."
  rm -rf zbar-src
  git clone --depth 1 "${repo}" zbar-src
}

if [ ! -d "zbar-src" ]; then
  refs=("${ZBAR_REF}")
  if [[ ! "${ZBAR_REF}" =~ ^[0-9a-fA-F]{7,40}$ && "${ZBAR_REF}" != v* ]]; then
    refs+=("v${ZBAR_REF}")
  fi
  refs+=("0.23.93" "v0.23.93")

  if ! clone_with_fallbacks "${ZBAR_REPO}" "${refs[@]}"; then
    clone_with_fallbacks "${ZBAR_FALLBACK_REPO}" "${refs[@]}"
  fi
fi

cd zbar-src

if [ ! -f configure ]; then
  if [ -f configure.ac ]; then
    if ! awk '
      /^[[:space:]]*(dnl|#)/ { next }
      /AM_PROG_AR/ { found=1; exit }
      END { exit found ? 0 : 1 }
    ' configure.ac; then
      if grep -Eq "^[[:space:]]*AM_PROG_LIBTOOL" configure.ac; then
        sed -i '/^[[:space:]]*AM_PROG_LIBTOOL/a AM_PROG_AR' configure.ac
      elif grep -Eq "^[[:space:]]*LT_INIT" configure.ac; then
        sed -i '/^[[:space:]]*LT_INIT/a AM_PROG_AR' configure.ac
      else
        sed -i '1a AM_PROG_AR' configure.ac
      fi
    fi
    sed -i 's/-Werror//g' configure.ac
  fi

  AUTOMAKE="automake --warnings=none" autopoint --force || true
  AUTOMAKE="automake --warnings=none" autoreconf -i -f
fi

echo "Configuring ZBar..."
CFLAGS="-O3 -fPIC" CXXFLAGS="-O3 -fPIC" ./configure \
  --prefix="${INSTALL_DIR}" \
  --enable-static \
  --disable-shared \
  --without-gtk \
  --without-qt \
  --without-python \
  --without-x \
  --without-imagemagick \
  --disable-video

echo "Building ZBar..."
make -j"${JOBS}"

echo "Installing ZBar..."
make install

echo "=========================================="
echo "ZBar built successfully!"
echo ""
echo "Static libraries installed to: ${INSTALL_DIR}"
