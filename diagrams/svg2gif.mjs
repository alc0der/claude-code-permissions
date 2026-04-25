import { chromium } from 'playwright';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';

const [, , svgPath, gifPath, framesArg, durationMsArg, scaleArg] = process.argv;
if (!svgPath || !gifPath) {
  console.error('usage: node svg2gif.mjs <svg> <gif> [frames=60] [durationMs=4933] [scale=1]');
  process.exit(2);
}

const frames = Number(framesArg ?? 60);
const durationMs = Number(durationMsArg ?? 4933);
const scale = Number(scaleArg ?? 1);
const interval = durationMs / frames;
const absSvg = resolve(svgPath);
const absGif = resolve(gifPath);
const framesDir = resolve(tmpdir(), `svg2gif-${process.pid}-${basename(absSvg, '.svg')}`);

if (existsSync(framesDir)) rmSync(framesDir, { recursive: true });
mkdirSync(framesDir, { recursive: true });

const svgText = readFileSync(absSvg, 'utf8');

function parseDims(text) {
  const m = text.match(/<svg\b[^>]*>/i);
  if (!m) throw new Error('no <svg> tag found');
  const tag = m[0];
  const wAttr = tag.match(/\bwidth="([^"]+)"/i);
  const hAttr = tag.match(/\bheight="([^"]+)"/i);
  const vbAttr = tag.match(/\bviewBox="([^"]+)"/i);
  let w = wAttr ? parseFloat(wAttr[1]) : null;
  let h = hAttr ? parseFloat(hAttr[1]) : null;
  if ((!w || !h) && vbAttr) {
    const [, , vw, vh] = vbAttr[1].split(/\s+/).map(Number);
    w = w || vw; h = h || vh;
  }
  return { w, h };
}

const { w, h } = parseDims(svgText);
const W = Math.ceil(w * scale);
const H = Math.ceil(h * scale);
console.log(`[${basename(absSvg)}] ${w}x${h} -> ${frames} frames over ${durationMs}ms`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const html = `<!doctype html><html><head><style>
html,body{margin:0;padding:0;background:white}
#wrap{width:${W}px;height:${H}px}
#wrap > svg{width:${W}px;height:${H}px;display:block}
</style></head><body><div id="wrap">${svgText}</div></body></html>`;
await page.setContent(html);
await page.waitForSelector('#wrap > svg');

const start = Date.now();
for (let i = 0; i < frames; i++) {
  const target = start + i * interval;
  const wait = target - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  const path = `${framesDir}/frame-${String(i).padStart(3, '0')}.png`;
  await page.screenshot({ path, clip: { x: 0, y: 0, width: W, height: H } });
}
await browser.close();

// Stitch with ImageMagick. Per-frame delay in 1/100 s to span durationMs evenly.
const delay = Math.max(2, Math.round((durationMs / frames) / 10));
mkdirSync(dirname(absGif), { recursive: true });
execFileSync('magick', [
  '-delay', String(delay),
  '-loop', '0',
  `${framesDir}/frame-*.png`,
  '-layers', 'Optimize',
  absGif,
], { stdio: 'inherit', shell: true });

rmSync(framesDir, { recursive: true });
const meta = execFileSync('magick', ['identify', '-format', '%n %wx%h', absGif]).toString().split('\n')[0];
console.log(`[${basename(absGif)}] frames=${meta.split(' ')[0]} size=${meta.split(' ')[1]}`);
