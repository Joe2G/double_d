import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import { exec, execFile } from "child_process";
import { Aria2Controller } from "./services/Aria2Controller.js";
import { YtdlpController } from "./services/YtdlpController.js";
import { BinaryManager } from "./services/BinaryManager.js";
import { FFmpegController } from "./services/FFmpegController.js";
import { mergeQueue } from "./services/MergeQueue.js";

async function safeUnlink(filePath, retries = 6, delay = 200) {
  if (!filePath) return;
  for (let i = 0; i < retries; i++) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

let mainWindow;
const virtualTasksMap = new Map();
let nextVirtualId = 1;
let broadcastTimer = null;
let rendererReady = false;
// map aria2 gid -> virtual task id for audio-only downloads
const aria2ToVirtual = new Map();
// per-aria2 gid polling timers to ensure live updates when WS events are missed
const aria2Polls = new Map();
// temporarily ignore GIDs that were just removed so UI doesn't keep showing stale entries
const ignoredAriaGids = new Set();

// start polling a specific aria2 gid until it completes/errors; onUpdate called after each fetch
function startAria2Polling(gid, onUpdate = broadcastTasksStatus, interval = 1000) {
  if (!gid) return;
  if (aria2Polls.has(gid)) return;
  const t = setInterval(async () => {
    try {
      await Aria2Controller.fetchTaskStatus(gid);
      try { await onUpdate(); } catch (e) {}
      // check status and stop polling if finished
      const tasks = await Aria2Controller.getAllTasks();
      const task = tasks.find((t) => t.gid === gid);
      if (!task) return;
      if (task.status === 'complete' || task.status === 'error' || task.status === 'removed') {
        clearInterval(t);
        aria2Polls.delete(gid);
      }
    } catch (e) {
      // ignore
    }
  }, interval);
  aria2Polls.set(gid, t);
}
const LOCAL_SERVER_PORT = 8848;

// 📁 إعداد مسار فولدر الأدوات في الـ AppData
const binDir = path.join(app.getPath("userData"), "bin");
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}
let ytdlpPath = path.join(binDir, "yt-dlp.exe"); // سنقوم بتحديثه بعد التحميل
const aria2Path = "aria2c";

// 🛠️ تحميل الأدوات بشكل متزامن عند بدء التطبيق
async function setupLocalBinaries() {
  const binDir = path.join(app.getPath("userData"), "bin");
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }
  ytdlpPath = path.join(binDir, "yt-dlp.exe");

  if (!fs.existsSync(ytdlpPath)) {
    console.log("yt-dlp غير موجود، جاري التحميل من GitHub...");
    const url =
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    await downloadBinaryWithRedirects(url, ytdlpPath);
    console.log("تم تحميل yt-dlp بنجاح");
  }
}

