// Node Mailer (No PowerShell wrappers) with simple license check
// Usage:
//  - npm start            -> start interactive menu
//  - node index.js --test -> send a single test email (requires valid config and license)

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const yaml = require('yaml');
const nodemailer = require('nodemailer');
const https = require('https');
const BACKEND_ROOT = process.env.APP_ROOT || __dirname;
const puppeteer = require('puppeteer');
const GENERATED_PDF_DIR = path.join(__dirname, 'ATTACHMENT', '__generated_pdfs__');
const GENERATED_PDFS = new Set();
const QRCode = require('qrcode');
const clearbitLogoCache = new Map();
const qrCodeCache = new Map(); // Cache for QR codes by content
const templateCache = new Map(); // Cache for loaded HTML templates
const attachmentCache = new Map(); // Global cache for static attachments
const attachmentsListCache = new Map(); // Memoize resolved attachment lists when safe

// Global browser instance for PDF conversion (reuse to save ~1-2s per PDF)
let globalBrowser = null;
async function getBrowserInstance() {
  if (!globalBrowser || !globalBrowser.isConnected()) {
    console.log('[i] Launching browser instance...');
    globalBrowser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // Performance flags
    });
  }
  return globalBrowser;
}

async function closeBrowserInstance() {
  if (globalBrowser) {
    try {
      await globalBrowser.close();
      globalBrowser = null;
      console.log('[i] Browser instance closed');
    } catch (_) { }
  }
}
// Load optional FEATURES from ../../features.js
let FEATURES;
try {
  const featuresPath = path.join(__dirname, '..', '..', 'features.js');
  if (fs.existsSync(featuresPath)) {
    FEATURES = require(featuresPath);
  }
} catch (_) {
  FEATURES = undefined;
}
function ensureGeneratedDir() {
  try { fs.mkdirSync(GENERATED_PDF_DIR, { recursive: true }); } catch (_) { }
}
function cleanupGeneratedPdfs() {
  try {
    if (fs.existsSync(GENERATED_PDF_DIR)) {
      const names = fs.readdirSync(GENERATED_PDF_DIR);
      let cleaned = 0;
      for (const n of names) {
        try {
          const filePath = path.join(GENERATED_PDF_DIR, n);
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        } catch (err) {
          if (VERBOSE) logError(`Failed to delete ${n}`, err);
        }
      }
      if (cleaned > 0 && VERBOSE) {
        logInfo(`Cleaned up ${cleaned} temporary PDF file(s)`);
      }
      try {
        // Only remove directory if it's empty
        const remaining = fs.readdirSync(GENERATED_PDF_DIR);
        if (remaining.length === 0) {
          fs.rmdirSync(GENERATED_PDF_DIR);
        }
      } catch (err) {
        // Directory not empty or already removed, ignore
      }
    }
  } catch (err) {
    if (VERBOSE) logError('Error during PDF cleanup', err);
  }
}

async function cleanup() {
  logInfo('Cleaning up temporary files and resources...');
  cleanupGeneratedPdfs();
  await closeBrowserInstance();
  logSuccess('Cleanup completed');
}

process.on('exit', () => { cleanupGeneratedPdfs(); });
process.on('SIGINT', async () => {
  try {
    await cleanup();
  } catch (_) { }
  process.exit(130);
});

// === Terminal board helpers (ANSI colors + row rendering) ===
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  fg: {
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
  },
  bg: {
    black: "\x1b[40m",
    red: "\x1b[41m",
    green: "\x1b[42m",
    yellow: "\x1b[43m",
    blue: "\x1b[44m",
    magenta: "\x1b[45m",
    cyan: "\x1b[46m",
    white: "\x1b[47m",
  },
};

function padCell(val, width) {
  const s = String(val ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > width) return s.slice(0, Math.max(0, width - 1)) + '…';
  return s.padEnd(width, ' ');
}

function emailAlias(email) {
  try {
    const local = String(email || '').split('@')[0];
    const words = local.replace(/[._-]+/g, ' ').split(' ').filter(Boolean);
    return words.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || email;
  } catch (_) {
    return String(email || '');
  }
}

function printBoardHeader(title = 'QUESSTALL EMAIL SENDER') {
  const banner = `${ANSI.bold}${ANSI.fg.white}${ANSI.bg.black} Administrator: ${title} ${ANSI.reset}`;
  console.log(banner);
}

function renderBoardRow({ name, from, status, subject, to, date }) {
  const colName = padCell(name, 24);
  const colFrom = `${ANSI.bg.green}${ANSI.fg.black}${padCell(from, 24)}${ANSI.reset}`;
  const ok = String(status).toLowerCase() === 'sent' || String(status).toLowerCase().startsWith('would');
  const colStatus = `${ok ? ANSI.bg.green : ANSI.bg.red}${ANSI.fg.white}${padCell(ok ? 'Sent' : 'Failed', 8)}${ANSI.reset}`;
  const colSubject = padCell(subject, 32);
  const colTo = padCell(to, 28);
  const colDate = `${ANSI.bg.magenta}${ANSI.fg.white}${padCell(date, 12)}${ANSI.reset}`;
  console.log(`${colName}  ${colFrom}  ${colStatus}  ${colSubject}  ${colTo}  ${colDate}`);
}

function resolveFirstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { }
  }
  return null;
}

const ARGS = process.argv.slice(2);
let VERBOSE = ARGS.includes('--verbose');
let DRY_RUN = ARGS.includes('--dry-run');
function logStep(msg, data) {
  if (!VERBOSE) return;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [TRACE] ${msg}`);
  if (data === undefined) return;
  try {
    if (Array.isArray(data)) {
      if (data.length && typeof data[0] === 'object') {
        console.table(data);
      } else {
        console.table(data.map((v, i) => ({ Index: i, Value: v })));
      }
    } else if (typeof data === 'object') {
      console.table(data);
    } else {
      console.log(data);
    }
  } catch (_) {
    console.log(data);
  }
}

function logInfo(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [i] ${msg}`);
}

function logError(msg, err = null) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [-] ${msg}`);
  if (err) {
    console.error(`[${timestamp}] [-] Error details:`, err.message || err);
    if (VERBOSE && err.stack) {
      console.error(`[${timestamp}] [-] Stack trace:`, err.stack);
    }
  }
}

function logSuccess(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [✓] ${msg}`);
}

function loadConfig() {
  const candidates = [
    path.join(__dirname, 'SETTING', 'config.yml'),
    path.join(BACKEND_ROOT, 'SETTING', 'config.yml'),
  ];
  logStep('Config candidates', candidates);
  const configPath = resolveFirstExisting(candidates);
  if (!configPath) {
    console.log('[!] config.yml not found. Expected at:');
    console.log('    -', candidates[0]);
    console.log('    -', candidates[1]);
    return {};
  }
  logStep('Using config path', configPath);
  const raw = fs.readFileSync(configPath, 'utf-8');
  try {
    const cfg = yaml.parse(raw) || {};
    logStep('Config keys', Object.keys(cfg));
    return cfg;
  } catch (e) {
    console.log('[!] Failed to parse config.yml:', e.message);
    return {};
  }
}

const { checkLicense: verifyLicense } = require('./license/sys-verify');
const readline = require('readline');

