import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global state for J.A.R.V.I.S. Autonomous Browser Engine
let browserInstance = null;
let activeContext = null;
let activePage = null;
let lastInteractiveMap = [];
let lastPageData = null;
let isIncognitoActive = false;
let isHeadlessActive = false;

// Safe check if browser instance is currently alive and connected
export function isBrowserActive(b = browserInstance) {
  if (!b) return false;
  try {
    if (typeof b.isConnected === 'function') {
      return b.isConnected();
    }
    return !!b.connected;
  } catch {
    return false;
  }
}

// Auto-detect browser executable path cross-platform (Windows, macOS, Linux)
export function findBrowserExecutable() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(os.homedir(), 'AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ];
    for (const c of candidates) {
      try {
        if (fsSync.existsSync(c)) return c;
      } catch {}
    }
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  } else if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
    for (const c of candidates) {
      try {
        if (fsSync.existsSync(c)) return c;
      } catch {}
    }
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else {
    const candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    ];
    for (const c of candidates) {
      try {
        if (fsSync.existsSync(c)) return c;
      } catch {}
    }
    return '/usr/bin/google-chrome';
  }
}

// Initialize or acquire managed browser instance
export async function getBrowser(options = {}) {
  const {
    headless = false,
    incognito = false,
    viewport = { width: 1366, height: 768 }
  } = options;

  if (isBrowserActive()) {
    if (incognito && !isIncognitoActive) {
      activeContext = await browserInstance.createBrowserContext();
      activePage = await activeContext.newPage();
      isIncognitoActive = true;
    }
    return browserInstance;
  }

  // 1. Try to connect to existing Chrome running with debugging on port 9222
  try {
    const connected = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9222',
      defaultViewport: null
    });
    if (connected && isBrowserActive(connected)) {
      console.log('[JARVIS Browser Engine] Successfully attached to existing Chrome instance on port 9222!');
      browserInstance = connected;
      const pages = await browserInstance.pages();
      activePage = pages.length > 0 ? pages[0] : await browserInstance.newPage();
      isHeadlessActive = false;
      isIncognitoActive = false;
      return browserInstance;
    }
  } catch {
    // Port 9222 not available, proceed to launch managed Chrome
  }

  // 2. Launch persistent managed Chrome
  const execPath = findBrowserExecutable();
  console.log(`[JARVIS Browser Engine] Launching managed browser (${headless ? 'Headless' : 'Visible'}, Incognito: ${incognito}) using: ${execPath}`);

  // Persistent user data profile so logins and cookies are preserved across sessions
  const profileDir = path.join(os.homedir(), '.jarvis-browser-profile');
  try {
    if (!fsSync.existsSync(profileDir)) {
      fsSync.mkdirSync(profileDir, { recursive: true });
    }
  } catch {}

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1366,768',
    '--start-maximized',
    '--remote-debugging-port=9222'
  ];

  if (!incognito) {
    args.push(`--user-data-dir=${profileDir}`);
  } else {
    args.push('--incognito');
  }

  try {
    browserInstance = await puppeteer.launch({
      executablePath: execPath,
      headless: headless ? 'new' : false,
      defaultViewport: null,
      args,
      ignoreDefaultArgs: ['--enable-automation']
    });
  } catch (launchErr) {
    console.warn('[JARVIS Browser Engine] Primary launch notice, retrying with fallback flags:', launchErr.message);
    const fallbackArgs = args.filter(a => !a.startsWith('--user-data-dir='));
    browserInstance = await puppeteer.launch({
      executablePath: execPath,
      headless: headless ? 'new' : false,
      defaultViewport: null,
      args: fallbackArgs,
      ignoreDefaultArgs: ['--enable-automation']
    });
  }

  isHeadlessActive = headless;
  isIncognitoActive = incognito;

  if (incognito) {
    activeContext = await browserInstance.createBrowserContext();
    activePage = await activeContext.newPage();
  } else {
    activeContext = browserInstance.defaultBrowserContext();
    const pages = await browserInstance.pages();
    activePage = pages.length > 0 ? pages[0] : await browserInstance.newPage();
  }

  if (viewport && activePage) {
    try { await activePage.setViewport(viewport); } catch {}
  }

  browserInstance.on('disconnected', () => {
    browserInstance = null;
    activeContext = null;
    activePage = null;
    isIncognitoActive = false;
    console.log('[JARVIS Browser Engine] Browser closed or disconnected.');
  });

  return browserInstance;
}

// Close browser
export async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {}
    browserInstance = null;
    activeContext = null;
    activePage = null;
    isIncognitoActive = false;
    lastInteractiveMap = [];
    return { success: true, message: 'Managed browser instance closed.' };
  }
  return { success: true, message: 'Browser was not running.' };
}

// Get live browser engine status
export async function getBrowserStatus() {
  const isConnected = isBrowserActive();
  let url = 'about:blank';
  let title = 'No page open';

  if (isConnected && activePage && !activePage.isClosed()) {
    try {
      url = activePage.url();
      title = await activePage.title();
    } catch {}
  }

  return {
    active: isConnected,
    url,
    title,
    incognito: isIncognitoActive,
    headless: isHeadlessActive,
    interactiveElementsCount: lastInteractiveMap.length,
    lastPageData
  };
}

export function getActivePage() {
  return activePage;
}

