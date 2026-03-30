import { FunctionTool, GOOGLE_SEARCH, InMemoryRunner, LlmAgent, LogLevel, PolicyOutcome, SecurityPlugin, setLogLevel, StreamingMode } from "@google/adk";
import dotenv from 'dotenv';
import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Browser, ElementHandle, Page, Target } from "puppeteer-core";
import { z } from "zod";
import { delay, isPortAvailable, launchChrome, connectToChrome } from "./chrome-sidekick.ts";

setLogLevel(LogLevel.WARN);

// Promisify exec - I can't belive I have to write this in 2026
const execPromise = promisify(exec);

process.on('SIGINT', () => {
    // Ignore SIGINT so that terminating Zsh commands with ^C doesn't kill the background agent
});

// Get the directory of the current script (src/)
const PWD = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables from root
dotenv.config({ path: path.resolve(PWD, '..', '.env'), quiet: true });

// Track commands that have been run in the current session
const sessionCommandRun = new Map<string, boolean>();
class ShellAndWriteFileSafetyPolicy {
    async evaluate(context: any) {
        if (['bash', 'write_file'].includes(context.tool.name)) {
            if (sessionCommandRun.get(context.tool.name)) {
                return { outcome: PolicyOutcome.ALLOW };
            }
            let command = JSON.stringify(context.toolArgs);
            try {
                const ttyHandle = await fs.open('/dev/tty', 'r+');
                const rlTty = readline.createInterface({
                    input: ttyHandle.createReadStream(),
                    output: ttyHandle.createWriteStream(),
                    terminal: false
                });

                const promptMsg = `\nProceed with ${context.tool.name}(${command})? (y/N/(s)ession): `;
                const answer = await rlTty.question(promptMsg);

                rlTty.close();
                await ttyHandle.close();

                if (answer.toLowerCase() === 's') {
                    sessionCommandRun.set(context.tool.name, true);
                    return { outcome: PolicyOutcome.ALLOW };
                } else if (answer.toLowerCase() === 'y') {
                    return { outcome: PolicyOutcome.ALLOW };
                }
            } catch (e: any) {
                process.stdout.write(`\n[Failed to prompt /dev/tty: ${e.message}]\n`);
            }
            return { outcome: PolicyOutcome.DENY, reason: "User cancelled the operation." };
        }
        return { outcome: PolicyOutcome.ALLOW };
    }
}

// Tools
// --- 1. BASH TOOL ---
const bash = new FunctionTool({
    name: 'bash',
    description: `Executes a command in the shell and returns the output.
    Use this tool to run shell commands.
    **MANDATORY** Before invoking any shell command, you must first use the 'cd <directory>' command to change to the 'Current directory:' value in your context.
    Note that there may be spaces in the directory path. So, use quotes around the directory path.`,
    parameters: z.object({
        command: z.string().describe("The full shell command to run.")
    }),
    execute: async ({ command }) => {
        try {
            const { stdout, stderr } = await execPromise(command);
            return { stdout, stderr };
        } catch (e: any) {
            return { error: e.message, stderr: e.stderr };
        }
    }
});

// --- 2. READ TOOL ---
const read_file = new FunctionTool({
    name: 'read_file',
    description: `Reads content from a file path.
    **MANDATORY** Before reading from any with relative path, you must resolve it relative to the 'Current directory:' value in your context.
    Note that there may be spaces in the directory path.`,
    parameters: z.object({
        path: z.string().describe("Path to the file to read.")
    }),
    execute: async ({ path }) => {
        const content = await fs.readFile(path, 'utf-8');
        return { content };
    }
});

// --- 3. WRITE TOOL ---
const write_file = new FunctionTool({
    name: 'write_file',
    description: `Writes or overwrites content to a file.
    **MANDATORY** Before writing to any file with relative path, you must resolve it relative to the 'Current directory:' value in your context.
    Note that there may be spaces in the directory path.`,
    parameters: z.object({
        path: z.string(),
        content: z.string()
    }),
    execute: async ({ path, content }) => {
        await fs.writeFile(path, content, 'utf-8');
        return { status: 'Success', path };
    }
});

