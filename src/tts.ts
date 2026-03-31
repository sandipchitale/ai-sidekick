import { mkdirSync, rmSync } from 'node:fs';
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
    .name('tts')
    .description('Text to Speech GUI')
    .version('1.0.0')
    .option('--title <title>', 'Title of the page', 'Speak')
    .option('--action <label>', 'Label for the action button', 'Stop & Exit')
    .argument('[text...]', 'Text to speak')
    .helpOption('-h, --help', 'Display help for command')
    .parse(process.argv);

  const options = program.opts();
  let textToSpeak = (program.args || []).join(' ');

  // if (!process.stdin.isTTY) {
  //   const chunks: Buffer[] = [];
  //   for await (const chunk of process.stdin) {
  //     chunks.push(chunk as Buffer);
  //   }
  //   const stdinText = Buffer.concat(chunks).toString('utf-8');
  //   if (stdinText) {
  //     textToSpeak = textToSpeak ? `${textToSpeak}\n${stdinText}` : stdinText;
  //   }
  // }

  const uiPath = path.resolve(__dirname, 'tts_ui.html');
  const url = `file://${uiPath}`;
  const tempDir = path.join(tmpdir(), `ai-sidekick-speak-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  let chrome: ChromeLauncher.LaunchedChrome | undefined;
  let browser: Browser | undefined;

  try {
    const userDataDir = path.join(tempDir, 'profile');
    mkdirSync(userDataDir, { recursive: true });

    chrome = await launchChrome({
      startingUrl: 'about:blank',
      userDataDir,
      chromeFlags: [
        `--app=${url}`,
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
        // console.log('PAGE:', msg.text());
    });

    async function cleanup() {
        if (browser) await browser.close(); // Graceful Puppeteer close
        if (chrome) await chrome.kill();
        try {
            rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
        process.exit(0);
    }

    await page.exposeFunction('onClose', () => {
      cleanup();
    });

    // Provide initial data BEFORE navigation using evaluateOnNewDocument
    // This ensures data is available even if the page loads very fast
    await page.evaluateOnNewDocument((initialText, initialTitle, initialAction) => {
        (window as any).getInitialText = async () => initialText;
        (window as any).getInitialTitle = async () => initialTitle;
        (window as any).getInitialActionLabel = async () => initialAction;
    }, textToSpeak, options.title, options.action);

    page.on('close', () => {
        cleanup();
    });

    // Navigate to the UI
    await page.goto(url);
    await page.bringToFront();

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