// 🌐 دالة تحميل الملفات مع دعم Redirects
function downloadBinaryWithRedirects(url, destPath) {
  return new Promise((resolve, reject) => {
    function fetchUrl(currentUrl) {
      const protocol = currentUrl.startsWith("https") ? https : http;
      protocol
        .get(currentUrl, (response) => {
          // 301, 302, 303 كلهم تحويلات
          if (
            response.statusCode === 301 ||
            response.statusCode === 302 ||
            response.statusCode === 303
          ) {
            fetchUrl(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`السيرفر رد برمز خطأ: ${response.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(destPath);
          response.pipe(file);
          file.on("finish", () => {
            file.close(() => resolve());
          });
        })
        .on("error", (err) => reject(err));
    }
    fetchUrl(url);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    title: "Double D",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), "dist/index.html"));
  }
}

// 🛰️ بث الحالات اللحظي للشاشة
async function broadcastTasksStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const allTasks = (await Aria2Controller.getAllTasks()).filter(t => !ignoredAriaGids.has(t.gid));
    const mappedTasks = allTasks.map((task) => {
      const total = parseInt(task.totalLength) || 0;
      const completed = parseInt(task.completedLength) || 0;
      const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
      let rawName = "جاري قنص بيانات ومساحة الملف... 🔍";
      if (task.files && task.files[0]) {
        const filePath = task.files[0].path;
        if (filePath) rawName = path.basename(filePath);
        else if (task.files[0].uris && task.files[0].uris[0])
          rawName = task.files[0].uris[0].uri.split("/").pop().split("?")[0];
      }
      const downloadSpeed = parseInt(task.downloadSpeed) || 0;
      let displaySpeed = formatSpeed(downloadSpeed);
      if (task.status === "complete") displaySpeed = "✓ اكتمل التحميل بنجاح";
      else if (task.status === "error") displaySpeed = "❌ فشل";
      const etaSeconds = downloadSpeed > 0 && total > completed ? Math.max(0, Math.round((total - completed) / downloadSpeed)) : null;

        if (aria2ToVirtual.has(task.gid)) {
        const vid = aria2ToVirtual.get(task.gid);
        const vtask = virtualTasksMap.get(vid);
        const displayName = vtask ? vtask.name : decodeURIComponent(rawName) || "Audio_File";
        if (task.status === "complete" || task.status === "error" || task.status === "removed") {
          aria2ToVirtual.delete(task.gid);
        }
        return {
          id: vid,
          name: displayName,
          size: total > 0 ? (total / (1024 * 1024)).toFixed(2) + " MB" : (vtask && vtask._totalSize > 0 ? (vtask._totalSize / (1024 * 1024)).toFixed(2) + " MB" : "جاري الحساب.."),
          status: task.status === "active" ? "downloading" : task.status,
          progress: task.status === "complete" ? 100 : progress,
          speed: displaySpeed,
          etaSeconds: etaSeconds,
          eta: etaSeconds ? formatEta(etaSeconds) : "--",
        };
      }

      return {
        id: task.gid,
        name: decodeURIComponent(rawName) || "Video_File",
        size: total > 0 ? (total / (1024 * 1024)).toFixed(2) + " MB" : "جاري الحساب..",
        status: task.status === "active" ? "downloading" : task.status,
        progress: task.status === "complete" ? 100 : progress,
        speed: displaySpeed,
        etaSeconds: etaSeconds,
        eta: etaSeconds ? formatEta(etaSeconds) : "--",
      };
    });
    const mappedVirtualIds = new Set(mappedTasks.map((t) => (typeof t.id === 'string' && t.id.startsWith('virtual_') ? t.id : null)).filter(Boolean));
    const virtualTasks = Array.from(virtualTasksMap.values()).filter((vt) => !mappedVirtualIds.has(vt.id));
    const allMapped = [...mappedTasks, ...virtualTasks];
    try {
      mainWindow.webContents.send("response-tasks-updated", allMapped);
    } catch (e) {
      console.error('failed to send response-tasks-updated', e && e.message);
    }
  } catch (err) {
    console.error(err.message);
  }
}

function addVirtualTask(name, totalSize = 0) {
  const id = `virtual_${nextVirtualId++}`;
  const task = {
    id,
    name,
    size:
      totalSize > 0
        ? (totalSize / (1024 * 1024)).toFixed(2) + " MB"
        : "جاري الحساب..",
    status: "downloading",
    progress: 0,
    speed: "0 KB/s",
    _totalSize: totalSize,
    _completed: 0,
  };
  virtualTasksMap.set(id, task);
  return id;
}

function updateVirtualTask(id, progress, speedText = null, status = null) {
  const task = virtualTasksMap.get(id);
  if (task) {
    if (progress !== undefined) task.progress = progress;
    // support passing an object { speed, eta }
    if (speedText && typeof speedText === 'object') {
      if (speedText.speed !== undefined) task.speed = speedText.speed;
      if (speedText.eta !== undefined) task.eta = speedText.eta;
    } else if (speedText !== null) {
      task.speed = speedText;
    }
    if (status) task.status = status;
    if (status === "complete") {
      task.speed = "✓ اكتمل";
      task.progress = 100;
    }
    broadcastTasksStatus();
  }
}

function removeVirtualTask(id) {
  virtualTasksMap.delete(id);
  broadcastTasksStatus();
}

// 🌐 السيرفر المحلي المُحسَّن ليمرر الداتا بين الرادار والمحرك
function startLocalServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/native-download") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        console.log("📨 سيرفر Double D استقبل:", body);
        try {
          const data = JSON.parse(body);

          // 🛠️ 1. فحص واستخراج الجودات (سواء طلب يدوي من الصفحة أو رادار من الشبكة)
          if (
            (data.action === "analyze_video" ||
              data.action === "sniffed_media_url") &&
            data.url
          ) {
            try {
              // 🧠 التكتيك الهجين: لو يوتيوب نبعت رابط الصفحة، لو موقع أفلام نبعت الـ m3u8
              let targetUrl = data.url;
              if (
                data.action === "sniffed_media_url" &&
                data.url.includes("googlevideo.com")
              ) {
                targetUrl = data.pageUrl || data.url;
              }

              const formats = await YtdlpController.getAvailableFormats(
                targetUrl,
                ytdlpPath,
              );
              const responseObj = {
                action: "video_qualities_response",
                qualities: formats,
              };
              if (data.requestId) responseObj.requestId = data.requestId;
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify(responseObj));
            } catch (err) {
              const responseObj = {
                action: "video_qualities_response",
                qualities: [],
              };
              if (data.requestId) responseObj.requestId = data.requestId;
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify(responseObj));
            }
          }

          // 🚀 2. استلام أمر التحميل الفعلي بعد ما اليوزر يختار الجودة
          if (data.action === "execute_download" && data.url) {
            startDownload(data.url, data.qualityRule || "best");
          } else if (data.action === "direct_download" && data.url) {
            startDownload(data.url, "best");
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } catch (e) {
          res.writeHead(400);
          res.end();
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(LOCAL_SERVER_PORT, "127.0.0.1");
}

// 🛠️ الجسر الذكي الدائم (تم إصلاح مشكلة اللغة العربية وحساب البايتات)
function autoRegisterNativeHost() {
  const exePath = process.execPath;
  const appDataPath = app.getPath("userData");
  const batFilePath = path.join(appDataPath, "launch-bridge.bat");
  const bridgeJsPath = path.join(appDataPath, "native-bridge.js");
  const jsonFilePath = path.join(appDataPath, "com.joe.doubled.json");
  const extensionId = "bndghfceddmcobhndklddmkndamoognj";

  const bridgeJsContent = `
const http = require('http');

let buffer = Buffer.alloc(0);

function sendToChrome(responseObj) {
  const jsonString = JSON.stringify(responseObj);
  // 💡 التعديل السحري: تحويل النص لـ Buffer عشان نحسب البايتات صح لدعم العربي والإيموجي
  const responseBuf = Buffer.from(jsonString, 'utf8');
  const headerBuf = Buffer.alloc(4);
  headerBuf.writeInt32LE(responseBuf.length, 0);
  
  process.stdout.write(headerBuf);
  process.stdout.write(responseBuf);
}

function callNativeServer(message) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: ${LOCAL_SERVER_PORT},
      path: '/native-download',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch (e) {
          resolve({ action: 'video_qualities_response', qualities: [] });
        }
      });
    });
    req.on('error', () => resolve({ action: 'video_qualities_response', qualities: [] }));
    req.write(JSON.stringify(message));
    req.end();
  });
}

process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  while (buffer.length >= 4) {
    const len = buffer.readInt32LE(0);
    if (buffer.length >= 4 + len) {
      const rawMsg = buffer.slice(4, 4 + len).toString('utf8');
      buffer = buffer.slice(4 + len);
      try {
        const msg = JSON.parse(rawMsg);
        callNativeServer(msg).then(response => sendToChrome(response));
      } catch (err) { }
    } else break;
  }
});