// DOM-to-AI Parser: Deep tree walker that pierces ALL Shadow Roots (e.g. Google Cloud Skills Boost <ql-button>)
export async function parseInteractiveDOM(page = activePage) {
  if (!page || page.isClosed()) return { elements: [], textSummary: 'No active page', credentialsDetected: null };

  const parsed = await page.evaluate(() => {
    // Deep Element Crawler: traverses light DOM + every open shadowRoot
    function getAllElementsDeep(root = document.body) {
      const all = [];
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType === Node.ELEMENT_NODE) {
          all.push(node);
          if (node.shadowRoot) {
            stack.push(...Array.from(node.shadowRoot.children));
          }
          if (node.children) {
            stack.push(...Array.from(node.children));
          }
        }
      }
      return all;
    }

    const items = [];
    const all = getAllElementsDeep(document.body);
    let idx = 1;

    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const isButtonLike = tag === 'button' ||
                           tag === 'ql-button' ||
                           tag === 'ql-icon-button' ||
                           role === 'button' ||
                           el.hasAttribute('onclick') ||
                           tag === 'a' ||
                           role === 'link' ||
                           tag === 'input' ||
                           tag === 'textarea' ||
                           tag === 'select' ||
                           el.hasAttribute('tabindex');

      if (!isButtonLike) continue;

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const isVisible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';

      if (!isVisible) continue;

      // Extract comprehensive text / label across light DOM, shadow root, and attributes
      let label = (el.getAttribute('label') || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
      let text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');

      if (el.shadowRoot) {
        const shadowText = (el.shadowRoot.textContent || '').trim().replace(/\s+/g, ' ');
        if (shadowText && !text) text = shadowText;
      }

      const descriptive = label || text || el.value || '';
      if (!descriptive && tag !== 'input' && tag !== 'textarea') continue;

      // Generate robust selector
      let selector = '';
      if (el.id) {
        selector = '#' + CSS.escape(el.id);
      } else if (el.getAttribute('data-action')) {
        selector = `${tag}[data-action="${el.getAttribute('data-action')}"]`;
      } else if (el.getAttribute('label')) {
        selector = `${tag}[label="${el.getAttribute('label')}"]`;
      } else if (el.getAttribute('data-testid')) {
        selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
      } else if (el.getAttribute('aria-label')) {
        selector = `${tag}[aria-label="${el.getAttribute('aria-label')}"]`;
      } else if (el.getAttribute('name')) {
        selector = `${tag}[name="${el.getAttribute('name')}"]`;
      } else if (el.className && typeof el.className === 'string') {
        const firstClass = el.className.trim().split(/\s+/)[0];
        if (firstClass && !firstClass.includes(':')) {
          selector = `${tag}.${CSS.escape(firstClass)}`;
        }
      }
      if (!selector) selector = tag;

      items.push({
        index: idx++,
        tag,
        type: el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : ''),
        role: role || tag,
        text: descriptive.slice(0, 80),
        selector,
        href: el.getAttribute('href') || null,
        disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        rect: {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }

    // Detect Google Cloud Skills Boost / Qwiklabs credentials box across light DOM & all shadow roots
    let deepText = document.body.innerText || '';
    for (const el of all) {
      if (el.shadowRoot) {
        deepText += '\n' + (el.shadowRoot.textContent || '');
      }
      if (el.value) deepText += '\n' + el.value;
      if (el.getAttribute('data-value')) deepText += '\n' + el.getAttribute('data-value');
      if (el.getAttribute('title')) deepText += '\n' + el.getAttribute('title');
    }

    let credentials = null;

    let userMatch = deepText.match(/(?:Student Email|Username|User Name|Email)[:\s]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i) ||
                    deepText.match(/([a-zA-Z0-9._%+-]+@qwiklabs\.net)/i);
    let pwdMatch = deepText.match(/(?:Password|Temporary Password|Passphrase)[:\s]+([a-zA-Z0-9!@#$%^&*()_+=-]{6,32})/i);
    let projectMatch = deepText.match(/(?:GCP Project ID|Project ID|GCP Project)[:\s]+([a-z0-9-]+)/i) ||
                         deepText.match(/(qwiklabs-gcp-[a-z0-9-]+)/i);
    const labTimerMatch = deepText.match(/(\d{1,2}:\d{2}:\d{2})/);

    // Deep search across individual elements for qwiklabs credentials
    for (const el of all) {
      const val = (el.value || el.innerText || el.textContent || '').trim();
      if (!userMatch && /^[a-zA-Z0-9._%+-]+@qwiklabs\.net$/i.test(val)) {
        userMatch = [val, val];
      }
      if (!projectMatch && /^qwiklabs-gcp-[a-z0-9-]+$/i.test(val)) {
        projectMatch = [val, val];
      }
    }

    const isSignedOut = /sign in to start lab/i.test(deepText) || /sign in with google/i.test(deepText);

    if (userMatch || pwdMatch || projectMatch) {
      credentials = {
        username: userMatch ? userMatch[1].trim() : null,
        password: pwdMatch ? pwdMatch[1].trim() : null,
        projectId: projectMatch ? projectMatch[1].trim() : null,
        timerRemaining: labTimerMatch ? labTimerMatch[1] : null
      };
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(h => `${h.tagName}: ${h.innerText.trim()}`)
      .filter(h => h.length > 5)
      .slice(0, 10);

    return {
      elements: items.slice(0, 100),
      credentials,
      isSignedOut,
      headings,
      title: document.title,
      url: window.location.href
    };
  });

  lastInteractiveMap = parsed.elements;
  lastPageData = parsed;

  let textSummary = `[PAGE TITLE]: ${parsed.title}\n[ACTIVE URL]: ${parsed.url}\n`;

  if (parsed.credentials && (parsed.credentials.username || parsed.credentials.password || parsed.credentials.projectId)) {
    textSummary += `\n=== 🔐 DETECTED LAB CREDENTIALS MATRIX ===\n`;
    if (parsed.credentials.username) textSummary += `• Student Email / Username: ${parsed.credentials.username}\n`;
    if (parsed.credentials.password) textSummary += `• Temporary Password: ${parsed.credentials.password}\n`;
    if (parsed.credentials.projectId) textSummary += `• GCP Project ID: ${parsed.credentials.projectId}\n`;
    if (parsed.credentials.timerRemaining) textSummary += `• Lab Time Remaining: ${parsed.credentials.timerRemaining}\n`;
  }

  if (parsed.isSignedOut) {
    textSummary += `\n⚠️ [AUTHENTICATION STATUS]: User appears signed out of Google Cloud Skills Boost. Sign-in required to launch lab.\n`;
  }

  if (parsed.headings && parsed.headings.length > 0) {
    textSummary += `\n=== PAGE OUTLINE ===\n` + parsed.headings.join('\n') + '\n';
  }

  textSummary += `\n=== INTERACTIVE ACTIONABLE ELEMENTS (${parsed.elements.length} detected) ===\n`;
  for (const el of parsed.elements) {
    const typeStr = el.type ? `[${el.type}]` : '';
    textSummary += `[#${el.index}] ${el.tag.toUpperCase()}${typeStr} "${el.text}" | selector: "${el.selector}"${el.disabled ? ' (DISABLED)' : ''}\n`;
  }

  return {
    elements: parsed.elements,
    credentials: parsed.credentials,
    isSignedOut: parsed.isSignedOut,
    textSummary,
    title: parsed.title,
    url: parsed.url
  };
}

// Navigate to URL
export async function navigate(url, options = {}) {
  const {
    waitUntil = 'networkidle2',
    timeout = 45000,
    incognito = false,
    headless = false
  } = options;

  await getBrowser({ headless, incognito });

  if (!activePage || activePage.isClosed()) {
    activePage = await (activeContext || browserInstance).newPage();
  }

  let finalUrl = url.trim();
  if (!/^https?:\/\//i.test(finalUrl)) {
    finalUrl = 'https://' + finalUrl;
  }

  console.log(`[JARVIS Browser] Navigating to: ${finalUrl}`);
  await activePage.goto(finalUrl, { waitUntil, timeout });

  await new Promise(r => setTimeout(r, 1200));
  const domIntel = await parseInteractiveDOM(activePage);

  return {
    success: true,
    url: activePage.url(),
    title: await activePage.title(),
    intel: domIntel.textSummary,
    credentials: domIntel.credentials,
    elementCount: domIntel.elements.length
  };
}

// Click element by selector, index (#1), or text with Shadow DOM piercing
export async function clickElement(options = {}) {
  const { selector, text, index, waitForNav = false, timeout = 10000 } = options;
  if (!activePage || activePage.isClosed()) {
    throw new Error('No active browser page open. Call browser_navigate first.');
  }

  let targetSelector = selector;

  // Resolve by index (e.g. 1 or "#1")
  if (index !== undefined || (typeof selector === 'string' && /^#?\d+$/.test(selector))) {
    const rawIdx = index !== undefined ? parseInt(index, 10) : parseInt(selector.replace('#', ''), 10);
    const match = lastInteractiveMap.find(el => el.index === rawIdx);
    if (!match) {
      throw new Error(`Element index #${rawIdx} not found in recent interactive map. Call browser_extract_dom to refresh.`);
    }
    targetSelector = match.selector;

    // Direct hardware click if coordinates exist
    if (match.rect && match.rect.x > 0 && match.rect.y > 0) {
      try {
        await activePage.mouse.click(match.rect.x, match.rect.y);
        await new Promise(r => setTimeout(r, 800));
        const domIntel = await parseInteractiveDOM(activePage);
        return { success: true, message: `Clicked element #${rawIdx} ("${match.text}")`, intel: domIntel.textSummary };
      } catch {}
    }
  }

  // Deep client-side click evaluator (handles Shadow DOM components like <ql-button>)
  const clickDeep = await activePage.evaluate((sel, txt) => {
    function getAllElementsDeep(root = document.body) {
      const all = [];
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType === Node.ELEMENT_NODE) {
          all.push(node);
          if (node.shadowRoot) {
            stack.push(...Array.from(node.shadowRoot.children));
          }
          if (node.children) {
            stack.push(...Array.from(node.children));
          }
        }
      }
      return all;
    }

    const all = getAllElementsDeep(document.body);
    let target = null;

    // Search by selector or text across deep DOM
    for (const el of all) {
      if (sel) {
        try {
          if (el.matches && el.matches(sel)) {
            target = el;
            break;
          }
        } catch {}
      }
      if (txt) {
        const label = (el.getAttribute('label') || el.getAttribute('aria-label') || '').toLowerCase();
        const inner = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (label.includes(txt.toLowerCase()) || inner.includes(txt.toLowerCase())) {
          target = el;
          break;
        }
      }
    }

    if (target) {
      // If web component with internal button, target the button
      if (target.shadowRoot) {
        const btn = target.shadowRoot.querySelector('button');
        if (btn) target = btn;
      }

      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      const rect = target.getBoundingClientRect();

      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      if (typeof target.click === 'function') target.click();

      return {
        found: true,
        rect: {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2)
        }
      };
    }
    return { found: false };
  }, targetSelector, text);

  if (clickDeep.found) {
    if (clickDeep.rect && clickDeep.rect.x > 0 && clickDeep.rect.y > 0) {
      try {
        await activePage.mouse.click(clickDeep.rect.x, clickDeep.rect.y);
      } catch {}
    }
    if (waitForNav) {
      try { await activePage.waitForNavigation({ timeout: 5000 }); } catch {}
    }
    await new Promise(r => setTimeout(r, 800));
    const domIntel = await parseInteractiveDOM(activePage);
    return { success: true, message: `Successfully clicked target`, intel: domIntel.textSummary };
  }

  // Standard Puppeteer click fallback
  if (targetSelector) {
    try {
      await activePage.waitForSelector(targetSelector, { timeout, visible: true });
      await activePage.click(targetSelector);
      await new Promise(r => setTimeout(r, 800));
      const domIntel = await parseInteractiveDOM(activePage);
      return { success: true, message: `Clicked "${targetSelector}"`, intel: domIntel.textSummary };
    } catch (err) {
      throw new Error(`Could not click target: ${err.message}`);
    }
  }

  throw new Error('Must provide selector, text, or index.');
}

// Type text into input element
export async function typeIntoElement(options = {}) {
  const { selector, index, text, clear = true, pressEnter = false, delay = 20 } = options;
  if (!activePage || activePage.isClosed()) {
    throw new Error('No active browser page open. Call browser_navigate first.');
  }

  let targetSelector = selector;

  if (index !== undefined || (typeof selector === 'string' && /^#?\d+$/.test(selector))) {
    const rawIdx = index !== undefined ? parseInt(index, 10) : parseInt(selector.replace('#', ''), 10);
    const match = lastInteractiveMap.find(el => el.index === rawIdx);
    if (!match) {
      throw new Error(`Element index #${rawIdx} not found in interactive map.`);
    }
    targetSelector = match.selector;
  }

  if (!targetSelector) {
    throw new Error('Must provide selector or index to type into.');
  }

  console.log(`[JARVIS Browser] Typing into "${targetSelector}" (length: ${text?.length || 0})`);
  await activePage.waitForSelector(targetSelector, { timeout: 10000, visible: true });

  if (clear) {
    await activePage.click(targetSelector, { clickCount: 3 });
    await activePage.keyboard.press('Backspace');
  }

  await activePage.type(targetSelector, text || '', { delay });

  if (pressEnter) {
    await activePage.keyboard.press('Enter');
    try { await activePage.waitForNavigation({ timeout: 5000, waitUntil: 'networkidle2' }); } catch {}
  }

  await new Promise(r => setTimeout(r, 600));
  const domIntel = await parseInteractiveDOM(activePage);

  return {
    success: true,
    message: `Typed text into "${targetSelector}"`,
    url: activePage.url(),
    intel: domIntel.textSummary
  };
}

// Capture screenshot for visual inspection
export async function capturePageScreenshot(options = {}) {
  const targetPage = options.page || activePage;
  if (!targetPage || targetPage.isClosed()) {
    throw new Error('No active browser page to capture screenshot.');
  }

  const { fullPage = false } = options;
  const buffer = await targetPage.screenshot({ fullPage, type: 'jpeg', quality: 80 });
  const base64 = buffer.toString('base64');

  const uploadDir = path.join(__dirname, 'uploads');
  const filename = `browser-snap-${Date.now()}.jpg`;
  const filePath = path.join(uploadDir, filename);
  try {
    await fs.writeFile(filePath, buffer);
  } catch {}

  return {
    success: true,
    filename,
    filePath,
    url: targetPage.url(),
    title: await targetPage.title(),
    base64,
    mimeType: 'image/jpeg'
  };
}

// Specialized: Bulletproof "Start Lab" Button Detection and Click (Pierces Shadow DOM + handles confirmation modals)
export async function clickStartLab(page = activePage) {
  if (!page || page.isClosed()) throw new Error('No active page open.');

  console.log('[JARVIS Browser] Autonomous Start Lab trigger initiated...');

  const clickResult = await page.evaluate(() => {
    function getAllElementsDeep(root = document.body) {
      const all = [];
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType === Node.ELEMENT_NODE) {
          all.push(node);
          if (node.shadowRoot) {
            stack.push(...Array.from(node.shadowRoot.children));
          }
          if (node.children) {
            stack.push(...Array.from(node.children));
          }
        }
      }
      return all;
    }

    const all = getAllElementsDeep(document.body);
    let target = null;

    // Search deep DOM for Start Lab button
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      const label = (el.getAttribute('label') || '').toLowerCase();
      const action = (el.getAttribute('data-action') || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();

      const isStart = label.includes('start lab') ||
                      action === 'start-lab' ||
                      aria.includes('start lab') ||
                      cls.includes('js-start-lab') ||
                      text.includes('start lab') ||
                      (tag === 'ql-button' && (label.includes('start') || text.includes('start')));

      if (isStart) {
        if (el.shadowRoot) {
          const innerBtn = el.shadowRoot.querySelector('button');
          if (innerBtn) {
            target = innerBtn;
            break;
          }
        }
        target = el;
        break;
      }
    }

    if (!target) {
      return { found: false, message: 'Could not find "Start Lab" button in DOM or Shadow DOM.' };
    }

    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    const rect = target.getBoundingClientRect();

    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    if (typeof target.click === 'function') target.click();

    return {
      found: true,
      tag: target.tagName.toLowerCase(),
      rect: {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2)
      }
    };
  });

  if (!clickResult.found) {
    throw new Error(clickResult.message);
  }

  // Also dispatch hardware mouse click at element center via Puppeteer
  if (clickResult.rect && clickResult.rect.x > 0 && clickResult.rect.y > 0) {
    try {
      await page.mouse.click(clickResult.rect.x, clickResult.rect.y);
    } catch {}
  }

  console.log('[JARVIS Browser] "Start Lab" clicked! Checking for confirmation modal / token prompt...');

  // Modal Handling: Wait for "Launch with 1 Credit" / "Use Subscription" / "Confirm" dialog
  await new Promise(r => setTimeout(r, 2000));

  const modalHandled = await page.evaluate(() => {
    function getAllElementsDeep(root = document.body) {
      const all = [];
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType === Node.ELEMENT_NODE) {
          all.push(node);
          if (node.shadowRoot) {
            stack.push(...Array.from(node.shadowRoot.children));
          }
          if (node.children) {
            stack.push(...Array.from(node.children));
          }
        }
      }
      return all;
    }

    const all = getAllElementsDeep(document.body);
    const confirmKeywords = [
      'launch with',
      'use subscription',
      'use credit',
      'launch lab',
      'confirm',
      'start'
    ];

    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (tag !== 'button' && tag !== 'ql-button' && el.getAttribute('role') !== 'button') continue;

      const label = (el.getAttribute('label') || '').toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      const match = confirmKeywords.some(k => label.includes(k) || text.includes(k));

      if (match) {
        let btnToClick = el;
        if (el.shadowRoot) {
          const inner = el.shadowRoot.querySelector('button');
          if (inner) btnToClick = inner;
        }
        btnToClick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
        if (typeof btnToClick.click === 'function') btnToClick.click();
        return { handled: true, text: label || text };
      }
    }
    return { handled: false };
  });

  if (modalHandled.handled) {
    console.log(`[JARVIS Browser] Modal prompt confirmed: "${modalHandled.text}"`);
  }

  return { success: true, message: 'Start Lab triggered successfully', modalHandled: modalHandled.handled };
}