// --- 4. SPEAK TOOL ---
const speak = new FunctionTool({
    name: 'speak',
    description: `Speak the given text.
    Use this tool to speak the given text.`,
    parameters: z.object({
        text: z.string().describe("The text to speak.")
    }),
    execute: async ({ text: textToSpeak }) => {
        if (textToSpeak) {
            try {
                // Use the browser-based TTS script
                // Remove leading . or trailing .. if present
                textToSpeak = textToSpeak.trim().replace(/^\./, '').replace(/\.\.$/, '');
                // Escape single quotes for shell command
                const escapedText = textToSpeak.replace(/'/g, "'\\''");
                // speak.ts is in src/speak.ts
                const speakScriptPath = path.resolve(PWD, 'speak.ts');
                const { stdout, stderr } = await execPromise(`node "${speakScriptPath}" '${escapedText}'`);
                return { stdout, stderr };
            } catch (e: any) {
                return { error: e.message, stderr: e.stderr };
            }
        }
    }
});

// Browser sidekick
const REMOTE_PORT: number = 19224;
const REMOTE_DEBUGGING_URL = `http://127.0.0.1:${REMOTE_PORT}`;

async function ensureChromeLaunched() {
    if (await isPortAvailable(REMOTE_PORT)) {
        await launchChrome({
            port: REMOTE_PORT,
            chromeFlags: [
                '--new-window',
                '--disable-blink-features=AutomationControlled',
                '--password-store=basic',
                '--use-mock-keychain',
            ]
        });
        await delay(1000);
    }
}

// Ensures that a session is available
async function ensureSession(sessionId: string) {
    await ensureChromeLaunched();

    const existingPage = await findPageForSession(sessionId);
    if (existingPage) {
        return;
    }

    await delay(1000);

    // Connect to the existing instance
    const browser: Browser = await connectToChrome(REMOTE_PORT);

    await delay(1000);

    const pages = (await browser.pages());

    // create page for session
    const page: Page = await browser.newPage();

    // Perform an action: Navigate and wait until network is idle
    await page.goto('https://gemini.google.com', { waitUntil: 'networkidle2' });
    await delay(1000);

    // close about:blank page if it exists
    for (const aPage of pages) {
        if (aPage.url() === 'about:blank') {
            await aPage.close({ runBeforeUnload: false });
            break;
        }
    }

    // Set the window.name property
    await page.evaluate((sessionId) => {
        window.name = sessionId;
    }, sessionId);

    // add code to enable the canvas tool
    try {
        const toolsToggleButton = await page.waitForSelector('toolbox-drawer button:first-of-type', { timeout: 10000 });
        if (toolsToggleButton) {
            await toolsToggleButton.click();
            await delay(1000);
            const canvasButton = await page.waitForSelector('toolbox-drawer-item:nth-of-type(2) button', { timeout: 5000 });
            if (canvasButton) {
                await canvasButton.click();
            }
        }
        await delay(2000);
    } catch (error) {
        console.error('Error enabling canvas tool:', error);
    }

}

// Finds a page for a given session
async function findPageForSession(sessionId: string): Promise<Page | undefined> {
    // Connect to the existing instance
    const browser: Browser = await connectToChrome(REMOTE_PORT);

    // 1. Get all targets
    const targets: Target[] = browser.targets();

    // 2. Filter for actual pages (tabs/windows)
    const pageTargets = targets.filter(t => t.type() === 'page');

    // 3. Find page for session concurrently
    const pages = await Promise.all(pageTargets.map(t => t.asPage()));
    const validPages = pages.filter((p): p is Page => p !== null);

    const matchingPages = await Promise.all(validPages.map(async (page) => {
        const windowName = await page.evaluate(() => window.name).catch(() => null);
        return { page, isMatch: windowName === sessionId };
    }));

    return matchingPages.find(p => p.isMatch)?.page;
}

// Types multiline text in the prompt box
async function typeMultilineTextInPromptBox(page: Page, promptBox: ElementHandle<Element>, text: string) {
    if (text) {
        await promptBox.click();
        await delay(100); // Wait for the editor to focus and initialize
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            await page.keyboard.type(line, { delay: 10 });
            if (i < lines.length - 1) {
                await page.keyboard.down('Shift');
                await page.keyboard.press('Enter');
                await page.keyboard.up('Shift');
            }
        }
    }
}

(async () => {
    const model = process.env.MODEL!;

    const rootAgent = new LlmAgent({
        name: 'sidekick',
        model: model,
        description: 'Acts as a AI sidekick to shell.',
        instruction: await fs.readFile(path.resolve(PWD, '..', 'ai_sidekick.md'), 'utf-8'),
        tools: [bash, GOOGLE_SEARCH, read_file, speak, write_file],
        generateContentConfig: {
            toolConfig: {
                includeServerSideToolInvocations: true
            }
        }
    });

    const runner = new InMemoryRunner({
        agent: rootAgent,
        appName: rootAgent.name,
        plugins: [
            new SecurityPlugin({ policyEngine: new ShellAndWriteFileSafetyPolicy() })
        ]
    });

    const userId = os.userInfo().username;
    const sessionId = `${userId}-${process.ppid}`;

    await runner.sessionService.createSession({
        appName: runner.appName,
        userId: userId,
        sessionId: sessionId
    });

    const geminiSuffix = await fs.readFile(path.resolve(PWD, '..', 'gemini_suffix.md'), 'utf-8');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
    });

    let promptLines: string[] = [];
    for await (const line of rl) {
        if (line === '__END_OF_PROMPT__') {
            const prompt = promptLines.join('\n').trim();
            promptLines = [];
            if (!prompt) continue;

            // Prepare prompt and submit to the agent
            const newMessage = {
                parts:[{
                    text: prompt
                }],
                role: 'user'
            };
            const events = runner.runAsync({
                userId,
                sessionId,
                newMessage,
                runConfig: {
                    streamingMode: StreamingMode.SSE
                }
            });

            // Accumulate response
            let fullResponse = "";
            for await (const event of events) {
                if (event.errorMessage) {
                    process.stdout.write(`\n[API Error: ${event.errorMessage}]\n`);
                }
                if (event.content && event.content.parts) {
                    if (event.partial) {
                        const chunk = event.content.parts.map(p => p.text || '').join('');
                        process.stdout.write(chunk);
                        fullResponse += chunk;
                    }
                }
            }

            // extract gemini prompt
            const match = fullResponse.match(/```gemini\s+([\s\S]*?)```/);
            if (match && match[1]) {
                const geminiPrompt = match[1].trim();
                if (geminiPrompt) {
                    await ensureSession(sessionId);
                    const page = await findPageForSession(sessionId);
                    if (page) {
                        const promptBox = await page.$('rich-textarea');
                        if (promptBox) {
                            await typeMultilineTextInPromptBox(page,
                                promptBox,
                                `${geminiPrompt}\n\n${geminiSuffix}`);
                            await delay(1000);
                            await page.keyboard.up('Enter');
                            await page.keyboard.press('Enter');
                        }
                    }
                }
                process.stdout.write(`\nThis has been sent to the browser sidekick.\n`);
            }
            process.stdout.write(`\n__AI_EOF__\n`);
        } else {
            promptLines.push(line);
        }
    }
})();
