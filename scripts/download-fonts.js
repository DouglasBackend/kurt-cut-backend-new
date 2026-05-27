#!/usr/bin/env node
/**
 * scripts/download-fonts.js
 *
 * Downloads all Google Fonts required by subtitle presets.
 * Run once during server setup:
 *   node scripts/download-fonts.js
 *
 * Fonts are saved to: assets/fonts/
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const FONTS_DIR = path.resolve(process.cwd(), 'assets/fonts');
if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });

// Google Fonts static TTF direct download URLs
const FONTS = [
  {
    name: 'Bangers-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/bangers/Bangers-Regular.ttf',
  },
  {
    name: 'Bungee-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/bungee/Bungee-Regular.ttf',
  },
  {
    name: 'Righteous-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/righteous/Righteous-Regular.ttf',
  },
  {
    name: 'RussoOne-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/russoone/RussoOne-Regular.ttf',
  },
  {
    name: 'Orbitron-Regular.ttf',
    url: 'https://fonts.gstatic.com/s/orbitron/v35/yMJMMIlzdpvBhQQL_SC3X9yhF25-T1nyGy6xpg.ttf',
  },
  {
    name: 'Staatliches-Regular.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/staatliches/Staatliches-Regular.ttf',
  },
  {
    name: 'Monoton-Regular.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/monoton/Monoton-Regular.ttf',
  },
  {
    name: 'PressStart2P-Regular.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/pressstart2p/PressStart2P-Regular.ttf',
  },
  {
    name: 'BlackOpsOne-Regular.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/blackopsone/BlackOpsOne-Regular.ttf',
  },
  {
    name: 'Ultra-Regular.ttf',
    url: 'https://fonts.gstatic.com/s/ultra/v25/zOLy4prXmrtY-tT6.ttf',
  },
  {
    name: 'BebasNeue-Regular.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/bebasneue/BebasNeue-Regular.ttf',
  },
  {
    name: 'Pacifico-Regular.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/pacifico/Pacifico-Regular.ttf',
  },
  {
    name: 'AlfaSlabOne-Regular.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/alfaslabone/AlfaSlabOne-Regular.ttf',
  },
  {
    name: 'Lobster-Regular.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/lobster/Lobster-Regular.ttf',
  },
  {
    name: 'FredokaOne-Regular.ttf',
    url: 'https://fonts.gstatic.com/s/fredokaone/v15/k3kUo8kEI-tA1RRcTZGmTmHB.ttf',
  },
  {
    name: 'Anton-Regular.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/anton/Anton-Regular.ttf',
  },
  {
    name: 'Montserrat-Bold.ttf',
    url: 'https://fonts.gstatic.com/s/montserrat/v31/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCuM70w-.ttf',
  },
  {
    name: 'Oswald-Bold.ttf',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/oswald/static/Oswald-Bold.ttf',
  },
  {
    name: 'PatrickHand-Regular.ttf', // substituto open-source para Segoe Print
    url: 'https://fonts.gstatic.com/s/patrickhand/v23/LDI1apSQOAYtSuYWp8ZhfYe8UcLLuhQ.ttf',
    filename: 'PatrickHand-Regular.ttf',
  },
];

// System fonts that should already be present on most Linux servers
// If not, install: sudo apt-get install fonts-liberation
const SYSTEM_FONTS_HINT = [
  'Arial Black  → fonts-liberation or msttcorefonts',
  'Impact       → fonts-liberation or msttcorefonts',
  '  sudo apt-get install fonts-liberation',
  '  or: sudo apt-get install ttf-mscorefonts-installer',
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      console.log(`  ✓ skip (exists): ${path.basename(dest)}`);
      return resolve();
    }
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          fs.unlinkSync(dest);
          return download(res.headers.location, dest)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
  });
}

async function copyWindowsSystemFonts() {
  if (process.platform !== 'win32') return;
  console.log('Detected Windows, attempting to copy Arial Black and Impact...');
  const WIN_FONTS = 'C:\\Windows\\Fonts';
  const mapping = {
    'ariblk.ttf': 'ArialBlack.ttf',
    'impact.ttf': 'Impact.ttf',
  };
  for (const [src, dest] of Object.entries(mapping)) {
    const srcPath = path.join(WIN_FONTS, src);
    const destPath = path.join(FONTS_DIR, dest);
    if (fs.existsSync(srcPath)) {
      try {
        fs.copyFileSync(srcPath, destPath);
        console.log(`  ✓ copied: ${dest}`);
      } catch (e) {
        console.log(`  ✗ failed to copy ${src}: ${e.message}`);
      }
    } else {
      console.log(`  ! source not found: ${srcPath}`);
    }
  }
}

async function main() {
  console.log(`\nDownloading fonts to: ${FONTS_DIR}\n`);

  await copyWindowsSystemFonts();

  let ok = 0,
    fail = 0;
  for (const f of FONTS) {
    process.stdout.write(`  Downloading ${f.name}... `);
    try {
      await download(f.url, path.join(FONTS_DIR, f.name));
      process.stdout.write('✓\n');
      ok++;
    } catch (e) {
      process.stdout.write(`✗ (${e.message})\n`);
      fail++;
    }
  }
  console.log(`\nDone: ${ok} ok, ${fail} failed\n`);
  console.log('System fonts needed (install separately if on Linux):');
  SYSTEM_FONTS_HINT.forEach((h) => console.log('  ' + h));
  console.log('');
}

main().catch(console.error);