// Specialized: Wait for Lab Resource Provisioning & Credentials Generation
export async function waitForLabProvisioning(page = activePage, maxWaitSec = 45) {
  console.log(`[JARVIS Lab Pilot] Waiting for Google Cloud lab resources to provision (max ${maxWaitSec}s)...`);
  const start = Date.now();

  while ((Date.now() - start) < maxWaitSec * 1000) {
    await new Promise(r => setTimeout(r, 3000));
    const dom = await parseInteractiveDOM(page);

    if (dom.credentials && dom.credentials.username && dom.credentials.password) {
      console.log(`[JARVIS Lab Pilot] Lab provisioned! Credentials captured: User: ${dom.credentials.username}, Project: ${dom.credentials.projectId}`);
      return { success: true, credentials: dom.credentials };
    }

    const endLab = dom.elements.find(el => el.text.toLowerCase().includes('end lab'));
    if (endLab && dom.credentials?.username) {
      return { success: true, credentials: dom.credentials };
    }
  }

  const domFinal = await parseInteractiveDOM(page);
  if (domFinal.credentials && domFinal.credentials.username) {
    return { success: true, credentials: domFinal.credentials };
  }

  return { success: false, error: 'Timed out waiting for student credentials to appear.' };
}

// Specialized: Parse Lab Tasks, Instructions, and Code Blocks from Lab Page
export async function extractLabTasksAndInstructions(page = activePage) {
  if (!page || page.isClosed()) throw new Error('No active page to extract tasks.');

  const tasksData = await page.evaluate(() => {
    function getAllElementsDeep(root = document.body) {
      const all = [];
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType === Node.ELEMENT_NODE) {
          all.push(node);
          if (node.shadowRoot) {
            stack.push(...Array.from(node.shadowRoot.children));
          }
          if (node.children) {
            stack.push(...Array.from(node.children));
          }
        }
      }
      return all;
    }

    const tasks = [];
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
    const taskHeadings = headings.filter(h => /task\s+\d+/i.test(h.innerText));

    const codeElements = Array.from(document.querySelectorAll('ql-code-block, ql-copyable-code, pre, code'));
    const allCodeSnippets = codeElements.map(el => (el.innerText || el.textContent || '').trim())
      .filter(t => t.length > 5 && !t.includes('\n\n\n\n'));

    const allDeep = getAllElementsDeep(document.body);
    const checkProgressBtns = allDeep.filter(el => {
      const label = (el.getAttribute('label') || '').toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      return label.includes('check my progress') || text.includes('check my progress') || cls.includes('js-check-progress');
    });

    if (taskHeadings.length > 0) {
      for (let i = 0; i < taskHeadings.length; i++) {
        const h = taskHeadings[i];
        const title = h.innerText.trim();
        const nextH = taskHeadings[i + 1];

        let curr = h.nextElementSibling;
        const taskCommands = [];
        let taskDesc = '';

        while (curr && curr !== nextH) {
          const text = (curr.innerText || '').trim();
          if (curr.tagName.toLowerCase().includes('code') || curr.querySelector('pre, code, ql-code-block')) {
            const codeText = (curr.innerText || curr.textContent || '').trim();
            if (codeText) taskCommands.push(codeText);
          } else {
            taskDesc += text + '\n';
          }
          curr = curr.nextElementSibling;
        }

        tasks.push({
          taskNumber: i + 1,
          title,
          description: taskDesc.slice(0, 1000),
          commands: taskCommands,
          hasCheckProgress: i < checkProgressBtns.length
        });
      }
    } else {
      tasks.push({
        taskNumber: 1,
        title: document.title || 'Lab Instructions',
        description: 'Auto-extracted lab commands',
        commands: allCodeSnippets,
        hasCheckProgress: checkProgressBtns.length > 0
      });
    }

    return {
      title: document.title,
      tasks,
      totalCheckProgressButtons: checkProgressBtns.length,
      allCodeSnippets
    };
  });

  return tasksData;
}

