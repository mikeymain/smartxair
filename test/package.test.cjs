const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { userPathFilter } = require('electron-packager/src/copy-filter');
const { scripts } = require('../package.json');

test('packaging excludes private development folders and keeps runtime files', async () => {
  const dir = path.join(__dirname, '..');
  const ignore = scripts.package.match(/--ignore="([^"]+)"/)[1];
  const filter = userPathFilter({ dir, out: path.join(dir, 'dist'), ignore });
  for (const file of ['.claude/worktrees/app/main.cjs', '.finish-pass/baseline.md', 'snapshots/crosshair.png', 'docs/crosshair.png']) {
    assert.equal(await filter(path.join(dir, file)), false, file);
  }
  for (const file of ['main.cjs', 'preload.cjs', 'engine/settings.cjs', 'renderer/app.js', 'assets/smartxair.png']) {
    assert.equal(await filter(path.join(dir, file)), true, file);
  }
});
