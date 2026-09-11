/**
 * Deploy the Worker, telling it which container image it is being deployed
 * with (11 Sep 2026).
 *
 * WHY THIS EXISTS. Container instances keep serving the old image until they
 * are cycled, so every container deploy used to end with a human POSTing to
 * /internal/board/cycle with the dashboard key. The Worker cycles the fleet
 * itself now (autoCycleIfNewImage in src/worker.js), but to know that the
 * image changed it has to be told the tag — and a tag copied by hand into
 * [vars] is a tag that drifts. So it is read off the `image =` line here, at
 * deploy time: one source of truth, no second place to remember.
 *
 *   npm run deploy            # same as npx wrangler deploy, plus the tag
 *   npm run deploy -- --dry-run
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toml = readFileSync(join(backend, 'wrangler.toml'), 'utf8');

// image = "registry.cloudflare.com/<account>/listinglab-pipeline:<tag>"
const line = toml.match(/^\s*image\s*=\s*"([^"]+)"/m);
if (!line) {
  console.error('deploy: no image = "..." line in wrangler.toml — is this the right directory?');
  process.exit(1);
}
const tag = line[1].split(':').pop();
if (!tag || tag.includes('/')) {
  console.error(`deploy: could not read a tag out of ${line[1]}`);
  process.exit(1);
}

console.log(`deploy: container image tag ${tag} — the fleet will cycle itself within a minute if this is new`);
const args = ['wrangler', 'deploy', '--var', `CONTAINER_TAG:${tag}`, ...process.argv.slice(2)];
const run = spawnSync('npx', args, { cwd: backend, stdio: 'inherit' });
process.exit(run.status ?? 1);
