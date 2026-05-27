const ffmpegPath = require('ffmpeg-static');
const { execSync } = require('child_process');
const path = require('path');

console.log('--- Diagnóstico FFmpeg Static ---');
console.log('Caminho retornado pelo ffmpeg-static:', ffmpegPath);

// Verificar se o caminho está dentro do projeto
const projectRoot = path.resolve(__dirname, '..');
if (ffmpegPath.startsWith(projectRoot)) {
    console.log('✅ O binário está dentro da pasta do projeto (node_modules).');
} else {
    console.warn('⚠️ O binário parece estar fora da pasta do projeto!');
}

try {
    // Executar o binário específico retornado pela biblioteca
    const output = execSync(`"${ffmpegPath}" -version`).toString();
    console.log('\n--- Saída do FFmpeg -version ---');
    console.log(output.split('\n')[0]); // Mostrar apenas a primeira linha (versão)
    console.log('✅ Executável funcionando corretamente.');
} catch (error) {
    console.error('❌ Erro ao executar o FFmpeg static:', error.message);
    process.exit(1);
}
