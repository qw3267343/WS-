const { spawnSync } = require('node:child_process');

if (!process.env.WWEBJS_TEST_REMOTE_ID) {
  console.log('Skipping tests: WWEBJS_TEST_REMOTE_ID is not set');
  process.exit(0);
}

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['mocha', 'tests', '--recursive', '--timeout', '5000'],
  { stdio: 'inherit', shell: false }
);

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
