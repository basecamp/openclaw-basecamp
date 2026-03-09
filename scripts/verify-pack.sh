#!/usr/bin/env bash
# Verify that openclaw.extensions targets exist in the npm pack artifact.
# Used by CI and release workflows to catch packaging mistakes before publish.
set -euo pipefail

PACKED=$(npm pack --dry-run --json 2>/dev/null)
EXT=$(node -p "require('./package.json').openclaw.extensions[0]")
EXT_PATH="${EXT#./}"

echo "$PACKED" | node -e "
  const files = JSON.parse(require('fs').readFileSync(0,'utf8'))[0].files.map(f => f.path);
  const target = '$EXT_PATH';
  if (!files.includes(target)) {
    console.error('::error::openclaw.extensions target \"' + target + '\" not found in packed artifact');
    console.error('Packed files:', files.join(', '));
    process.exit(1);
  }
  console.log('openclaw.extensions target \"' + target + '\" verified in packed artifact');
"
