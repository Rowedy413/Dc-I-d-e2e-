/* Messenger Playwright server
 *
 * Important fixes:
 * 1. Do not use messagix-js. It is not in package.json and its old composer
 *    selector is: div[role="textbox"] [contenteditable="true"].
 * 2. Messenger normally puts role="textbox" and contenteditable="true" on
 *    the SAME element. The selector must therefore be:
 *    [role="textbox"][contenteditable="true"]
 * 3. Sending is done with Playwright keyboard events and is verified by
 *    checking that the composer was cleared.
 */

const express = require("express");
const { chromium } = require("playwright");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = path.join(__dirname, "tasks.json");
const activeTasks = new Map();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

process.on("uncaughtException", (error) => {
  console.error("[ANTI-CRASH]", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[ANTI-CRASH]", error);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toLocaleTimeString();

function getUptime(startTime) {
  const diff = Math.max(0, Date.now() - startTime);
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return `${days} Days, ${hours} Hours, ${mins} Mins`;
}

function addLog(task, message) {
  task.logs = Array.isArray(task.logs) ? task.logs : [];
  task.logs.push(`[${now()}] ${message}`);
  if (task.logs.length > 80) task.logs = task.logs.slice(-80);
  saveTasks();
}

function saveTasks() {
  const output = {};
  for (const [taskId, task] of activeTasks) {
    output[taskId] = {
      cookies: task.cookies,
      backupCookies: task.backupCookies || "",
      threadId: task.threadId,
      hatersName: task.hatersName || "",
      messages: task.messages,
      delaySec: task.delaySec,
      status: task.status,
      startTime: task.startTime,
      logs: (task.logs || []).slice(-80),
      activeCookieSource: task.activeCookieSource || "primary",
    };
  }

  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(output, null, 2));
  } catch (error) {
    console.error("[SAVE]", error.message);
  }
}

function loadTasks() {
  if (!fs.existsSync(DB_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    for (const [taskId, saved] of Object.entries(data)) {
      if (saved.status !== "running") continue;

      const task = {
        ...saved,
        messages: Array.isArray(saved.messages) ? saved.messages : [],
        logs: Array.isArray(saved.logs) ? saved.logs : [],
        stopRequested: false,
        runnerStarted: false,
      };
      activeTasks.set(taskId, task);
      addLog(task, "♻️ Task restored after server restart.");
      runTask(taskId).catch((error) => {
        console.error(`[${taskId}] restore error`, error);
      });
    }
  } catch (error) {
    console.error("[LOAD]", error.message);
  }
}

function parseCookies(cookieText) {
  if (!cookieText || typeof cookieText !== "string") {
    throw new Error("Cookies empty hain.");
  }

  const cookies = [];
  for (const part of cookieText.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;

    cookies.push({
      name,
      value,
      domain: ".facebook.com",
      path: "/",
      secure: true,
      sameSite: "Lax",
    });
  }

  if (!cookies.length) throw new Error("Cookie format invalid hai.");
  return cookies;
}

function isLoginPage(url, title = "") {
  const value = `${url} ${title}`.toLowerCase();
  return (
    value.includes("/login") ||
    value.includes("login | facebook") ||
    value.includes("log in | facebook")
  );
}

async function pageLooksLoggedOut(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  if (isLoginPage(url, title)) return true;

  const loginText = page
    .getByText(/log in|login|create new account/i)
    .first();
  return (await loginText.count().catch(() => 0)) > 0 &&
    (await loginText.isVisible().catch(() => false));
}

async function openMessenger(task, cookieText) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1365, height: 900 },
  });

  await context.addCookies(parseCookies(cookieText));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  const threadId = encodeURIComponent(String(task.threadId).trim());
  const urls = [
    `https://www.facebook.com/messages/t/${threadId}`,
    `https://www.messenger.com/t/${threadId}`,
  ];

  let lastError;
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
      await page.waitForTimeout(3500);

      if (await pageLooksLoggedOut(page)) {
        throw new Error(
          "Facebook ne login page dikhaya. Cookies expired/invalid hain."
        );
      }

      const composer = await findComposer(page, 7000);
      if (composer) return { browser, context, page };
      lastError = new Error(
        `Composer nahi mila (URL: ${page.url()}, title: ${await page.title()})`
      );
    } catch (error) {
      lastError = error;
      if (await pageLooksLoggedOut(page).catch(() => false)) break;
    }
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  throw lastError || new Error("Messenger open nahi hua.");
}

// This is intentionally a list of independent, current/fallback selectors.
// The old broken selector searched for a contenteditable child inside a
// textbox. On Messenger both attributes are usually on one element.
const COMPOSER_SELECTORS = [
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'div[contenteditable="true"][aria-label*="message" i]',
  'textarea[placeholder*="message" i]',
  'textarea[aria-label*="message" i]',
  'div[contenteditable="true"]',
];

