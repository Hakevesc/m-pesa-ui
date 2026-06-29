const fs = require('fs');
const path = require('path');
const root = 'C:/Users/LEGION/Documents/My Project/M-PESA App/M-PESA Lehulum';
const page = process.argv[2];
const tokens = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean);
const html = fs.readFileSync(path.join(root, page), 'utf8');
const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).map(b => b.replace(/<\/?style[^>]*>/gi, '')).join('\n');
const out = [];
function walk(start, end) {
  let j = start;
  while (j < end) {
    const brace = css.indexOf('{', j);
    if (brace === -1 || brace >= end) break;
    const selector = css.slice(j, brace).trim();
    let depth = 1, k = brace + 1;
    while (k < end && depth > 0) { const c = css[k]; if (c === '{') depth++; else if (c === '}') depth--; k++; }
    const body = css.slice(brace + 1, k - 1);
    if (/^@(media|supports)/.test(selector)) walk(brace + 1, k - 1);
    else if (/^@keyframes/.test(selector)) { if (tokens.some(t => selector.includes(t.replace(/^\./, '')))) out.push(selector + ' {' + body.trim() + '}'); }
    else if (selector && !selector.startsWith('@')) { if (selector.split(',').some(s => tokens.some(t => s.includes(t)))) out.push(selector.trim() + ' { ' + body.trim().replace(/\s*\n\s*/g, ' ') + ' }'); }
    j = k;
  }
}
walk(0, css.length);
console.log(out.join('\n'));
console.log('\n--- ' + out.length + ' rules for [' + tokens.join(', ') + '] in ' + page + ' ---');
