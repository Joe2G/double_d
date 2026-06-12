import { spawn } from "child_process";
import path from "path";
import { app } from "electron";
import { execFile } from "child_process";
import { BinaryManager } from "./BinaryManager.js";
import EventEmitter from "events";

let aria2Process = null;
let wsClient = null;
let pollTimer = null;
let reconnectTimer = null;
let connecting = false;
let isRunning = false;
const RPC_URL = "http://localhost:6800/jsonrpc";
const emitter = new EventEmitter();
const tasksCache = new Map();

async function rpcCall(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now().toString(), method, params }),
  });
  return res.json();
}

async function fetchTaskStatus(gid) {
  try {
    const resp = await rpcCall("aria2.tellStatus", [gid, ["gid", "status", "totalLength", "completedLength", "downloadSpeed", "files"]]);
    if (resp && resp.result) {
      tasksCache.set(resp.result.gid, resp.result);
      emitter.emit("tasks-updated");
    }
  } catch (e) {}
}

async function populateCache() {
  try {
    const headers = { "Content-Type": "application/json" };
    const [activeRes, waitingRes, stoppedRes] = await Promise.all([
      fetch(RPC_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "aria2.tellActive" }) }),
      fetch(RPC_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "2", method: "aria2.tellWaiting", params: [0, 100] }) }),
      fetch(RPC_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "3", method: "aria2.tellStopped", params: [0, 100] }) }),
    ]);
    const active = await activeRes.json();
    const waiting = await waitingRes.json();
    const stopped = await stoppedRes.json();
    const all = [...(active.result || []), ...(waiting.result || []), ...(stopped.result || [])];
    tasksCache.clear();
    for (const t of all) tasksCache.set(t.gid, t);
    emitter.emit("tasks-updated");
  } catch (e) {
    // ignore
  }
}

