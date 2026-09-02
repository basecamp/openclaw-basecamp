#!/usr/bin/env bash
# Verify that the npm pack artifact ships everything the OpenClaw host needs:
# the plugin manifest, the runtime entry (openclaw.extensions), and the setup
# entry (openclaw.setupEntry). Used by CI and release workflows to catch
# packaging mistakes before publish.
set -euo pipefail

PACKED=$(npm pack --dry-run --json)

echo "$PACKED" | node -e "
  const pkg = require('./package.json');
  const files = JSON.parse(require('fs').readFileSync(0,'utf8'))[0].files.map(f => f.path);
  const normalize = p => p.startsWith('./') ? p.slice(2) : p;

  const required = [
    'openclaw.plugin.json',
    ...(pkg.openclaw?.extensions ?? []).map(normalize),
    ...(pkg.openclaw?.setupEntry ? [normalize(pkg.openclaw.setupEntry)] : []),
    'dist/index.js',
    'dist/setup-entry.js',
  ];

  const missing = [];
  for (const target of [...new Set(required)]) {
    if (files.includes(target)) {
      console.log('pack target \"' + target + '\" verified in packed artifact');
    } else {
      missing.push(target);
    }
  }

  if (missing.length > 0) {
    console.error('::error::pack target(s) not found in packed artifact: ' + missing.join(', '));
    console.error('Packed files:', files.join(', '));
    process.exit(1);
  }
"
