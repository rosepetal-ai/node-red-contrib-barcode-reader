#!/bin/bash
set -e

echo "==================================================="
echo "  Installing rosepetal-barcode dependencies"
echo "==================================================="
echo ""

# Check if running on Linux
if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    echo "Error: This package only supports Linux"
    exit 1
fi

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "Warning: Running as root. This script will use sudo for system packages."
    SUDO=""
else
    SUDO="sudo"
fi

# Update package list
echo "Updating package lists..."
$SUDO apt-get update || {
    echo "Warning: Could not update package lists. Continuing anyway..."
}

echo ""
echo "--- Installing ZBar ---"
if dpkg -l | grep -q libzbar-dev; then
    echo "✓ ZBar already installed"
else
    echo "Installing libzbar-dev..."
    $SUDO apt-get install -y libzbar-dev || {
        echo "Error: Failed to install ZBar"
        exit 1
    }
    echo "✓ ZBar installed successfully"
fi

echo ""
echo "--- Installing ZXing ---"
if dpkg -l | grep -q libzxing-dev; then
    echo "✓ ZXing already installed"
elif [ -f "/usr/local/include/ZXing/ReadBarcode.h" ]; then
    echo "✓ ZXing already installed (from source)"
else
    # Try package manager first
    if apt-cache show libzxing-dev &> /dev/null; then
        echo "Installing libzxing-dev from repository..."
        $SUDO apt-get install -y libzxing-dev
        echo "✓ ZXing installed successfully"
    else
        echo "libzxing-dev not available in repositories"
        echo "Building ZXing from source (this may take a few minutes)..."

        # Install build dependencies
        $SUDO apt-get install -y build-essential cmake git

        ORIGINAL_DIR=$(pwd)

        # Build in temp directory
        TEMP_DIR=$(mktemp -d)
        cd "$TEMP_DIR"

        echo "Cloning ZXing repository..."
        git clone --depth 1 --branch v2.3.0 https://github.com/zxing-cpp/zxing-cpp.git || {
            echo "Error: Failed to clone ZXing repository"
            cd "$ORIGINAL_DIR"
            rm -rf "$TEMP_DIR"
            exit 1
        }

        cd zxing-cpp
        mkdir build && cd build

        echo "Configuring ZXing..."
        cmake .. -DCMAKE_BUILD_TYPE=Release -DBUILD_EXAMPLES=OFF -DBUILD_BLACKBOX_TESTS=OFF || {
            echo "Error: Failed to configure ZXing"
            cd "$ORIGINAL_DIR"
            rm -rf "$TEMP_DIR"
            exit 1
        }

        echo "Building ZXing..."
        make -j$(nproc) || {
            echo "Error: Failed to build ZXing"
            cd "$ORIGINAL_DIR"
            rm -rf "$TEMP_DIR"
            exit 1
        }

        echo "Installing ZXing..."
        $SUDO make install || {
            echo "Error: Failed to install ZXing"
            cd "$ORIGINAL_DIR"
            rm -rf "$TEMP_DIR"
            exit 1
        }

        $SUDO ldconfig

        # Return to original directory and cleanup
        cd "$ORIGINAL_DIR"
        rm -rf "$TEMP_DIR"

        echo "✓ ZXing built and installed successfully"
    fi
fi

echo ""
echo "--- Installing OpenCV ---"
if dpkg -l | grep -q libopencv-dev; then
    echo "✓ OpenCV already installed"
else
    echo "Installing libopencv-dev..."
    $SUDO apt-get install -y libopencv-dev || {
        echo "Error: Failed to install OpenCV"
        exit 1
    }
    echo "✓ OpenCV installed successfully"
fi

echo ""
echo "--- Building C++ Addon ---"
echo "Cleaning previous builds..."
node-gyp clean || echo "No previous build to clean"

# When installed from a local path, npm may hoist dependencies into the
# caller's node_modules while the package itself is a symlink. Ensure
# node-gyp can resolve node-addon-api in that case.
if [ -n "$INIT_CWD" ] && [ -d "$INIT_CWD/node_modules" ]; then
    export NODE_PATH="$INIT_CWD/node_modules${NODE_PATH:+:$NODE_PATH}"
fi

if ! node -e "require('node-addon-api')" >/dev/null 2>&1; then
    echo "Error: node-addon-api not found. Run npm install in the caller project or install from a tarball."
    exit 1
fi

echo "Configuring addon..."
node-gyp configure || {
    echo "Error: Failed to configure addon"
    exit 1
}

echo "Building addon..."
node-gyp build || {
    echo "Error: Failed to build addon"
    echo ""
    echo "Common issues:"
    echo "  - Missing ZXing headers: Check /usr/include/ZXing or /usr/local/include/ZXing"
    echo "  - Node-gyp not installed: npm install -g node-gyp"
    echo "  - Python not found: Install python3"
    exit 1
}

echo "✓ C++ addon built successfully"

echo ""
echo "==================================================="
echo "  ✓ All system dependencies installed!"
echo "==================================================="
echo ""
echo "Next steps:"
echo "  1. npm install (to get JavaScript dependencies like Quagga2)"
echo "  2. npm test (to verify all decoders work)"
echo ""
