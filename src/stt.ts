import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from 'puppeteer-core';
import * as ChromeLauncher from 'chrome-launcher';
import { program } from 'commander';
import { launchChrome, connectToChrome } from './chrome-sidekick.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  program
    .name('stt')
    .description('Speech to Text GUI')
    .version('1.0.0')
    .option('--title <title>', 'Title of the page', 'Type or dictate')
    .option('--action <label>', 'Label for the complete button', 'Send')
    .argument('[text...]', 'Initial text')
    .helpOption('-h, --help', 'Display help for command')
    .parse(process.argv);

  const options = program.opts();
  const initialText = (program.args || []).join(' ');

  const uiPath = path.resolve(__dirname, 'stt_ui.html');
  const url = `file://${uiPath}`;
  const tempDir = path.join(tmpdir(), `ai-sidekick-prompt-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  let chrome: ChromeLauncher.LaunchedChrome | undefined;
  let browser: Browser | undefined;

  try {
    const userDataDir = path.join(tempDir, 'profile');
    mkdirSync(userDataDir, { recursive: true });

    // Launch Chrome in "app" mode for a clean window
    chrome = await launchChrome({
      startingUrl: 'about:blank',
      userDataDir,
      chromeFlags: [
        `--app=${url}`,
        '--window-size=800,600',
        '--allow-file-access-from-files'
      ],
    });

    browser = await connectToChrome(chrome.port);

    const [page] = await browser.pages();
    
    page.on('console', msg => {
      // console.log('PAGE:', msg.text());
    });

    // Safety: bypass the "allow microphone" popup
    const context = browser.defaultBrowserContext();
    await context.setPermission(url, { 
      permission: { name: 'microphone' }, 
      state: 'granted' 
    } as any);

    async function cleanup() {
        if (browser) await browser.disconnect();
        if (chrome) await chrome.kill();
        try {
            rmSync(tempDir!, { recursive: true, force: true });
        } catch (e) {}
        process.exit(0);
    }

    // Provide initial data BEFORE navigation using evaluateOnNewDocument
    await page.evaluateOnNewDocument((text, title, action) => {
        (window as any).getInitialText = async () => text;
        (window as any).getInitialTitle = async () => title;
        (window as any).getInitialActionLabel = async () => action;
    }, initialText, options.title, options.action);

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

    await page.goto(url);
    await page.bringToFront();

    // Keep the process alive
    await new Promise(() => {});

  } catch (err) {
    console.error('Failed to launch prompt:', err);
    if (chrome) await chrome.kill();
    process.exit(1);
  }
}

main();