async function findComposer(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of COMPOSER_SELECTORS) {
      const candidates = page.locator(selector);
      const count = await candidates.count().catch(() => 0);

      for (let index = 0; index < Math.min(count, 5); index++) {
        const candidate = candidates.nth(index);
        if (
          (await candidate.isVisible().catch(() => false)) &&
          (await candidate.isEditable().catch(() => true))
        ) {
          return candidate;
        }
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function composerText(composer) {
  return composer
    .evaluate((element) => {
      if ("value" in element) return element.value || "";
      return element.textContent || element.innerText || "";
    })
    .catch(() => "");
}

async function sendOne(page, message) {
  const composer = await findComposer(page, 15000);
  if (!composer) {
    throw new Error(
      "Message composer nahi mila. Messenger UI/selector change ya page login nahi hai."
    );
  }

  await composer.click();
  await composer.fill("");
  await composer.fill(message);
  await page.waitForTimeout(250);

  const entered = (await composerText(composer)).trim();
  if (!entered) throw new Error("Message composer me text enter nahi hua.");

  // Messenger sends a normal message with Enter. Do not use Shift+Enter.
  await composer.press("Enter");
  await page.waitForTimeout(1200);

  const remaining = (await composerText(composer)).trim();
  if (remaining === entered || remaining.includes(message.slice(0, 20))) {
    throw new Error(
      "Enter press hua, lekin composer clear nahi hua; message send verify nahi hua."
    );
  }
}

async function connectTask(task, cookieText) {
  addLog(task, "🌐 Messenger page open ho raha hai...");
  return openMessenger(task, cookieText);
}

async function runTask(taskId) {
  const task = activeTasks.get(taskId);
  if (!task || task.runnerStarted) return;
  task.runnerStarted = true;

  let session = null;
  let messageIndex = 0;
  let cookieFailures = 0;

  try {
    while (activeTasks.has(taskId) && task.status === "running" && !task.stopRequested) {
      if (!session) {
        const sources = [
          { name: "primary", value: task.cookies },
          { name: "backup", value: task.backupCookies },
        ].filter((item) => item.value && item.value.trim());

        let connected = false;
        for (const source of sources) {
          if (task.stopRequested) break;
          try {
            addLog(task, `🔌 [${source.name.toUpperCase()}] Connecting...`);
            session = await connectTask(task, source.value);
            task.activeCookieSource = source.name;
            cookieFailures = 0;
            addLog(task, `✅ [${source.name.toUpperCase()}] Logged in and composer found.`);
            connected = true;
            break;
          } catch (error) {
            cookieFailures++;
            addLog(task, `⚠️ [${source.name.toUpperCase()}] ${error.message}`);
            if (session) {
              await session.context.close().catch(() => {});
              await session.browser.close().catch(() => {});
              session = null;
            }
          }
        }

        if (!connected) {
          addLog(
            task,
            "❌ Login/composer connection failed. Cookies update karke 30s baad retry hoga."
          );
          await sleep(Math.min(30000, 5000 + cookieFailures * 2500));
          continue;
        }
      }

      const rawMessage = task.messages[messageIndex];
      const finalMessage = task.hatersName
        ? `${task.hatersName} ${rawMessage}`
        : rawMessage;

      try {
        await sendOne(session.page, finalMessage);
        addLog(
          task,
          `🚀 [${task.activeCookieSource.toUpperCase()}] Sent: ${finalMessage}`
        );

        messageIndex = (messageIndex + 1) % task.messages.length;
        saveTasks();
        await sleep(Math.max(2, task.delaySec) * 1000);
      } catch (error) {
        addLog(task, `⚠️ Send error: ${error.message}. Reopening Messenger...`);
        await session.context.close().catch(() => {});
        await session.browser.close().catch(() => {});
        session = null;
        await sleep(2500);
      }
    }
  } catch (error) {
    task.status = "error";
    addLog(task, `❌ Task stopped بسبب: ${error.message}`);
  } finally {
    if (session) {
      await session.context.close().catch(() => {});
      await session.browser.close().catch(() => {});
    }
    task.runnerStarted = false;
    if (task.status === "running" && task.stopRequested) task.status = "stopped";
    saveTasks();
  }
}

// Minimal dashboard kept compatible with the existing API.
app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Messenger Playwright Auto Tool</title>
<style>
body{font-family:Arial,sans-serif;background:#101012;color:#eee;margin:0;padding:22px}
.box{max-width:620px;margin:auto;background:#18181b;border:1px solid #39393f;border-radius:14px;padding:20px}
h2{margin-top:0}label{display:block;color:#aaa;margin:14px 0 6px}
input,textarea,button{box-sizing:border-box;width:100%;font:inherit;border-radius:8px;padding:11px}
input,textarea{background:#202023;color:#eee;border:1px solid #555}textarea{min-height:86px}
button{border:0;background:#0878df;color:white;margin-top:14px;font-weight:bold;cursor:pointer}
.danger{background:#cc3f46}.row{display:flex;gap:10px}.row>*{flex:1}
pre{height:230px;overflow:auto;background:#050505;color:#46d369;padding:12px;border-radius:8px;white-space:pre-wrap}
.hint{color:#aaa;font-size:13px;line-height:1.45}
</style></head><body><main class="box">
<h2>Messenger Playwright Auto Tool</h2>
<p class="hint">Cookies se login hota hai. Agar logs me login page ya composer error aaye, fresh cookies aur sahi thread/user ID use karein.</p>
<form id="form">
<label>Primary Cookies</label><textarea name="cookies" required placeholder="c_user=...; xs=...;"></textarea>
<label>Backup Cookies (optional)</label><textarea name="backupCookies" placeholder="c_user=...; xs=...;"></textarea>
<label>Target Thread/User ID</label><input name="threadId" required>
<label>Message Prefix (optional)</label><input name="hatersName">
<label>Messages (one per line)</label><textarea name="messages" required placeholder="Hello&#10;Test"></textarea>
<label>Delay in seconds (minimum 2)</label><input name="delay" type="number" min="2" value="40" required>
<button>START TASK</button></form>
<label>Task ID</label><input id="taskId" placeholder="Task ID">
<div class="row"><button type="button" onclick="watch()">CHECK LOGS</button><button type="button" class="danger" onclick="stopTask()">STOP TASK</button></div>
<pre id="logs">Waiting...</pre>
</main><script>
let timer;
form.onsubmit=async(e)=>{e.preventDefault();const body=Object.fromEntries(new FormData(form));const r=await fetch('/start-task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!j.success)return alert(j.error);taskId.value=j.taskId;alert('Task ID: '+j.taskId);watch()};
function watch(){clearInterval(timer);timer=setInterval(async()=>{const id=taskId.value.trim();if(!id)return;const j=await (await fetch('/logs/'+id)).json();logs.textContent=j.success?j.logs.join('\\n'):j.message},2000)}
async function stopTask(){const id=taskId.value.trim();if(!id)return alert('Task ID daaliye');const j=await (await fetch('/stop-task/'+id,{method:'POST'})).json();alert(j.message);clearInterval(timer)}
</script></body></html>`);
});

app.head("/", (req, res) => res.status(200).end());
app.get("/ping", (req, res) => res.send("Pong"));

app.post("/start-task", (req, res) => {
  const { cookies, backupCookies, threadId, hatersName, messages, delay } = req.body || {};
  if (!cookies || !threadId || !messages) {
    return res.status(400).json({
      success: false,
      error: "Cookies, target ID aur messages required hain.",
    });
  }

  const messageList = String(messages)
    .split(/\r?\n/)
    .map((message) => message.trim())
    .filter(Boolean);
  if (!messageList.length) {
    return res.status(400).json({ success: false, error: "Messages empty hain." });
  }

  const taskId = `TASK-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const task = {
    cookies: String(cookies).trim(),
    backupCookies: String(backupCookies || "").trim(),
    threadId: String(threadId).trim(),
    hatersName: String(hatersName || "").trim(),
    messages: messageList,
    delaySec: Math.max(2, Number.parseInt(delay, 10) || 40),
    status: "running",
    startTime: Date.now(),
    activeCookieSource: "primary",
    logs: [`[${now()}] Task ${taskId} created.`],
    stopRequested: false,
    runnerStarted: false,
  };

  activeTasks.set(taskId, task);
  saveTasks();
  res.json({ success: true, taskId });
  runTask(taskId).catch((error) => console.error(`[${taskId}]`, error));
});

app.get("/logs/:taskId", (req, res) => {
  const task = activeTasks.get(req.params.taskId);
  if (!task) return res.json({ success: false, message: "Task not found." });

  res.json({
    success: true,
    status: task.status,
    uptime: getUptime(task.startTime),
    activeCookieSource:
      task.activeCookieSource === "backup" ? "🍪 BACKUP" : "🍪 PRIMARY",
    logs: task.logs || [],
  });
});

app.post("/stop-task/:taskId", (req, res) => {
  const taskId = req.params.taskId;
  const task = activeTasks.get(taskId);
  if (!task) return res.status(404).json({ success: false, message: "Task not found." });

  task.stopRequested = true;
  task.status = "stopped";
  saveTasks();
  res.json({ success: true, message: `Task ${taskId} stopped.` });
});

app.post("/update-cookies/:taskId", (req, res) => {
  const task = activeTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, message: "Task not found." });

  if (req.body.newCookies && String(req.body.newCookies).trim()) {
    task.cookies = String(req.body.newCookies).trim();
  }
  if (req.body.newBackup !== undefined) {
    task.backupCookies = String(req.body.newBackup || "").trim();
  }
  task.stopRequested = false;
  task.status = "running";
  saveTasks();
  if (!task.runnerStarted) runTask(req.params.taskId).catch(console.error);
  res.json({ success: true, message: "Cookies updated. Next connection me use hongi." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[LIVE] Port ${PORT}`);
  loadTasks();
});
