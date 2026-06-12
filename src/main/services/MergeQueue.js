import EventEmitter from "events";
import { FFmpegController } from "./FFmpegController.js";

class MergeQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.processing = false;
  }

  enqueueMerge(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
      this.queue.push({ videoPath, audioPath, outputPath, resolve, reject });
      this.processNext();
    });
  }

  async processNext() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        try {
          const out = await FFmpegController.mergeVideoAudio(
            task.videoPath,
            task.audioPath,
            task.outputPath,
          );
          task.resolve(out);
          this.emit("merged", out);
        } catch (e) {
          try { task.reject(e); } catch (ee) {}
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

export const mergeQueue = new MergeQueue();
