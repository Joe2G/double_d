import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { BinaryManager } from "./BinaryManager.js";

export const FFmpegController = {
  mergeVideoAudio(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
      const ffmpegPath = BinaryManager.getFfmpegPath();
      if (!ffmpegPath) return reject(new Error("ffmpeg not found"));

      const args = [
        "-i",
        videoPath,
        "-i",
        audioPath,
        "-c",
        "copy",
        "-y",
        outputPath,
      ];

      execFile(ffmpegPath, args, (err, stdout, stderr) => {
        if (err) {
          console.error("FFmpeg merge error:", stderr || err.message);
          return reject(err);
        }
        resolve(outputPath);
      });
    });
  },

  convertAudioToMp3(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const ffmpegPath = BinaryManager.getFfmpegPath();
      if (!ffmpegPath) return reject(new Error("ffmpeg not found"));
      try {
        if (!fs.existsSync(inputPath)) return reject(new Error("input file does not exist"));
        const stat = fs.statSync(inputPath);
        if (stat.size === 0) return reject(new Error("input file is empty"));
      } catch (e) {
        return reject(e);
      }

      // Force MP3 muxer and convert audio to libmp3lame (high quality)
      const args = ["-i", inputPath, "-vn", "-codec:a", "libmp3lame", "-q:a", "0", "-f", "mp3", "-y", outputPath];
      execFile(ffmpegPath, args, (err, stdout, stderr) => {
        if (err) {
          console.error("FFmpeg convert error:", stderr || err.message);
          return reject(err);
        }
        resolve(outputPath);
      });
    });
  },

  cleanupTempFiles(downloadsDir = null) {
    try {
      if (!downloadsDir) downloadsDir = path.join(process.env.HOME || process.cwd(), "Downloads", "DoubleD");
      if (!fs.existsSync(downloadsDir)) return;
      const files = fs.readdirSync(downloadsDir);
      for (const f of files) {
        if (f.startsWith("temp_")) {
          try {
            fs.unlinkSync(path.join(downloadsDir, f));
          } catch (e) {}
        }
      }
    } catch (e) {
      console.warn("cleanupTempFiles failed:", e.message);
    }
  },
};
