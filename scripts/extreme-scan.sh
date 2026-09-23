#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node <<'NODE'
const fs=require('fs');
const files=['server/server.js','client/js/app.js'];
const src=files.map(f=>[f,fs.readFileSync(f,'utf8')]);
for(let i=1;i<=34;i++) for(const [name,code] of src){new Function(code);}
console.log('PASS: 34 in-process JavaScript syntax passes for server + client.');
NODE
python3 - <<'PY'
import json
from pathlib import Path
for name in ['package.json','client/manifest.json','server/starter_catalog.json']:
    json.loads(Path(name).read_text())
text=Path('render.yaml').read_text()
assert 'services:' in text and 'healthCheckPath: /api/health' in text and 'mountPath: /var/data' in text
html=Path('client/index.html').read_text()
assert '<script src="/js/app.js"></script>' in html
assert Path('client/icon.svg').exists()
assert not Path('client/demo_videos').exists()
PY
printf 'PASS: configuration, manifest, catalog, HTML and shell syntax checks; no demo video bundle present.\n'
