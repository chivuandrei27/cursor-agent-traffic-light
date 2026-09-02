#!/usr/bin/env node

/**
 * Local MCP server exposing report_cursor_status for Cursor Desktop.
 * Uses stdio transport. Diagnostic logs go to stderr only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { reportCursorStatus } from './status-client.mjs';

const server = new McpServer({
  name: 'cursor-agent-traffic-light',
  version: '0.1.0',
});

const validationSchema = z
  .object({
    lint: z.enum(['passed', 'failed', 'not-run']).optional(),
    tests: z.enum(['passed', 'failed', 'not-run']).optional(),
    build: z.enum(['passed', 'failed', 'not-run']).optional(),
  })
  .optional();

server.tool(
  'report_cursor_status',
  'Report Cursor agent traffic-light status to the local bridge',
  {
    state: z.enum(['working', 'waiting', 'completed', 'error', 'idle']),
    message: z.string().max(500).describe('Short description'),
    project: z.string().max(200).optional(),
    task: z.string().max(300).optional(),
    validation: validationSchema,
  },
  async (args) => {
    const result = await reportCursorStatus(args);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
      structuredContent: result,
      isError: !result.ok && result.bridgeReachable === null ? true : false,
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] cursor-agent-traffic-light listening on stdio');
}

main().catch((error) => {
  console.error('[mcp] fatal', error instanceof Error ? error.message : error);
  process.exit(1);
});
