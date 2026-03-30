import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from 'puppeteer-core';
import * as ChromeLauncher from 'chrome-launcher';
import { launchChrome, connectToChrome } from './chrome-sidekick.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const defaultText = process.argv[2] || '';
  const uiPath = path.resolve(__dirname, 'prompt_ui.html');
  const url = `file://${uiPath}#${encodeURIComponent(defaultText)}`;

  let chrome: ChromeLauncher.LaunchedChrome | undefined;
  let browser: Browser | undefined;
  let tempDir: string | undefined;

  try {
    // Unique profile = No "Restore Pages" warning
    tempDir = path.join(tmpdir(), `ai-sidekick-prompt-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const userDataDir = path.join(tempDir, 'profile');
    mkdirSync(userDataDir, { recursive: true });

    // Launch Chrome in "app" mode for a clean window
    chrome = await launchChrome({
      startingUrl: url,
      userDataDir,
      chromeFlags: [
        `--app=${url}`,
        '--window-size=800,600',
      ],
    });

    browser = await connectToChrome(chrome.port);

    const [page] = await browser.pages();
    
    page.on('console', msg => {
      console.log('PAGE:', msg.text());
    });

    // Safety: bypass the "allow microphone" popup
    const context = browser.defaultBrowserContext();
    await context.setPermission(url.split('#')[0], { 
      permission: { name: 'microphone' }, 
      state: 'granted' 
    } as any);

    // Expose functions to the browser
    await page.exposeFunction('onComplete', (text: string) => {
      process.stdout.write(text + '\n');
      cleanup();
    });

    await page.exposeFunction('onCancel', () => {
      cleanup();
    });

    // Close on window close
    page.on('close', () => {
        cleanup();
    });

    async function cleanup() {
        if (browser) await browser.disconnect();
        if (chrome) await chrome.kill();
        try {
            if (tempDir) rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
        process.exit(0);
    }

    // Keep the process alive
    await new Promise(() => {});

  } catch (err) {
    console.error('Failed to launch prompt:', err);
    if (chrome) await chrome.kill();
    process.exit(1);
  }
}

main();
