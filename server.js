const express = require('express');
const http = require('http');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const activeTasks = new Map();
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const now = () => new Date().toLocaleTimeString();

function addLog(task, message) {
    if (!task) return;
    task.logs.push(`[${now()}] ${message}`);
    // A task can run for days. Keep the dashboard responsive and memory bounded.
    if (task.logs.length > 500) task.logs.splice(0, task.logs.length - 500);
}

function parseCookies(cookieStr) {
    return String(cookieStr || '')
        .split(';')
        .map((pair) => {
            const separator = pair.indexOf('=');
            if (separator <= 0) return null;

            const name = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            if (!name || !value) return null;

            return {
                name,
                value,
                domain: '.messenger.com',
                path: '/',
                httpOnly: false,
                secure: true,
                sameSite: 'Lax'
            };
        })
        .filter(Boolean);
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

// ---------------- DASHBOARD UI ----------------
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="hi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Messenger Playwright Auto Tool</title>
    <style>
        body { font-family: Segoe UI, Tahoma, sans-serif; background:#0f0f12; color:#e1e1e6; padding:20px; margin:0; }
        .container { max-width:650px; margin:0 auto; background:#18181b; padding:25px; border-radius:12px; border:1px solid #27272a; box-shadow:0 10px 25px rgba(0,0,0,.5); }
        h2 { text-align:center; color:#0084ff; margin-bottom:20px; }
        label { font-weight:600; margin-top:15px; display:block; color:#a1a1aa; font-size:14px; }
        input, textarea { width:100%; padding:10px; margin-top:6px; border-radius:6px; border:1px solid #3f3f46; background:#27272a; color:#fff; box-sizing:border-box; }
        textarea { height:90px; }
        .btn-start { background:#0084ff; color:#fff; width:100%; margin-top:20px; padding:12px; border:0; border-radius:6px; font-weight:bold; cursor:pointer; font-size:16px; }
        .btn-stop { background:#ef4444; color:#fff; padding:10px; border:0; border-radius:6px; font-weight:bold; cursor:pointer; }
        .stop-box { margin-top:25px; padding-top:15px; border-top:1px solid #27272a; display:flex; gap:10px; }
        #logBox { margin-top:20px; background:#09090b; padding:12px; height:220px; overflow-y:auto; border-radius:6px; font-family:monospace; font-size:12px; border:1px solid #27272a; color:#22c55e; white-space:pre-wrap; }
        .task-badge { background:#27272a; color:#0084ff; padding:4px 8px; border-radius:4px; font-weight:bold; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Messenger Auto Tool</h2>
        <form id="botForm">
            <label>Messenger.com Cookie String:</label>
            <textarea id="cookies" placeholder="c_user=...; xs=...; datr=..." required></textarea>

            <label>Target UID / Thread ID:</label>
            <input type="text" id="threadId" placeholder="e.g. 1000XXXXXXXXX or Group ID" required>

            <label>E2EE 6-Digit PIN (Optional):</label>
            <input type="password" id="e2eePin" placeholder="e.g. 123456">

            <label>Message Prefix (Optional):</label>
            <input type="text" id="prefix" placeholder="e.g. [DevilX]">

            <label>Messages (.txt File):</label>
            <input type="file" id="msgFile" accept=".txt" required>

            <label>Delay (In Seconds):</label>
            <input type="number" id="delay" value="5" min="1" step="1" required>

            <button type="button" class="btn-start" onclick="startTask()">START TASK</button>
        </form>

        <div class="stop-box">
            <input type="text" id="stopTaskId" placeholder="Enter Task ID">
            <button type="button" class="btn-stop" onclick="stopTask()">STOP TASK</button>
        </div>

        <label>Active Task Log (<span id="currentTaskId">No Task Running</span>):</label>
        <div id="logBox">Waiting for input...</div>
    </div>

    <script>
        let activeTaskId = null;
        let pollInterval = null;

        function renderLogs(logs) {
            const logBox = document.getElementById('logBox');
            logBox.textContent = '';
            for (const line of logs || []) {
                const row = document.createElement('div');
                row.textContent = line;
                logBox.appendChild(row);
            }
            logBox.scrollTop = logBox.scrollHeight;
        }

        async function startTask() {
            const cookies = document.getElementById('cookies').value.trim();
            const threadId = document.getElementById('threadId').value.trim();
            const e2eePin = document.getElementById('e2eePin').value.trim();
            const prefix = document.getElementById('prefix').value;
            const delay = Number(document.getElementById('delay').value);
            const fileInput = document.getElementById('msgFile');

            if (!cookies || !threadId || !fileInput.files.length) {
                alert('Cookies, UID aur Message file fill karein!');
                return;
            }
            if (!Number.isFinite(delay) || delay < 1) {
                alert('Delay kam se kam 1 second hona chahiye.');
                return;
            }

            const text = await fileInput.files[0].text();
            const messages = text.split(/\\r?\\n/).map((m) => m.trim()).filter(Boolean);
            if (!messages.length) {
                alert('Message file khali hai!');
                return;
            }

            renderLogs(['Task initializing...']);
            const response = await fetch('/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies, threadId, e2eePin, prefix, messages, delay })
            });
            const data = await response.json();

            if (!data.success) {
                alert(data.message || 'Task start nahi ho payi.');
                return;
            }

            activeTaskId = data.taskId;
            const taskLabel = document.getElementById('currentTaskId');
            taskLabel.textContent = activeTaskId;
            taskLabel.className = 'task-badge';
            document.getElementById('stopTaskId').value = activeTaskId;
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(fetchLogs, 1500);
            fetchLogs();
        }

        async function fetchLogs() {
            if (!activeTaskId) return;
            try {
                const response = await fetch('/api/logs/' + encodeURIComponent(activeTaskId));
                const data = await response.json();
                renderLogs(data.logs);
            } catch (error) {
                // A temporary polling failure must not stop the browser task.
            }
        }

        async function stopTask() {
            const taskId = document.getElementById('stopTaskId').value.trim();
            if (!taskId) {
                alert('Task ID daalein!');
                return;
            }

            const response = await fetch('/api/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId })
            });
            const data = await response.json();
            const logBox = document.getElementById('logBox');
            const row = document.createElement('div');
            row.textContent = data.message;
            logBox.appendChild(row);
            logBox.scrollTop = logBox.scrollHeight;

            if (taskId === activeTaskId && pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        }
    </script>
</body>
</html>
    `);
});

// ---------------- PLAYWRIGHT HELPERS ----------------

const editableSelectors = [
    'div[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"][aria-label*="message" i]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    '[contenteditable="true"]'
];

const fallbackInputSelectors = [
    'textarea[aria-label*="message" i]',
    'input[aria-label*="message" i]',
    'div[role="textbox"]'
];

const sendButtonSelectors = [
    'button[aria-label="Send"]',
    '[role="button"][aria-label="Send"]',
    'div[aria-label="Send"]',
    'button[data-testid*="send" i]',
    '[role="button"][data-testid*="send" i]',
    'button[title="Send"]',
    '[role="button"][title="Send"]',
    '[role="button"]:has-text("Send")'
];

async function findVisibleEditable(page) {
    // Do not keep one selector forever. Messenger can replace the composer
    // after each send, and it also renders hidden textboxes for other views.
    for (const selector of editableSelectors) {
        const candidates = page.locator(selector);
        const count = await candidates.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
            const candidate = candidates.nth(i);
            if (await candidate.isVisible().catch(() => false)) {
                return candidate;
            }
        }
    }

    for (const selector of fallbackInputSelectors) {
        const candidates = page.locator(selector);
        const count = await candidates.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
            const candidate = candidates.nth(i);
            if (
                (await candidate.isVisible().catch(() => false)) &&
                (await candidate.isEditable().catch(() => true))
            ) {
                return candidate;
            }
        }
    }
    return null;
}

async function findVisibleSendButton(page) {
    for (const selector of sendButtonSelectors) {
        const candidates = page.locator(selector);
        const count = await candidates.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
            const candidate = candidates.nth(i);
            if (
                (await candidate.isVisible().catch(() => false)) &&
                (await candidate.isEnabled().catch(() => true))
            ) {
                return candidate;
            }
        }
    }
    return null;
}

async function enterPinIfNeeded(page, pin, task) {
    if (!pin) return;

    const pinSelectors = [
        'input[type="password"]',
        'input[aria-label*="PIN" i]',
        'input[placeholder*="PIN" i]',
        'input[inputmode="numeric"]'
    ];

    for (const selector of pinSelectors) {
        const candidates = page.locator(selector);
        const count = await candidates.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
            const input = candidates.nth(i);
            if (!(await input.isVisible().catch(() => false))) continue;

            addLog(task, 'E2EE PIN prompt detected. Entering PIN...');
            await input.fill(String(pin));

            const button = await findVisibleButton(page, [
                'button[type="submit"]',
                '[role="button"]:has-text("Continue")',
                '[role="button"]:has-text("Submit")',
                'button:has-text("Continue")',
                'button:has-text("Submit")'
            ]);

            if (button) {
                await button.click({ timeout: 3000 }).catch(() => input.press('Enter'));
            } else {
                await input.press('Enter');
            }
            await page.waitForTimeout(1500);
            addLog(task, 'PIN submitted. Waiting for chat...');
            return;
        }
    }
}

async function findVisibleButton(page, selectors) {
    for (const selector of selectors) {
        const candidates = page.locator(selector);
        const count = await candidates.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
            const candidate = candidates.nth(i);
            if (
                (await candidate.isVisible().catch(() => false)) &&
                (await candidate.isEnabled().catch(() => true))
            ) {
                return candidate;
            }
        }
    }
    return null;
}

async function sendMessage(page, payload, task) {
    const input = await findVisibleEditable(page);
    if (!input) {
        throw new Error('Visible editable chat input not found.');
    }

    await input.click({ timeout: 3000 });
    // insertText works for contenteditable and avoids slow key-by-key typing.
    await page.keyboard.insertText(payload);
    await page.waitForTimeout(100);

    const sendButton = await findVisibleSendButton(page);
    if (sendButton) {
        // Prefer the actual Send control when Messenger exposes it.
        await sendButton.click({ timeout: 3000 });
    } else {
        // Some Messenger layouts have no visible button; Enter is the fallback.
        await page.keyboard.press('Enter');
    }

    // If the first action did not consume the composer, retry once with the
    // other action. This handles UI transitions and delayed button rendering.
    await page.waitForTimeout(250);
    const currentInput = await findVisibleEditable(page);
    if (currentInput) {
        const currentText = (await currentInput.textContent().catch(() => '')) || '';
        if (currentText.trim()) {
            const retryButton = await findVisibleSendButton(page);
            if (retryButton) {
                await retryButton.click({ timeout: 3000 }).catch(() => page.keyboard.press('Enter'));
            } else {
                await page.keyboard.press('Enter');
            }
        }
    }

    addLog(task, `Message Sent: "${payload}"`);
}

// ---------------- BACKEND ----------------

app.post('/api/start', (req, res) => {
    const { cookies, threadId, e2eePin, prefix, messages, delay } = req.body || {};

    if (
        typeof cookies !== 'string' ||
        !cookies.trim() ||
        typeof threadId !== 'string' ||
        !threadId.trim() ||
        !Array.isArray(messages) ||
        !messages.length
    ) {
        return res.status(400).json({ success: false, message: 'Cookies, thread ID aur messages required hain.' });
    }

    const safeDelay = Number(delay);
    if (!Number.isFinite(safeDelay) || safeDelay < 1) {
        return res.status(400).json({ success: false, message: 'Delay kam se kam 1 second hona chahiye.' });
    }

    let taskId;
    do {
        taskId = 'TASK-' + Math.floor(100000 + Math.random() * 900000);
    } while (activeTasks.has(taskId));

    const task = {
        taskId,
        isRunning: true,
        logs: [`[${now()}] Task initialized. ID: ${taskId}`],
        browser: null,
        context: null
    };
    activeTasks.set(taskId, task);

    // Start in the background so the dashboard gets the task ID immediately.
    runPlaywrightBot(
        taskId,
        cookies,
        threadId.trim(),
        e2eePin,
        typeof prefix === 'string' ? prefix : '',
        messages.map((message) => String(message)).filter(Boolean),
        safeDelay
    );

    return res.json({ success: true, taskId });
});

async function runPlaywrightBot(taskId, cookiesStr, threadId, e2eePin, prefix, messages, delay) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    try {
        addLog(task, 'Launching browser engine...');
        const browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });
        task.browser = browser;

        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });
        task.context = context;

        const parsedCookies = parseCookies(cookiesStr);
        if (!parsedCookies.length) throw new Error('Cookie string parse nahi hui.');
        await context.addCookies(parsedCookies);

        const page = await context.newPage();
        page.setDefaultTimeout(5000);

        addLog(task, `Navigating to target thread: ${threadId}`);
        await page.goto(`https://www.messenger.com/t/${encodeURIComponent(threadId)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });
        await page.waitForTimeout(1000);

        await enterPinIfNeeded(page, e2eePin, task);

        let input = null;
        for (let attempt = 1; attempt <= 12 && task.isRunning; attempt += 1) {
            input = await findVisibleEditable(page);
            if (input) break;
            if (attempt === 1) addLog(task, 'Waiting for visible chat composer...');
            await page.waitForTimeout(500);
        }
        if (!input) {
            const screenshotPath = `/tmp/${taskId}-input-error.png`;
            await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
            throw new Error(`Visible chat input not found. Debug screenshot: ${screenshotPath}`);
        }

        addLog(task, 'Chat composer connected. Nonstop loop started.');
        let index = 0;

        while (task.isRunning) {
            const rawMessage = messages[index];
            const payload = (prefix ? prefix + ' ' : '') + rawMessage;

            try {
                await sendMessage(page, payload, task);
            } catch (error) {
                addLog(task, `Send failed: ${error.message}`);

                // Recover from a replaced composer instead of killing the task.
                await page.waitForTimeout(500);
                const recoveredInput = await findVisibleEditable(page);
                if (recoveredInput && task.isRunning) {
                    try {
                        await recoveredInput.click({ timeout: 3000 });
                        await page.keyboard.insertText(payload);
                        await page.keyboard.press('Enter');
                        addLog(task, 'Message sent using recovery fallback.');
                    } catch (recoveryError) {
                        addLog(task, `Recovery failed: ${recoveryError.message}`);
                    }
                }
            }

            index = (index + 1) % messages.length;
            // Stop remains responsive during the delay.
            const endAt = Date.now() + delay * 1000;
            while (task.isRunning && Date.now() < endAt) {
                await sleep(Math.min(0.25, Math.max(0.01, (endAt - Date.now()) / 1000)));
            }
        }

        addLog(task, 'Task loop ended.');
    } catch (error) {
        if (task.isRunning) addLog(task, `FATAL ERROR: ${error.message}`);
    } finally {
        task.isRunning = false;
        if (task.browser) await task.browser.close().catch(() => {});
        addLog(task, 'Browser closed.');
    }
}

app.get('/api/screenshot/:taskId', (req, res) => {
    const candidates = [
        `/tmp/${req.params.taskId}-input-error.png`,
        `/tmp/${req.params.taskId}-after-pin.png`
    ];
    const filePath = candidates.find((candidate) => fs.existsSync(candidate));
    if (filePath) return res.sendFile(filePath);
    return res.status(404).send('Screenshot not found.');
});

app.get('/api/logs/:taskId', (req, res) => {
    const task = activeTasks.get(req.params.taskId);
    if (!task) return res.json({ logs: ['Task not found or expired.'] });
    return res.json({ logs: task.logs, isRunning: task.isRunning });
});

app.post('/api/stop', async (req, res) => {
    const { taskId } = req.body || {};
    const task = activeTasks.get(taskId);
    if (!task) return res.status(404).json({ message: 'Invalid Task ID!' });

    task.isRunning = false;
    addLog(task, 'Stop signal received. Closing task...');
    if (task.browser) await task.browser.close().catch(() => {});
    return res.json({ message: `Task ${taskId} stopped.` });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server live on http://localhost:${PORT}`);
});
