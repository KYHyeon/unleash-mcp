import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createLogger, type ServerContext } from '../src/context.js';
import {
  FEATURE_FLAG_RESOURCE_URI,
  FEATURE_FLAGS_RESOURCE_TEMPLATE,
  PROJECTS_RESOURCE_TEMPLATE,
  parseFeatureFlagsResourceOptions,
  parseProjectsResourceOptions,
  readFeatureFlagResource,
  readFeatureFlagsResource,
  readProjectsResource,
} from '../src/resources/unleashResources.js';
import { cleanupFlagTool } from '../src/tools/cleanupFlag.js';
import { createFlagTool } from '../src/tools/createFlag.js';
import { detectFlagTool } from '../src/tools/detectFlag.js';
import { evaluateChangeTool } from '../src/tools/evaluateChange.js';
import { getFlagStateTool } from '../src/tools/getFlagState.js';
import { removeFlagStrategyTool } from '../src/tools/removeFlagStrategy.js';
import { setFlagRolloutTool } from '../src/tools/setFlagRollout.js';
import { toggleFlagEnvironmentTool } from '../src/tools/toggleFlagEnvironment.js';
import type { ToolType } from '../src/tools/types.js';
import { wrapChangeTool } from '../src/tools/wrapChange.js';
import { UnleashClient } from '../src/unleash/client.js';
import { VERSION } from '../src/version.js';
import { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';

/**
 * Tiny in-memory transport that mirrors stdio framing so we can connect a client and server
 * without spawning a separate process.
 */
class MemoryTransport {
  private readBuffer = new ReadBuffer();

  constructor(
    private readable: PassThrough,
    private writable: PassThrough,
  ) {}

  onmessage?: (message: unknown) => void;
  onerror?: (error: unknown) => void;
  onclose?: () => void;

  async start(): Promise<void> {
    this.readable.on('data', (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      this.processReadBuffer();
    });
    this.readable.on('end', () => this.onclose?.());
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          break;
        }
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error);
      }
    }
  }

  async close(): Promise<void> {
    this.readable.removeAllListeners();
    this.readBuffer.clear();
    this.onclose?.();
  }

  async send(message: unknown): Promise<void> {
    const json = serializeMessage(message as any);
    if (!this.writable.write(json)) {
      await new Promise<void>((resolve) => this.writable.once('drain', resolve));
    }
  }
}

function buildServer(): { server: McpServer; context: ServerContext } {
  // Use a fixed, non-networking config so tests do not depend on env vars or live Unleash.
  const config = {
    unleash: {
      baseUrl: 'https://example.com',
      pat: 'dummy',
      defaultProject: 'proj',
      defaultEnvironment: 'dev',
    },
    server: {
      dryRun: true,
      logLevel: 'info' as const,
    },
  };
  const logger = createLogger(config.server.logLevel);
  const unleashClient = new UnleashClient(
    config.unleash.baseUrl,
    config.unleash.pat,
    config.server.dryRun,
  );

  const server = new McpServer(
    {
      name: 'unleash-mcp',
      version: VERSION,
      title:
        'Local development assistant. After making a code change follow this workflow: evaluate_change → create_flag → wrap_change to score risk and steer next steps.',
    },
    {
      capabilities: {
        tools: {},
        logging: {},
        resources: {},
      },
      instructions: 'test-only',
    },
  );

  const context: ServerContext = {
    server,
    config,
    unleashClient,
    logger,
  };

  const tools: ToolType[] = [
    createFlagTool,
    evaluateChangeTool,
    detectFlagTool,
    wrapChangeTool,
    cleanupFlagTool,
    setFlagRolloutTool,
    getFlagStateTool,
    toggleFlagEnvironmentTool,
    removeFlagStrategyTool,
  ];

  tools.forEach((tool) => {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema as AnySchema,
      },
      (args: unknown, extra: any) =>
        tool.implementation(context, args, extra?._meta?.progressToken),
    );
  });

  // Minimal resource registration (matches index.ts) to ensure MCP listResources works if exercised.
  const projectsTemplate = new ResourceTemplate(PROJECTS_RESOURCE_TEMPLATE, { list: undefined });
  server.registerResource(
    'unleash-projects-filtered',
    projectsTemplate,
    {
      mimeType: 'application/json',
      description: 'Unleash projects with optional query parameters.',
    },
    async (uri) => ({
      contents: [await readProjectsResource(context, parseProjectsResourceOptions(uri.toString()))],
    }),
  );

  const featureFlagsTemplate = new ResourceTemplate(FEATURE_FLAGS_RESOURCE_TEMPLATE, {
    list: undefined,
  });
  server.registerResource(
    'unleash-feature-flags-by-project',
    featureFlagsTemplate,
    {
      mimeType: 'application/json',
      description: 'Feature flags for a specific Unleash project.',
    },
    async (uri, variables: any) => {
      const projectId = variables.projectId;
      return {
        contents: [
          await readFeatureFlagsResource(
            context,
            projectId,
            parseFeatureFlagsResourceOptions(uri.toString()),
          ),
        ],
      };
    },
  );

  const featureFlagTemplate = new ResourceTemplate(FEATURE_FLAG_RESOURCE_URI, { list: undefined });
  server.registerResource(
    'unleash-feature-flag',
    featureFlagTemplate,
    {
      mimeType: 'application/json',
      description: 'Single feature flag resource.',
    },
    async (_uri, variables: any) => {
      const { projectId, flagName } = variables;
      return {
        contents: [await readFeatureFlagResource(context, projectId, flagName)],
      };
    },
  );

  return { server, context };
}

describe('MCP startup', () => {
  it('does not write to stdout during startup (keeps protocol channel clean)', async () => {
    // Provide a fake stdout to capture any accidental writes
    const fakeStdin = new PassThrough();
    const fakeStdout = new PassThrough();
    const observed: Buffer[] = [];
    fakeStdout.on('data', (chunk) => observed.push(Buffer.from(chunk)));

    const { server } = buildServer();
    const transport = new StdioServerTransport(fakeStdin, fakeStdout);

    await server.connect(transport);

    // Give the event loop a tick to flush any eager writes
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(Buffer.concat(observed).length).toBe(0);

    await server.close();
  });

  it('responds to tools/list over a JSON-RPC transport', async () => {
    // Wire an in-memory client/server pair using stdio framing
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();

    const serverTransport = new MemoryTransport(clientToServer, serverToClient);
    const clientTransport = new MemoryTransport(serverToClient, clientToServer);

    const { server } = buildServer();
    await server.connect(serverTransport as any);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport as any);

    const tools = await client.listTools();

    expect(tools.tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.tools.map((t) => t.name)).toContain('create_flag');

    await client.close();
    await server.close();
  });
});
