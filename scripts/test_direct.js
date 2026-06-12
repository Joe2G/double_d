import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/test_direct.js <url>');
  process.exit(2);
}

(async () => {
  try {
    import { pathToFileURL } from 'url';
    const modPath = path.resolve(__dirname, '..', 'src', 'main', 'services', 'YtdlpController.js');
    const Y = await import(pathToFileURL(modPath).href);
    const isVideo = Y.YtdlpController.isVideoPlatform(target);
    console.log('isVideoPlatform:', isVideo);
    const lower = (target||'').toLowerCase();
    const directExts = [
      ".zip",".exe",".msi",".rar",".7z",".pdf",".mp4",".mkv",".webm",".m3u8",".ts",".png",".jpg",".jpeg",".tar",".gz",".iso",".dmg",
    ];
    const looksLikeDirect = directExts.some(ext => lower.includes(ext));
    console.log('looksLikeDirect:', looksLikeDirect);
    console.log('Final decision -> useAria2:', looksLikeDirect || !isVideo);
  } catch (e) {
    console.error('ERROR', e);
    process.exit(1);
  }
})();
