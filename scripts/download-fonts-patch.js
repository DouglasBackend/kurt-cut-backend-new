/**
 * PATCH: adicionar estas entradas ao array FONTS_TO_DOWNLOAD em scripts/download-fonts.js
 * Os presets novos que usam fontes já existentes (Arial Black, Courier New, Impact, Segoe Print)
 * são fontes do sistema — não precisam de download.
 *
 * Fontes já presentes no backend (assets/fonts/) que cobrem todos os 53 presets:
 *
 *  ✅ Bangers         → Bangers-Regular.ttf
 *  ✅ Bungee          → Bungee-Regular.ttf
 *  ✅ Righteous       → Righteous-Regular.ttf
 *  ✅ Russo One       → RussoOne-Regular.ttf
 *  ✅ Orbitron        → Orbitron-Regular.ttf
 *  ✅ Staatliches     → Staatliches-Regular.ttf
 *  ✅ Monoton         → Monoton-Regular.ttf
 *  ✅ Press Start 2P  → PressStart2P-Regular.ttf
 *  ✅ Black Ops One   → BlackOpsOne-Regular.ttf
 *  ✅ Ultra           → Ultra-Regular.ttf
 *  ✅ Bebas Neue      → BebasNeue-Regular.ttf
 *  ✅ Pacifico        → Pacifico-Regular.ttf
 *  ✅ Alfa Slab One   → AlfaSlabOne-Regular.ttf
 *  ✅ Lobster         → Lobster-Regular.ttf
 *  ✅ Fredoka One     → FredokaOne-Regular.ttf
 *  ✅ Anton           → Anton-Regular.ttf
 *  ✅ Arial Black     → ArialBlack.ttf
 *  ✅ Impact          → Impact.ttf
 *  ✅ Montserrat      → Montserrat-Bold.ttf
 *  ✅ Oswald          → Oswald-Bold.ttf
 *
 *  ℹ️  Courier New   → fonte do sistema (Chromium já inclui)
 *  ℹ️  Segoe Print   → fonte do sistema Windows (fallback: Courier New no Linux)
 *
 * CONCLUSÃO: Nenhum download adicional necessário. Todas as fontes dos 30 novos
 * presets (Arial Black, Courier New, Impact) já estão disponíveis no servidor.
 */

// Se quiser garantir Segoe Print no Linux (para o preset "chalkboard"),
// adicione esta entrada no array FONTS_TO_DOWNLOAD:
const SEGOE_PRINT_FALLBACK = {
  name: 'Patrick Hand',  // substituto open-source para Segoe Print
  url: 'https://fonts.gstatic.com/s/patrickhand/v23/LDI1apSQOAYtSuYWp8ZhfYe8UcLLuhQ.ttf',
  filename: 'PatrickHand-Regular.ttf',
};

// E no SubtitleOverlay.tsx, o case 'chalkboard' já usa:
// fontFamily: "'Courier New', monospace"  ← fallback seguro em produção
