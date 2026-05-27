const cp = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const cmd = `"${ffmpegPath}" -y -f lavfi -i color=c=black:s=1080x1920:d=5 -loglevel trace -vf "ass='test.ass':fontsdir='assets/fonts'" test_output.mp4`;

console.log("Running command:", cmd);
try {
  const result = cp.execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' });
  console.log("Success:\n", result);
} catch (e) {
  console.error("Error stdout:\n", e.stdout);
  console.error("Error stderr:\n", e.stderr);
}
