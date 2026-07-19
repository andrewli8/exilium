#!/usr/bin/env node
// Launcher: runs the TypeScript CLI via tsx so `exilium <cmd>` works after
// `npm install` (npx exilium ...) or `npm link`.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const tsx = require.resolve('tsx');

const child = spawn(process.execPath, ['--import', tsx, join(root, 'src', 'cli.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
