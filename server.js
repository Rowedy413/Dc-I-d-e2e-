const express = require('express');
const http = require('http');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Active Tasks Store
const activeTasks = new Map();

// Delay Helper
const sleep = (sec) => new Promise((resolve) => setTimeout(resolve, sec * 1000));

// Cookie Parser Helper
function parseCookies(cookieStr) {
    return cookieStr.split(';').map(pair => {
        const [name, ...rest] = pair.trim().split('=');
        if (!name || rest.length === 0) return null;
        return {
            name: name.trim(),
            value: rest.join('=').trim(),
            domain: '.messenger.com',
            path: '/',
            httpOnly: false,
            secure: true,
            sameSite: 'Lax'
        };
    }).filter(Boolean);
}

// ---------------- DASHBOARD UI ----------------
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="hi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Messenger Playwright Auto Tool (With E2EE PIN)</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f0f12; color: #e1e1e6; padding: 20px; margin: 0; }
        .container { max-width: 650px; margin: 0 auto; background: #18181b; padding: 25px; border-radius: 12px; border: 1px solid #27272a; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        h2 { text-align: center; color: #0084ff; margin-bottom: 20px; }
        label { font-weight: 600; margin-top: 15px; display: block; color: #a1a1aa; font-size: 14px; }
        input, textarea { width: 100%; padding: 10px; margin-top: 6px; border-radius: 6px; border: 1px solid #3f3f46; background: #27272a; color: #fff; box-sizing: border-box; }
        textarea { height: 90px; }
        .btn-start { background: #0084ff; color: white; width: 100%; margin-top: 20px; padding: 12px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 16px; }
        .btn-stop { background: #ef4444; color: white; padding: 10px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
        .stop-box { margin-top: 25px; padding-top: 15px; border-top: 1px solid #27272a; display: flex; gap: 10px; }
        #logBox { margin-top: 20px; background: #09090b; padding: 12px; height: 180px; overflow-y: auto; border-radius: 6px; font-family: monospace; font-size: 12px; border: 1px solid #27272a; color: #22c55e; }
        .task-badge { background: #27272a; color: #0084ff; padding: 4px 8px; border-radius: 4px; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Messenger E2EE Bot Dashboard</h2>
        
        <form id="botForm">
            <label>Messenger.com Cookie String:</label>
            <textarea id="cookies" placeholder="c_user=...; xs=...; datr=...;" required></textarea>

            <label>Target UID / Thread ID:</label>
            <input type="text" id="threadId" placeholder="e.g. 1000XXXXXXXXX ya Group ID" required>

            <label>E2EE 6-Digit PIN (Optional / If required by Meta):</label>
            <input type="password" id="e2eePin" placeholder="e.g. 123456">

            <label>Message Prefix (Optional):</label>
            <input type="text" id="prefix" placeholder="e.g. [DevilX]">

            <label>Messages (.txt File Choose Karein):</label>
            <input type="file" id="msgFile" accept=".txt" required>

            <label>Delay (In Seconds):</label>
            <input type="number" id="delay" value="30" min="5" required>

            <button type="button" class="btn-start" onclick="startTask()">START TASK</button>
        </form>

        <div class="stop-box">
            <input type="text" id="stopTaskId" placeholder="Enter Task ID to stop (e.g. TASK-123456)">
            <button type="button" class="btn-stop" onclick="stopTask()">STOP TASK</button>
        </div>

        <label>Active Task Log (<span id="currentTaskId">No Task Running</span>):</label>
        <div id="logBox">Waiting for input...</div>
    </div>

    <script>
        let activeTaskId = null;
        let pollInterval = null;

        function log(msg) {
            const logBox = document.getElementById('logBox');
            logBox.innerHTML += '<div>[' + new Date().toLocaleTimeString() + '] ' + msg + '</div>';
            logBox.scrollTop = logBox.scrollHeight;
        }

        async function startTask() {
            const cookies = document.getElementById('cookies').value.trim();
            const threadId = document.getElementById('threadId').value.trim();
            const e2eePin = document.getElementById('e2eePin').value.trim();
            const prefix = document.getElementById('prefix').value;
            const delay = parseInt(document.getElementById('delay').value);
            const fileInput = document.getElementById('msgFile');

            if (!cookies || !threadId || fileInput.files.length === 0) {
                alert('Cookies, UID aur Message file fill karein!');
                return;
            }

            const file = fileInput.files[0];
            const text = await file.text();
            const messages = text.split('\\n').map(m => m.trim()).filter(m => m.length > 0);

            if (messages.length === 0) {
                alert('Message File khali hai!');
                return;
            }

            log("Task initializing...");

            const response = await fetch('/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies, threadId, e2eePin, prefix, messages, delay })
            });

            const data = await response.json();
            if (data.success) {
                activeTaskId = data.taskId;
                document.getElementById('currentTaskId').innerHTML = '<span class="task-badge">' + activeTaskId + '</span>';
                document.getElementById('stopTaskId').value = activeTaskId;
                log("Generated Task ID: " + activeTaskId);
                
                if(pollInterval) clearInterval(pollInterval);
                pollInterval = setInterval(fetchLogs, 2000);
            } else {
                alert("Task Start Nahi Ho Payi!");
            }
        }

        async function fetchLogs() {
            if (!activeTaskId) return;
            const res = await fetch('/api/logs/' + activeTaskId);
            const data = await res.json();
            if (data.logs) {
                const logBox = document.getElementById('logBox');
                logBox.innerHTML = data.logs.map(l => '<div>' + l + '</div>').join('');
                logBox.scrollTop = logBox.scrollHeight;
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
            log(data.message);
            if (taskId === activeTaskId) {
                clearInterval(pollInterval);
            }
        }
    </script>
</body>
</html>
    `);
});

// ---------------- BACKEND LOGIC ----------------

app.post('/api/start', async (req, res) => {
    const { cookies, threadId, e2eePin, prefix, messages, delay } = req.body;
    
    const taskId = "TASK-" + Math.floor(100000 + Math.random() * 900000);

    const taskData = {
        taskId,
        isRunning: true,
        logs: [`[${new Date().toLocaleTimeString()}] Task Initialized. ID: ${taskId}`],
        browser: null,
        context: null
    };

    activeTasks.set(taskId, taskData);

    runPlaywrightBot(taskId, cookies, threadId, e2eePin, prefix, messages, delay);

    res.json({ success: true, taskId });
});

async function runPlaywrightBot(taskId, cookiesStr, threadId, e2eePin, prefix, messages, delay) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    try {
        task.logs.push(`[${new Date().toLocaleTimeString()}] Launching Browser Engine...`);
        
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
        await context.addCookies(parsedCookies);

        const page = await context.newPage();

        task.logs.push(`[${new Date().toLocaleTimeString()}] Navigating to Target Thread: ${threadId}`);
        await page.goto(`https://www.messenger.com/t/${threadId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // --- E2EE PIN AUTO-FILL CHECK ---
        if (e2eePin) {
            try {
                const pinSelector = 'input[type="password"], input[aria-label*="PIN"], input[placeholder*="PIN"]';
                const pinInput = await page.waitForSelector(pinSelector, { timeout: 8000 }).catch(() => null);
                
                if (pinInput) {
                    task.logs.push(`[INFO] E2EE PIN Prompt detected. Entering PIN...`);
                    await pinInput.click();
                    await pinInput.fill(e2eePin);
                    await page.keyboard.press('Enter');

                    // Button Click Fallback
                    const submitBtn = await page.$('button[type="submit"], div[role="button"]:has-text("Continue"), div[role="button"]:has-text("Submit")').catch(() => null);
                    if (submitBtn) await submitBtn.click();

                    task.logs.push(`[INFO] PIN submitted. Waiting for chat unlock...`);
                    await page.waitForTimeout(6000);

                    task.logs.push(`[DEBUG] Current URL: ${page.url()}`);
                    task.logs.push(`[DEBUG] Title: ${await page.title()}`);

                    const screenshotPath = `/tmp/${taskId}-after-pin.png`;
                    await page.screenshot({
                        path: screenshotPath,
                        fullPage: true
                    }).catch(() => {});
                    task.logs.push(`[DEBUG] Screenshot saved to ${screenshotPath}`);
                }
            } catch (pErr) {
                task.logs.push(`[DEBUG ERROR] PIN Handling Issue: ${pErr.message}`);
            }
        }

        // --- MULTI-SELECTOR CHAT INPUT CHECK ---
        const possibleSelectors = [
            'div[role="textbox"][contenteditable="true"]',
            'div[contenteditable="true"][aria-label*="Message"]',
            'div[contenteditable="true"]',
            'div[aria-label="Message"]',
            'div[role="textbox"]'
        ];

        let inputSelector = null;
        task.logs.push(`[${new Date().toLocaleTimeString()}] Searching for chat input box...`);

        for (const selector of possibleSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 6000 });
                inputSelector = selector;
                break;
            } catch (e) {
                // Try next fallback selector
            }
        }

        if (!inputSelector) {
            throw new Error(`Chat input box not found. Check screenshot at /api/screenshot/${taskId}`);
        }

        task.logs.push(`[${new Date().toLocaleTimeString()}] Connected to E2EE Chat using '${inputSelector}'. Starting loop...`);

        let index = 0;

        while (task.isRunning) {
            const rawMsg = messages[index];
            const finalPayload = (prefix ? prefix + " " : "") + rawMsg;

            try {
                await page.click(inputSelector);
                await page.keyboard.type(finalPayload, { delay: 35 });
                await page.keyboard.press('Enter');

                task.logs.push(`[SUCCESS] Message Sent: "${finalPayload}"`);
            } catch (err) {
                task.logs.push(`[ERROR] Failed to send message: ${err.message}`);
            }

            index = (index + 1) % messages.length;

            for (let i = 0; i < delay; i++) {
                if (!task.isRunning) break;
                await sleep(1);
            }
        }

        task.logs.push(`[${new Date().toLocaleTimeString()}] Task Loop Ended.`);

    } catch (err) {
        task.logs.push(`[FATAL ERROR] ${err.message}`);
    } finally {
        if (task.browser) {
            await task.browser.close().catch(() => {});
        }
        task.isRunning = false;
    }
}

// Route to view debug screenshots directly in browser
app.get('/api/screenshot/:taskId', (req, res) => {
    const filePath = `/tmp/${req.params.taskId}-after-pin.png`;
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Screenshot not found or task has not processed PIN yet.');
    }
});

app.get('/api/logs/:taskId', (req, res) => {
    const task = activeTasks.get(req.params.taskId);
    if (!task) return res.json({ logs: ["Task not found or expired."] });
    res.json({ logs: task.logs });
});

app.post('/api/stop', async (req, res) => {
    const { taskId } = req.body;
    const task = activeTasks.get(taskId);

    if (!task) {
        return res.json({ message: "Invalid Task ID!" });
    }

    task.isRunning = false;
    if (task.browser) {
        await task.browser.close().catch(() => {});
    }

    task.logs.push(`[${new Date().toLocaleTimeString()}] Stop signal received. Task terminated.`);
    res.json({ message: `Task ${taskId} is stopped!` });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server live on http://localhost:${PORT}`);
});

