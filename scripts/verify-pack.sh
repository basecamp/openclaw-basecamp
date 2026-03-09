#!/usr/bin/env bash
# Verify that all openclaw.extensions targets exist in the npm pack artifact.
# Used by CI and release workflows to catch packaging mistakes before publish.
set -euo pipefail

PACKED=$(npm pack --dry-run --json)

echo "$PACKED" | node -e "
  const pkg = require('./package.json');
  const files = JSON.parse(require('fs').readFileSync(0,'utf8'))[0].files.map(f => f.path);
  const extensions = pkg.openclaw?.extensions ?? [];
  const normalize = p => p.startsWith('./') ? p.slice(2) : p;
  const missing = [];

  for (const ext of extensions) {
    const target = normalize(ext);
    if (files.includes(target)) {
      console.log('openclaw.extensions target \"' + target + '\" verified in packed artifact');
    } else {
      missing.push(target);
    }
  }

  if (missing.length > 0) {
    console.error('::error::openclaw.extensions target(s) not found in packed artifact: ' + missing.join(', '));
    console.error('Packed files:', files.join(', '));
    process.exit(1);
  }
"