process.stdin.on('end', () => process.exit(0));
`;

  const batContent = `@echo off\nset ELECTRON_RUN_AS_NODE=1\n"${exePath}" "${bridgeJsPath}" %*`;
  const manifestContent = {
    name: "com.joe.doubled",
    description: "Double D Native Messaging Host Bridge",
    path: batFilePath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  try {
    fs.writeFileSync(bridgeJsPath, bridgeJsContent.trim());
    fs.writeFileSync(batFilePath, batContent.trim());
    fs.writeFileSync(jsonFilePath, JSON.stringify(manifestContent, null, 2));
    const registryKey = `HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.joe.doubled`;
    const command = `reg add "${registryKey}" /ve /t REG_SZ /d "${jsonFilePath}" /f`;
    exec(command);
    console.log("✅ تم تحديث الجسر بنجاح لإصلاح خطأ الـ JSON!");
  } catch (err) {
    console.error(err.message);
  }
}

// 🎯 دالة التحميل الرئيسية (تستقبل الجودة الديناميكية)
async function startDownload(targetUrl, qualityRule = "best") {
  // support object shape
  if (typeof targetUrl === 'object' && targetUrl !== null) {
    qualityRule = targetUrl.qualityRule || qualityRule;
    targetUrl = targetUrl.targetUrl || targetUrl.url || '';
  }

  console.log(`🚀 بدء مهمة تحميل: ${targetUrl} - جودة: ${qualityRule}`);

  // Quick bypass for direct-downloads (non-video files)
  const lower = (targetUrl || '').toLowerCase();
  const directExts = [
    ".zip",
    ".exe",
    ".msi",
    ".rar",
    ".7z",
    ".pdf",
    ".mp4",
    ".mkv",
    ".webm",
    ".m3u8",
    ".ts",
    ".png",
    ".jpg",
    ".jpeg",
    ".tar",
    ".gz",
    ".iso",
    ".dmg",
  ];

  const looksLikeDirect = directExts.some((ext) => lower.includes(ext));
  if (looksLikeDirect || !YtdlpController.isVideoPlatform(targetUrl)) {
    try {
      const filename = decodeURIComponent(
        (targetUrl.split("?")[0].split("/").pop() || `file_${Date.now()}`)
      );
      const gid = await Aria2Controller.addDownload(targetUrl, filename, null, { "check-certificate": "false" });
      if (gid) startAria2Polling(gid);
      await broadcastTasksStatus();
    } catch (e) {
      console.error("❌ خطأ عند إرسال الرابط المباشر إلى Aria2:", e.message);
    }
    return;
  }

  // الحصول على معلومات الفورمات (عشان نعرف الفيديو ده فيه صوت ولا لأ)
  let formatsInfo = [];
  try {
    formatsInfo = await YtdlpController.getFormatsInfo(targetUrl, ytdlpPath);
  } catch (e) {
    console.warn("فشل جلب معلومات الفورمات", e);
  }

  const selectedFormat = formatsInfo.find((f) => f.format_id === qualityRule);
  const isAudioOnly = selectedFormat && !selectedFormat.hasVideo;
  const isVideoOnly =
    selectedFormat && selectedFormat.hasVideo && !selectedFormat.hasAudio;
  const isNormal =
    selectedFormat && selectedFormat.hasVideo && selectedFormat.hasAudio;

  if (isAudioOnly) {
    try {
      let finalName = await YtdlpController.getSuggestedFilename(
        targetUrl,
        ytdlpPath,
        qualityRule,
      );
      // ensure final audio output uses .mp3 to avoid container/codec mismatches
      const base = path.parse(finalName).name || finalName;
      finalName = `${base}.mp3`;
      const tempAudio = path.join(
        app.getPath("downloads"),
        "DoubleD",
        `temp_audio_${Date.now()}.m4a`,
      );
      const finalPath = path.join(app.getPath("downloads"), "DoubleD", finalName);

      // منع التكرار
      if (fs.existsSync(finalPath)) {
        console.log("⚠️ الملف موجود بالفعل:", finalName);
        return;
      }

      const virtualId = addVirtualTask(finalName);

      // get direct audio url
      const audioUrl = await YtdlpController.getDirectUrl(
        targetUrl,
        ytdlpPath,
        qualityRule,
      );

      const audioGid = await Aria2Controller.addDownload(
        audioUrl,
        path.basename(tempAudio),
        null,
      );
      if (!audioGid) throw new Error("فشل بدء تحميل الصوت");
      // link aria2 gid with our virtual task so UI shows one merged entry
      try { aria2ToVirtual.set(audioGid, virtualId); } catch (e) {}
      // immediately request aria2 to populate this task into cache so broadcasts include it
      try { await Aria2Controller.fetchTaskStatus(audioGid); } catch (e) {}

      // start a short polling loop for this gid to ensure the UI gets frequent updates
      try {
        if (!aria2Polls.has(audioGid)) {
          const t = setInterval(async () => {
            try {
              await Aria2Controller.fetchTaskStatus(audioGid);
              // call handler to refresh virtual task state
              try { await handler(); } catch (e) {}
            } catch (e) {}
          }, 1000);
          aria2Polls.set(audioGid, t);
        }
      } catch (e) {}

      const handler = async () => {
        try {
          const tasks = await Aria2Controller.getAllTasks();
          const audioTask = tasks.find((t) => t.gid === audioGid);
          let completed = 0,
            total = 0,
            speed = 0;
          if (audioTask) {
            completed += parseInt(audioTask.completedLength) || 0;
            total += parseInt(audioTask.totalLength) || 0;
            speed += parseInt(audioTask.downloadSpeed) || 0;
          }
          const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
          const etaSeconds = speed > 0 && total > completed ? Math.max(0, Math.round((total - completed) / speed)) : null;
          updateVirtualTask(virtualId, progress, { speed: formatSpeed(speed), eta: etaSeconds ? formatEta(etaSeconds) : "--" });
          if (audioTask?.status === "complete") {
            Aria2Controller.emitter.removeListener("tasks-updated", handler);
            if (aria2Polls.has(audioGid)) { clearInterval(aria2Polls.get(audioGid)); aria2Polls.delete(audioGid); }
            await waitForFiles([tempAudio]);
            try {
              // convert to mp3 using ffmpeg
              await FFmpegController.convertAudioToMp3(tempAudio, finalPath);
              try { await safeUnlink(tempAudio); } catch (e) {}
              // remove the underlying aria2 task so it doesn't show as a temp entry
              try { await Aria2Controller.removeTask(audioGid); ignoredAriaGids.add(audioGid); setTimeout(()=>ignoredAriaGids.delete(audioGid),5000); } catch (e) {}
              updateVirtualTask(virtualId, 100, null, "complete");
              // keep virtual task in history (do not auto-remove)
            } catch (e) {
              updateVirtualTask(virtualId, 0, null, "error");
            }
          }
          if (audioTask?.status === "error" || audioTask?.status === "removed") {
            Aria2Controller.emitter.removeListener("tasks-updated", handler);
            if (aria2Polls.has(audioGid)) { clearInterval(aria2Polls.get(audioGid)); aria2Polls.delete(audioGid); }
            updateVirtualTask(virtualId, 0, null, "error");
          }
        } catch (err) {
          Aria2Controller.emitter.removeListener("tasks-updated", handler);
          if (aria2Polls.has(audioGid)) { clearInterval(aria2Polls.get(audioGid)); aria2Polls.delete(audioGid); }
          updateVirtualTask(virtualId, 0, null, "error");
        }
      };

      Aria2Controller.emitter.on("tasks-updated", handler);
      handler();
    } catch (err) {
      console.error("❌ فشل تحميل الصوت:", err.message);
      updateVirtualTask(virtualId, 0, null, "error");
    }
    return;
  }

  if (isVideoOnly) {
    try {
      const finalName = await YtdlpController.getSuggestedFilename(
        targetUrl,
        ytdlpPath,
        qualityRule,
      );
      const virtualId = addVirtualTask(finalName);

      const videoUrl = await YtdlpController.getDirectUrl(
        targetUrl,
        ytdlpPath,
        qualityRule,
      );
      // 💡 التعديل هنا: إجبار yt-dlp إنه يجيب أفضل صوت بصيغة m4a لضمان الدمج السليم
      const audioUrl = await YtdlpController.getDirectUrl(
        targetUrl,
        ytdlpPath,
        "bestaudio[ext=m4a]/bestaudio",
      );

      const tempVideo = path.join(
        app.getPath("downloads"),
        "DoubleD",
        `temp_video_${Date.now()}.mp4`,
      );
      const tempAudio = path.join(
        app.getPath("downloads"),
        "DoubleD",
        `temp_audio_${Date.now()}.m4a`,
      );
      const finalPath = path.join(
        app.getPath("downloads"),
        "DoubleD",
        finalName,
      );

      const videoGid = await Aria2Controller.addDownload(
        videoUrl,
        path.basename(tempVideo),
        null,
      );
      const audioGid = await Aria2Controller.addDownload(
        audioUrl,
        path.basename(tempAudio),
        null,
      );
      if (!videoGid || !audioGid) throw new Error("فشل بدء التحميل");

      // map both gids to the virtual task so the UI shows one entry
      try { aria2ToVirtual.set(videoGid, virtualId); aria2ToVirtual.set(audioGid, virtualId); } catch (e) {}
      try { await Aria2Controller.fetchTaskStatus(videoGid); } catch (e) {}
      try { await Aria2Controller.fetchTaskStatus(audioGid); } catch (e) {}

      // start polling for both gids to keep UI updated
      try {
        if (!aria2Polls.has(videoGid)) {
          const t1 = setInterval(async () => {
            try { await Aria2Controller.fetchTaskStatus(videoGid); await handler(); } catch (e) {}
          }, 1000);
          aria2Polls.set(videoGid, t1);
        }
        if (!aria2Polls.has(audioGid)) {
          const t2 = setInterval(async () => {
            try { await Aria2Controller.fetchTaskStatus(audioGid); await handler(); } catch (e) {}
          }, 1000);
          aria2Polls.set(audioGid, t2);
        }
      } catch (e) {}

      // استبدال polling بمستمع حدثي من Aria2Controller
      const handler = async () => {
        try {
          const tasks = await Aria2Controller.getAllTasks();
          const videoTask = tasks.find((t) => t.gid === videoGid);
          const audioTask = tasks.find((t) => t.gid === audioGid);
          let completed = 0,
            total = 0,
            speed = 0;
          if (videoTask) {
            completed += parseInt(videoTask.completedLength) || 0;
            total += parseInt(videoTask.totalLength) || 0;
            speed += parseInt(videoTask.downloadSpeed) || 0;
          }
          if (audioTask) {
            completed += parseInt(audioTask.completedLength) || 0;
            total += parseInt(audioTask.totalLength) || 0;
            speed += parseInt(audioTask.downloadSpeed) || 0;
          }
          const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
          const etaSeconds = speed > 0 && total > completed ? Math.max(0, Math.round((total - completed) / speed)) : null;
          updateVirtualTask(virtualId, progress, { speed: formatSpeed(speed), eta: etaSeconds ? formatEta(etaSeconds) : "--" });
          if (
            videoTask?.status === "complete" &&
            audioTask?.status === "complete"
          ) {
            // إلغاء المستمع ثم متابعة الدمج
            Aria2Controller.emitter.removeListener("tasks-updated", handler);
            // clear any polling timers for these gids
            if (aria2Polls.has(videoGid)) { clearInterval(aria2Polls.get(videoGid)); aria2Polls.delete(videoGid); }
            if (aria2Polls.has(audioGid)) { clearInterval(aria2Polls.get(audioGid)); aria2Polls.delete(audioGid); }
            await waitForFiles([tempVideo, tempAudio]);
            try {
              await mergeQueue.enqueueMerge(tempVideo, tempAudio, finalPath);
              try { await safeUnlink(tempVideo); await safeUnlink(tempAudio); } catch (e) {}
              // remove underlying aria2 tasks so temp entries don't appear
              try { await Aria2Controller.removeTask(videoGid); ignoredAriaGids.add(videoGid); setTimeout(()=>ignoredAriaGids.delete(videoGid),5000); } catch (e) {}
              try { await Aria2Controller.removeTask(audioGid); ignoredAriaGids.add(audioGid); setTimeout(()=>ignoredAriaGids.delete(audioGid),5000); } catch (e) {}
              updateVirtualTask(virtualId, 100, null, "complete");
              // keep virtual task in history (do not auto-remove)
            } catch (e) {
              updateVirtualTask(virtualId, 0, null, "error");
            }
          }
        } catch (err) {
          Aria2Controller.emitter.removeListener("tasks-updated", handler);
          if (aria2Polls.has(videoGid)) { clearInterval(aria2Polls.get(videoGid)); aria2Polls.delete(videoGid); }
          if (aria2Polls.has(audioGid)) { clearInterval(aria2Polls.get(audioGid)); aria2Polls.delete(audioGid); }
          updateVirtualTask(virtualId, 0, null, "error");
        }
      };

      Aria2Controller.emitter.on("tasks-updated", handler);
      // نطلب تنفيذ أولي لتحديث الحالة مباشرة
      handler();
    } catch (err) {
      console.error("❌ فشل:", err.message);
    }
    return;
  }

  // الحالة العادية (فيديو بصوت مدمج) أو أي رابط آخر
  try {
    const directUrl = await YtdlpController.getDirectUrl(
      targetUrl,
      ytdlpPath,
      qualityRule,
    );
    let filename = null;
    try {
      filename = await YtdlpController.getSuggestedFilename(
        targetUrl,
        ytdlpPath,
        qualityRule,
      );
    } catch (e) {
      filename = `video_${Date.now()}.mp4`;
    }
    const directGid = await Aria2Controller.addDownload(directUrl, filename, null);
    if (directGid) startAria2Polling(directGid);
    await broadcastTasksStatus();
  } catch (err) {
    console.error("❌ فشل التحميل العادي:", err);
  }
}

ipcMain.on("command-start-download", async (event, targetUrl, qualityRule = "best") => {
  startDownload(targetUrl, qualityRule);
});

// دالة مساعدة لانتظار وجود الملفات
function waitForFiles(filePaths, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const allExist = filePaths.every((p) => fs.existsSync(p));
      if (allExist) resolve();
      else if (Date.now() - start > timeout)
        reject(new Error("Timeout waiting for files"));
      else setTimeout(check, 500);
    };
    check();
  });
}

async function waitForTasksComplete(gids, timeout = 120000) {
  // Deprecated: polling removed. Prefer using Aria2Controller.emitter events instead.
  throw new Error("waitForTasksComplete deprecated; use Aria2Controller.emitter events");
}

ipcMain.on("command-pause-task", async (event, gid) => {
  await Aria2Controller.pauseTask(gid);
  await broadcastTasksStatus();
});
ipcMain.on("command-resume-task", async (event, gid) => {
  await Aria2Controller.resumeTask(gid);
  await broadcastTasksStatus();
});

ipcMain.on("command-pause-all-tasks", async () => {
  try {
    const tasks = await Aria2Controller.getAllTasks();
    for (const task of tasks) {
      if (task.status === "active" || task.status === "waiting")
        await Aria2Controller.pauseTask(task.gid);
    }
    await broadcastTasksStatus();
  } catch (err) {
    console.error(err);
  }
});

ipcMain.on("command-resume-all-tasks", async () => {
  try {
    const tasks = await Aria2Controller.getAllTasks();
    for (const task of tasks) {
      if (task.status === "paused") await Aria2Controller.resumeTask(task.gid);
    }
    await broadcastTasksStatus();
  } catch (err) {
    console.error(err);
  }
});

ipcMain.on("command-delete-task", async (event, gid) => {
  try {
    // If deleting a virtual task (history entry), remove virtual entry and any mapped aria2 tasks/files
    if (typeof gid === 'string' && gid.startsWith('virtual_')) {
      const vtask = virtualTasksMap.get(gid);
      // remove final file if exists
      if (vtask && vtask.name) {
        const finalPath = path.join(app.getPath("downloads"), "DoubleD", vtask.name);
        try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (e) {}
      }
      // remove any aria2 tasks mapped to this virtual id
      for (const [ariaGid, vid] of Array.from(aria2ToVirtual.entries())) {
        if (vid === gid) {
          try { await Aria2Controller.removeTask(ariaGid); ignoredAriaGids.add(ariaGid); setTimeout(()=>ignoredAriaGids.delete(ariaGid),5000); } catch (e) {}
          aria2ToVirtual.delete(ariaGid);
          if (aria2Polls.has(ariaGid)) { clearInterval(aria2Polls.get(ariaGid)); aria2Polls.delete(ariaGid); }
        }
      }
      removeVirtualTask(gid);
      return;
    }

    const allTasks = await Aria2Controller.getAllTasks();
    const targetTask = allTasks.find((t) => t.gid === gid);
    await Aria2Controller.removeTask(gid);
    if (targetTask && targetTask.files && targetTask.files[0]) {
      const filePath = targetTask.files[0].path;
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      const aria2ControlFile = `${filePath}.aria2`;
      if (fs.existsSync(aria2ControlFile)) fs.unlinkSync(aria2ControlFile);
    }
    await broadcastTasksStatus();
  } catch (error) {
    console.error(error);
  }
});

ipcMain.on("command-open-download-folder", () => {
  const downloadDir = path.join(app.getPath("downloads"), "DoubleD");
  shell.openPath(downloadDir);
});

ipcMain.on("command-check-tools-versions", (event) => {
  let result = {
    ytdlp: "غير مثبت (اضغط تحديث لتحميله) ❌",
    aria2: "v1.36.0 مستقر",
  };

  if (!fs.existsSync(ytdlpPath)) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("response-tools-versions", result);
    }
    return;
  }

  exec(`"${ytdlpPath}" --version`, (err, stdout) => {
    if (!err && stdout) result.ytdlp = stdout.trim();
    exec(`"${aria2Path}" --version`, (errAria, stdoutAria) => {
      if (!errAria && stdoutAria) {
        result.aria2 = stdoutAria
          .split("\n")[0]
          .replace("aria2 version", "")
          .trim();
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("response-tools-versions", result);
      }
    });
  });
});

// 🔄 التحديث المباشر من GitHub
ipcMain.on("command-update-ytdlp", async (event) => {
  const downloadUrl =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  const tempPath = `${ytdlpPath}.tmp`;

  console.log("🔄 جاري سحب الـ Binary الجديد مباشرة من سيرفرات GitHub...");
  try {
    await downloadBinaryWithRedirects(downloadUrl, tempPath);
    if (fs.existsSync(ytdlpPath)) {
      fs.unlinkSync(ytdlpPath);
    }
    fs.renameSync(tempPath, ytdlpPath);
    console.log("🎉 اكتمل استبدال وتثبيت الملف بنجاح!");

    exec(`"${ytdlpPath}" --version`, (versionErr, newVersionStdout) => {
      const newVer =
        !versionErr && newVersionStdout
          ? newVersionStdout.trim()
          : "2026.03.17+";
      event.reply("response-ytdlp-update-result", {
        success: true,
        message: `🎉 مبروك يا جو! تم تحديث الصائد الذكي بنجاح من سيرفر GitHub مباشرة.`,
        newVersion: newVer,
      });
    });
  } catch (err) {
    console.error("❌ فشل التحديث المباشر للـ Binary:", err.message);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    event.reply("response-ytdlp-update-result", {
      success: false,
      message: `❌ فشل التحديث التلقائي المباشر.\n\nالسبب: ${err.message}`,
    });
  }
});

let ffmpegPath = null;

async function setupFfmpeg() {
  const binDir = path.join(app.getPath("userData"), "bin");
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
  ffmpegPath = path.join(binDir, "ffmpeg.exe");

  if (!fs.existsSync(ffmpegPath)) {
    console.log("ffmpeg غير موجود، جاري التحميل من GitHub...");
    // استخدام رابط مباشر للملف التنفيذي
    const exeUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
    const zipPath = path.join(binDir, "ffmpeg.zip");
    
    await downloadBinaryWithRedirects(exeUrl, zipPath);

    await new Promise((resolve, reject) => {
      // فك الضغط الذكي واستخراج ffmpeg.exe فقط
      exec(
        `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${binDir}' -Force"`,
        (err) => {
          if (err) return reject(err);
          
          // البحث عن ffmpeg.exe بغض النظر عن اسم الفولدر
          const findCmd = `dir /s /b "${binDir}\\ffmpeg.exe" 2>nul`;
          exec(findCmd, (findErr, findOut) => {
            if (!findErr && findOut.trim()) {
              const found = findOut.trim().split("\n")[0];
              // نقله للفولدر الرئيسي
              fs.renameSync(found, ffmpegPath);
            }
            
            // تنظيف
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            // حظر الفولدرات اللي طلعت من الـ zip
            fs.readdirSync(binDir).forEach(file => {
               if(fs.lstatSync(path.join(binDir, file)).isDirectory()){
                   fs.rmSync(path.join(binDir, file), { recursive: true, force: true });
               }
            });
            resolve();
          });
        }
      );
    });
    console.log("✅ تم تحميل وتجهيز ffmpeg بنجاح");
  }
}

