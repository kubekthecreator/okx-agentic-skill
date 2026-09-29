// Guard: the Docker image copies an explicit list of modules
// (deploy/Dockerfile). A root-level module missing from that list only
// shows up on the VPS, as a crash-restart loop. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

test('deploy/Dockerfile copies every root-level module', () => {
  const dockerfile = fs.readFileSync('deploy/Dockerfile', 'utf-8');
  const copyLine = dockerfile.split('\n').find(l => l.startsWith('COPY') && l.includes('bot.js'));
  assert.ok(copyLine, 'COPY line with bot.js not found');
  const modules = fs.readdirSync('.').filter(f => f.endsWith('.js'));
  for (const m of modules) {
    assert.ok(copyLine.split(/\s+/).includes(m), `${m} missing from the deploy/Dockerfile COPY line`);
  }
});
