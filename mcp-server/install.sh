#!/bin/bash
# Web2MD Native Messaging Host Installer
# Usage: ./install.sh <chrome-extension-id>

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.web2md.agent"
INSTALL_DIR="$HOME/.web2md"

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Usage: ./install.sh <chrome-extension-id>"
  echo ""
  echo "To find your extension ID:"
  echo "  1. Open chrome://extensions"
  echo "  2. Enable Developer Mode"
  echo "  3. Find Web2MD and copy the ID"
  exit 1
fi

# Resolve absolute path to node (Chrome launches with minimal PATH)
NODE_BIN="$(which node)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH"
  exit 1
fi

# Detect OS
if [ "$(uname)" = "Darwin" ]; then
  TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
fi

mkdir -p "$TARGET_DIR"
mkdir -p "$INSTALL_DIR"

# Copy host files to ~/.web2md/ (outside ~/Desktop to avoid macOS TCC restrictions)
# native-host.js is self-contained (tsup inlines native-messaging), so we
# only copy the one bundled file.
cp "$SCRIPT_DIR/dist/native-host.js" "$INSTALL_DIR/"

# Create the runner script with absolute node path
RUNNER="$INSTALL_DIR/web2md-agent-host.sh"
cat > "$RUNNER" << RUNNER_EOF
#!/bin/bash
exec "$NODE_BIN" "$INSTALL_DIR/native-host.js"
RUNNER_EOF
chmod +x "$RUNNER"

# Write manifest
cat > "$TARGET_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "Web2MD Agent Bridge",
  "path": "$RUNNER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo "✓ Native messaging host installed"
echo "  Manifest: $TARGET_DIR/$HOST_NAME.json"
echo "  Host:     $INSTALL_DIR/"
echo "  Node:     $NODE_BIN"
echo "  Extension ID: $EXT_ID"
echo ""
echo "Restart Chrome (Cmd+Q then reopen) for the changes to take effect."
