"""Prepare deterministic gzip bodies for versioned Object Storage assets; never uploads."""
from pathlib import Path
import argparse
import concurrent.futures
import gzip
import hashlib
import json

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = root / 'public'
target = args.out.resolve()
if target == source or source in target.parents:
    parser.error('--out must be outside public/')
if target.exists() and any(target.iterdir()):
    parser.error('--out must be empty; use a new version directory')
files = sorted(p for name in ['scenes', 'environments'] for p in (source / name).rglob('*') if p.is_file())
if not files:
    parser.error('No exported assets under public/')
target.mkdir(parents=True, exist_ok=True)

def prepare(path):
    raw = path.read_bytes()
    relative = path.relative_to(source)
    output = target / relative
    output.parent.mkdir(parents=True, exist_ok=True)
    packed = gzip.compress(raw, compresslevel=6, mtime=0)
    output.write_bytes(packed)
    return {'path': relative.as_posix(), 'bytes': len(raw), 'transferBytes': len(packed),
            'sha256': hashlib.sha256(raw).hexdigest()}

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    records = list(pool.map(prepare, files))
manifest = {'version': json.loads((root / 'package.json').read_text())['version'], 'files': records,
            'bytes': sum(r['bytes'] for r in records), 'transferBytes': sum(r['transferBytes'] for r in records)}
(target / 'assets-manifest.json').write_bytes(gzip.compress(json.dumps(manifest).encode(), compresslevel=6, mtime=0))
print(json.dumps({k: v for k, v in manifest.items() if k != 'files'}))
print(f'{len(records)} assets prepared. Upload with Content-Encoding: gzip; original filenames are intentional.')
