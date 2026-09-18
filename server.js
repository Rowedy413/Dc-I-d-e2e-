global.WebSocket = require("ws");

const express = require("express");
const { MessengerClient, Platform, CookieManager } = require("messagix-js");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = "./tasks.json";
const activeTasks = new Map();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

process.on("uncaughtException", (err) =>
  console.error("[ANTI-CRASH]", err.message)
);
process.on("unhandledRejection", (err) =>
  console.error("[ANTI-CRASH]", err)
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const time = () => new Date().toLocaleTimeString();

// messagix-js tries to load the optional "pino-pretty" transport when no
// logger is supplied. Render's production install does not include that
// development transport, so the client can crash before cookies are checked.
// This keeps the original login flow intact without changing the HTML.
const messengerLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (...args) => console.warn("[MESSENGER]", ...args),
  error: (...args) => console.error("[MESSENGER]", ...args),
  child() {
    return this;
  },
};

function getUptimeString(startTime) {
  const diff = Date.now() - startTime;
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${d} Days, ${h} Hours, ${m} Mins`;
}

function saveTasks() {
  const out = {};
  for (const [id, task] of activeTasks.entries()) {
    out[id] = {
      cookies: task.cookies,
      backupCookies: task.backupCookies || "",
      threadId: task.threadId,
      hatersName: task.hatersName || "",
      messages: task.messages,
      delaySec: task.delaySec,
      status: task.status,
      startTime: task.startTime,
      logs: (task.logs || []).slice(-60),
      activeCookieSource: task.activeCookieSource || "primary",
    };
  }
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(out, null, 2));
  } catch (e) {
    console.error("[SAVE]", e.message);
  }
}

function logTask(task, message) {
  task.logs.push(`[${time()}] ${message}`);
  if (task.logs.length > 60) task.logs.shift();
  saveTasks();
}

function loadTasks() {
  if (!fs.existsSync(DB_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    for (const [taskId, saved] of Object.entries(data)) {
      if (saved.status !== "running") continue;
      const task = {
        ...saved,
        logs: Array.isArray(saved.logs) ? saved.logs : [],
        messages: Array.isArray(saved.messages) ? saved.messages : [],
        runnerStarted: false,
        stopRequested: false,
      };
      activeTasks.set(taskId, task);
      logTask(task, "♻️ Task restored after server restart.");
      runPersistentTask(taskId).catch((e) =>
        console.error(`[${taskId}]`, e.message)
      );
    }
  } catch (e) {
    console.error("[LOAD]", e.message);
  }
}

app.head("/", (req, res) => res.status(200).end());
app.get("/ping", (req, res) => res.send("Pong"));

// ==================== SAME OLD UI ====================
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>24/7 Messenger Bot</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>
body{font-family:Poppins,sans-serif;background:linear-gradient(135deg,#fff0f3,#ffe5ec);color:#2b2d42;padding:20px;margin:0;min-height:100vh}
.c{max-width:680px;margin:auto;background:#fff;padding:30px;border-radius:20px;box-shadow:0 15px 35px rgba(255,105,135,.15);border:1px solid #ffd1dc}
h2{text-align:center;margin:0 0 5px;font-size:24px}.b{text-align:center;background:linear-gradient(135deg,#ff758c,#ff7eb3);color:#fff;display:block;padding:5px 15px;border-radius:20px;font-size:12px;font-weight:600;margin:0 auto 20px;width:fit-content}
label{font-weight:600;margin-top:15px;display:block;font-size:14px}
input,textarea{width:100%;padding:12px;margin-top:6px;border-radius:10px;border:1.5px solid #ffd1dc;background:#fff9fa;box-sizing:border-box;font-family:Poppins;font-size:14px}
textarea{height:80px;resize:vertical}.fb{margin-top:6px;background:#fff5f7;border:1.5px dashed #ff477e;padding:12px;border-radius:10px;text-align:center;cursor:pointer}.fb input{display:none}.fl{color:#ff477e;font-weight:500;font-size:13px;cursor:pointer}
button{padding:14px;border:none;border-radius:10px;font-weight:600;cursor:pointer;font-size:15px;width:100%;margin-top:15px;color:#fff}.bs{background:linear-gradient(135deg,#ff477e,#ff1f59)}.bc{background:linear-gradient(135deg,#3b82f6,#2563eb)}.bt{background:linear-gradient(135deg,#ff6b6b,#ee5253)}
.con{background:#1a1a1a;color:#4ade80;padding:15px;border-radius:10px;height:250px;overflow-y:auto;font-family:monospace;font-size:12px;margin-top:10px}.tb{margin-top:30px;border-top:1.5px dashed #ffd1dc;padding:15px;background:#fafafa;border-radius:15px}.sb{display:inline-block;padding:5px 12px;border-radius:12px;font-size:12px;font-weight:bold;background:#e0f2fe;color:#0284c7;margin-top:10px}
</style></head><body><div class="c">
<h2>⚡ 24/7 Messenger Bot ⚡</h2><span class="b">DEVELOPER: RAJ MISHRA</span>
<form id="f">
<label>Primary Cookies (Required):</label><textarea name="cookies" placeholder="c_user=...; xs=...;" required></textarea>
<label>Backup Cookies (Optional):</label><textarea name="backupCookies" placeholder="Agar primary fail ho jaye to ye use hongi..."></textarea>
<label>Target ID:</label><input type="text" name="threadId" placeholder="Group/User ID" required>
<label>Haters Name (Prefix):</label><input type="text" name="hatersName" placeholder="Optional">
<label>Messages:</label><div class="fb" onclick="document.getElementById('mf').click()"><span class="fl" id="fl">📁 Upload Messages File</span><input type="file" id="mf" accept=".txt" onchange="loadF(event)"></div>
<textarea name="messages" id="mb" placeholder="Hello&#10;Test" required></textarea>
<label>Delay (Seconds):</label><input type="number" name="delay" value="40" min="2" required>
<button type="submit" class="bs">🚀 Start 24/7 Task</button></form>
<div class="tb"><h3>🔍 Task Control</h3><label>Task ID:</label><input type="text" id="tid" placeholder="Paste Task ID">
<div style="display:flex;gap:10px"><button type="button" class="bc" onclick="check()">👁️ Check</button><button type="button" class="bt" onclick="del()">🗑️ Delete</button></div>
<div style="margin-top:15px;border-top:1px dashed #ffd1dc;padding-top:10px"><label>Update Primary Cookies:</label><textarea id="nc" placeholder="Nayi primary cookies" style="height:50px"></textarea><label>Update Backup Cookies:</label><textarea id="nb" placeholder="Nayi backup cookies" style="height:50px"></textarea><button type="button" class="bc" onclick="upd()">🔄 Update Cookies</button></div>
<div id="si" class="sb" style="display:none"></div><div class="con" id="cl">Waiting...</div></div></div>
<script>
let iv;
function loadF(e){const f=e.target.files[0];if(!f)return;document.getElementById('fl').innerText='📄 '+f.name;const r=new FileReader();r.onload=x=>document.getElementById('mb').value=x.target.result;r.readAsText(f)}
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(e.target);const r=await fetch('/start-task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(fd))});const j=await r.json();if(j.success){alert('Task ID: '+j.taskId+'\\n\\nIse save karein!');document.getElementById('tid').value=j.taskId;check()}else alert('Error: '+j.error)});
function check(){const id=document.getElementById('tid').value.trim();if(!id)return alert('Task ID daaliye!');if(iv)clearInterval(iv);iv=setInterval(async()=>{try{const r=await fetch('/logs/'+id);const d=await r.json();const cl=document.getElementById('cl'),si=document.getElementById('si');if(d.success){si.style.display='block';si.innerHTML='🟢 '+d.status.toUpperCase()+' | ⏱️ '+d.uptime+' | '+d.activeCookieSource;cl.innerHTML=d.logs.join('<br>');cl.scrollTop=cl.scrollHeight}else{clearInterval(iv);si.style.display='none';cl.innerHTML=d.message||'Not found!'}}catch(e){}},2000)}
async function del(){const id=document.getElementById('tid').value.trim();if(!id)return alert('Task ID daaliye!');if(confirm('STOP aur DELETE karein?')){const r=await fetch('/stop-task/'+id,{method:'POST'});const j=await r.json();alert(j.message);if(iv)clearInterval(iv);document.getElementById('cl').innerHTML='Deleted.';document.getElementById('si').style.display='none'}}
async function upd(){const id=document.getElementById('tid').value.trim(),nc=document.getElementById('nc').value.trim(),nb=document.getElementById('nb').value.trim();if(!id)return alert('Task ID daaliye!');if(!nc&&!nb)return alert('Cookies daaliye!');const r=await fetch('/update-cookies/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newCookies:nc,newBackup:nb})});const j=await r.json();alert(j.message);if(j.success){document.getElementById('nc').value='';document.getElementById('nb').value=''}}
</script></body></html>`);
});