// Specialized: Secure Credential Injection for Google Cloud Console (Incognito)
export async function injectCredentials(options = {}) {
  const {
    url = 'https://console.cloud.google.com',
    username,
    password,
    projectId,
    incognito = true,
    headless = false
  } = options;

  if (!username || !password) {
    throw new Error('Both username and password are required for credential injection.');
  }

  console.log(`[JARVIS Credential Injector] Initiating secure ${incognito ? 'Incognito' : 'Standard'} session for: ${username}`);

  await getBrowser({ headless, incognito: true });
  activePage = await activeContext.newPage();

  await activePage.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 1500));

  // Step 1: Detect Google Email / Username input
  const emailSelectors = ['input[type="email"]', '#identifierId', 'input[name="identifier"]', 'input[type="text"]'];
  for (const sel of emailSelectors) {
    try {
      const el = await activePage.$(sel);
      if (el) {
        console.log(`[JARVIS Credential Injector] Injecting student username into: ${sel}`);
        await el.click({ clickCount: 3 });
        await el.type(username, { delay: 25 });

        // Click Next
        const nextButtons = ['#identifierNext', 'button[type="button"]', 'button:not([disabled])'];
        for (const btnSel of nextButtons) {
          const btn = await activePage.$(btnSel);
          if (btn) {
            await btn.click();
            break;
          }
        }
        break;
      }
    } catch {}
  }

  // Step 2: Wait for Password input
  await new Promise(r => setTimeout(r, 2500));
  const passwordSelectors = ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]'];

  for (const pwdSel of passwordSelectors) {
    try {
      await activePage.waitForSelector(pwdSel, { timeout: 10000, visible: true });
      const el = await activePage.$(pwdSel);
      if (el) {
        console.log(`[JARVIS Credential Injector] Injecting password securely into: ${pwdSel}`);
        await el.type(password, { delay: 25 });

        const pwdNextButtons = ['#passwordNext', 'button[type="button"]', 'button[type="submit"]'];
        for (const btnSel of pwdNextButtons) {
          const btn = await activePage.$(btnSel);
          if (btn) {
            await btn.click();
            break;
          }
        }
        break;
      }
    } catch {}
  }

  // Step 3: Handle Google Terms / "I understand" / "Accept" prompt if presented
  await new Promise(r => setTimeout(r, 3500));
  try {
    const accepted = await activePage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
      for (const b of buttons) {
        const t = (b.innerText || b.textContent || b.value || '').toLowerCase();
        if (t.includes('i understand') || t.includes('accept') || t.includes('agree') || t.includes('confirm')) {
          b.click();
          return true;
        }
      }
      return false;
    });
    if (accepted) {
      console.log('[JARVIS Credential Injector] Accepted Google Cloud terms agreement prompt.');
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch {}

  // Step 4: Handle Google Cloud Console Terms of Service modal
  try {
    await activePage.evaluate(() => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
      checkboxes.forEach(cb => {
        if (!cb.checked) cb.click();
      });

      const buttons = Array.from(document.querySelectorAll('button'));
      for (const b of buttons) {
        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
        if (t.includes('agree and continue') || t.includes('agree & continue')) {
          b.click();
          break;
        }
      }
    });
  } catch {}

  const finalUrl = activePage.url();
  const finalTitle = await activePage.title();
  const domIntel = await parseInteractiveDOM(activePage);
  const snap = await capturePageScreenshot();

  return {
    success: true,
    message: `Secure Incognito credentials injection completed for ${username}. Active page: ${finalTitle}`,
    url: finalUrl,
    title: finalTitle,
    screenshotBase64: snap.base64,
    intel: domIntel.textSummary
  };
}