export const Aria2Controller = {
  emitter,
  fetchTaskStatus,
  // تحديث دالة start لتأكيد الإعدادات الافتراضية القوية
  start() {
    let binPath = BinaryManager.getAria2Path();
    if (!binPath) {
      const isDev = process.env.VITE_DEV_SERVER_URL;
      binPath = isDev
        ? path.join(app.getAppPath(), "bin", "aria2c.exe")
        : path.join(process.resourcesPath, "bin", "aria2c.exe");
    }

    const downloadDir = path.join(app.getPath("downloads"), "DoubleD");

    console.log(
      "🤖 جاري إيقاظ البلدوزر بالسرعة القصوى.. مسار الحفظ:",
      downloadDir,
    );

    const args = [
      "--enable-rpc",
      "--rpc-listen-all=false",
      "--rpc-listen-port=6800",
      `--dir=${downloadDir}`,
      "--max-connection-per-server=16", // فتح 16 اتصال للسيرفر الواحد
      "--split=16", // تقسيم الملف لـ 16 جزء للتحميل المتوازي
      "--min-split-size=1M", // السماح بالتقسيم حتى لو الملف صغير لتسريع البدء
      "--no-conf=true",
    ];

    if (isRunning) return;
    aria2Process = spawn(binPath, args);
    isRunning = true;

    // lightweight fallback: populate cache periodically only if WS not connected
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!wsClient) {
        try {
          await populateCache();
        } catch (e) {
          // ignore
        }
      }
    }, 30000);

    // بعد تشغيل aria2 نحاول الاتصال عبر WebSocket للاستماع للإشعارات
    const wsUrl = "ws://127.0.0.1:6800/jsonrpc";
    let reconnectDelay = 500;
    const connectWs = async () => {
      if (connecting) return;
      connecting = true;
      // load `ws` at runtime to avoid bundlers attempting to resolve optional native deps
      let WS = null;
      try {
        // prefer dynamic import if available
        const mod = await import('module');
      } catch (e) {}
      try {
        const { createRequire } = await import('module');
        const require = createRequire(import.meta.url);
        WS = require('ws');
      } catch (e) {
        WS = null;
      }
      if (!WS) {
        connecting = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWs, reconnectDelay);
        return;
      }

      try {
        wsClient = new WS(wsUrl);
      } catch (e) {
        wsClient = null;
      }
      if (!wsClient) {
        connecting = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWs, reconnectDelay);
        return;
      }

      wsClient.on("open", () => {
        reconnectDelay = 500;
        connecting = false;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        populateCache();
      });

      wsClient.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method && msg.method.startsWith("aria2.")) {
            const params = msg.params || [];
            // gid may be string or object
            let gid = null;
            if (params.length > 0) {
              if (typeof params[0] === "string") gid = params[0];
              else if (params[0] && params[0].gid) gid = params[0].gid;
            }
            if (gid) fetchTaskStatus(gid);
            else populateCache();
          }
        } catch (e) {}
      });

      wsClient.on("close", () => {
        wsClient = null;
        connecting = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWs, reconnectDelay);
        reconnectDelay = Math.min(60000, reconnectDelay * 1.5);
      });

      wsClient.on("error", () => {});
    };
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, 1000);
  },

  // FFmpeg merging is handled by FFmpegController

  // تحديث دالة addDownload لتمرير الخصائص القتالية لكل رابط بشكل منفصل
  async addDownload(url, filename = null, headers = null, extraOptions = {}) {
    try {
      const options = {
        "max-connection-per-server": "16",
        split: "16",
        "min-split-size": "1M",
      };

      if (filename) {
        // 🟢 الحل السحري: استخدام escape لضمان وصول Unicode لـ Aria2
        options.out = filename;
      }

      if (headers && Object.keys(headers).length > 0) {
        options.header = Object.entries(headers).map(
          ([key, value]) => `${key}: ${value}`,
        );
        if (headers["User-Agent"]) {
          options["user-agent"] = headers["User-Agent"];
        }
      }

      // Merge any caller-specified aria2 options (e.g., check-certificate)
      if (extraOptions && typeof extraOptions === "object") {
        for (const k of Object.keys(extraOptions)) {
          options[k] = extraOptions[k];
        }
      }

      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "double-d",
          method: "aria2.addUri",
          params: [[url], options],
        }),
      });
      const data = await response.json();
      // تحديث الكاش لو نجح
      if (data && data.result) {
        // GID
        const gid = data.result;
        fetchTaskStatus(gid);
      }
      return data.result;
    } catch (error) {
      console.error("❌ فشل إرسال الرابط لـ Aria2:", error);
      return null;
    }
  },

  stop() {
    if (aria2Process) {
      try { aria2Process.kill(); } catch (e) {}
      aria2Process = null;
      isRunning = false;
    }
    if (wsClient) {
      try { wsClient.close(); } catch (e) {}
      wsClient = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  },

  // 📊 جلب كل التحميلات بجميع حالاتها (نشط - منتظر - متوقف/فاشل)
  async getAllTasks() {
    // نُعيد من الكاش المحلّي أولاً، ونقFallback للـ RPC لو الكاش فاضي
    if (tasksCache.size > 0) return Array.from(tasksCache.values());
    try {
      await populateCache();
      return Array.from(tasksCache.values());
    } catch (e) {
      return [];
    }
  },

  async pauseTask(gid) {
    try {
      await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "pause",
          method: "aria2.pause",
          params: [gid],
        }),
      });
      return true;
    } catch (error) {
      console.error("❌ فشل إيقاف المهمة:", error);
      return false;
    }
  },

  // ▶️ استكمال التحميل المؤقوف
  async resumeTask(gid) {
    try {
      await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "unpause",
          method: "aria2.unpause",
          params: [gid],
        }),
      });
      return true;
    } catch (error) {
      console.error("❌ فشل استكمال المهمة:", error);
      return false;
    }
  },

  // 🗑️ حذف التحميل نهائياً من القائمة (إلغاء التحميل)
  async removeTask(gid) {
    try {
      await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "remove",
          method: "aria2.forceRemove",
          params: [gid],
        }),
      });
      return true;
    } catch (error) {
      console.error("❌ فشل حذف المهمة:", error);
      return false;
    }
  },
};
