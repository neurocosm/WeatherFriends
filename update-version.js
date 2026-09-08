import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getEasternVersion(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || '';
  let hh = get('hour');
  if (hh === '24') hh = '00';
  return `v1.${get('month')}${get('day')}${get('year')}.${hh}${get('minute')}`;
}

const currentVersion = getEasternVersion();

// 1. Write version.json
const versionData = {
  version: currentVersion,
  timezone: 'America/New_York (Eastern Time / EDT / EST)',
  updatedAt: new Date().toISOString()
};
fs.writeFileSync(path.join(__dirname, 'version.json'), JSON.stringify(versionData, null, 2));

// 2. Update index.html
const indexPath = path.join(__dirname, 'index.html');
if (fs.existsSync(indexPath)) {
  let indexHtml = fs.readFileSync(indexPath, 'utf8');
  indexHtml = indexHtml.replace(/const CLIENT_APP_VERSION = 'v1\.[^']+';/, `const CLIENT_APP_VERSION = '${currentVersion}';`);
  indexHtml = indexHtml.replace(/<span id="appVersionText">v1\.[^<]+<\/span>/, `<span id="appVersionText">${currentVersion}</span>`);
  fs.writeFileSync(indexPath, indexHtml);
}

// 3. Update sw.js CACHE_NAME so browsers/tablets/Smart TVs immediately detect and activate new worker
const swPath = path.join(__dirname, 'sw.js');
if (fs.existsSync(swPath)) {
  let swJs = fs.readFileSync(swPath, 'utf8');
  swJs = swJs.replace(/const CACHE_NAME = '[^']+';/, `const CACHE_NAME = 'wf-${currentVersion}';`);
  fs.writeFileSync(swPath, swJs);
}

console.log(`[Version Revision] Set to Eastern US Time (EDT/EST): ${currentVersion}`);
