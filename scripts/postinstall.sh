#!/bin/bash
# Postinstall script to patch kuromoji's package.json
# Removes the "browser" field that causes Vercel's bundler to use the browser loader
KUROMOJI_PKG="node_modules/kuromoji/package.json"
if [ -f "$KUROMOJI_PKG" ]; then
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$KUROMOJI_PKG', 'utf8'));
    if (pkg.browser) {
      delete pkg.browser;
      fs.writeFileSync('$KUROMOJI_PKG', JSON.stringify(pkg, null, 2) + '\n');
      console.log('Removed browser field from kuromoji package.json');
    }
  "
fi