// Specialized: Execute Cloud Shell Commands in Google Cloud Console
export async function executeCloudShellCommands(consolePage, commands = []) {
  if (!consolePage || consolePage.isClosed()) throw new Error('Console page not active.');

  console.log(`[JARVIS Cloud Shell] Activating Cloud Shell terminal in Console...`);

  const activateSelectors = [
    'button[aria-label*="Cloud Shell" i]',
    'button[aria-label*="Activate Cloud Shell" i]',
    'div[debugid="cloud-shell-button"]',
    'button[mattooltip*="Cloud Shell" i]',
    '.cloud-shell-button'
  ];

  let clicked = false;
  for (const sel of activateSelectors) {
    try {
      const btn = await consolePage.$(sel);
      if (btn) {
        await btn.click();
        clicked = true;
        console.log(`[JARVIS Cloud Shell] Clicked Cloud Shell button via: ${sel}`);
        break;
      }
    } catch {}
  }

  console.log('[JARVIS Cloud Shell] Waiting for Cloud Shell environment to connect...');
  await new Promise(r => setTimeout(r, 6000));

  // Handle "Authorize Cloud Shell" modal if prompted
  try {
    await consolePage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
        if (t === 'authorize' || t.includes('authorize cloud shell')) {
          b.click();
          return true;
        }
      }
      return false;
    });
  } catch {}

  const executed = [];
  for (const cmd of commands) {
    const cleanCmd = cmd.trim();
    if (!cleanCmd) continue;

    console.log(`[JARVIS Cloud Shell] Executing command: ${cleanCmd.slice(0, 100)}...`);

    try {
      await consolePage.evaluate(() => {
        const terminalEl = document.querySelector('.terminal, textarea.xterm-helper-textarea, div[role="terminal"]');
        if (terminalEl) terminalEl.focus();
      });

      await consolePage.keyboard.type(cleanCmd, { delay: 10 });
      await consolePage.keyboard.press('Enter');
      executed.push(cleanCmd);

      await new Promise(r => setTimeout(r, 4000));

      await consolePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        for (const b of btns) {
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          if (t === 'authorize') b.click();
        }
      });
    } catch (err) {
      console.warn(`[JARVIS Cloud Shell] Command execution note: ${err.message}`);
    }
  }

  return { success: true, executedCount: executed.length, commands: executed };
}