// ==================== START TASK ====================
app.post("/start-task", (req, res) => {
  const { cookies, backupCookies, threadId, hatersName, messages, delay } =
    req.body || {};
  if (!cookies || !threadId || !messages) {
    return res.status(400).json({
      success: false,
      error: "Cookies, Target ID aur Messages required hain.",
    });
  }

  const messageList = String(messages)
    .split(/\r?\n/)
    .map((m) => m.trim())
    .filter(Boolean);
  const cleanThreadId = String(threadId).trim();

  if (!/^\d+$/.test(cleanThreadId)) {
    return res.status(400).json({
      success: false,
      error: "Target ID sirf numeric Messenger thread/user ID hona chahiye.",
    });
  }
  if (!messageList.length) {
    return res.status(400).json({ success: false, error: "Messages empty hain." });
  }

  const taskId = `TASK-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const task = {
    cookies: String(cookies).trim(),
    backupCookies: String(backupCookies || "").trim(),
    threadId: cleanThreadId,
    hatersName: String(hatersName || "").trim(),
    messages: messageList,
    delaySec: Math.max(2, Number.parseInt(delay, 10) || 40),
    logs: [`[${time()}] Task ${taskId} created.`],
    status: "running",
    startTime: Date.now(),
    activeCookieSource: "primary",
    runnerStarted: false,
    stopRequested: false,
  };
  if (task.backupCookies) task.logs.push(`[${time()}] 🛡️ Backup cookies enabled.`);

  activeTasks.set(taskId, task);
  saveTasks();
  res.json({ success: true, taskId });
  runPersistentTask(taskId).catch((e) =>
    console.error(`[${taskId}]`, e.message)
  );
});

app.post("/update-cookies/:taskId", (req, res) => {
  const task = activeTasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ success: false, message: "Task not found." });
  }
  if (req.body.newCookies && String(req.body.newCookies).trim()) {
    task.cookies = String(req.body.newCookies).trim();
  }
  if (req.body.newBackup !== undefined) {
    task.backupCookies = String(req.body.newBackup || "").trim();
  }
  task.stopRequested = false;
  task.status = "running";
  task.activeCookieSource = "primary";
  saveTasks();
  if (!task.runnerStarted) runPersistentTask(req.params.taskId).catch(console.error);
  res.json({
    success: true,
    message: "Cookies updated! Bot next connection me nayi cookies use karega.",
  });
});

// ==================== SAME OLD LOGIN FLOW ====================
async function runPersistentTask(taskId) {
  const task = activeTasks.get(taskId);
  if (!task || task.runnerStarted) return;
  task.runnerStarted = true;

  let client = null;
  let msgIndex = 0;
  let loopCount = 1;

  async function doConnect(cookies) {
    if (client) {
      try {
        await client.disconnect();
      } catch (e) {}
      client = null;
    }

    await wait(3000);
    const cm = CookieManager.fromString(Platform.Messenger, cookies);
    const nextClient = new MessengerClient({
      platform: Platform.Messenger,
      cookies: cm.getAll(),
      enableE2EE: false,
      logger: messengerLogger,
    });

    // Do not change this order: this is the old working login flow.
    await nextClient.loadMessagesPage();
    const connectPromise = nextClient.connect();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout 25s")), 25000)
    );
    await Promise.race([connectPromise, timeoutPromise]);
    return nextClient;
  }

  async function sendMessageReliably(text) {
    if (!client) throw new Error("Messenger client connected nahi hai.");
    const target = String(task.threadId).trim();
    if (!/^\d+$/.test(target)) {
      throw new Error("Thread ID numeric nahi hai.");
    }

    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Keep the original API call; only pass clean thread ID and text.
        return await client.sendMessage(target, String(text));
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          logTask(task, `🔁 Send retry ${attempt}/1...`);
          await wait(1500);
        }
      }
    }
    throw lastError;
  }

  try {
    while (
      activeTasks.has(taskId) &&
      task.status === "running" &&
      !task.stopRequested
    ) {
      if (!client) {
        let connected = false;

        for (let i = 1; i <= 3; i++) {
          if (task.stopRequested || task.status !== "running") return;
          try {
            logTask(task, `🔌 [PRIMARY] Attempt ${i}/3...`);
            client = await doConnect(task.cookies);
            task.activeCookieSource = "primary";
            logTask(task, "✅ Primary connected!");
            connected = true;
            break;
          } catch (e) {
            logTask(task, `⚠️ Primary ${i}/3 failed: ${e.message}`);
            if (client) {
              try {
                await client.disconnect();
              } catch (x) {}
              client = null;
            }
            if (i < 3) await wait(5000);
          }
        }

        if (!connected && task.backupCookies) {
          logTask(task, "🔄 Primary fail. Backup try...");
          for (let i = 1; i <= 2; i++) {
            if (task.stopRequested || task.status !== "running") return;
            try {
              logTask(task, `🔌 [BACKUP] Attempt ${i}/2...`);
              client = await doConnect(task.backupCookies);
              task.activeCookieSource = "backup";
              logTask(task, "✅ Backup connected!");
              connected = true;
              break;
            } catch (e) {
              logTask(task, `⚠️ Backup ${i}/2 failed: ${e.message}`);
              if (client) {
                try {
                  await client.disconnect();
                } catch (x) {}
                client = null;
              }
              if (i < 2) await wait(5000);
            }
          }
        }

        if (!connected) {
          logTask(task, "❌ Saare attempts fail. 60s wait karke phir try...");
          logTask(task, "💡 Tip: Panel se nayi cookies update karein.");
          task.activeCookieSource = "primary";
          for (let w = 0; w < 12; w++) {
            if (task.stopRequested || task.status !== "running") return;
            await wait(5000);
          }
          continue;
        }
      }

      const rawMessage = task.messages[msgIndex];
      const finalMessage = task.hatersName
        ? `${task.hatersName} ${rawMessage}`
        : rawMessage;

      try {
        await sendMessageReliably(finalMessage);
        logTask(
          task,
          `🚀 [${task.activeCookieSource.toUpperCase()}] Sent: ${finalMessage}`
        );

        msgIndex++;
        if (msgIndex >= task.messages.length) {
          msgIndex = 0;
          loopCount++;
          logTask(task, `🔄 Round ${loopCount} started...`);
        }

        await wait(Math.max(2, task.delaySec) * 1000);
      } catch (e) {
        logTask(task, `⚠️ Send error: ${e.message}. Reconnecting...`);
        if (client) {
          try {
            await client.disconnect();
          } catch (x) {}
          client = null;
        }
        await wait(3000);
      }
    }
  } catch (e) {
    task.status = "error";
    logTask(task, `❌ Task stopped: ${e.message}`);
  } finally {
    if (client) {
      try {
        await client.disconnect();
      } catch (e) {}
    }
    task.runnerStarted = false;
    if (task.stopRequested) task.status = "stopped";
    saveTasks();
  }
}

app.get("/logs/:taskId", (req, res) => {
  const task = activeTasks.get(req.params.taskId);
  if (!task) return res.json({ success: false, message: "Task not found." });
  res.json({
    success: true,
    status: task.status,
    uptime: getUptimeString(task.startTime),
    activeCookieSource:
      task.activeCookieSource === "backup" ? "🍪 BACKUP" : "🍪 PRIMARY",
    logs: task.logs,
  });
});

app.post("/stop-task/:taskId", (req, res) => {
  const task = activeTasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ success: false, message: "Task not found." });
  }
  task.stopRequested = true;
  task.status = "stopped";
  saveTasks();
  res.json({ success: true, message: `Task ${req.params.taskId} deleted!` });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[LIVE] Port ${PORT} - Raj Mishra`);
  loadTasks();
});
