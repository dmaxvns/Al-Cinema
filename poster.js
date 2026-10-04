const sharp = require("sharp");
const path = require("path");

const W = 500;
const H = 750;
const FONT_FILE = path.join(__dirname, "fonts", "Poppins-Bold.ttf");

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// testo renderizzato con Pango usando il font incluso nel progetto
// (su Render non ci sono font di sistema affidabili)
function textLayer(text, size, color) {
  return sharp({
    text: {
      text: `<span foreground="${color}">${esc(text)}</span>`,
      font: `Poppins Bold ${size}`,
      fontfile: FONT_FILE,
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer();
}

const gradients = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.92"/>
    </linearGradient>
    <linearGradient id="t" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${W}" height="190" fill="url(#t)"/>
  <rect x="0" y="${H - 230}" width="${W}" height="230" fill="url(#b)"/>
</svg>`);

async function composePoster(posterBuffer, rank, genre) {
  const base = await sharp(posterBuffer)
    .resize(W, H, { fit: "cover" })
    .toBuffer();

  const num = await textLayer(String(rank), 150, "#ffffff");
  const numShadow = await sharp(await textLayer(String(rank), 150, "#000000"))
    .blur(6)
    .toBuffer();

  const layers = [
    { input: gradients, top: 0, left: 0 },
    { input: numShadow, top: 20, left: 24 },
    { input: num, top: 14, left: 20 },
  ];

  if (genre) {
    const size = genre.length > 18 ? 22 : genre.length > 12 ? 26 : 30;
    const g = await textLayer(genre, size, "#d9d9d9");
    const meta = await sharp(g).metadata();
    layers.push({
      input: g,
      top: H - 62,
      left: Math.max(0, Math.round((W - meta.width) / 2)),
    });
  }

  return sharp(base).composite(layers).jpeg({ quality: 82 }).toBuffer();
}

module.exports = { composePoster };
