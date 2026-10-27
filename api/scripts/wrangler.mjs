// Runs wrangler with the real D1 database ID filled in, so the ID never lives in the repo.
// The ID comes from the D1_DATABASE_ID env var (CI) or the git-ignored api/.d1-id file (local).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const id = process.env.D1_DATABASE_ID?.trim() || (existsSync('.d1-id') ? readFileSync('.d1-id', 'utf8').trim() : '');
if (!/^[0-9a-f-]{36}$/i.test(id)) {
  console.error('Missing D1 database ID: set D1_DATABASE_ID or put it in api/.d1-id');
  process.exit(1);
}

writeFileSync('.wrangler.deploy.toml', readFileSync('wrangler.toml', 'utf8').replace('__D1_DATABASE_ID__', id));
const res = spawnSync('npx', ['wrangler', ...process.argv.slice(2), '--config', '.wrangler.deploy.toml'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(res.status ?? 1);
