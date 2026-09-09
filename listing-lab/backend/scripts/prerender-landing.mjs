// Bake the landing page's marketing markup into web/index.html.
//
// WHY (4 Sep 2026): the front door was a single <div id="app"></div> filled by
// script — 54 characters of visible text without JavaScript. Search engines,
// link previews and anyone with scripts off saw a blank page. This runs the
// page's own renderMarketing() in a headless browser and writes its output
// into the HTML between two markers, so the words are there before any script
// runs; the page script keeps that markup on first paint and only wires the
// behaviour (see the data-ssr branch in render()).
//
// Run after ANY edit to the landing markup or copy, before `wrangler deploy`:
//   node scripts/prerender-landing.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(new URL('.', import.meta.url).pathname, '../web/index.html');
let html = fs.readFileSync(file, 'utf8');
const START = '<!--ssr:start-->', END = '<!--ssr:end-->';

// Start from a clean shell so the renderer runs against the same file it will fill.
const shell = html.replace(new RegExp(`<div id="app"[^>]*>[\\s\\S]*?${END}</div>`), '<div id="app"></div>');
if (!shell.includes('<div id="app"></div>')) throw new Error('no <div id="app"></div> in web/index.html');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.route('**/*', r => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
await page.setContent(shell.replace(/<link[^>]+fonts\.googleapis[^>]*>/g, ''), { waitUntil: 'domcontentloaded' });
const markup = await page.evaluate(() => window.__llRenderMarketing());
await browser.close();
if (!markup || markup.length < 5000 || !/AI enhancement built for/.test(markup)) throw new Error('renderMarketing() output looks wrong');

const out = shell.replace('<div id="app"></div>', `<div id="app" data-ssr="1">${START}${markup}${END}</div>`);
fs.writeFileSync(file, out);
const text = markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
console.log(`prerendered ${markup.length} chars of markup (${text.split(' ').length} words of text) into web/index.html`);