async function checkLicense() {
  let result = verifyLicense();

  if (result.valid) {
    console.log(`${ANSI.fg.green}[✓] Authorization Valid until ${result.data.expiryDate}${ANSI.reset}`);
    return true;
  }

  // If missing, try interactive activation
  if (result.reason === 'AUTH_MISSING') {
    const { getMachineId } = require('./license/hw-config');
    const mid = getMachineId();

    console.log(`\n${ANSI.bg.blue}${ANSI.fg.white} FIRST LAUNCH ACTIVATION ${ANSI.reset}`);
    console.log(`Your Machine ID: ${ANSI.fg.cyan}${mid}${ANSI.reset}`);
    console.log(`${ANSI.dim}Please provide this ID to the developer to get your activation token.${ANSI.reset}\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const token = await new Promise(resolve => {
      rl.question(`${ANSI.bold}Enter Activation Token:${ANSI.reset} `, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });

    if (token) {
      try {
        const { saveAuth } = require('./license/sys-verify');
        saveAuth(token);
        console.log(`[i] Token encrypted and stored securely. Re-verifying...`);
        result = verifyLicense();
      } catch (err) {
        console.log(`[-] Failed to save token: ${err.message}`);
        return false;
      }
    }
  }

  if (result.valid) {
    console.log(`${ANSI.fg.green}[✓] Authorization Successful!${ANSI.reset}`);
    return true;
  }

  console.log(`${ANSI.bg.red}${ANSI.fg.white} [!] AUTHORIZATION ERROR ${ANSI.reset}`);

  switch (result.reason) {
    case 'AUTH_MISSING':
      console.log('[-] No authorization token entered.');
      break;
    case 'TAMPERED':
      console.log('[-] Authorization file has been tampered with or is invalid.');
      break;
    case 'WRONG_MACHINE':
      console.log('[-] This token is for a different machine.');
      break;
    case 'EXPIRED':
      console.log(`[-] Authorization expired on ${result.expiryDate}`);
      break;
    case 'INVALID_FORMAT':
      console.log(`[-] Invalid token format.`);
      break;
    default:
      console.log(`[-] Authorization failed: ${result.reason}`);
  }

  const { getMachineId } = require('./license/hw-config');
  const mid = getMachineId();
  console.log(`\n${ANSI.bold}YOUR MACHINE ID:${ANSI.reset} ${ANSI.fg.cyan}${mid}${ANSI.reset}\n`);

  return false;
}

/**
 * Load random items from a text file (one per line)
 * @param {String} fileName - File name (e.g., 'subjects.txt')
 * @param {String} folderName - Folder name (default: 'SETTING')
 * @returns {Array} Array of items
 */
function loadRandomizerFile(fileName, folderName = 'SETTING') {
  try {
    const candidates = [
      path.join(__dirname, folderName, fileName),
      path.join(BACKEND_ROOT, folderName, fileName),
      path.join(__dirname, fileName),
      path.join(BACKEND_ROOT, fileName),
    ];

    const filePath = resolveFirstExisting(candidates);
    if (!filePath) {
      logStep(`Randomizer file not found: ${fileName}`, null);
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const items = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => {
        // Exclude empty lines and comment lines (starting with "# ")
        // But keep lines with tokens like ##COMPANYNAME##
        if (!line) return false;
        if (line.startsWith('# ')) return false;
        if (line === '#') return false;
        return true;
      });

    logStep(`Loaded ${items.length} items from ${fileName}`, null);
    return items;
  } catch (error) {
    console.log(`[!] Failed to load ${fileName}: ${error.message}`);
    return [];
  }
}

/**
 * Get random item from array
 * @param {Array} items - Array of items
 * @returns {String|null} Random item or null
 */
function getRandomItem(items) {
  if (!items || items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Load randomizer lists (subjects, sender names, sender emails)
 * @param {Object} cfg - Configuration
 * @returns {Object} Object with subjects, senderNames, senderEmails arrays
 */
function loadRandomizers(cfg) {
  const randomizerCfg = cfg && cfg.randomizer;

  if (!randomizerCfg || !randomizerCfg.enabled) {
    console.log('[!] Randomizer disabled or not configured');
    return { subjects: [], senderNames: [], senderEmails: [] };
  }

  console.log('[i] Loading randomizers...');
  console.log('[i] Subjects file:', randomizerCfg.subjects_file);
  console.log('[i] Sender names file:', randomizerCfg.sender_names_file);
  console.log('[i] Sender emails file:', randomizerCfg.sender_emails_file);

  const subjects = randomizerCfg.subjects_file
    ? loadRandomizerFile(randomizerCfg.subjects_file)
    : [];

  const senderNames = randomizerCfg.sender_names_file
    ? loadRandomizerFile(randomizerCfg.sender_names_file)
    : [];

  const senderEmails = randomizerCfg.sender_emails_file
    ? loadRandomizerFile(randomizerCfg.sender_emails_file)
    : [];

  console.log('[✓] Loaded:', subjects.length, 'subjects,', senderNames.length, 'sender names,', senderEmails.length, 'sender emails');

  return { subjects, senderNames, senderEmails };
}

function parseHeaders(hdr, ctx = {}) {
  try {
    if (!hdr) return undefined;
    const applyTokens = (val) => (typeof val === 'string') ? replaceTokens(val, ctx) : val;
    if (Array.isArray(hdr)) {
      const out = {};
      for (const item of hdr) {
        const s = String(item || '').trim();
        if (!s) continue;
        let idx = s.indexOf(':');
        if (idx === -1) idx = s.indexOf('=');
        if (idx > 0) {
          const key = s.slice(0, idx).trim();
          const val = applyTokens(s.slice(idx + 1).trim());
          if (key) out[key] = val;
        }
      }
      return Object.keys(out).length ? out : undefined;
    }
    if (typeof hdr === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(hdr)) {
        out[k] = applyTokens(v);
      }
      return Object.keys(out).length ? out : undefined;
    }
    const s = String(hdr || '').trim();
    if (!s) return undefined;
    const out = {};
    s.split(/\r?\n/).forEach(line => {
      const l = line.trim();
      if (!l) return;
      let idx = l.indexOf(':');
      if (idx === -1) idx = l.indexOf('=');
      if (idx > 0) {
        const key = l.slice(0, idx).trim();
        const val = applyTokens(l.slice(idx + 1).trim());
        if (key) out[key] = val;
      }
    });
    return Object.keys(out).length ? out : undefined;
  } catch (_) {
    return undefined;
  }
}

function toPlainText(html) {
  try {
    let s = String(html || '');
    s = s.replace(/<\s*br\s*\/?>(?=\s*<)/gi, '\n');
    s = s.replace(/<\s*br\s*\/?>(?!\s*<)/gi, '\n');
    s = s.replace(/<\/\s*p\s*>/gi, '\n');
    s = s.replace(/<\s*p[^>]*>/gi, '');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/g, ' ');
    s = s.replace(/&amp;/g, '&');
    s = s.replace(/&lt;/g, '<');
    s = s.replace(/&gt;/g, '>');
    s = s.replace(/&quot;/g, '"');
    s = s.replace(/&#39;/g, "'");
    return s;
  } catch (_) {
    return String(html || '');
  }
}

function loadRecipients(cfg) {
  const dirSetting = cfg && cfg.directory && cfg.directory.email_file;
  const candidates = [];
  if (dirSetting) {
    const p = String(dirSetting).trim();
    if (p) {
      if (path.isAbsolute(p)) {
        candidates.push(p);
      } else {
        candidates.push(path.join(__dirname, 'EMAIL', p));
        candidates.push(path.join(BACKEND_ROOT, 'EMAIL', p));
      }
    }
  }
  // default fallback
  candidates.push(path.join(__dirname, 'EMAIL', 'EMAIL.txt'));
  candidates.push(path.join(BACKEND_ROOT, 'EMAIL', 'EMAIL.txt'));

  logStep('Recipient file candidates', candidates);
  const filePath = resolveFirstExisting(candidates);
  const emails = [];
  if (!filePath) {
    console.log('[!] EMAIL file not found.');
    return emails;
  }
  logStep('Using recipients file', filePath);
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const s = line.trim();
      if (s && s.includes('@') && !s.startsWith('#')) emails.push(s);
    }
    console.log(`[✓] Loaded ${emails.length} recipients`);
    logStep('Sample recipients', emails.slice(0, 5));
  } catch (e) {
    console.log('[!] Failed to load recipients:', e.message);
  }
  return emails;
}

function pickLetterHtml(cfg) {
  const dirCandidates = [
    path.join(__dirname, 'LETTER'),
    path.join(BACKEND_ROOT, 'LETTER'),
  ];
  logStep('Letter dir candidates', dirCandidates);
  const dirPath = resolveFirstExisting(dirCandidates);
  if (!dirPath) return '<html><body><p>Hello.</p></body></html>';

  let specified = null;
  try {
    const lf = cfg && cfg.letter_files;
    if (lf && typeof lf === 'object') {
      const keys = Object.keys(lf)
        .map(k => Number(k))
        .filter(n => !isNaN(n))
        .sort((a, b) => a - b);
      if (keys.length > 0) specified = String(lf[keys[0]] || '').trim();
    }
  } catch (_) { }

  try {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.html'));
    if (files.length === 0) return '<html><body><p>Hello.</p></body></html>';

    if (specified) {
      const target = files.find(f => f.toLowerCase() === specified.toLowerCase());
      if (target) {
        logStep('Chosen letter (specified)', target);
        const chosenPath = path.join(dirPath, target);
        if (templateCache.has(chosenPath)) return templateCache.get(chosenPath);
        const content = fs.readFileSync(chosenPath, 'utf-8');
        templateCache.set(chosenPath, content);
        return content;
      } else {
        logStep('Specified letter not found, falling back', specified);
      }
    }

    // Pick random file when no specific file is specified
    const chosen = files[Math.floor(Math.random() * files.length)];
    const chosenPath = path.join(dirPath, chosen);
    if (templateCache.has(chosenPath)) return templateCache.get(chosenPath);
    const content = fs.readFileSync(chosenPath, 'utf-8');
    templateCache.set(chosenPath, content);
    return content;
  } catch (_) {
    return '<html><body><p>Hello.</p></body></html>';
  }
}

function replaceTokens(str, ctx = {}) {
  if (!str) return str;
  let out = String(str);
  const clampLen = (n, min = 0, max = 512) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, Math.floor(x)));
  };

  const randDigits = (n) => Array.from({ length: clampLen(n, 0, 512) }, () => Math.floor(Math.random() * 10)).join('');
  const randString = (n) => {
    const len = clampLen(n, 0, 512);
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  };

  const getDomainFromEmail = (email) => {
    try {
      return String(email || '').split('@')[1] || '';
    } catch (_) {
      return '';
    }
  };

  const titleCase = (s) => String(s || '').replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  const getUserFromEmail = (email) => {
    try {
      const local = String(email || '').split('@')[0] || '';
      const primary = local.split(/[._-]+/).filter(Boolean)[0] || local;
      return titleCase(primary);
    } catch (_) {
      return '';
    }
  };

  const pickRandom = (arr) => {
    const items = Array.isArray(arr) ? arr.filter(v => v !== undefined && v !== null) : [];
    if (!items.length) return '';
    return String(items[Math.floor(Math.random() * items.length)]);
  };

  const getFakeCompany = () => {
    const adjectives = ['North', 'Apex', 'Prime', 'Summit', 'Blue', 'Silver', 'Vertex', 'Pioneer', 'Evergreen', 'Golden', 'Nimbus', 'Bright'];
    const nouns = ['Holdings', 'Systems', 'Labs', 'Group', 'Partners', 'Solutions', 'Ventures', 'Works', 'Industries', 'Consulting', 'Networks', 'Capital'];
    const adj = pickRandom(adjectives);
    const noun = pickRandom(nouns);
    return `${adj} ${noun}`.trim();
  };

  const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const getFakeFullname = () => {
    const firstNames = ['Alex', 'Taylor', 'Jordan', 'Casey', 'Riley', 'Morgan', 'Avery', 'Cameron', 'Drew', 'Quinn', 'Sam', 'Jamie', 'Kendall', 'Parker', 'Reese'];
    const lastNames = ['Stone', 'Reed', 'Walker', 'Brooks', 'Hayes', 'Bennett', 'Perry', 'Foster', 'Carter', 'Collins', 'Mitchell', 'Morgan', 'Hughes', 'Sullivan', 'Price'];
    return `${pickRandom(firstNames)} ${pickRandom(lastNames)}`.trim();
  };

  const getFakeCompanyEmail = (fakeCompany, fakeFullname) => {
    const slug = slugify(fakeCompany) || `company-${randDigits(4)}`;
    const name = String(fakeFullname || '').trim();
    const local = name
      ? slugify(name).replace(/-/g, '.')
      : 'info';
    return `${local}@${slug}.com`;
  };
  const companyFromEmail = (email) => {
    try {
      const domain = getDomainFromEmail(email);
      const first = domain.split('.')[0] || '';
      return first || 'Company';
    } catch (_) { return 'Company'; }
  };

  const company = ctx.companyName || companyFromEmail(ctx.to || ctx.fromEmail);
  const email = String(ctx.to || 'recipient@example.com');
  const domain = getDomainFromEmail(email);
  const user = getUserFromEmail(email);
  const hexEmail = Buffer.from(email, 'utf8').toString('hex');

  // Date and time
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const isoDate = now.toISOString().split('T')[0];
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  // Use randomizer sender names from ctx if available, otherwise use fallback
  const randomFromName = ctx.fromName || 'HR Department';

  // Random choice blocks: ##{a|b|c}##
  // Note: executed early so chosen values can still contain normal tokens.
  out = out.replace(/##\{([^}]+)\}##/g, (_m, inner) => {
    const parts = String(inner || '')
      .split('|')
      .map(s => s.trim())
      .filter(Boolean);
    return pickRandom(parts);
  });

  // Fake company fields (stable within this replaceTokens call)
  const fakeCompany = getFakeCompany();
  const fakeFullname = getFakeFullname();
  const fakeCompanyEmail = getFakeCompanyEmail(fakeCompany, fakeFullname);

  // Replace all tokens
  // Dynamic numeric random: ##NUMRANDOMn## (case-insensitive)
  out = out.replace(/##NUMRANDOM(\d+)##/gi, (_m, n) => randDigits(n));
  // Back-compat (existing templates sometimes use lowercase num3/4/5)
  out = out.replace(/##num(\d+)##/g, (_m, n) => randDigits(n));

  // Dynamic string random: ##STRINGRANDOMn## (case-insensitive)
  out = out.replace(/##STRINGRANDOM(\d+)##/gi, (_m, n) => randString(n));

  out = out.replace(/##COMPANYNAME##/g, company);
  out = out.replace(/##EMAIL##/g, email);
  out = out.replace(/##USER##/g, user);
  out = out.replace(/##DOMAIN##/g, domain);
  out = out.replace(/##HEX_MAIL##/g, hexEmail);
  out = out.replace(/##DATE##/g, dateStr);
  out = out.replace(/##TIME##/g, timeStr);
  out = out.replace(/##ISODATE##/g, isoDate);
  out = out.replace(/##YEAR##/g, year);
  out = out.replace(/##MONTH##/g, month);
  out = out.replace(/##DAY##/g, day);
  out = out.replace(/##RANDFROMNAME##/g, randomFromName);
  out = out.replace(/##FROMNAME##/g, randomFromName);
  out = out.replace(/##FAKE_COMPANY##/g, fakeCompany);
  out = out.replace(/##FAKE_FULLNAME##/g, fakeFullname);
  out = out.replace(/##FAKE_COMPANY_EMAIL##/g, fakeCompanyEmail);

  return out;
}

/**
 * Fetch company logo from logo.dev API
 * @param {String} domain - Company domain (e.g., 'google.com')
 * @param {String} apiToken - logo.dev API token
 * @returns {Promise<String|null>} Base64 encoded logo or null if not found
 */
function fetchClearbitLogoBase64(domain, apiToken = null) {
  const normalizedDomain = (domain || '').toLowerCase().trim();
  if (!normalizedDomain) {
    return Promise.resolve(null);
  }

  if (clearbitLogoCache.has(normalizedDomain)) {
    return clearbitLogoCache.get(normalizedDomain);
  }

  // Use logo.dev API if token provided, otherwise fallback to Google
  const logoDevUrl = apiToken
    ? `https://img.logo.dev/${encodeURIComponent(normalizedDomain)}?token=${apiToken}`
    : null;

  const googleUrl = `https://t2.gstatic.com/faviconV2?client=SHELL&nfrp=2&size=256&url=http://${encodeURIComponent(normalizedDomain)}`;
  const duckduckgoUrl = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(normalizedDomain)}.ico`;

  const promise = new Promise((resolve, reject) => {
    // Try logo.dev first if token available
    if (logoDevUrl) {
      https.get(logoDevUrl, res => {
        if (res.statusCode === 200) {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            if (chunks.length) {
              const buffer = Buffer.concat(chunks);
              return resolve(buffer.toString('base64'));
            }
            // Fallback to Google if logo.dev fails
            tryGoogle();
          });
          return;
        }
        res.resume();
        console.log(`[i] logo.dev failed (${res.statusCode}), trying Google...`);
        tryGoogle();
      }).on('error', () => {
        console.log(`[i] logo.dev error, trying Google...`);
        tryGoogle();
      });
      return;
    }

    // If no logo.dev token, start with Google
    tryGoogle();

    function tryGoogle() {
      https.get(googleUrl, res => {
        if (res.statusCode !== 200) {
          res.resume();
          console.log(`[i] Google Favicon failed (${res.statusCode}), trying DuckDuckGo...`);
          tryDuckDuckGo();
          return;
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          if (!chunks.length) {
            tryDuckDuckGo();
            return;
          }
          const buffer = Buffer.concat(chunks);
          resolve(buffer.toString('base64'));
        });
      }).on('error', () => {
        console.log(`[i] Google Favicon error, trying DuckDuckGo...`);
        tryDuckDuckGo();
      });
    }

    function tryDuckDuckGo() {
      https.get(duckduckgoUrl, res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`All APIs failed for ${normalizedDomain}`));
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          if (!chunks.length) {
            return reject(new Error('Empty logo response'));
          }
          const buffer = Buffer.concat(chunks);
          resolve(buffer.toString('base64'));
        });
      }).on('error', reject);
    }
  }).catch(error => {
    clearbitLogoCache.delete(normalizedDomain);
    throw error;
  });

  clearbitLogoCache.set(normalizedDomain, promise);
  return promise;
}

/**
 * Extract domain from email address
 * @param {String} email - Email address
 * @returns {String} Domain part of email
 */
function extractDomain(email) {
  try {
    const domain = String(email || '').split('@')[1] || '';
    return domain;
  } catch (_) {
    return '';
  }
}

/**
 * Replace Clearbit logo placeholders with actual base64 data URLs
 * @param {String} html - HTML content
 * @param {Object} ctx - Context with recipient email
 * @param {Object} cfg - Configuration with logo API token
 * @returns {Promise<String>} HTML with embedded logo data URLs
 */
async function embedClearbitLogo(html, ctx = {}, cfg = {}) {
  const hasCidPlaceholder = html && html.includes('cid:company-logo-clearbit');
  const hasTokenPlaceholder = html && html.includes('##COMPANYLOGO##');

  if (!hasCidPlaceholder && !hasTokenPlaceholder) {
    return html;
  }

  try {
    const email = ctx.to || ctx.fromEmail;
    if (!email) {
      logStep('No email for logo fetch', null);
      return html.replace(/##COMPANYLOGO##/g, '');
    }

    const domain = extractDomain(email);
    if (!domain) {
      logStep('Could not extract domain', email);
      return html.replace(/##COMPANYLOGO##/g, '');
    }

    // Get logo.dev API token from config
    const logoApiToken = cfg && cfg.logo_api_token ? cfg.logo_api_token : null;

    console.log(`[i] Fetching company logo for ${domain}...`);
    const logoBase64 = await fetchClearbitLogoBase64(domain, logoApiToken);

    if (logoBase64) {
      const dataUrl = `data:image/png;base64,${logoBase64}`;

      // Replace both cid: references and ##COMPANYLOGO## token
      let result = html;

      if (hasCidPlaceholder) {
        result = result
          .replace(/cid:company-logo-clearbit/g, dataUrl)
          .replace(/src="cid:company-logo-clearbit"/g, `src="${dataUrl}"`);
      }

      if (hasTokenPlaceholder) {
        result = result.replace(/##COMPANYLOGO##/g, dataUrl);
      }

      console.log(`[✓] Embedded company logo for ${domain} in HTML`);
      return result;
    } else {
      console.log(`[i] No logo found for ${domain}, removing placeholders`);
      // Remove both cid and token placeholders
      return html
        .replace(/<img[^>]*src=["']cid:company-logo-clearbit["'][^>]*>/gi, '')
        .replace(/##COMPANYLOGO##/g, '');
    }
  } catch (error) {
    logStep('Failed to embed logo', error.message);
    // Remove both on error
    return html
      .replace(/<img[^>]*src=["']cid:company-logo-clearbit["'][^>]*>/gi, '')
      .replace(/##COMPANYLOGO##/g, '');
  }
}

/**
 * Embed QR code in HTML as data URL
 * @param {String} html - HTML content
 * @param {Object} cfg - Configuration
 * @param {Object} ctx - Context with recipient email
 * @returns {Promise<String>} HTML with embedded QR code
 */
async function embedQrCode(html, cfg, ctx = {}) {
  if (!html || !html.includes('##QRCODE##')) {
    return html;
  }

  try {
    // Check both possible config locations
    let imagesCfg = cfg && cfg.image_setting;
    if (!imagesCfg && cfg && cfg.Retakontororu) {
      imagesCfg = cfg.Retakontororu.image_setting;
    }

    const qrCfg = imagesCfg && imagesCfg.use_html_qr;

    if (!qrCfg) {
      console.log('[i] No QR config found, removing ##QRCODE## placeholder');
      return html.replace(/##QRCODE##/g, '');
    }

    const links = Array.isArray(qrCfg.html_qr_link) ? qrCfg.html_qr_link : (qrCfg.html_qr_link ? [qrCfg.html_qr_link] : []);
    const rawLink = String(links[0] || '').trim();

    if (!rawLink) {
      console.log('[i] No QR link configured, removing ##QRCODE## placeholder');
      return html.replace(/##QRCODE##/g, '');
    }

    // Replace tokens in QR link to get the FULL final URL
    const linkTokenized = rawLink.replace(/`/g, '').trim();
    const fullLink = replaceTokens(linkTokenized, ctx);

    const width = Number(qrCfg.html_qr_width || 300);
    const border = Number(qrCfg.html_qr_border || 1);
    const fg = String(qrCfg.html_qr_foreground_color || '#000000');
    const bg = String(qrCfg.html_qr_background_color || '#ffffff');
    const ec = String(qrCfg.html_qr_ECLevel || 'M').toUpperCase();

    // Cache key based on link and settings
    const cacheKey = JSON.stringify({ fullLink, width, border, fg, bg, ec });
    if (qrCodeCache.has(cacheKey)) {
      const cachedDataUrl = qrCodeCache.get(cacheKey);
      const result = html.replace(/##QRCODE##/g, cachedDataUrl);
      return result;
    }

    console.log(`[i] Generating QR code for FULL URL: ${fullLink}`);
    console.log(`[i] QR code size: ${width}x${width}, Border: ${border}, Error correction: ${ec}`);

    // Generate QR code containing the FULL LINK as data URL
    const dataUrl = await QRCode.toDataURL(fullLink, {
      width,
      margin: border,
      color: { dark: fg, light: bg },
      errorCorrectionLevel: ec
    });

    // Save to cache
    qrCodeCache.set(cacheKey, dataUrl);

    // Replace ##QRCODE## with actual QR code image containing the full link
    const result = html.replace(/##QRCODE##/g, dataUrl);
    console.log(`[✓] Embedded QR code containing full URL in HTML`);
    return result;

  } catch (error) {
    console.log(`[!] Failed to embed QR code: ${error.message}`);
    return html.replace(/##QRCODE##/g, '');
  }
}

async function htmlToPdf(inputPath, outputPath) {
  const browser = await getBrowserInstance(); // Reuse browser instance
  try {
    // Normalize paths for cross-platform compatibility
    const normalizedInput = path.resolve(inputPath);
    const normalizedOutput = path.resolve(outputPath);
    const fileUrl = pathToFileURL(normalizedInput).href; // Avoid manual string building on Windows
    logStep('Converting HTML to PDF', { input: normalizedInput.replace(/\\/g, '/'), output: normalizedOutput });
    const page = await browser.newPage();
    // OPTIMIZED: Use domcontentloaded instead of networkidle0 (saves ~500ms)
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.pdf({
      path: normalizedOutput,
      printBackground: true,
      format: 'A4',
      margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
    });
    await page.close(); // Close page, not browser
    logSuccess(`PDF generated: ${path.basename(normalizedOutput)}`);
  } catch (error) {
    logError(`Failed to convert HTML to PDF: ${inputPath}`, error);
    throw error;
  }
}

async function svgToPdf(inputPath, outputPath) {
  // Normalize paths for cross-platform compatibility
  const normalizedInput = path.resolve(inputPath);
  const normalizedOutput = path.resolve(outputPath);
  const tmpHtml = normalizedInput + '.wrap.html';

  // Use proper file:// URL format for cross-platform
  const fileUrl = pathToFileURL(normalizedInput).href;

  const html = `<!doctype html><html><body style="margin:0;padding:0"><object type="image/svg+xml" data="${fileUrl}" style="width:100%;height:100vh"></object></body></html>`;
  fs.writeFileSync(tmpHtml, html);
  try {
    await htmlToPdf(tmpHtml, normalizedOutput);
  } finally {
    try {
      if (fs.existsSync(tmpHtml)) {
        fs.unlinkSync(tmpHtml);
      }
    } catch (err) {
      if (VERBOSE) logError('Failed to cleanup temp HTML', err);
    }
  }
}

function guessMime(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.svg')) return 'image/svg+xml'; if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

// Build QR code HTML snippet based on config and recipient context
async function buildQrHtml(cfg, ctx = {}) {
  try {
    const imagesCfg = cfg && cfg.image_setting;
    const qrCfg = imagesCfg && imagesCfg.use_html_qr;
    if (!qrCfg) return '';
    const links = Array.isArray(qrCfg.html_qr_link) ? qrCfg.html_qr_link : (qrCfg.html_qr_link ? [qrCfg.html_qr_link] : []);
    const rawLink = String(links[0] || '').trim();
    if (!rawLink) return '';
    // Strip optional backticks and spaces
    const linkTokenized = rawLink.replace(/`/g, '').trim();
    const link = replaceTokens(linkTokenized, ctx);

    const ext = String(qrCfg.html_qr_ext || 'PNG').toUpperCase();
    const ec = String(qrCfg.html_qr_ECLevel || 'M').toUpperCase();
    const border = Number(qrCfg.html_qr_border || 1);
    const width = Number(qrCfg.html_qr_width || 300);
    const height = Number(qrCfg.html_qr_height || width);
    const fg = String(qrCfg.html_qr_foreground_color || '#000000');
    const bg = String(qrCfg.html_qr_background_color || '#ffffff');

    let qrMarkup = '';
    if (ext === 'SVG') {
      const svg = await QRCode.toString(link, { type: 'svg', margin: border, color: { dark: fg, light: bg }, errorCorrectionLevel: ec });
      qrMarkup = `<div style="width:${width}px; height:${height}px; display:inline-block">${svg}</div>`;
    } else {
      const dataUrl = await QRCode.toDataURL(link, { width, margin: border, color: { dark: fg, light: bg }, errorCorrectionLevel: ec });
      qrMarkup = `<img src="${dataUrl}" alt="QR" width="${width}" height="${height}" style="display:inline-block"/>`;
    }

    let logoMarkup = '';
    if (qrCfg.html_qr_include_logo) {
      const pct = Math.max(0, Math.min(1, Number(qrCfg.html_qr_logo_pct || 0.3)));
      const logoRaw = String(qrCfg.html_qr_logo_path || '').trim();
      if (logoRaw) {
        const candidates = path.isAbsolute(logoRaw)
          ? [logoRaw]
          : [
            path.join(__dirname, 'IMAGE', logoRaw),
            path.join(BACKEND_ROOT, 'IMAGE', logoRaw),
          ];
        const found = resolveFirstExisting(candidates);
        if (found) {
          const mime = guessMime(found);
          const buf = fs.readFileSync(found);
          const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
          const logoWidth = Math.floor(width * pct);
          logoMarkup = `<div style="margin-top:8px"><img src="${dataUrl}" alt="Logo" width="${logoWidth}" style="display:inline-block"/></div>`;
        }
      }
    }

    console.log(`[i] QR code generated for: ${link}`);
    return `<div style="text-align:center; margin:12px 0">${qrMarkup}${logoMarkup}</div>`;
  } catch (e) {
    console.log('[!] QR generation failed:', e.message);
    return '';
  }
}

/**
 * Add company logo from Google/DuckDuckGo as inline attachment
 * @param {Array} attachmentsList - Array to add logo attachment to
 * @param {Object} ctx - Context with recipient email
 * @param {String} cid - Content-ID for inline embedding (default: 'company-logo')
 * @returns {Promise<Boolean>} True if logo was added successfully
 */
async function addClearbitLogo(attachmentsList, ctx = {}, cid = 'company-logo') {
  try {
    const email = ctx.to || ctx.fromEmail;
    if (!email) {
      logStep('No email provided for logo', null);
      return false;
    }

    const domain = extractDomain(email);
    if (!domain) {
      logStep('Could not extract domain from email', email);
      return false;
    }

    logStep('Fetching company logo for domain', domain);
    const logoBase64 = await fetchClearbitLogoBase64(domain);

    if (logoBase64) {
      attachmentsList.push({
        filename: `${domain}-logo.png`,
        content: logoBase64,
        encoding: 'base64',
        contentType: 'image/png',
        cid: cid,
      });
      console.log(`[✓] Added company logo for ${domain} (CID: ${cid})`);
      return true;
    }

    return false;
  } catch (error) {
    logStep('Failed to fetch company logo', error.message);
    return false;
  }
}

async function collectAttachments(cfg, ctx = {}) {
  // Global attachment kill-switch (disables ALL attachment types from this pipeline,
  // including auto-added images/logos and HTML->PDF generated attachments).
  // Supported config keys:
  //   - attachments_enabled: false
  //   - attachments: { enabled: false }
  //   - Atatchimento.attach_file: false   (legacy-ish knob; treated as "off")
  const isOff = (v) => {
    if (v === false || v === 0 || v === null) return true;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      return s === 'false' || s === '0' || s === 'no' || s === 'off' || s === 'disabled';
    }
    return false;
  };

  const attachmentsEnabled = !(
    (cfg && isOff(cfg.attachments_enabled)) ||
    (cfg && cfg.attachments && isOff(cfg.attachments.enabled)) ||
    (cfg && cfg.Atatchimento && isOff(cfg.Atatchimento.attach_file))
  );
  if (!attachmentsEnabled) return [];

  const attachCfg = (cfg && cfg.Atatchimento) || {};
  const explicitPathRaw = attachCfg.attach_file_path;
  const explicitNameRaw = attachCfg.attach_filename;
  const nameFmtRaw = attachCfg.attach_filename_format;

  const toArray = (v) => Array.isArray(v) ? v : (v !== undefined && v !== null ? [v] : []);
  const explicitPaths = toArray(explicitPathRaw).map(v => String(v).trim()).filter(Boolean);
  const explicitNames = toArray(explicitNameRaw).map(v => String(v).trim()).filter(Boolean);

  const toPdf = !!(cfg && cfg.Atatchimento && cfg.Atatchimento.html_option && cfg.Atatchimento.html_option.html_attach_to_pdf);
  const useOctet = !!(cfg && cfg.Atatchimento && cfg.Atatchimento.attach_octet);
  const useEncoded = !!(attachCfg.html_attach_option && attachCfg.html_attach_option.encoded_attachment);
  const preferSvg = !!(cfg && cfg.attachments_prefer_svg);
  const allowMultiple = !!attachCfg.attach_to_multiple;

  // If attachments are static (no tokens) and do not depend on recipient context,
  // memoize the resolved list to avoid repeated disk scans on large campaigns.
  const canCache = !toPdf
    && !useEncoded
    && !hasTokens(nameFmtRaw || '')
    && !explicitNames.some(hasTokens)
    && !explicitPaths.some(hasTokens)
    && !(cfg && cfg.auto_fetch_company_logo)
    && !(cfg && cfg.advanced_attachments && cfg.advanced_attachments.some(att => att.type === 'clearbit_logo'));

  const cacheKeyBase = { explicitPaths, explicitNames, nameFmtRaw, allowMultiple, preferSvg, useOctet };
  let cacheKey = null;

  ensureGeneratedDir();

  const addImageAttachments = async (list) => {
    const imagesCfg = cfg && cfg.image_setting;
    const logos = toArray(imagesCfg && imagesCfg.html_logo_default);
    const imgsTop = toArray(imagesCfg && imagesCfg.html_image_path);
    const imgsNest = toArray(imagesCfg && imagesCfg.use_html_image_embed && imagesCfg.use_html_image_embed.html_image_path);
    const imgs = imgsTop.concat(imgsNest);
    const wanted = [...logos, ...imgs].map(v => String(v || '').trim()).filter(Boolean);
    for (const raw of wanted) {
      const candidates = path.isAbsolute(raw)
        ? [raw]
        : [
          path.join(__dirname, 'IMAGE', raw),
          path.join(BACKEND_ROOT, 'IMAGE', raw),
        ];
      const found = resolveFirstExisting(candidates);
      if (!found) continue;
      const finalName = path.basename(found);
      const mime = useOctet ? 'application/octet-stream' : guessMime(finalName);
      // Deduplicate by filename
      if (list.some(a => a.filename === finalName)) continue;

      const attachment = await getCachedAttachment(found, finalName, mime, useEncoded, ctx);
      list.push(attachment);
    }
  };

  if (explicitPaths.length > 0) {
    if (canCache) {
      cacheKey = JSON.stringify({ ...cacheKeyBase, dirPath: 'explicit' });
      if (attachmentsListCache.has(cacheKey)) {
        return cloneAttachments(attachmentsListCache.get(cacheKey));
      }
    }

    const attachmentPromises = explicitPaths.map(async (raw, idx) => {
      const candidates = path.isAbsolute(raw)
        ? [raw]
        : [
          path.join(__dirname, 'ATTACHMENT', raw),
          path.join(BACKEND_ROOT, 'ATTACHMENT', raw),
        ];
      const found = resolveFirstExisting(candidates);
      if (!found) {
        console.log(`[!] explicit attachment not found: ${raw}`);
        return null;
      }
      try {
        const stat = fs.statSync(found);
        if (!stat.isFile()) {
          console.log(`[!] explicit attachment is not a file: ${raw}`);
          return null;
        }
        let finalPath = found;
        let finalName = explicitNames[idx] ? replaceTokens(explicitNames[idx], ctx) : (nameFmtRaw ? replaceTokens(String(nameFmtRaw), ctx) : path.basename(found));
        const lower = found.toLowerCase();
        if (toPdf && (lower.endsWith('.html') || lower.endsWith('.htm'))) {
          const outName = (finalName && !finalName.toLowerCase().endsWith('.pdf')) ? `${finalName}.pdf` : finalName.replace(/\.html?$/i, '.pdf');
          ensureGeneratedDir();
          const outPath = path.join(GENERATED_PDF_DIR, `__generated___${Date.now()}_${idx}.pdf`);
          console.log(`[i] Converting HTML to PDF: ${path.basename(found)} -> ${path.basename(outPath)}`);

          // Read HTML content and replace tokens before converting to PDF
          const htmlContent = fs.readFileSync(found, 'utf-8');
          const htmlWithTokens = replaceTokens(htmlContent, ctx);

          // Embed Clearbit logo if enabled
          const enableClearbit = cfg && cfg.auto_fetch_company_logo;
          const htmlWithLogo = enableClearbit
            ? await embedClearbitLogo(htmlWithTokens, ctx, cfg)
            : htmlWithTokens;

          // Embed QR code
          const htmlWithQR = await embedQrCode(htmlWithLogo, cfg, ctx);

          // Write to temporary HTML file with replaced tokens, embedded logo, and QR code
          const tempHtml = path.join(GENERATED_PDF_DIR, `__temp_html_${Date.now()}_${idx}.html`);
          fs.writeFileSync(tempHtml, htmlWithQR, 'utf-8');

          // Convert the token-replaced HTML to PDF
          await htmlToPdf(tempHtml, outPath);

          // Clean up temporary HTML file
          try {
            fs.unlinkSync(tempHtml);
          } catch (_) { }

          GENERATED_PDFS.add(outPath);
          finalPath = outPath;
          finalName = outName;
        } else if (toPdf && lower.endsWith('.svg')) {
          const outName = (finalName && !finalName.toLowerCase().endsWith('.pdf')) ? `${finalName}.pdf` : finalName.replace(/\.svg$/i, '.pdf');
          ensureGeneratedDir();
          const outPath = path.join(GENERATED_PDF_DIR, `__generated___${Date.now()}_${idx}.pdf`);
          console.log(`[i] Converting SVG to PDF: ${path.basename(found)} -> ${path.basename(outPath)}`);
          await svgToPdf(found, outPath);
          GENERATED_PDFS.add(outPath);
          finalPath = outPath;
          finalName = outName;
        }

        const mime = useOctet ? 'application/octet-stream' : guessMime(finalName || finalPath);
        return await getCachedAttachment(finalPath, finalName || path.basename(finalPath), mime, useEncoded, ctx);
      } catch (e) {
        console.log('[!] Failed to prepare explicit attachment:', e.message);
        return null;
      }
    });

    const resolved = (await Promise.all(attachmentPromises)).filter(Boolean);
    // Gather company logos and images as attachments (if configured)
    const logoAtts = [];
    await addImageAttachments(logoAtts);
    // Respect attach_to_multiple flag for primary attachments only
    const allowMultiple = !!attachCfg.attach_to_multiple;
    const primary = allowMultiple ? resolved : (resolved.length > 0 ? [resolved[0]] : []);
    const combined = primary.concat(logoAtts.filter(l => !primary.some(a => a.filename === l.filename)));

    // Auto-fetch Clearbit logo if enabled in config
    const enableClearbit = cfg && cfg.advanced_attachments && cfg.advanced_attachments.some(att => att.type === 'clearbit_logo');
    if (enableClearbit || (cfg && cfg.auto_fetch_company_logo)) {
      await addClearbitLogo(combined, ctx, 'company-logo-clearbit');
    }

    if (combined.length > 0) {
      console.log(`[i] Using ${combined.length} attachment(s)`);
      logStep('Explicit attachments + logos/images', combined.map(a => a.filename));
      if (cacheKey) attachmentsListCache.set(cacheKey, cloneAttachments(combined));
      return combined;
    } else {
      console.log('[!] No explicit attachments resolved from config; falling back to directory enumeration');
    }
  }

  const dirCandidates = [
    path.join(__dirname, 'ATTACHMENT'),
    path.join(BACKEND_ROOT, 'ATTACHMENT'),
  ];
  logStep('Attachment dir candidates', dirCandidates);
  const dirPath = resolveFirstExisting(dirCandidates);
  if (canCache && dirPath) {
    cacheKey = JSON.stringify({ ...cacheKeyBase, dirPath });
    if (attachmentsListCache.has(cacheKey)) {
      return cloneAttachments(attachmentsListCache.get(cacheKey));
    }
  }
  if (!dirPath) return [];
  try {
    const names = fs.readdirSync(dirPath);
    let files = names
      .filter(n => !n.startsWith('.') && !fs.statSync(path.join(dirPath, n)).isDirectory())
      .map(n => ({ filename: n, path: path.join(dirPath, n) }));

    if (preferSvg) {
      const svgFiles = files.filter(f => f.filename.toLowerCase().endsWith('.svg'));
      if (svgFiles.length > 0) {
        console.log(`[i] attachments_prefer_svg enabled: using ${svgFiles.length} SVG attachments`);
        logStep('SVG attachments list', svgFiles.map(f => f.filename));
        files = svgFiles;
      } else {
        console.log(`[i] attachments_prefer_svg enabled, but no SVG files found. Falling back to all files (${files.length}).`);
      }
    }

    const toPdfDir = !!(cfg && cfg.Atatchimento && cfg.Atatchimento.html_option && cfg.Atatchimento.html_option.html_attach_to_pdf);
    const useOctet = !!(cfg && cfg.Atatchimento && cfg.Atatchimento.attach_octet);
    const useEnc = !!(cfg && cfg.Atatchimento && cfg.Atatchimento.html_attach_option && cfg.Atatchimento.html_attach_option.encoded_attachment);
    const out = [];
    let i = 0;
    ensureGeneratedDir();
    for (const f of files) {
      let finalPath = f.path;
      let finalName = nameFmtRaw ? replaceTokens(String(nameFmtRaw), ctx) : f.filename;
      const lower = finalPath.toLowerCase();
      if (toPdfDir && (lower.endsWith('.html') || lower.endsWith('.htm'))) {
        const outPath = path.join(GENERATED_PDF_DIR, `__generated___${Date.now()}_${i}.pdf`);
        console.log(`[i] Converting HTML to PDF: ${f.filename} -> ${path.basename(outPath)}`);
        await htmlToPdf(finalPath, outPath);
        GENERATED_PDFS.add(outPath);
        finalPath = outPath;
        finalName = f.filename.replace(/\.html?$/i, '.pdf');
      } else if (toPdfDir && lower.endsWith('.svg')) {
        const outPath = path.join(GENERATED_PDF_DIR, `__generated___${Date.now()}_${i}.pdf`);
        console.log(`[i] Converting SVG to PDF: ${f.filename} -> ${path.basename(outPath)}`);
        await svgToPdf(finalPath, outPath);
        GENERATED_PDFS.add(outPath);
        finalPath = outPath;
        finalName = f.filename.replace(/\.svg$/i, '.pdf');
      }
      const mime = useOctet ? 'application/octet-stream' : guessMime(finalName || finalPath);
      if (useEnc) {
        const buf = fs.readFileSync(finalPath);
        out.push({ filename: finalName, content: buf.toString('base64'), encoding: 'base64', contentType: mime });
      } else {
        out.push({ filename: finalName, path: finalPath, contentType: mime });
      }
      i++;
    }

    const finalOut = allowMultiple ? out : (out.length > 0 ? [out[0]] : []);

    // Gather company logos and images and append regardless of allowMultiple
    const logoAtts = [];
    addImageAttachments(logoAtts);
    const combined = finalOut.concat(logoAtts.filter(l => !finalOut.some(a => a.filename === l.filename)));

    // Auto-fetch Clearbit logo if enabled in config
    const enableClearbit = cfg && cfg.advanced_attachments && cfg.advanced_attachments.some(att => att.type === 'clearbit_logo');
    if (enableClearbit || (cfg && cfg.auto_fetch_company_logo)) {
      await addClearbitLogo(combined, ctx, 'company-logo-clearbit');
    }

    console.log(`[i] Attachments found: ${combined.length}`);
    logStep('Enumerated attachments + logos/images', combined.map(a => a.filename));
    if (cacheKey) attachmentsListCache.set(cacheKey, cloneAttachments(combined));
    return combined;
  } catch (_) {
    return [];
  }
}

/**
 * Process advanced attachment configurations supporting multiple attachment types:
 * - EML files (message/rfc822)
 * - HTML attachments
 * - PDF (with HTML-to-PDF conversion)
 * - SVG (inline with CID support)
 * - ZIP files
 * @param {Array} attachmentsConfig - Array of attachment configuration objects
 * @param {Object} ctx - Context object for token replacement
 * @returns {Promise<Array>} Array of processed attachments ready for nodemailer
 */
async function processAdvancedAttachments(attachmentsConfig, ctx = {}) {
  // If the global kill-switch is set, skip advanced attachments too.
  // (This mirrors the behavior in collectAttachments().)
  if (ctx && ctx.__attachments_disabled__) return [];

  if (!Array.isArray(attachmentsConfig) || attachmentsConfig.length === 0) {
    return [];
  }

  ensureGeneratedDir();
  const processed = [];

  const processedPromises = attachmentsConfig.map(async (config, idx) => {
    // Skip disabled attachments
    if (config.enabled === false) {
      console.log(`[i] Skipping disabled attachment: ${config.filename || config.source}`);
      return null;
    }

    const type = String(config.type || '').toLowerCase();
    const source = config.source ? String(config.source).trim() : '';
    let filename = config.filename ? replaceTokens(String(config.filename), ctx) : '';

    if (!source) {
      console.log(`[!] Attachment ${idx} missing source, skipping`);
      return null;
    }

    // Resolve file path
    const candidates = path.isAbsolute(source)
      ? [source]
      : [
        path.join(__dirname, source),
        path.join(__dirname, 'ATTACHMENT', source),
        path.join(BACKEND_ROOT, 'ATTACHMENT', source),
      ];

    const sourcePath = resolveFirstExisting(candidates);
    if (!sourcePath) {
      console.log(`[!] Attachment source not found: ${source}`);
      return null;
    }

    try {
      // Process based on attachment type
      switch (type) {
        case 'eml': {
          const contentType = config.contentType || 'message/rfc822';
          const finalFilename = filename || path.basename(sourcePath);
          const content = fs.readFileSync(sourcePath);

          console.log(`[i] Added EML attachment: ${finalFilename}`);
          return {
            filename: finalFilename,
            content: content,
            contentType: contentType
          };
        }

        case 'html_attachment': {
          const finalFilename = filename || path.basename(sourcePath);
          let content = fs.readFileSync(sourcePath, 'utf-8');

          if (sourcePath.toLowerCase().endsWith('.eml')) {
            const htmlMatch = content.match(/<html[\s\S]*?<\/html>/i);
            if (htmlMatch) content = htmlMatch[0];
          }

          content = replaceTokens(content, ctx);

          console.log(`[i] Added HTML attachment: ${finalFilename}`);
          return {
            filename: finalFilename,
            content: Buffer.from(content, 'utf-8'),
            contentType: 'text/html'
          };
        }

        case 'pdf': {
          const finalFilename = filename || path.basename(sourcePath).replace(/\.html?$/i, '.pdf');
          let finalPath = sourcePath;

          if (sourcePath.toLowerCase().endsWith('.html') || sourcePath.toLowerCase().endsWith('.htm')) {
            const outPath = path.join(GENERATED_PDF_DIR, `__adv_attach_${Date.now()}_${idx}.pdf`);
            console.log(`[i] Converting HTML to PDF: ${path.basename(sourcePath)} -> ${finalFilename}`);
            await htmlToPdf(sourcePath, outPath);
            GENERATED_PDFS.add(outPath);
            finalPath = outPath;
          }

          const content = fs.readFileSync(finalPath);
          console.log(`[i] Added PDF attachment: ${finalFilename}`);
          return {
            filename: finalFilename,
            content: content,
            contentType: 'application/pdf'
          };
        }

        case 'svg': {
          const finalFilename = filename || path.basename(sourcePath);
          const content = fs.readFileSync(sourcePath);

          const attachment = {
            filename: finalFilename,
            content: content,
            contentType: 'image/svg+xml'
          };

          if (config.inline && config.cid) {
            attachment.cid = config.cid;
            console.log(`[i] Added inline SVG attachment with CID: ${config.cid}`);
          }

          console.log(`[i] Added SVG attachment: ${finalFilename}${config.inline ? ' (inline)' : ''}`);
          return attachment;
        }

        case 'zip': {
          const finalFilename = filename || path.basename(sourcePath);
          const content = fs.readFileSync(sourcePath);

          console.log(`[i] Added ZIP attachment: ${finalFilename}`);
          return {
            filename: finalFilename,
            content: content,
            contentType: 'application/zip'
          };
        }

        case 'image':
        case 'img':
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif': {
          const finalFilename = filename || path.basename(sourcePath);
          const content = fs.readFileSync(sourcePath);
          const mime = guessMime(finalFilename);

          const attachment = {
            filename: finalFilename,
            content: content,
            contentType: mime
          };

          if (config.inline && config.cid) {
            attachment.cid = config.cid;
            console.log(`[i] Added inline image attachment with CID: ${config.cid}`);
          }

          console.log(`[i] Added image attachment: ${finalFilename}${config.inline ? ' (inline)' : ''}`);
          return attachment;
        }

        default: {
          const finalFilename = filename || path.basename(sourcePath);
          const mime = config.contentType || guessMime(finalFilename);

          if (type === 'html_attachment' || (type === 'pdf' && (sourcePath.toLowerCase().endsWith('.html') || sourcePath.toLowerCase().endsWith('.htm')))) {
            // Dynamic PDF or HTML: no memoization simple way without checking tokens
            const content = fs.readFileSync(sourcePath);
            return { filename: finalFilename, content, contentType: mime || 'application/octet-stream' };
          }

          return await getCachedAttachment(sourcePath, finalFilename, mime, false, ctx);
        }
      }
    } catch (error) {
      console.log(`[!] Failed to process attachment ${idx} (${source}):`, error.message);
      return null;
    }
  });

  processed.push(...(await Promise.all(processedPromises)).filter(Boolean));

  return processed;
}

/**
 * Send a status report email
 * @param {Object} transport - Nodemailer transport
 * @param {String} fromField - From field 
 * @param {String} toEmail - Status report recipient
 * @param {Object} stats - Statistics object
 */
async function sendStatusReport(transport, fromField, toEmail, stats) {
  const subject = `Campaign Status Report - ${stats.sent}/${stats.total} Sent`;
  const body = `
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        .header { background: #4CAF50; color: white; padding: 15px; text-align: center; }
        .stats { margin: 20px 0; }
        .stat-row { display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid #ddd; }
        .stat-label { font-weight: bold; }
        .success { color: #4CAF50; }
        .failed { color: #f44336; }
        .footer { margin-top: 20px; padding: 10px; background: #f5f5f5; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>Email Campaign Status Report</h2>
      </div>
      <div class="stats">
        <div class="stat-row">
          <span class="stat-label">Total Recipients:</span>
          <span>${stats.total}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label success">Successfully Sent:</span>
          <span class="success">${stats.sent}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label failed">Failed:</span>
          <span class="failed">${stats.failed}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Remaining:</span>
          <span>${stats.remaining}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Success Rate:</span>
          <span>${stats.successRate}%</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Start Time:</span>
          <span>${stats.startTime}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Current Time:</span>
          <span>${stats.currentTime}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Elapsed Time:</span>
          <span>${stats.elapsedTime}</span>
        </div>
      </div>
      <div class="footer">
        <p>This is an automated status report from your email campaign.</p>
        <p>Campaign will continue until all recipients are processed.</p>
      </div>
    </body>
    </html>
  `;

  try {
    await sendEmail(transport, fromField, toEmail, subject, body, [], undefined, false);
    console.log(`\n[✓] Status report sent to ${toEmail}`);
  } catch (e) {
    console.log(`\n[!] Failed to send status report: ${e.message}`);
  }
}

/**
 * Sleep for specified milliseconds
 * @param {Number} ms - Milliseconds to sleep
 */
/**
 * Simple attachment processor with caching for static files
 */
function hasTokens(val) {
  return typeof val === 'string' && /##[A-Z0-9_]+##/i.test(val);
}

function cloneAttachments(list = []) {
  return list.map(att => ({ ...att }));
}

async function getCachedAttachment(sourcePath, filename, contentType, useEncoded, ctx) {
  const isStatic = !sourcePath.includes('##') && !filename.includes('##');
  const cacheKey = `${sourcePath}:${filename}:${contentType}:${useEncoded}`;

  if (isStatic && attachmentCache.has(cacheKey)) {
    return attachmentCache.get(cacheKey);
  }

  const buf = fs.readFileSync(sourcePath);
  let attachment;
  if (useEncoded) {
    attachment = { filename, content: buf.toString('base64'), encoding: 'base64', contentType };
  } else {
    attachment = { filename, path: sourcePath, contentType };
  }

  if (isStatic) {
    attachmentCache.set(cacheKey, attachment);
  }
  return attachment;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Prepares all components of an email for a specific recipient
 * @param {Object} cfg - Configuration object
 * @param {Object} randomizers - Loaded randomizers
 * @param {String} recipient - Recipient email
 * @param {String} fromEmail - Default from email
 * @param {String} html - Base HTML template
 * @param {Boolean} isText - Whether to send as plain text
 * @returns {Promise<Object>} Prepared email data
 */
async function prepareEmail(cfg, randomizers, recipient, fromEmail, html, isText) {
  const ctx = { to: recipient, fromEmail };
  const isOff = (v) => {
    if (v === false || v === 0 || v === null) return true;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      return s === 'false' || s === '0' || s === 'no' || s === 'off' || s === 'disabled';
    }
    return false;
  };

  const attachmentsEnabled = !(
    (cfg && isOff(cfg.attachments_enabled)) ||
    (cfg && cfg.attachments && isOff(cfg.attachments.enabled)) ||
    (cfg && cfg.Atatchimento && isOff(cfg.Atatchimento.attach_file))
  );
  if (!attachmentsEnabled) ctx.__attachments_disabled__ = true;

  // 1. Subject Randomization & Token Replacement
  const subjRaw = randomizers.subjects.length > 0
    ? getRandomItem(randomizers.subjects)
    : (cfg.subject || (cfg.message && cfg.message.subject) || (cfg.message_setting && cfg.message_setting.subject) || 'Notification');
  const subject = replaceTokens(subjRaw, ctx);

  // 2. Sender Name Randomization
  const fromNameRaw = randomizers.senderNames.length > 0
    ? getRandomItem(randomizers.senderNames)
    : (cfg.message && cfg.message.from_name);

  ctx.fromName = fromNameRaw || 'HR Department';
  const fromName = fromNameRaw ? replaceTokens(String(fromNameRaw), ctx) : undefined;

  // 3. Sender Email Randomization
  const actualFromEmail = randomizers.senderEmails.length > 0
    ? getRandomItem(randomizers.senderEmails)
    : fromEmail;

  const fromField = fromName ? `${JSON.stringify(String(fromName))} <${actualFromEmail}>` : actualFromEmail;

  // 4. Body Preparation (QR + Logo + Tokens)
  const qrHtml = (FEATURES && FEATURES.includeQrCode === false) ? '' : await buildQrHtml(cfg, ctx);
  const bodyHtml = replaceTokens(html, ctx) + qrHtml;
  const body = isText ? toPlainText(bodyHtml) : bodyHtml;

  // 5. Attachments
  const attachments = attachmentsEnabled ? await collectAttachments(cfg, ctx) : [];
  const advancedAttachments = attachmentsEnabled && cfg && cfg.advanced_attachments
    ? await processAdvancedAttachments(cfg.advanced_attachments, ctx)
    : [];
  const allAttachments = attachmentsEnabled ? [...attachments, ...advancedAttachments] : [];

  // 6. Headers
  const headers = (FEATURES && FEATURES.enableCustomHeaders && FEATURES.customHeaders)
    ? parseHeaders(FEATURES.customHeaders, ctx)
    : parseHeaders(cfg && cfg.custom_headers, ctx);

  return { fromField, to: recipient, subject, body, attachments: allAttachments, headers, isText };
}

/**
 * Sends email with configurable retry logic
 * @param {Object} transport - Nodemailer transport
 * @param {Object} emailData - Data from prepareEmail
 * @param {Number} maxRetry - Max retry attempts
 * @returns {Promise<Object>} Send result
 */
async function sendEmailWithRetry(transport, emailData, maxRetry = 3) {
  let attempt = 0;
  const { fromField, to, subject, body, attachments, headers, isText } = emailData;

  while (attempt <= maxRetry) {
    try {
      return await sendEmail(transport, fromField, to, subject, body, attachments, headers, isText);
    } catch (e) {
      attempt++;
      if (attempt > maxRetry) {
        throw new Error(`Failed after ${maxRetry} retries: ${e.message}`);
      }

      // Exponential backoff: 2s, 4s, 8s...
      const delay = Math.pow(2, attempt) * 1000;
      if (VERBOSE) {
        console.log(`\n[!] Send failed to ${to} (Attempt ${attempt}/${maxRetry}): ${e.message}. Retrying in ${delay}ms...`);
      }
      await sleep(delay);
    }
  }
}

/**
 * Simple Terminal Progress Bar
 */
class ProgressBar {
  constructor(total, width = 40) {
    this.total = total;
    this.width = width;
    this.current = 0;
    this.startTime = Date.now();
  }

  update(current) {
    this.current = current;
    this.render();
  }

  render() {
    const percent = Math.min(100, Math.floor((this.current / this.total) * 100));
    const filledLength = Math.floor((this.width * this.current) / this.total);
    const emptyLength = this.width - filledLength;

    const bar = ANSI.fg.green + '━'.repeat(filledLength) + ANSI.reset + ANSI.dim + '━'.repeat(emptyLength) + ANSI.reset;
    const stats = ` ${this.current}/${this.total} (${percent}%)`;

    // Clear line and move to start
    process.stdout.write(`\r${bar}${stats}`);
    if (this.current === this.total) {
      process.stdout.write('\n');
    }
  }
}

function createTransport(smtp, poolSize = 5) {
  const host = smtp?.host;
  const port = Number(smtp?.port) || 587;
  const user = smtp?.username;
  const pass = smtp?.password;
  const secure = (smtp?.secure !== undefined) ? !!smtp.secure : (port === 465); // if 465 -> implicit TLS
  let requireTLS = !!smtp?.use_tls && !secure; // for STARTTLS on port 587
  const provider = typeof smtp?.provider === 'string' ? smtp.provider.trim().toLowerCase() : '';
  const fromEmail = smtp?.from_email || smtp?.username;

  if (!host) {
    throw new Error('SMTP config incomplete: host required');
  }

  const isGsuiteRelay = host === 'smtp-relay.gmail.com';
  if (isGsuiteRelay) {
    // Force STARTTLS for relay unless explicitly disabled
    requireTLS = smtp?.use_tls !== false;
  }

  const needsAuth = provider === 'gsuite' && !isGsuiteRelay;
  const hasCreds = !!user && !!pass;
  if (needsAuth && !hasCreds) {
    throw new Error('SMTP auth required for G Suite: username/password missing');
  }

  const options = {
    host,
    port,
    secure,
    requireTLS,
    // Enable connection pooling for better performance
    pool: true,
    maxConnections: poolSize,
    maxMessages: 1300,
    // Connection timeout and retry settings
    connectionTimeout: 60000, // 60 seconds
    greetingTimeout: 30000,   // 30 seconds
    socketTimeout: 60000,      // 60 seconds
    // Optional TLS hardening (allow override for self-signed certs in dev)
    tls: {
      rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'
    },
    // Rate limiting protection
    rateDelta: 1000,
    rateLimit: 14, // Max 14 connections per second
  };

  // Present a domain in EHLO/HELO that matches the from address's domain
  const ehloName = smtp?.client_hostname || (fromEmail && fromEmail.split('@')[1]) || 'localhost';
  options.name = ehloName;

  // Do not use AUTH when using smtp-relay.gmail.com (passwordless relay)
  if (hasCreds && !isGsuiteRelay) {
    options.auth = { user, pass };
  }

  logStep('Transport options', { host, port, secure, requireTLS, provider, ehloName, auth: (hasCreds && !isGsuiteRelay) ? { user } : undefined, isRelay: isGsuiteRelay });

  const transport = nodemailer.createTransport(options);
  return transport;
}

async function sendEmail(transport, fromField, to, subject, body, attachments = [], headers = undefined, isText = false) {
  const message = {
    from: fromField,
    to,
    subject,
    attachments,
    envelope: { from: fromField, to }
  };
  if (isText) message.text = body; else message.html = body;
  if (headers && typeof headers === 'object') message.headers = headers;
  logStep('Prepared message', { to, subject, from: fromField, attachments: attachments.map(a => a.filename) });
  if (DRY_RUN) {
    console.log(`[DRY-RUN] Skipping actual send to ${to}`);
    return { messageId: 'dry-run', envelope: { from: fromField, to } };
  }
  const info = await transport.sendMail(message);
  logStep('Send result', { id: info.messageId, accepted: info.accepted, rejected: info.rejected });
  return info;
}

function loadSmtpFromTxt(cfg) {
  try {
    const fileName = (cfg && cfg.directory && cfg.directory.smtp_file) ? String(cfg.directory.smtp_file).trim() : 'smtps.txt';
    // Prefer BACKEND_ROOT first (sender/SETTING), then local node_version fallback
    const candidates = [
      path.join(BACKEND_ROOT, 'SETTING', fileName),
      path.join(__dirname, 'SETTING', fileName),
    ];
    logStep('SMTP file candidates', candidates);
    const smtpPath = resolveFirstExisting(candidates);
    if (!smtpPath) {
      console.log('[!] SMTP file not found:', fileName);
      return {};
    }
    const raw = fs.readFileSync(smtpPath, 'utf-8');
    const lines = raw.split(/\r?\n/).map(l => l.trim());

    // New format (multi-line with ## titles or key:value)
    if (raw.includes('##') || raw.includes(': ')) {
      const data = {};
      let lastKey = null;

      const findKey = (rawHeader) => {
        const h = rawHeader.toLowerCase();
        if (h.includes('host')) return 'host';
        if (h.includes('port')) return 'port';
        if (h.includes('user')) return 'username';
        if (h.includes('pass')) return 'password';
        if (h.includes('from') || h.includes('email')) return 'from_email';
        if (h.includes('secure')) return 'secure';
        if (h.includes('hostname')) return 'client_hostname';
        return null;
      };

      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('##')) {
          lastKey = findKey(line.replace(/^##\s*/, ''));
          continue;
        }
        if (line.includes(': ')) {
          const idx = line.indexOf(': ');
          const k = findKey(line.slice(0, idx).trim());
          const v = line.slice(idx + 2).trim();
          if (k) data[k] = v;
          continue;
        }
        if (lastKey) {
          data[lastKey] = line;
          lastKey = null;
        }
      }

      const host = data.host || '';
      const port = Number(data.port) || 587;
      const username = data.username;
      const password = data.password;
      const from_email = data.from_email;
      const secureVal = String(data.secure || '').toLowerCase();
      const secure = secureVal === 'true' || secureVal === '1' || (port === 465);
      const client_hostname = data.client_hostname;

      const isRelay = host === 'smtp-relay.gmail.com';
      const provider = (host.includes('gmail.com') || isRelay) ? 'gsuite' : 'custom';
      const use_tls = !secure && (port === 587);

      const smtp = { host, port, username, password, from_email, secure, use_tls, provider };
      if (client_hostname) smtp.client_hostname = client_hostname;
      logStep('SMTP (parsed from multi-line)', smtp);
      return smtp;
    }

    const activeLines = lines.filter(l => l && !l.startsWith('#'));
    if (activeLines.length === 0) {
      console.log('[!] SMTP file has no active lines:', smtpPath);
      return {};
    }

    let fullLine = activeLines[0];
    if (activeLines.length > 1 && !fullLine.includes(':')) {
      // It seems it was split line by line
      const host = activeLines[0] || '';
      const port = Number(activeLines[1]) || 587;
      const username = activeLines[2];
      const password = activeLines[3];
      const from_email = activeLines[4];
      const secureVal = (activeLines[5] || '').toLowerCase();
      const secure = secureVal === 'true' || secureVal === '1' || (port === 465);
      const client_hostname = activeLines[6];

      const isRelay = host === 'smtp-relay.gmail.com';
      const provider = (host.includes('gmail.com') || isRelay) ? 'gsuite' : 'custom';
      const use_tls = !secure && (port === 587);

      const smtp = { host, port, username, password, from_email, secure, use_tls, provider };
      if (client_hostname) smtp.client_hostname = client_hostname;
      logStep('SMTP (parsed from line-by-line)', smtp);
      return smtp;
    }

    const parts = fullLine.split(':');
    const host = parts[0] ? parts[0].trim() : '';
    const port = parts[1] ? Number(parts[1]) : 587;
    const username = parts[2] ? parts[2].trim() : undefined;
    const password = parts[3] ? parts[3].trim() : undefined;
    const from_email = parts[4] ? parts[4].trim() : undefined;
    const secureVal = parts[5] ? parts[5].trim().toLowerCase() : '';
    const secure = secureVal === 'true' || secureVal === '1' || (port === 465);
    const client_hostname = parts[6] ? parts[6].trim() : undefined;
    const isRelay = host === 'smtp-relay.gmail.com';
    const provider = (host.includes('gmail.com') || isRelay) ? 'gsuite' : 'custom';
    const use_tls = !secure && (port === 587); // default to STARTTLS on 587
    const smtp = { host, port, username, password, from_email, secure, use_tls, provider };
    if (client_hostname) smtp.client_hostname = client_hostname;
    logStep('SMTP (parsed from smtps.txt)', smtp);
    return smtp;
  } catch (e) {
    console.log('[!] Failed to load SMTP from smtps.txt:', e.message);
    return {};
  }
}

async function runTest() {
  const cfg = loadConfig();
  const randomizers = loadRandomizers(cfg);
  const smtp = loadSmtpFromTxt(cfg);
  const fromEmail = smtp.from_email || smtp.username;
  const html = pickLetterHtml(cfg);
  const fmtRaw = cfg && cfg.Retakontororu && cfg.Retakontororu.message_format;
  const isText = (typeof fmtRaw === 'string' && fmtRaw.trim().toLowerCase() === 'plaintext');

  const recipients = loadRecipients(cfg);
  const to = (cfg && cfg.options && cfg.options.test_email) ? cfg.options.test_email : recipients[0];

  if (!to) {
    console.log('[!] No recipients available');
    return;
  }

  console.log(`\n[TEST] Sending to: ${to}`);
  const isRelay = smtp.host === 'smtp-relay.gmail.com';
  if (smtp.provider === 'gsuite' || isRelay) console.log(`[i] Provider: G Suite (${smtp.host}, ${smtp.use_tls ? 'STARTTLS' : (smtp.port === 465 ? 'Implicit TLS' : 'Plain')})`);

  try {
    const transport = createTransport(smtp);
    const emailData = await prepareEmail(cfg, randomizers, to, fromEmail, html, isText);
    const maxRetry = Number(cfg.max_control?.max_retry) || 3;
    const info = await sendEmailWithRetry(transport, emailData, maxRetry);
    console.log('[✓] Email sent:', { id: info.messageId, envelope: info.envelope });
  } catch (e) {
    console.log('[-] Send failed:', e.message);
    process.exit(1);
  }
}

async function runCampaign() {
  const cfg = loadConfig();
  const randomizers = loadRandomizers(cfg);
  const smtp = loadSmtpFromTxt(cfg);
  const fromEmail = smtp.from_email || smtp.username;
  const html = pickLetterHtml(cfg);
  const fmtRaw = cfg && cfg.Retakontororu && cfg.Retakontororu.message_format;
  const isText = typeof fmtRaw === 'string' && fmtRaw.trim().toLowerCase() === 'plaintext';

  console.log(`\n[SETTINGS] VERBOSE=${VERBOSE} DRY_RUN=${DRY_RUN}`);

  if (!(await checkLicense())) {
    console.log('\n[!] Critical: Industrial security check failed. Exiting.');
    process.exit(1);
  }

  const recipients = loadRecipients(cfg);
  if (recipients.length === 0) {
    console.log('[!] No recipients found');
    process.exit(1);
  }

  console.log(`\n[CAMPAIGN] Starting send to ${recipients.length} recipients`);
  const isRelay = smtp.host === 'smtp-relay.gmail.com';
  if (smtp.provider === 'gsuite' || isRelay) console.log(`[i] Provider: G Suite (${smtp.host}, ${smtp.use_tls ? 'STARTTLS' : (smtp.port === 465 ? 'Implicit TLS' : 'Plain')})`);

  // Load send speed and status report config
  const sendSpeedMs = cfg && cfg.send_speed && cfg.send_speed.delay_ms ? Number(cfg.send_speed.delay_ms) : 0;
  const statusReportEnabled = !!(cfg && cfg.status_report && cfg.status_report.enabled);
  const statusReportEmail = cfg && cfg.status_report && cfg.status_report.email ? String(cfg.status_report.email).trim() : null;
  const statusReportInterval = cfg && cfg.status_report && cfg.status_report.interval ? Number(cfg.status_report.interval) : 100;
  const concurrency = Number(cfg.max_control?.max_pid) || 3;
  const maxRetry = Number(cfg.max_control?.max_retry) || 3;

  if (sendSpeedMs > 0) {
    console.log(`[i] Send speed: ${sendSpeedMs}ms delay between emails`);
  }
  console.log(`[i] Concurrency: ${concurrency} parallel workers`);

  try {
    const transport = createTransport(smtp, concurrency);
    let sent = 0;
    let failed = 0;
    const startTime = new Date();

    printBoardHeader('QUESSTALL EMAIL SENDER');
    const progressBar = new ProgressBar(recipients.length);

    // Optimized Concurrency pool: keep the pool full
    let index = 0;
    const startWorker = async () => {
      while (index < recipients.length) {
        const i = index++;
        const recipient = recipients[i];

        try {
          const emailData = await prepareEmail(cfg, randomizers, recipient, fromEmail, html, isText);
          await sendEmailWithRetry(transport, emailData, maxRetry);

          if (!DRY_RUN && !VERBOSE) {
            renderBoardRow({
              name: emailAlias(recipient) + ' Employee',
              from: emailData.fromField,
              subject: emailData.subject,
              to: recipient,
              status: 'Sent',
              date: new Date().toLocaleDateString()
            });
          }
          sent++;
        } catch (e) {
          failed++;
          if (VERBOSE) console.log(`\n[!] Failed to send to ${recipient}: ${e.message}`);
        } finally {
          progressBar.update(sent + failed);

          if (statusReportEnabled && statusReportEmail && (sent + failed) % statusReportInterval === 0) {
            const currentTime = new Date();
            const elapsedMs = currentTime - startTime;
            const stats = {
              total: recipients.length, sent, failed, remaining: recipients.length - sent - failed,
              successRate: sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : 0,
              startTime: startTime.toLocaleString(), currentTime: currentTime.toLocaleString(),
              elapsedTime: `${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s`
            };
            await sendStatusReport(transport, fromEmail, statusReportEmail, stats);
          }
        }

        if (sendSpeedMs > 0 && index < recipients.length) {
          await sleep(sendSpeedMs);
        }
      }
    };

    const workers = [];
    for (let w = 0; w < Math.min(concurrency, recipients.length); w++) {
      workers.push(startWorker());
      if (sendSpeedMs > 0) await sleep(sendSpeedMs / concurrency);
    }
    await Promise.all(workers);

    console.log(`\n[=] Completed. ${DRY_RUN ? 'Would send' : 'Sent'}: ${sent}/${recipients.length} | Failed: ${failed}`);
  } catch (e) {
    console.log('[-] Transport error:', e.message);
    process.exit(1);
  }
}

async function runInteractive() {
  const cfg = loadConfig();
  const randomizers = loadRandomizers(cfg);
  const smtp = loadSmtpFromTxt(cfg);
  const fromEmail = smtp.from_email || smtp.username;
  const html = pickLetterHtml(cfg);
  const fmtRaw = cfg && cfg.Retakontororu && cfg.Retakontororu.message_format;
  const isText = typeof fmtRaw === 'string' && fmtRaw.trim().toLowerCase() === 'plaintext';
  // Compute attachments for summary using test email if present
  const ctxSummary = { to: (cfg && cfg.options && cfg.options.test_email) ? cfg.options.test_email : undefined, fromEmail };
  const subjRaw = (FEATURES && Array.isArray(FEATURES.subject) && FEATURES.subject.length > 0)
    ? FEATURES.subject[Math.floor(Math.random() * FEATURES.subject.length)]
    : (cfg.subject || (cfg.message && cfg.message.subject) || (cfg.message_setting && cfg.message_setting.subject) || 'Interactive');
  const subject = replaceTokens(String(subjRaw), ctxSummary);

  // Use random sender name if available, otherwise use config
  const fromNameRaw = randomizers.senderNames.length > 0
    ? getRandomItem(randomizers.senderNames)
    : (cfg.message && cfg.message.from_name);

  // Set ctx.fromName before token replacement
  if (fromNameRaw) {
    ctxSummary.fromName = fromNameRaw;
    const fromName = replaceTokens(String(fromNameRaw), ctxSummary);
    var fromField = fromName ? `${JSON.stringify(String(fromName))} <${fromEmail}>` : fromEmail;
  } else {
    var fromField = fromEmail;
  }

  const attachments = await collectAttachments(cfg, ctxSummary);
  const advancedAttachments = cfg && cfg.advanced_attachments ? await processAdvancedAttachments(cfg.advanced_attachments, ctxSummary) : [];
  const allAttachments = [...attachments, ...advancedAttachments];

  console.log('\n=== NODE MAILER (LICENSED) ===');
  console.log('Configuration summary:');
  const isRelay = smtp.host === 'smtp-relay.gmail.com';
  console.table([
    { Item: 'SMTP host', Value: smtp.host },
    { Item: 'SMTP port', Value: smtp.port },
    { Item: 'From', Value: fromField },
    { Item: 'Subject', Value: subject },
    { Item: 'Attachments', Value: attachments.length },
    { Item: 'Provider', Value: (smtp.provider === 'gsuite' || isRelay) ? 'G Suite' : (smtp.provider || 'Custom SMTP') },
  ]);
  // npm run start -- --all --verbose --dry-run
  if (!(await checkLicense())) {
    console.log('\n[!] Critical: Industrial security check failed. Exiting.');
    process.exit(1);
  }

  const recipients = loadRecipients(cfg);
  console.table([{ Item: 'Recipients', Value: recipients.length }]);

  const stdin = process.stdin;
  const stdout = process.stdout;

  stdout.write('\nOptions:\n');
  stdout.write('  1) Send test email (first recipient or options.test_email)\n');
  stdout.write('  2) Run campaign (ALL recipients)\n');
  stdout.write('  3) Exit\n');
  stdout.write('\nSelect: ');

  stdin.setEncoding('utf-8');
  stdin.once('data', async (data) => {
    const choice = String(data || '').trim();
    if (choice === '1') {
      try {
        const transport = createTransport(smtp);
        const to = (cfg && cfg.options && cfg.options.test_email) ? cfg.options.test_email : recipients[0];
        if (!to) {
          console.log('[!] No recipients available');
          process.exit(1);
        }
        const ctx = { to, fromEmail };
        const testAttachments = await collectAttachments(cfg, ctx);
        const advancedTestAttachments = cfg && cfg.advanced_attachments ? await processAdvancedAttachments(cfg.advanced_attachments, ctx) : [];
        const allTestAttachments = [...testAttachments, ...advancedTestAttachments];
        const subjRaw = (FEATURES && Array.isArray(FEATURES.subject) && FEATURES.subject.length > 0)
          ? FEATURES.subject[Math.floor(Math.random() * FEATURES.subject.length)]
          : (cfg.subject || (cfg.message && cfg.message.subject) || (cfg.message_setting && cfg.message_setting.subject) || 'Interactive');
        const subject = replaceTokens(String(subjRaw), ctx);
        const fromNameRaw = cfg.message && cfg.message.from_name;
        const fromName = fromNameRaw ? replaceTokens(String(fromNameRaw), ctx) : undefined;
        const fromField = fromName ? `${JSON.stringify(String(fromName))} <${fromEmail}>` : fromEmail;
        const qrHtml = (FEATURES && FEATURES.includeQrCode === false) ? '' : await buildQrHtml(cfg, ctx);
        const bodyHtml = replaceTokens(html, ctx) + qrHtml;
        const body = isText ? toPlainText(bodyHtml) : bodyHtml;
        const headers = (FEATURES && FEATURES.enableCustomHeaders && FEATURES.customHeaders)
          ? parseHeaders(FEATURES.customHeaders, ctx)
          : parseHeaders(cfg && cfg.custom_headers, ctx);
        const info = await sendEmail(transport, fromField, to, subject, body, allTestAttachments, headers, isText);
        console.log('[✓] Test sent:', { id: info.messageId, to });
      } catch (e) {
        console.log('[-] Transport error:', e.message);
        process.exit(1);
      }
    } else if (choice === '2') {
      try {
        const transport = createTransport(smtp);
        let sent = 0;
        let failed = 0;

        // Load send speed and status report config
        const sendSpeedMs = cfg && cfg.send_speed && cfg.send_speed.delay_ms ? Number(cfg.send_speed.delay_ms) : 0;
        const statusReportEnabled = !!(cfg && cfg.status_report && cfg.status_report.enabled);
        const statusReportEmail = cfg && cfg.status_report && cfg.status_report.email ? String(cfg.status_report.email).trim() : null;
        const statusReportInterval = cfg && cfg.status_report && cfg.status_report.interval ? Number(cfg.status_report.interval) : 100;
        const concurrency = Number(cfg.max_control?.max_pid) || 3;
        const maxRetry = Number(cfg.max_control?.max_retry) || 3;
        const startTime = new Date();

        printBoardHeader('QUESSTALL EMAIL SENDER');
        const progressBar = new ProgressBar(recipients.length);

        if (sendSpeedMs > 0) {
          console.log(`[i] Send speed: ${sendSpeedMs}ms delay between emails`);
        }
        console.log(`[i] Concurrency: ${concurrency} parallel workers`);

        // Optimized Concurrency pool: keep the pool full
        let index = 0;
        const startWorker = async () => {
          while (index < recipients.length) {
            const i = index++;
            const recipient = recipients[i];

            try {
              const emailData = await prepareEmail(cfg, randomizers, recipient, fromEmail, html, isText);
              await sendEmailWithRetry(transport, emailData, maxRetry);
              sent++;
            } catch (e) {
              failed++;
              if (VERBOSE) console.log(`\n[!] Failed to send to ${recipient}: ${e.message}`);
            } finally {
              progressBar.update(sent + failed);

              if (statusReportEnabled && statusReportEmail && (sent + failed) % statusReportInterval === 0) {
                const currentTime = new Date();
                const elapsedMs = currentTime - startTime;
                const stats = {
                  total: recipients.length, sent, failed, remaining: recipients.length - sent - failed,
                  successRate: sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : 0,
                  startTime: startTime.toLocaleString(), currentTime: currentTime.toLocaleString(),
                  elapsedTime: `${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s`
                };
                await sendStatusReport(transport, fromEmail, statusReportEmail, stats);
              }
            }

            if (sendSpeedMs > 0 && index < recipients.length) {
              await sleep(sendSpeedMs);
            }
          }
        };

        const workers = [];
        for (let w = 0; w < Math.min(concurrency, recipients.length); w++) {
          workers.push(startWorker());
          if (sendSpeedMs > 0) await sleep(sendSpeedMs / concurrency);
        }
        await Promise.all(workers);

        console.log(`\n[=] Completed. Sent: ${sent}/${recipients.length} | Failed: ${failed}`);
        process.exit(0);
      } catch (e) {
        console.log('[-] Campaign error:', e.message);
        process.exit(1);
      }
    } else {
      console.log('Bye');
      process.exit(0);
    }
  });
}

(async function main() {
  const args = process.argv.slice(2);
  VERBOSE = args.includes('--verbose') || VERBOSE;
  DRY_RUN = args.includes('--dry-run') || DRY_RUN;
  if (args.includes('--all')) {
    await runCampaign();
  } else if (args.includes('--test')) {
    await runTest();
  } else {
    await runInteractive();
  }
})();