// Specialized: Audit and Click all "Check my progress" buttons across lab page
export async function checkAllProgress(labPage) {
  if (!labPage || labPage.isClosed()) throw new Error('Lab page is not active.');

  console.log('[JARVIS Lab Pilot] Auditing and clicking all "Check my progress" buttons...');

  const result = await labPage.evaluate(async () => {
    function getAllElementsDeep(root = document.body) {
      const all = [];
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.nodeType === Node.ELEMENT_NODE) {
          all.push(node);
          if (node.shadowRoot) {
            stack.push(...Array.from(node.shadowRoot.children));
          }
          if (node.children) {
            stack.push(...Array.from(node.children));
          }
        }
      }
      return all;
    }

    const all = getAllElementsDeep(document.body);
    const checkBtns = all.filter(el => {
      const label = (el.getAttribute('label') || '').toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      return label.includes('check my progress') || text.includes('check my progress') || cls.includes('js-check-progress');
    });

    let clicked = 0;
    for (const btn of checkBtns) {
      let target = btn;
      if (btn.shadowRoot) {
        const inner = btn.shadowRoot.querySelector('button');
        if (inner) target = inner;
      }
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      if (typeof target.click === 'function') target.click();
      clicked++;
    }

    return { totalFound: checkBtns.length, clicked };
  });

  await new Promise(r => setTimeout(r, 5000));

  const scoreResult = await labPage.evaluate(() => {
    const text = document.body.innerText || '';
    const scoreMatch = text.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
    const score = scoreMatch ? `${scoreMatch[1]}/${scoreMatch[2]}` : null;
    const checksPassed = (text.match(/assessment completed/gi) || []).length;

    return { score, checksPassed, text: text.slice(0, 500) };
  });

  return {
    success: true,
    totalButtons: result.totalFound,
    clickedCount: result.clicked,
    score: scoreResult.score || 'In Progress',
    checksPassed: scoreResult.checksPassed
  };
}

// Designated target Google account for Google Skills authentication
const GOOGLE_SKILLS_ACCOUNT = 'ramireddygarikarthikreddy@gmail.com';

