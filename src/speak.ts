import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from 'puppeteer-core';
import * as ChromeLauncher from 'chrome-launcher';
import { launchChrome, connectToChrome } from './chrome-sidekick.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const textToSpeak = process.argv.slice(2).join(' ') || '';
  const uiPath = path.resolve(__dirname, 'speak_ui.html');
  
  // Create a temporary HTML file to avoid long Data URL issues
  const tempDir = path.join(tmpdir(), `ai-sidekick-speak-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  
  const tempHtmlPath = path.join(tempDir, 'index.html');
  let html = readFileSync(uiPath, 'utf-8');
  // Inject text
  html = html.replace('let text = "";', `let text = ${JSON.stringify(textToSpeak)};`);
  writeFileSync(tempHtmlPath, html);

  let chrome: ChromeLauncher.LaunchedChrome | undefined;
  let browser: Browser | undefined;

  try {
    // Unique profile = No "Restore Pages" warning
    const userDataDir = path.join(tempDir, 'profile');
    mkdirSync(userDataDir, { recursive: true });

    chrome = await launchChrome({
      startingUrl: `file://${tempHtmlPath}`,
      userDataDir,
      chromeFlags: [
        `--app=file://${tempHtmlPath}`,
        '--window-size=800,600',
        '--autoplay-policy=no-user-gesture-required',
        '--force-device-scale-factor=1',
        '--disable-session-crashed-bubble',
        '--allow-file-access-from-files'
      ],
    });

    browser = await connectToChrome(chrome.port);

    const [page] = await browser.pages();
    
    page.on('console', msg => {
        console.log('PAGE:', msg.text());
    });

    await page.exposeFunction('onClose', () => {
      cleanup();
    });

    page.on('close', () => {
        cleanup();
    });

    await page.bringToFront();

    async function cleanup() {
        if (browser) await browser.close(); // Graceful Puppeteer close
        if (chrome) await chrome.kill();
        try {
            rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
        process.exit(0);
    }

    await new Promise(() => {});

  } catch (err) {
    console.error('Failed to launch speaker:', err);
    if (chrome) await chrome.kill();
    try {
        rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
    process.exit(1);
  }
}

main();
