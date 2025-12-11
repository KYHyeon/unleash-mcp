import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

// Opt-in flag so this spawn test only runs when explicitly requested.
const runSpawnTest = process.env.RUN_MCP_SPAWN_TEST === '1';

const envForSpawn = {
  ...process.env,
  UNLEASH_BASE_URL: process.env.UNLEASH_BASE_URL ?? 'https://example.com',
  UNLEASH_PAT: process.env.UNLEASH_PAT ?? 'dummy',
  UNLEASH_DEFAULT_PROJECT: process.env.UNLEASH_DEFAULT_PROJECT ?? 'proj',
};

describe('MCP stdio spawn', () => {
  it.runIf(runSpawnTest)('keeps the process alive and responds to tools/list', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/index.js', '--dry-run', '--log-level', 'info'],
      env: envForSpawn,
      stderr: 'pipe',
    });

    const client = new Client({ name: 'spawn-test', version: '0.0.0' });

    // If the server writes anything suspicious to stderr, surface it for debugging.
    transport.stderr?.on('data', (data) => {
      // eslint-disable-next-line no-console
      console.error('[server stderr]', data.toString());
    });

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('create_flag');

    await client.close();
  }, 10_000);
});