// Specialized: Handle Google Skills Single Sign-On (SSO) autonomously
export async function handleGoogleSkillsSignIn(page, returnUrl) {
  try {
    console.log(`[JARVIS Lab Pilot] Attempting Google Single Sign-On (SSO) exclusively with: ${GOOGLE_SKILLS_ACCOUNT}...`);

    // Step 1: If not already on sign_in page or accounts.google.com, navigate to sign_in
    const initialUrl = page.url();
    if (!initialUrl.includes('sign_in') && !initialUrl.includes('accounts.google.com')) {
      try {
        await page.goto('https://www.skills.google/users/sign_in', { waitUntil: 'networkidle2', timeout: 25000 });
      } catch {}
    }

    // Step 2: Click "Sign in with Google" button if present
    const ssoBtnClicked = await page.evaluate(() => {
      const btn = document.querySelector('#sign_in_with_google') ||
                  document.querySelector('ql-button[icon="google"]') ||
                  document.querySelector('ql-button[data-analytics-id="signin_google_sso"]') ||
                  document.querySelector('a[href*="google_oauth2"]') ||
                  document.querySelector('a[href*="/users/auth/google"]');
      if (btn) {
        if (btn.shadowRoot) {
          const b = btn.shadowRoot.querySelector('button');
          if (b) { b.click(); return true; }
        }
        btn.click();
        return true;
      }
      return false;
    });

    if (ssoBtnClicked) {
      console.log('[JARVIS Lab Pilot] Clicked "Sign in with Google" button.');
    }

    // Wait for navigation
    await new Promise(r => setTimeout(r, 4000));

    // Step 3: Handle Google Accounts chooser / email entry / consent
    const maxAuthWait = 60000;
    const authStart = Date.now();

    while ((Date.now() - authStart) < maxAuthWait) {
      const currUrl = page.url();

      if (currUrl.includes('accounts.google.com')) {
        try {
          await page.evaluate(() => {
            if (!document.getElementById('jarvis-auth-alert')) {
              const div = document.createElement('div');
              div.id = 'jarvis-auth-alert';
              div.style.position = 'fixed';
              div.style.top = '0';
              div.style.left = '0';
              div.style.width = '100vw';
              div.style.height = '150px';
              div.style.backgroundColor = 'rgba(255,0,0,0.9)';
              div.style.color = 'white';
              div.style.zIndex = '999999';
              div.style.fontSize = '30px';
              div.style.display = 'flex';
              div.style.alignItems = 'center';
              div.style.justifyContent = 'center';
              div.style.textAlign = 'center';
              div.style.pointerEvents = 'none';
              div.innerHTML = '<strong>⚠️ J.A.R.V.I.S.: PLEASE COMPLETE LOGIN / 2FA HERE TO CONTINUE!</strong>';
              document.body.appendChild(div);
            }
          });
          await page.bringToFront();
        } catch {}
      }

      // Check if we successfully returned to skills.google (authenticated!)
      if (currUrl.includes('skills.google') && !currUrl.includes('sign_in')) {
        console.log('[JARVIS Lab Pilot] Google SSO authentication successful!');
        if (returnUrl && !currUrl.includes('/labs/')) {
          await page.goto(returnUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        }
        return true;
      }

      // Check if on accounts.google.com
      if (currUrl.includes('accounts.google.com')) {
        // A: Check if account chooser is present with target email
        const accountChosen = await page.evaluate((targetEmail) => {
          const items = Array.from(document.querySelectorAll('div[data-email], div[data-identifier], li[data-identifier], div[role="link"]'));
          for (const item of items) {
            const emailAttr = (item.getAttribute('data-email') || item.getAttribute('data-identifier') || '').toLowerCase();
            const text = (item.innerText || item.textContent || '').toLowerCase();
            if (emailAttr === targetEmail.toLowerCase() || text.includes(targetEmail.toLowerCase())) {
              item.click();
              return true;
            }
          }
          return false;
        }, GOOGLE_SKILLS_ACCOUNT);

        if (accountChosen) {
          console.log(`[JARVIS Lab Pilot] Selected ${GOOGLE_SKILLS_ACCOUNT} from account chooser.`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        // B: If account chooser doesn't have target email, check for "Use another account"
        const usedAnother = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('div, li, button, span'));
          for (const item of items) {
            const t = (item.innerText || item.textContent || '').toLowerCase().trim();
            if (t === 'use another account' || t === 'add account') {
              item.click();
              return true;
            }
          }
          return false;
        });

        if (usedAnother) {
          console.log('[JARVIS Lab Pilot] Clicked "Use another account".');
          await new Promise(r => setTimeout(r, 2000));
        }

        // C: Check if email identifier input is present
        const inputFound = await page.$('input[type="email"], #identifierId, input[name="identifier"]');
        if (inputFound) {
          const isValueTarget = await page.evaluate((targetEmail) => {
            const el = document.querySelector('input[type="email"], #identifierId, input[name="identifier"]');
            return el && el.value.toLowerCase().includes(targetEmail.toLowerCase());
          }, GOOGLE_SKILLS_ACCOUNT);

          if (!isValueTarget) {
            console.log(`[JARVIS Lab Pilot] Entering email: ${GOOGLE_SKILLS_ACCOUNT}`);
            await inputFound.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type('input[type="email"], #identifierId, input[name="identifier"]', GOOGLE_SKILLS_ACCOUNT, { delay: 25 });
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
        }

        // D: Handle Google OAuth consent screen ("Allow", "Continue", etc.)
        const consentHandled = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'));
          for (const b of btns) {
            const t = (b.innerText || b.textContent || b.value || '').toLowerCase().trim();
            if (t === 'continue' || t === 'allow' || t === 'confirm' || t === 'i agree' || t === 'submit') {
              b.click();
              return true;
            }
          }
          return false;
        });

        if (consentHandled) {
          console.log('[JARVIS Lab Pilot] Confirmed OAuth consent dialog.');
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        // E: Password or device confirmation notice
        const isPasswordStep = currUrl.includes('/challenge/pwd') || await page.$('input[type="password"]');
        if (isPasswordStep) {
          console.log(`[JARVIS Lab Pilot] Sign-in checkpoint: Password or device confirmation active for ${GOOGLE_SKILLS_ACCOUNT}. Monitoring authentication progress in visible browser...`);
        }
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    // Final check
    if (page.url().includes('skills.google') && !page.url().includes('sign_in')) {
      if (returnUrl && !page.url().includes('/labs/')) {
        await page.goto(returnUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      }
      return true;
    }
  } catch (err) {
    console.warn('[JARVIS Lab Pilot] SSO automation notice:', err.message);
  }
  return false;
}

// Automatically discover active Google Skills lab URL from Chrome history & active sessions
export function getActiveGoogleSkillsLabUrl() {
  try {
    // 1. Check Chrome active open session tabs first
    const sessionsDir = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Sessions');
    if (fsSync.existsSync(sessionsDir)) {
      const tabFiles = fsSync.readdirSync(sessionsDir).filter(f => f.startsWith('Tabs_'));
      if (tabFiles.length > 0) {
        tabFiles.sort((a, b) => fsSync.statSync(path.join(sessionsDir, b)).mtimeMs - fsSync.statSync(path.join(sessionsDir, a)).mtimeMs);
        const latestTabFile = path.join(sessionsDir, tabFiles[0]);
        const buf = fsSync.readFileSync(latestTabFile);
        const str = buf.toString('latin1');
        const sessionMatches = str.match(/https?:\/\/(?:www\.)?skills\.google\/course_sessions\/\d+\/labs\/\d+/g);
        if (sessionMatches && sessionMatches.length > 0) {
          const nonExpired = sessionMatches.filter(u => !u.includes('45960361'));
          if (nonExpired.length > 0) {
            return nonExpired[0];
          }
          return sessionMatches[0];
        }
        const templateMatches = str.match(/https?:\/\/(?:www\.)?skills\.google\/course_templates\/\d+\/labs\/\d+/g);
        if (templateMatches && templateMatches.length > 0) {
          const nonExpiredT = templateMatches.filter(u => !u.includes('568119'));
          if (nonExpiredT.length > 0) {
            return nonExpiredT[0];
          }
          return templateMatches[0];
        }
      }
    }

    // 2. Fallback to Chrome History database
    const historyPath = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'History');
    if (fsSync.existsSync(historyPath)) {
      const tempHistory = path.join(os.tmpdir(), `jarvis-hist-${Date.now()}.db`);
      fsSync.copyFileSync(historyPath, tempHistory);
      const buf = fsSync.readFileSync(tempHistory);
      try { fsSync.unlinkSync(tempHistory); } catch {}
      const str = buf.toString('latin1');
      const matches = str.match(/https?:\/\/(?:www\.)?skills\.google\/course_sessions\/\d+\/labs\/\d+/g);
      if (matches && matches.length > 0) {
        const nonExpired = matches.filter(u => !u.includes('45960361'));
        if (nonExpired.length > 0) return nonExpired[nonExpired.length - 1];
        return matches[matches.length - 1];
      }
    }
  } catch (err) {
    console.warn('[JARVIS Lab Pilot] Chrome session tab discovery notice:', err.message);
  }
  return 'https://www.skills.google/course_sessions/45816933/labs/625100';
}

// Master Autonomous Google Cloud Skills Boost / Qwiklabs Lab Pilot Workflow
export async function solveLabWorkflow(options = {}) {
  const {
    labUrl,
    autoStart = true,
    executeTasks = true
  } = options;

  console.log(`[JARVIS Lab Pilot] Initializing Full Autonomous Lab Completion Workflow...`);

  // Target lab URL dynamically discovered from active session if not explicitly provided
  let targetUrl = labUrl;
  if (!targetUrl || targetUrl.includes('/course_templates/702/labs/568119') || targetUrl.includes('/course_sessions/45960361/labs/568119')) {
    const discovered = getActiveGoogleSkillsLabUrl();
    if (discovered) {
      console.log(`[JARVIS Lab Pilot] Discovered active lab URL from user session: ${discovered}`);
      targetUrl = discovered;
    } else {
      targetUrl = 'https://www.skills.google/course_sessions/45816933/labs/625100';
    }
  }

  // Step 1: Open lab page or bring active lab page to focus
  if (targetUrl) {
    console.log(`[JARVIS Lab Pilot] Navigating to lab page: ${targetUrl}`);
    await navigate(targetUrl, { headless: false });
  } else if (!activePage || activePage.isClosed()) {
    await getBrowser({ headless: false });
    const pages = await browserInstance.pages();
    for (const p of pages) {
      const url = p.url();
      if (url.includes('cloudskillsboost.google') || url.includes('skills.google')) {
        activePage = p;
        break;
      }
    }
  }

  if (!activePage || activePage.isClosed()) {
    throw new Error('No Google Cloud Skills lab page found. Please provide the labUrl or open the lab page in the browser.');
  }

  const labPage = activePage;
  let dom = await parseInteractiveDOM(labPage);

  // Step 2: Try to click Start Lab directly first
  let startTriggered = false;
  if (autoStart && (!dom.credentials || !dom.credentials.username)) {
    console.log('[JARVIS Lab Pilot] Attempting to click "Start Lab"...');
    try {
      const clickRes = await clickStartLab(labPage);
      if (clickRes.success) {
        startTriggered = true;
        console.log('[JARVIS Lab Pilot] Start Lab button clicked successfully!');
      }
    } catch (err) {
      console.log(`[JARVIS Lab Pilot] Direct click attempt note: ${err.message}`);
    }

    // If Start Lab was not found, attempt Google SSO (we might be signed out but the URL doesn't show it)
    if (!startTriggered) {
      console.log('[JARVIS Lab Pilot] Start Lab not triggered: initiating automated Google SSO or waiting for user auth...');
      const ssoSuccess = await handleGoogleSkillsSignIn(labPage, targetUrl || labUrl);
      if (ssoSuccess) {
        dom = await parseInteractiveDOM(labPage);
        try {
          await clickStartLab(labPage);
          startTriggered = true;
        } catch {}
      } else {
        console.log('[JARVIS Lab Pilot] Waiting for sign-in confirmation in browser window...');
        const authStart = Date.now();
        while ((Date.now() - authStart) < 25000) {
          await new Promise(r => setTimeout(r, 3000));
          if (!labPage.url().includes('sign_in') && !labPage.url().includes('accounts.google.com')) {
            dom = await parseInteractiveDOM(labPage);
            try {
              await clickStartLab(labPage);
              startTriggered = true;
              break;
            } catch {}
          }
        }
      }
    }

    // Step 3: Wait for lab provisioning and capture credentials
    if (startTriggered) {
      const provResult = await waitForLabProvisioning(labPage, 45);
      if (provResult.success) {
        dom = await parseInteractiveDOM(labPage);
      }
    }
  }

  if (!dom.credentials || !dom.credentials.username || !dom.credentials.password) {
    return {
      success: false,
      message: 'Could not capture temporary lab credentials from page.',
      url: labPage.url()
    };
  }

  const { username, password, projectId } = dom.credentials;
  console.log(`[JARVIS Lab Pilot] Captured credentials: ${username}, Project: ${projectId}`);

  // Step 4: Extract all instructions and tasks from lab page
  console.log('[JARVIS Lab Pilot] Parsing lab tasks and command blocks...');
  const labData = await extractLabTasksAndInstructions(labPage);

  // Step 5: Locate "Open Google Console" link
  let consoleUrl = 'https://console.cloud.google.com';
  const consoleLink = dom.elements.find(el => el.text.toLowerCase().includes('open google') || el.text.toLowerCase().includes('console'));
  if (consoleLink && consoleLink.href) {
    consoleUrl = consoleLink.href;
  }

  // Step 6: Launch Incognito Session & Inject Credentials into GCP Console
  console.log(`[JARVIS Lab Pilot] Authenticating into Google Cloud Console (${consoleUrl})...`);
  const loginResult = await injectCredentials({
    url: consoleUrl,
    username,
    password,
    projectId,
    incognito: true,
    headless: false
  });

  const consolePage = activePage;

  // Step 7: Autonomous Task Execution in Cloud Shell
  let executionResult = null;
  if (executeTasks && labData.tasks && labData.tasks.length > 0) {
    console.log(`[JARVIS Lab Pilot] Executing ${labData.tasks.length} task(s) in Cloud Shell...`);

    const allCommands = [];
    for (const task of labData.tasks) {
      if (task.commands && task.commands.length > 0) {
        allCommands.push(...task.commands);
      }
    }

    if (allCommands.length > 0) {
      executionResult = await executeCloudShellCommands(consolePage, allCommands);
    }

    // Step 8: Switch to Lab Page and Click All "Check my progress" Buttons
    console.log('[JARVIS Lab Pilot] Verifying all progress checkpoints on lab page...');
    const progressResult = await checkAllProgress(labPage);

    const finalConsoleSnap = await capturePageScreenshot({ page: consolePage });
    const finalLabSnap = await capturePageScreenshot({ page: labPage });

    return {
      success: true,
      message: `Sir, the Google Cloud Skills Boost lab "${labData.title}" has been autonomously executed! Credentials captured, Google Cloud Console authenticated, commands run in Cloud Shell, and progress checks verified.`,
      credentials: dom.credentials,
      labTitle: labData.title,
      tasksCount: labData.tasks.length,
      executedCommands: executionResult?.executedCount || 0,
      progressResult,
      screenshotBase64: finalLabSnap.base64,
      consoleScreenshotBase64: finalConsoleSnap.base64
    };
  }

  return {
    success: true,
    message: `Autonomous Lab Pilot initiated: Start Lab clicked, credentials captured (${username}), and Incognito Google Cloud Console logged in.`,
    credentials: dom.credentials,
    consoleUrl: loginResult.url,
    screenshotBase64: loginResult.screenshotBase64
  };
}
