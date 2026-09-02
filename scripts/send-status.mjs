#!/usr/bin/env node

/**
 * Manual CLI for posting agent status to the local bridge.
 *
 * Examples:
 *   node scripts/send-status.mjs working "Implementing authentication"
 *   node scripts/send-status.mjs --state working --message "..." --project ulise
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3210';
const ALLOWED_STATES = ['idle', 'working', 'waiting', 'completed', 'error'];

function printHelp() {
  console.log(`Usage:
  node scripts/send-status.mjs <state> [message]
  node scripts/send-status.mjs --state <state> [options]

States:
  idle, working, waiting, completed, error

Options:
  --state <state>       Status state (required unless positional)
  --message <text>      Status message
  --project <name>      Project name
  --task <name>         Task name
  --source <name>       Source label (default: manual-cli)
  --event <name>        Event name
  --conversation-id <id>
  --help                Show this help

Environment:
  BRIDGE_URL            Bridge base URL (default: ${DEFAULT_BRIDGE_URL})

npm shortcuts:
  npm run status:working -- "Building the Chrome extension"
`);
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  const options = {
    state: null,
    message: '',
    project: '',
    task: '',
    source: 'manual-cli',
    event: null,
    conversationId: null,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') {
      options.state = argv[++i];
    } else if (arg === '--message') {
      options.message = argv[++i] ?? '';
    } else if (arg === '--project') {
      options.project = argv[++i] ?? '';
    } else if (arg === '--task') {
      options.task = argv[++i] ?? '';
    } else if (arg === '--source') {
      options.source = argv[++i] ?? 'manual-cli';
    } else if (arg === '--event') {
      options.event = argv[++i] ?? null;
    } else if (arg === '--conversation-id') {
      options.conversationId = argv[++i] ?? null;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!options.state && positional.length > 0) {
    options.state = positional[0];
    if (positional[1] !== undefined && !options.message) {
      options.message = positional.slice(1).join(' ');
    }
  } else if (options.state && positional.length > 0 && !options.message) {
    options.message = positional.join(' ');
  }

  if (!options.state) {
    throw new Error('Missing state. Pass a positional state or --state.');
  }

  if (!ALLOWED_STATES.includes(options.state)) {
    throw new Error(`Invalid state "${options.state}". Allowed: ${ALLOWED_STATES.join(', ')}`);
  }

  return { help: false, options };
}

/**
 * @param {object} options
 * @param {string} bridgeUrl
 */
export async function sendStatus(options, bridgeUrl = DEFAULT_BRIDGE_URL) {
  const base = bridgeUrl.replace(/\/$/, '');
  const payload = {
    state: options.state,
    message: options.message ?? '',
    project: options.project ?? '',
    task: options.task ?? '',
    source: options.source ?? 'manual-cli',
    event: options.event,
    conversationId: options.conversationId,
  };

  let response;
  try {
    response = await fetch(`${base}/api/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Bridge unavailable at ${base} (${reason})`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Bridge returned non-JSON response (HTTP ${response.status})`);
  }

  if (!response.ok) {
    const message = data?.error?.message || `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const bridgeUrl = process.env.BRIDGE_URL || DEFAULT_BRIDGE_URL;

  try {
    const result = await sendStatus(parsed.options, bridgeUrl);
    console.log(JSON.stringify(result.status ?? result, null, 2));
    if (result.deduped) {
      console.error('(deduped: identical status within 500ms window)');
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
