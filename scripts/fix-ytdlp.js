const fs = require('fs');
const path = require('path');
const https = require('https');
const { chmodSync } = require('fs');

const BIN_DIR = path.join(__dirname, '..', 'node_modules', 'yt-dlp-exec', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp');

// URL for the latest Linux binary (compatible with Render's environment)
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

async function downloadBinary(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading yt-dlp from ${url}...`);
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        downloadBinary(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('Download complete.');
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function fix() {
  try {
    if (!fs.existsSync(BIN_DIR)) {
      console.log(`Creating directory ${BIN_DIR}...`);
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    if (fs.existsSync(BIN_PATH)) {
      console.log(`Checking existing binary at ${BIN_PATH}...`);
      const stats = fs.statSync(BIN_PATH);
      if (stats.size > 1000000) { // Simple sanity check for size
        console.log('Binary looks healthy. Ensuring it is executable...');
        chmodSync(BIN_PATH, '755');
        return;
      }
      console.log('Binary looks corrupted or too small. Re-downloading...');
    }

    await downloadBinary(YTDLP_URL, BIN_PATH);
    console.log('Ensuring it is executable...');
    chmodSync(BIN_PATH, '755');
    console.log('✅ yt-dlp is ready!');
  } catch (error) {
    console.error('❌ Failed to fix yt-dlp:', error.message);
    // Don't exit with 1 yet, let the app try to start, but log the error
  }
}

fix();
