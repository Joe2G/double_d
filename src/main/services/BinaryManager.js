import path from "path";
import fs from "fs";
import { app } from "electron";

function resolveFromUserData(name) {
  const p = path.join(app.getPath("userData"), "bin", name);
  if (fs.existsSync(p)) return p;
  return null;
}

function resolveFromResources(name) {
  const p = path.join(process.resourcesPath || app.getAppPath(), "bin", name);
  if (fs.existsSync(p)) return p;
  return null;
}

export const BinaryManager = {
  getYtdlpPath() {
    return (
      resolveFromUserData("yt-dlp.exe") || resolveFromResources("yt-dlp.exe")
    );
  },

  getAria2Path() {
    return (
      resolveFromUserData("aria2c.exe") || resolveFromResources("aria2c.exe")
    );
  },

  getFfmpegPath() {
    return (
      resolveFromUserData("ffmpeg.exe") || resolveFromResources("ffmpeg.exe")
    );
  },
};