// 🏁 التشغيل الرئيسي
app.whenReady().then(async () => {
  await setupLocalBinaries(); // نضمن وجود الأداة
  await setupFfmpeg();
  // تنظيف أي ملفات مؤقتة قد تكون بقت من جلسات سابقة
  try {
    FFmpegController.cleanupTempFiles(path.join(app.getPath("downloads"), "DoubleD"));
  } catch (e) {}
  autoRegisterNativeHost();
  startLocalServer();
  Aria2Controller.start();
  createWindow();

  // ensure renderer receives updates even if Aria2 WS misses an event
  mainWindow.on("closed", () => {
    if (broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
    }
  });

  // when the renderer finishes loading, mark ready and push an immediate update
  mainWindow.webContents.on("did-finish-load", () => {
    rendererReady = true;
    broadcastTasksStatus();
  });

  // الآن نعتمد على إشعارات Aria2 عبر WebSocket لتحديث الحالة لحظياً
  Aria2Controller.emitter.on("tasks-updated", () => {
    broadcastTasksStatus();
  });

  // fallback periodic broadcaster (small interval) to keep UI in sync
  if (!broadcastTimer) broadcastTimer = setInterval(broadcastTasksStatus, 2000);

  // handle explicit ready handshake from renderer
  ipcMain.on("renderer-ready", () => {
    rendererReady = true;
    broadcastTasksStatus();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function formatSpeed(speedBytes) {
  const s = parseInt(speedBytes) || 0;
  if (s === 0) return "0 KB/s";
  if (s < 1024 * 1024) return (s / 1024).toFixed(1) + " KB/s";
  return (s / (1024 * 1024)).toFixed(1) + " MB/s";
}

function formatEta(seconds) {
  if (seconds == null) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

app.on("window-all-closed", () => {
  Aria2Controller.stop();
  if (process.platform !== "darwin") app.quit();
});
