import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('firmware jitter buffer streams, pauses/resumes, keeps live samples and cancels safely', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tts-firmware-'));
  const run = promisify(execFile);
  try {
    const binary = join(temp, 'pcm-player');
    await run(process.env.CXX ?? 'c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror',
      '-I', fileURLToPath(new URL('../../firmware/include', import.meta.url)),
      fileURLToPath(new URL('../../firmware/test/pcm-player.cpp', import.meta.url)), '-o', binary]);
    const { stdout } = await run(binary);
    expect(stdout).toContain('timeout passed');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
