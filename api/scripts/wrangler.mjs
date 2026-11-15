// Runs wrangler with the real D1 database ID filled in, so the ID never lives in the repo.
// The ID comes from the D1_DATABASE_ID env var (CI) or the git-ignored api/.d1-id file (local).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const id = process.env.D1_DATABASE_ID?.trim() || (existsSync('.d1-id') ? readFileSync('.d1-id', 'utf8').trim() : '');
if (!/^[0-9a-f-]{36}$/i.test(id)) {
  console.error('Missing D1 database ID: set D1_DATABASE_ID or put it in api/.d1-id');
  process.exit(1);
}

writeFileSync('.wrangler.deploy.toml', readFileSync('wrangler.toml', 'utf8').replace('__D1_DATABASE_ID__', id));
// Wrangler's own script, run with this Node and no shell, so arguments with spaces (`--command "SELECT …"`) arrive
// whole. Going through npx needs a shell on Windows, which splits them.
const pkg = createRequire(import.meta.url).resolve('wrangler/package.json');
const bin = join(dirname(pkg), JSON.parse(readFileSync(pkg, 'utf8')).bin.wrangler);
const res = spawnSync(process.execPath, [bin, ...process.argv.slice(2), '--config', '.wrangler.deploy.toml'], {
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
