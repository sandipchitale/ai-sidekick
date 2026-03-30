import * as ChromeLauncher from 'chrome-launcher';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, Browser } from 'puppeteer-core';

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export function getChromeUserDataDir(dirOrSubdir?: string): string {
  const dir = dirOrSubdir 
    ? (path.isAbsolute(dirOrSubdir) ? dirOrSubdir : path.join(tmpdir(), dirOrSubdir))
    : path.join(tmpdir(), 'ai-sidekick-user-data-dir');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface LaunchOptions {
  port?: number;
  startingUrl?: string;
  userDataDir?: string;
  chromeFlags?: string[];
}

export async function launchChrome(options: LaunchOptions = {}) {
  const userDataDir = getChromeUserDataDir(options.userDataDir);
  const {
    port,
    startingUrl = 'about:blank',
    chromeFlags = []
  } = options;

  const defaultFlags = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
  ];

  const mergedFlags = [...new Set([...defaultFlags, ...chromeFlags])];
  if (port) {
      mergedFlags.push(`--remote-debugging-port=${port}`);
  }

  return await ChromeLauncher.launch({
    port,
    startingUrl,
    userDataDir,
    ignoreDefaultFlags: true,
    chromeFlags: mergedFlags,
  });
}

export async function connectToChrome(port: number): Promise<Browser> {
  return await connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null
  });
}
