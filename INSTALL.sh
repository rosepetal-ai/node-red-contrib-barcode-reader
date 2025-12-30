#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

        ORIGINAL_DIR="$SCRIPT_DIR"

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
cd "$SCRIPT_DIR/barcode-engine"
if npm install; then
    echo "✓ C++ addon built successfully"
else
    echo "Error: Failed to build addon"
    echo ""
    echo "Common issues:"
    echo "  - Missing ZXing headers: Check /usr/include/ZXing or /usr/local/include/ZXing"
    echo "  - Node-gyp not installed: npm install -g node-gyp"
    echo "  - Python not found: Install python3"
    exit 1
fi

echo ""
echo "--- Installing Node-RED package (local) ---"
cd "$SCRIPT_DIR/node-red-contrib-barcode-reader"
if npm install; then
    echo "✓ Node-RED package installed successfully"
else
    echo "Error: Failed to install the Node-RED package"
    exit 1
fi

echo ""
echo "==================================================="
echo "  ✓ All system dependencies installed!"
echo "==================================================="

# Optional: install into Node-RED
NODE_RED_DIR="$HOME/.node-red"
if [ -d "$NODE_RED_DIR" ]; then
    echo ""
    echo "--- Optional: install into your Node-RED instance ---"
    read -p "Do you want to install this package into '$NODE_RED_DIR'? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        (cd "$NODE_RED_DIR" && npm install "$SCRIPT_DIR/node-red-contrib-barcode-reader")
        echo "✓ Installed in Node-RED. Restart Node-RED to load the new node."
    else
        echo "Skipping Node-RED installation."
        echo "You can install later with:"
        echo "  cd ~/.node-red && npm install $SCRIPT_DIR/node-red-contrib-barcode-reader"
    fi
fi
