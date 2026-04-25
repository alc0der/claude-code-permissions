import { chromium } from 'playwright';
import { mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';

const [, , svgPath, gifPath, fpsArg, durationMsArg, widthArg, qualityArg] = process.argv;
if (!svgPath || !gifPath) {
  console.error('usage: node svg2gif.mjs <svg> <gif> [fps=15] [durationMs=4933] [width=1200] [quality=90]');
  process.exit(2);
}

const fps = Number(fpsArg ?? 15);
const durationMs = Number(durationMsArg ?? 4933);
const targetWidth = Number(widthArg ?? 1200);
const quality = Number(qualityArg ?? 90);
const settleMs = 600;

const absSvg = resolve(svgPath);
const absGif = resolve(gifPath);
const work = resolve(tmpdir(), `svg2gif-${process.pid}-${basename(absSvg, '.svg')}`);

if (existsSync(work)) rmSync(work, { recursive: true });
mkdirSync(work, { recursive: true });

const svgText = readFileSync(absSvg, 'utf8');
const tag = svgText.match(/<svg\b[^>]*>/i)[0];
const wAttr = tag.match(/\bwidth="([^"]+)"/i);
const hAttr = tag.match(/\bheight="([^"]+)"/i);
const vbAttr = tag.match(/\bviewBox="([^"]+)"/i);
let w = wAttr ? parseFloat(wAttr[1]) : null;
let h = hAttr ? parseFloat(hAttr[1]) : null;
if ((!w || !h) && vbAttr) {
  const [, , vw, vh] = vbAttr[1].split(/\s+/).map(Number);
  w = w || vw; h = h || vh;
}
const renderW = Math.min(Math.ceil(w), targetWidth);
const renderH = Math.ceil((renderW / w) * h);
console.log(`[${basename(absSvg)}] svg=${Math.ceil(w)}x${Math.ceil(h)} render=${renderW}x${renderH} @ ${fps}fps q=${quality}`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: renderW, height: renderH },
  deviceScaleFactor: 1,
  recordVideo: { dir: work, size: { width: renderW, height: renderH } },
});
const page = await context.newPage();

const html = `<!doctype html><html><head><style>
html,body{margin:0;padding:0;background:white}
#wrap{width:${renderW}px;height:${renderH}px}
#wrap > svg{width:${renderW}px;height:${renderH}px;display:block}
</style></head><body><div id="wrap">${svgText}</div></body></html>`;

await page.setContent(html);
await page.waitForSelector('#wrap > svg');
await page.waitForTimeout(settleMs + durationMs);

const video = page.video();
await page.close();
await context.close();
await browser.close();

const rawWebm = await video.path();
const framesDir = resolve(work, 'frames');
mkdirSync(framesDir);

execFileSync('ffmpeg', [
  '-loglevel', 'error',
  '-ss', (settleMs / 1000).toFixed(3),
  '-i', rawWebm,
  '-t', (durationMs / 1000).toFixed(3),
  '-vf', `fps=${fps}`,
  `${framesDir}/f%04d.png`,
], { stdio: 'inherit' });

const frames = readdirSync(framesDir)
  .filter((f) => f.endsWith('.png'))
  .sort()
  .map((f) => resolve(framesDir, f));
if (frames.length === 0) throw new Error('ffmpeg produced no frames');

mkdirSync(dirname(absGif), { recursive: true });
execFileSync('gifski', [
  '--fps', String(fps),
  '--width', String(renderW),
  '--quality', String(quality),
  '--quiet',
  '--output', absGif,
  ...frames,
], { stdio: 'inherit' });

rmSync(work, { recursive: true });

const meta = execFileSync('magick', ['identify', '-format', '%n %wx%h\n', absGif]).toString().split('\n')[0];
console.log(`[${basename(absGif)}] frames=${meta.split(' ')[0]} size=${meta.split(' ')[1]}`);
