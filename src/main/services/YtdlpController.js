import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import { app } from "electron";
import { BinaryManager } from "./BinaryManager.js";

function resolveYtdlp(customPath = null) {
  // Prefer explicit custom path, then BinaryManager discovery, then fallback
  if (customPath) return customPath;
  const fromBM = BinaryManager.getYtdlpPath();
  if (fromBM) return fromBM;
  const isDev = process.env.VITE_DEV_SERVER_URL;
  return isDev
    ? path.join(app.getAppPath(), "bin", "yt-dlp.exe")
    : path.join(process.resourcesPath, "bin", "yt-dlp.exe");
}

export const YtdlpController = {
  // استخراج بيانات التحميل (رابط مباشر + اسم ملف)
  extractVideoData(videoUrl, customBinPath = null, formatId = "best") {
    return new Promise((resolve, reject) => {
      let binPath = customBinPath;

      if (!binPath) {
        const appDataPath = path.join(
          app.getPath("userData"),
          "bin",
          "yt-dlp.exe",
        ); //[cite: 18]
        if (fs.existsSync(appDataPath)) {
          binPath = appDataPath; //[cite: 18]
        } else {
          const isDev = process.env.VITE_DEV_SERVER_URL; //[cite: 18]
          binPath = isDev //[cite: 18]
            ? path.join(app.getAppPath(), "bin", "yt-dlp.exe") //[cite: 18]
            : path.join(process.resourcesPath, "bin", "yt-dlp.exe"); //[cite: 18]
        }
      }

      const binFolder = path.dirname(binPath);
      const downloadDir = path.join(app.getPath("downloads"), "DoubleD");
      if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
      }

      console.log(`🔍 Starting scan and download for quality: ${formatId}`); //[cite: 18]

      // إعداد المصفوفة الأساسية للـ Arguments
      let args = ["--ffmpeg-location", binFolder];

      // 🧠 التكتيك الذكي: هل الطلب الحالي هو "صوت فقط"؟
      // بنعرف لو الـ formatId جاي من كود الصوت (أو لو اليوزر اختار أفضل صوت تلقائي)
      const isAudioTask =
        formatId.includes("audio") || formatId === "bestaudio";

      if (isAudioTask || formatId === "140" || formatId === "251") {
        // 🎵 إذا كان المطلوب صوتاً: استخراج وتحويل مباشر لـ MP3 بكود مخصص
        args.push(
          "-f",
          "bestaudio",
          "--extract-audio",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "0", // (0 تعني أعلى جودة صوت MP3 وهي 320kbps)
          "-o",
          path.join(downloadDir, "%(title)s.%(ext)s"),
        );
      } else {
        // 🎬 إذا كان المطلوب فيديو عالي الجودة: دمج الفيديو مع أفضل صوت في ملف MP4
        let formatArgument = formatId;
        if (formatId !== "best" && !formatId.includes("+")) {
          formatArgument = `${formatId}+bestaudio/best`;
        }
        args.push(
          "-f",
          formatArgument,
          "--merge-output-format",
          "mp4",
          "-o",
          path.join(downloadDir, "%(title)s_%(resolution)s.%(ext)s"),
        );
      }

      // إضافة أمر الـ JSON في الآخر عشان القراءة النهائية
      args.push("--dump-json", videoUrl);

      const binPathFinal = resolveYtdlp(binPath);
      execFile(
        binPathFinal,
        args,
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) return reject(error);

          // 1. تنظيف المخرجات من أي سطور فارغة أو رموز تحكم خفية في الويندوز
          let lines = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          let rawName = lines[0] || "video";

          // 2. تنظيف الرموز الممنوعة في نظام الويندوز فقط مع حماية كاملة للعربي
          rawName = rawName.replace(/[\\/:*?"<>|]/g, "_");

          // 3. التأكد من إن الاسم مطالعش فاضي بعد التنظيف
          if (
            !rawName.trim() ||
            rawName === ".mp4" ||
            rawName === ".mkv" ||
            rawName === ".mp3"
          ) {
            rawName = "YouTube_Video_" + Date.now();
          }

          if (rawName.length > 150) {
            const ext = path.extname(rawName);
            const base = rawName.slice(0, 150 - ext.length);
            rawName = base + ext;
          }

          resolve(rawName);
        },
      );
    });
  },

  // جلب الجودات المتاحة فقط
  getAvailableFormats(videoUrl, binPath) {
    return new Promise((resolve, reject) => {
      // ضفنا --dump-json بدل -j لأنها أدق، و --no-warnings لمنع أي نصوص تخرب الـ JSON
      const args = [
        "--dump-json",
        "--no-warnings",
        "--no-playlist",
        "--quiet",
        "--playlist-end",
        "1",
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        videoUrl,
      ];

      const binPathFinal = resolveYtdlp(binPath);
      execFile(
        binPathFinal,
        args,
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 },
        (error, stdout, stderr) => {
          if (error && !stdout) {
            console.error(
              "❌ خطأ في الفحص (البرنامج فشل):",
              stderr || error.message,
            );
            return reject(error);
          }
          try {
            // فلترة المخرجات: أحياناً yt-dlp بيطبع سطور فارغة قبل أو بعد الـ JSON
            const jsonString = stdout.trim().split("\n").pop();
            if (!jsonString) {
              throw new Error("المخرجات فارغة");
            }

            const info = JSON.parse(jsonString);

            if (!info.formats || info.formats.length === 0) {
              console.warn("⚠️ مفيش فورمات! الرابط قد يكون Live.");
              return resolve([]);
            }

            // 🧹 الفلترة الذكية: MP4 للفيديو، وصوت MP3
            const formats = info.formats
              .filter((f) => {
                if (!f.format_id) return false;
                const isVideo = f.vcodec !== "none" && f.vcodec != null;
                const isAudioOnly =
                  f.vcodec === "none" || f.resolution === "audio only";

                if (isVideo && f.ext === "mp4") return true;
                if (isAudioOnly && (f.ext === "m4a" || f.ext === "webm"))
                  return true;
                return false;
              })
              .map((f) => {
                const isAudioOnly =
                  f.vcodec === "none" || f.resolution === "audio only";
                const sizeInBytes = f.filesize || f.filesize_approx;
                const sizeText = sizeInBytes
                  ? (sizeInBytes / 1024 / 1024).toFixed(1) + " MB"
                  : "مجهول";

                return {
                  format_id: f.format_id,
                  resolution: isAudioOnly
                    ? "🎵 صوت MP3 عالي الجودة"
                    : `🎬 ${f.resolution}`,
                  ext: isAudioOnly ? "mp3" : f.ext,
                  filesize: sizeText,
                };
              });

            // 💡 التعديل السحري: إزالة التكرار (نحتفظ بنسخة واحدة من كل جودة)
            const uniqueFormats = [];
            const seenResolutions = new Set();

            // yt-dlp يرتب الجودات من الأقل للأعلى، نعكسها أولاً لنجلب الأفضل
            const reversedFormats = formats.reverse();

            for (const f of reversedFormats) {
              if (!seenResolutions.has(f.resolution)) {
                seenResolutions.add(f.resolution);
                uniqueFormats.push(f);
              }
            }

            // إرسال اللستة النظيفة للواجهة (أحادي المسار للـ Promise)
            resolve(uniqueFormats);
          } catch (e) {
            console.error(
              "❌ Error processing JSON (returned data is not valid JSON):",
              e.message,
            );
            // Print the first 100 characters of the output to help debug the invalid JSON
            console.log("Invalid output:", stdout.substring(0, 100));
            reject(e);
          }
        },
      );
    });
  },

  // أضف هذه الدالة داخل كائن YtdlpController
  getDirectUrl(videoUrl, binPath, formatId = "best") {
    return new Promise((resolve, reject) => {

      const args = [
        "-f",
        formatId,
        "--get-url", // 👈 هذا السحر: يطبع الرابط المباشر فقط
        "--no-warnings",
        "--quiet",
        "--no-playlist",
        "--playlist-end",
        "1",
        videoUrl,
      ];

      const binPathFinal = resolveYtdlp(binPath);
      execFile(
        binPathFinal,
        args,
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            console.error(
              "❌ فشل الحصول على الرابط المباشر:",
              stderr || error.message,
            );
            return reject(error);
          }
          const directUrl = stdout.trim().split("\n")[0];
          if (!directUrl) return reject(new Error("لم يتم العثور على رابط"));
          resolve(directUrl);
        },
      );
    });
  },

  getSuggestedFilename(videoUrl, binPath, formatId = "best") {
    return new Promise((resolve, reject) => {

      // 🎯 طريقتك الذكية بنظام الـ JSON لمنع تشوه العربي
      const args = [
        "-f",
        formatId,
        "--dump-json",
        "--no-warnings",
        "--quiet",
        "--no-playlist",
        "--playlist-end",
        "1",
        videoUrl,
      ];

      const binPathFinal = resolveYtdlp(binPath);
      execFile(
        binPathFinal,
        args,
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 },
        (error, stdout) => {
          if (error) return reject(error);

          try {
            const lines = stdout.trim().split("\n");
            const jsonString = lines[lines.length - 1];
            const videoInfo = JSON.parse(jsonString);

            // 🟢 استخراج الاسم وتنظيف الرموز الممنوعة في الويندوز مع حماية كاملة للعربي
            let safeTitle = videoInfo.title
              .replace(/[\\/:*?"<>|]/g, "_")
              .trim();

            // تحديد الامتداد الذكي (لو صوت خليه mp3، ولو فيديو ومكتوب mp4_dash خليه mp4 عادي)
            let ext = videoInfo.ext || "mp4";
            if (
              formatId === "ba" ||
              formatId === "bestaudio" ||
              ext === "m4a"
            ) {
              ext = "mp3";
            } else if (ext.includes("mp4")) {
              ext = "mp4";
            }

            let filename = `${safeTitle}.${ext}`;

            // 🛡️ خط دفاع: لو اسم الفيديو العربي طويل جداً، بنقصه عشان الويندوز ميضربش
            if (filename.length > 150) {
              const base = safeTitle.slice(0, 140);
              filename = `${base}.${ext}`;
            }

            resolve(filename);
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  },

  // جلب معلومات كاملة عن كل الفورمات (عشان نعرف مين فيه صوت)
  async getFormatsInfo(videoUrl, binPath) {
    return new Promise((resolve, reject) => {

      const args = [
        "--dump-json",
        "--no-warnings",
        "--quiet",
        "--no-playlist", // 🟢 منع معالجة playlist
        "--playlist-end",
        "1", // 🟢 خد أول فيديو بس
        videoUrl,
      ];

      const binPathFinal = resolveYtdlp(binPath);
      execFile(
        binPathFinal,
        args,
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 }, // 🟢 زيادة إلى 50 ميجا
        (error, stdout) => {
          if (error) return reject(error);
          try {
            const lines = stdout.trim().split("\n");
            const jsonString = lines[lines.length - 1];
            const info = JSON.parse(jsonString);
            const formats = info.formats.map((f) => ({
              format_id: f.format_id,
              resolution:
                f.resolution ||
                (f.vcodec !== "none" ? `${f.height}p` : "audio"),
              ext: f.ext,
              vcodec: f.vcodec,
              acodec: f.acodec,
              filesize: f.filesize || f.filesize_approx,
              hasAudio: f.acodec !== "none",
              hasVideo: f.vcodec !== "none",
            }));
            resolve(formats);
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  },

  // تحميل الصوت وتحويله إلى MP3 باستخدام yt-dlp (لأنه أسهل للتحويل)
  async downloadAudioAsMp3(videoUrl, binPath, outputPath) {
    return new Promise((resolve, reject) => {
      const binPathFinal = resolveYtdlp(binPath);
      const args = [
        "-f",
        "bestaudio",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "-o",
        outputPath,
        videoUrl,
      ];
      // binPathFinal already resolved above
      execFile(
        binPathFinal,
        args,
        { encoding: "utf8", timeout: 120000 },
        (error) => {
          if (error) reject(error);
          else resolve(outputPath);
        },
      );
    });
  },

  isVideoPlatform(url) {
    const videoDomains = [
      "youtube.com",
      "youtu.be",
      "facebook.com",
      "fb.watch",
      "instagram.com",
      "tiktok.com",
      "twitter.com",
      "x.com",
      "vimeo.com",
    ];
    return videoDomains.some((domain) => url.toLowerCase().includes(domain));
  },
};
