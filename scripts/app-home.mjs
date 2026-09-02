import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'cursor-agent-traffic-light';
export const APP_HOME = join(homedir(), `.${APP_NAME}`);
export const APP_DIR = join(APP_HOME, 'app');
export const RUNTIME_DIR = join(APP_HOME, 'runtime');
export const STATE_PATH = join(APP_HOME, 'install.json');
export const LOG_DIR = join(APP_HOME, 'logs');

/** Pinned private runtime. System Node >=18 may be used instead (policy A). */
export const PRIVATE_NODE_VERSION = '22.18.0';
export const MIN_SYSTEM_NODE_MAJOR = 18;

/** Placeholder until the extension is published on the Chrome Web Store. */
export const CHROME_EXTENSION_URL =
  process.env.TRAFFIC_LIGHT_EXTENSION_URL ||
  'https://chromewebstore.google.com/detail/cursor-agent-traffic-light';
