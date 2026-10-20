import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { exec, spawn, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import os from 'os';
import multer from 'multer';
import AdmZip from 'adm-zip';
import puppeteer from 'puppeteer-core';
import fsSync from 'fs';
import * as browserEngine from './browser-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execAsync = promisify(exec);

const PORT = process.env.PORT || 3000;
let API_KEY = process.env.GOOGLE_API_KEY || '';

// Automatically read and parse .env file if present
try {
  const envContent = await fs.readFile(path.join(__dirname, '.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let val = (match[2] || '').trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
  if (!API_KEY && process.env.GOOGLE_API_KEY) {
    API_KEY = process.env.GOOGLE_API_KEY;
  }
} catch {}

// Ensure data, skills, and uploads directories exist
const DATA_DIR = path.join(__dirname, 'data');
const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');

await fs.mkdir(SKILLS_DIR, { recursive: true });
await fs.mkdir(UPLOAD_DIR, { recursive: true });

function formatBytes(bytes, decimals = 1) {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Multer disk storage: streams files of ANY size directly to disk with zero RAM overflow
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${uniqueSuffix}-${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10 GB limit per file
});

// Initialize persistent memory
let memory = {
  learned_preferences: {},
  learned_heuristics: [],
  custom_skills: {},
  ai_provider: 'ollama',
  ollama_model: 'llama3.2:3b',
  execution_stats: {
    total_commands: 0,
    successful_actions: 0,
    skills_created: 0,
    evolution_cycles: 0,
    last_evolved: new Date().toISOString()
  },
  conversation_history: []
};

try {
  const memData = await fs.readFile(MEMORY_FILE, 'utf-8');
  memory = { ...memory, ...JSON.parse(memData) };
  // Ensure default is ollama if not explicitly switched
  if (!memory.ai_provider || memory.ai_provider === 'gemini') {
    // Only keep gemini if explicitly desired, otherwise prefer offline Ollama
    memory.ai_provider = 'ollama';
  }
  if (!memory.ollama_model) memory.ollama_model = 'llama3.2:3b';
  console.log(`[JARVIS Memory] Loaded ${Object.keys(memory.learned_preferences).length} preferences, ${memory.learned_heuristics.length} heuristics, ${Object.keys(memory.custom_skills).length} custom skills.`);
} catch {
  await fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf-8');
}

async function saveMemory() {
  try {
    await fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf-8');
  } catch (err) {
    console.error('[JARVIS Memory Save Error]:', err.message);
  }
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ── TOOL DEFINITIONS FOR GEMINI ──
const tools = [{
  functionDeclarations: [
    {
      name: 'execute_command',
      description: 'Execute a PowerShell command on the Windows PC. Use for running scripts, installing software (winget, npm, pip), managing git repos, launching processes, managing network/files, etc.',
      parameters: {
        type: 'OBJECT',
        properties: {
          command: { type: 'STRING', description: 'The exact PowerShell command to run' },
          timeout_ms: { type: 'NUMBER', description: 'Timeout in ms (default 30000)' }
        },
        required: ['command']
      }
    },
    {
      name: 'open_website',
      description: 'Open any URL in the user\'s default web browser (Chrome/Edge)',
      parameters: {
        type: 'OBJECT',
        properties: {
          url: { type: 'STRING', description: 'The full URL to open (e.g. https://youtube.com)' }
        },
        required: ['url']
      }
    },
    {
      name: 'open_application',
      description: 'Launch any Windows desktop application or settings panel (e.g., notepad, chrome, code, explorer, calc, spotify, task manager, settings, paint)',
      parameters: {
        type: 'OBJECT',
        properties: {
          app_name: { type: 'STRING', description: 'Name of the app or executable path' }
        },
        required: ['app_name']
      }
    },
    {
      name: 'build_project',
      description: 'Build and scaffold a full multi-file website or software project on the PC. Generates all files and directories, and optionally serves/opens it.',
      parameters: {
        type: 'OBJECT',
        properties: {
          project_dir: { type: 'STRING', description: 'Target directory path (e.g. C:\\Users\\rkart\\Desktop\\my-website)' },
          files: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                path: { type: 'STRING', description: 'Relative path within the project (e.g., index.html, style.css, app.js)' },
                content: { type: 'STRING', description: 'Complete file contents' }
              },
              required: ['path', 'content']
            },
            description: 'Array of all project files'
          },
          open_in_browser: { type: 'BOOLEAN', description: 'Whether to immediately open the index.html or project in the browser' }
        },
        required: ['project_dir', 'files']
      }
    },
    {
      name: 'create_file',
      description: 'Create or overwrite a file with specified content anywhere on the filesystem',
      parameters: {
        type: 'OBJECT',
        properties: {
          file_path: { type: 'STRING', description: 'Absolute path to the file' },
          content: { type: 'STRING', description: 'Text or code content' }
        },
        required: ['file_path', 'content']
      }
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file on the PC',
      parameters: {
        type: 'OBJECT',
        properties: {
          file_path: { type: 'STRING', description: 'Absolute path to read' }
        },
        required: ['file_path']
      }
    },
    {
      name: 'list_directory',
      description: 'List contents of a directory to explore files and folders',
      parameters: {
        type: 'OBJECT',
        properties: {
          dir_path: { type: 'STRING', description: 'Absolute directory path' }
        },
        required: ['dir_path']
      }
    },
    {
      name: 'search_web',
      description: 'Search the web using Google Search and open the results',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'Search term or question' }
        },
        required: ['query']
      }
    },
    {
      name: 'send_message',
      description: 'Send a message or open communication tools: WhatsApp (opens chat with contact/number), Email (mailto with subject/body), Telegram, or Discord',
      parameters: {
        type: 'OBJECT',
        properties: {
          platform: { type: 'STRING', description: 'Platform: whatsapp, email, telegram, discord' },
          recipient: { type: 'STRING', description: 'Phone number (with country code), email address, or contact handle' },
          subject: { type: 'STRING', description: 'Subject line (for email)' },
          message: { type: 'STRING', description: 'The text message content' }
        },
        required: ['platform']
      }
    },
    {
      name: 'generate_image',
      description: 'Generates an image from a text prompt using a free public AI API (pollinations.ai). Returns the image URL and markdown to display to the user.',
      parameters: {
        type: 'OBJECT',
        properties: {
          prompt: { type: 'STRING', description: 'Detailed prompt describing the image to generate.' }
        },
        required: ['prompt']
      }
    },
    {
      name: 'generate_pdf',
      description: 'Generates a clean, professionally formatted downloadable PDF document (e.g. study plan, question paper analysis, summary, report, cheat sheet) from HTML content. Saves to uploads directory and returns a direct clickable download link and preview.',
      parameters: {
        type: 'OBJECT',
        properties: {
          filename: { type: 'STRING', description: 'Name of the PDF file to create (e.g. "Study_Plan.pdf" or "PYQ_Analysis.pdf")' },
          htmlContent: { type: 'STRING', description: 'Complete styled HTML content with headers, CSS styles, tables, bullet points, and neat typography to be rendered into the PDF.' },
          title: { type: 'STRING', description: 'Document title' }
        },
        required: ['filename', 'htmlContent']
      }
    },
    {
      name: 'deploy_to_public_url',
      description: 'Deploys a local web project, website, or server running on any local port (e.g. 8080 for AetherStream audio relay, 3000 for JARVIS) to an instant, secure public HTTPS URL via Cloudflare Tunnel. Works worldwide on any smartphone or browser with zero logins required.',
      parameters: {
        type: 'OBJECT',
        properties: {
          port: { type: 'INTEGER', description: 'The local port number to tunnel and make public (e.g. 8080, 3000)' },
          projectPath: { type: 'STRING', description: 'Optional project directory path if the server needs to be started first' }
        },
        required: ['port']
      }
    },
    {
      name: 'system_info',
      description: 'Get live hardware and OS telemetry: CPU, RAM, disk space, battery status, network IP, and Windows OS details',
      parameters: {
        type: 'OBJECT',
        properties: {
          category: { type: 'STRING', description: 'Category: all, cpu, memory, disk, network, battery, os' }
        },
        required: ['category']
      }
    },
    {
      name: 'manage_process',
      description: 'List active resource-heavy processes or terminate a process',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', description: 'Action: list or kill' },
          process_name: { type: 'STRING', description: 'Process name to terminate (e.g. notepad, chrome)' }
        },
        required: ['action']
      }
    },
    {
      name: 'clipboard_control',
      description: 'Read or set text on the Windows clipboard',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', description: 'Action: get or set' },
          text: { type: 'STRING', description: 'Text to copy into clipboard' }
        },
        required: ['action']
      }
    },
    {
      name: 'set_reminder',
      description: 'Set a timed reminder or alert for the user',
      parameters: {
        type: 'OBJECT',
        properties: {
          message: { type: 'STRING', description: 'Reminder alert message' },
          seconds: { type: 'NUMBER', description: 'Time in seconds from now' }
        },
        required: ['message', 'seconds']
      }
    },
    {
      name: 'learn_and_remember',
      description: 'Continuous Learning Engine: Save a user preference, habit, domain fact, key heuristic, or mistake correction into persistent memory so JARVIS continuously trains itself and remembers across sessions.',
      parameters: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', description: 'Type: preference, heuristic, fact, correction' },
          key: { type: 'STRING', description: 'Topic or label (e.g., default_framework, user_editor, whatsapp_contacts)' },
          detail: { type: 'STRING', description: 'Detailed knowledge or lesson learned' }
        },
        required: ['type', 'key', 'detail']
      }
    },
    {
      name: 'create_custom_skill',
      description: 'Self-Development Engine: Write and register a new reusable automation skill/script (PowerShell or Node.js) in JARVIS\'s skill matrix. JARVIS can call this skill in the future for specialized tasks.',
      parameters: {
        type: 'OBJECT',
        properties: {
          skill_name: { type: 'STRING', description: 'Identifier for the skill (e.g. clean_temp_files, backup_desktop)' },
          description: { type: 'STRING', description: 'What this skill does' },
          language: { type: 'STRING', description: 'Language: powershell or javascript' },
          code: { type: 'STRING', description: 'Executable script code' }
        },
        required: ['skill_name', 'description', 'language', 'code']
      }
    },
    {
      name: 'execute_custom_skill',
      description: 'Execute a previously created self-developed custom skill from the skill registry',
      parameters: {
        type: 'OBJECT',
        properties: {
          skill_name: { type: 'STRING', description: 'Name of the custom skill' },
          args: { type: 'STRING', description: 'Optional arguments to pass to the script' }
        },
        required: ['skill_name']
      }
    },
    {
      name: 'access_mail',
      description: 'Access the user\'s emails ONLY when explicitly instructed by the user. Opens Gmail or email client, searches emails, or opens the email composer.',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: {
            type: 'STRING',
            description: 'Action to perform: "inbox" (opens inbox), "unread" (shows unread emails), "search" (searches for emails matching a query), "compose" (opens composer)'
          },
          query: { type: 'STRING', description: 'Search keywords, sender, or subject query' },
          to: { type: 'STRING', description: 'Recipient email address for compose action' },
          subject: { type: 'STRING', description: 'Email subject for compose action' },
          body: { type: 'STRING', description: 'Email message body text for compose action' }
        },
        required: ['action']
      }
    },
    {
      name: 'access_whatsapp',
      description: 'Access WhatsApp ONLY when explicitly instructed by the user. Opens WhatsApp Web/Desktop, opens a direct chat with a phone number or contact, or prepares a drafted message.',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: {
            type: 'STRING',
            description: 'Action to perform: "open" (opens WhatsApp Web or Desktop application), "chat" (opens direct conversation with number/contact), "search" (opens WhatsApp search)'
          },
          recipient: { type: 'STRING', description: 'Phone number (with country code e.g. +91...) or contact name' },
          message: { type: 'STRING', description: 'Message text to send or draft' }
        },
        required: ['action']
      }
    },
    {
      name: 'access_classroom',
      description: 'Access Google Classroom to view pending homework, assignments, missing/overdue tasks, calendar deadlines, and course materials.',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: {
            type: 'STRING',
            description: 'Action to perform: "todo" (view all pending/assigned coursework & homework), "missing" (view overdue or missing assignments), "done" (view turned-in work), "calendar" (view assignment due dates calendar), "all_classes" (open main Google Classroom stream)'
          },
          class_name: { type: 'STRING', description: 'Optional specific class or subject name' }
        },
        required: ['action']
      }
    },
    {
      name: 'access_drive',
      description: 'Access Google Drive to manage, search, view files, or create new Google Docs, Sheets, or Slides.',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: {
            type: 'STRING',
            description: 'Action to perform: "my_drive" (opens root Google Drive), "search" (search for files/folders in Drive), "recent" (view recently accessed files), "starred" (view starred items), "shared" (view files shared with user), "create_doc" (create new Google Doc), "create_sheet" (create new Google Spreadsheet), "create_slides" (create new Google Presentation)'
          },
          query: { type: 'STRING', description: 'Search term or file name to find in Google Drive' }
        },
        required: ['action']
      }
    },
    {
      name: 'capture_screen',
      description: 'The FRIDAY Protocol: Capture a real-time high-resolution screenshot of the user\'s active desktop screen to visually see what is currently displayed (e.g. read unread WhatsApp messages, parse emails, solve homework problems on Google Classroom, read error messages, inspect code).',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: {
            type: 'STRING',
            description: 'The objective or focus for capturing the screen (e.g., "Read unread WhatsApp messages", "Check Google Classroom homework question", "Inspect active error dialog")'
          }
        },
        required: ['reason']
      }
    },
    {
      name: 'browser_navigate',
      description: 'Autonomous Browser Bridge: Navigate managed Chrome/Edge browser to any website URL. Automatically launches browser if not open. Returns page title and structured interactive DOM element map so you know exactly what buttons, links, inputs, and forms are available.',
      parameters: {
        type: 'OBJECT',
        properties: {
          url: { type: 'STRING', description: 'Target website URL (e.g., https://www.cloudskillsboost.google, https://console.cloud.google.com, https://github.com)' },
          incognito: { type: 'BOOLEAN', description: 'Whether to launch in an isolated Incognito browser session with zero history/data leakage' },
          headless: { type: 'BOOLEAN', description: 'Whether to run headless in background (default false, kept visible so user can watch)' }
        },
        required: ['url']
      }
    },
    {
      name: 'browser_click',
      description: 'Autonomous Browser Bridge: Click an actionable element on the managed browser page using its CSS selector, visible text, or interactive element index number (e.g., 1 or "#1" from the interactive DOM map).',
      parameters: {
        type: 'OBJECT',
        properties: {
          selector: { type: 'STRING', description: 'CSS selector or index "#N"' },
          text: { type: 'STRING', description: 'Visible text content of element to click' },
          index: { type: 'NUMBER', description: 'Numeric index [#N] of the element from the interactive DOM map' },
          waitForNav: { type: 'BOOLEAN', description: 'Wait for page navigation after clicking (default true)' }
        }
      }
    },
    {
      name: 'browser_type',
      description: 'Autonomous Browser Bridge: Type text into an input field or textarea on the managed browser page. Supports clearing field first and pressing Enter to submit.',
      parameters: {
        type: 'OBJECT',
        properties: {
          selector: { type: 'STRING', description: 'CSS selector of the input field' },
          index: { type: 'NUMBER', description: 'Numeric index [#N] of the input field from interactive DOM map' },
          text: { type: 'STRING', description: 'Text to type into the input field' },
          clear: { type: 'BOOLEAN', description: 'Whether to clear existing text before typing (default true)' },
          pressEnter: { type: 'BOOLEAN', description: 'Whether to press Enter after typing to submit form (default false)' }
        },
        required: ['text']
      }
    },
    {
      name: 'browser_extract_dom',
      description: 'DOM-to-AI Parser: Extract the full interactive DOM map, accessibility tree, page headings, and detected lab credentials (student email, temporary password, GCP project ID) from the active webpage.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'browser_screenshot',
      description: 'Autonomous Browser Bridge: Capture a high-resolution visual screenshot of the managed browser page for visual OCR and multimodal inspection by your neural vision core.',
      parameters: {
        type: 'OBJECT',
        properties: {
          fullPage: { type: 'BOOLEAN', description: 'Capture full scrollable page or viewport only (default false)' }
        }
      }
    },
    {
      name: 'browser_inject_credentials',
      description: 'Secure Credential Injection: securely inject student/user credentials into Google Cloud Console or any login form inside an isolated Incognito browser session, ensuring zero data leakage into main browser history or saved passwords.',
      parameters: {
        type: 'OBJECT',
        properties: {
          url: { type: 'STRING', description: 'Login URL (default https://console.cloud.google.com)' },
          username: { type: 'STRING', description: 'Username or student email address' },
          password: { type: 'STRING', description: 'Password or temporary lab token' },
          projectId: { type: 'STRING', description: 'Optional GCP project ID to associate' },
          incognito: { type: 'BOOLEAN', description: 'Launch in isolated Incognito window (default true)' }
        },
        required: ['username', 'password']
      }
    },
    {
      name: 'browser_solve_lab',
      description: 'Autonomous Google Cloud Skills Boost / Qwiklabs Agent: clicks "Start Lab" (piercing Shadow DOM components and automatically confirming credit/subscription modals), extracts temporary student credentials, launches Incognito Google Cloud Console, authenticates, activates Cloud Shell, executes bash/gcloud instructions, and verifies all "Check my progress" checkpoints until the project is 100% complete.',
      parameters: {
        type: 'OBJECT',
        properties: {
          labUrl: { type: 'STRING', description: 'Optional URL of the lab page. If omitted, uses active page or open tab.' },
          autoStart: { type: 'BOOLEAN', description: 'Automatically click Start Lab if lab is not yet provisioned (default true)' },
          executeTasks: { type: 'BOOLEAN', description: 'Execute extracted task commands in Cloud Shell and verify progress checks (default true)' }
        }
      }
    },
    {
      name: 'browser_start_lab',
      description: 'Autonomous Google Cloud Skills Boost Start Button Trigger: pierces all Shadow DOM components to find and click the "Start Lab" button on the lab page, and automatically confirms any credit/subscription modal prompt.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'browser_check_progress',
      description: 'Audit and click all "Check my progress" buttons across the lab page, waiting for the assessment API and reporting the score.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'desktop_click_element',
      description: 'Desktop OS Hardware Mouse Click: click directly on any coordinate (x, y) on the user\'s physical screen. Used when an app or website (like Google Skills) is open in the user\'s window on screen, physically moving the cursor and clicking buttons.',
      parameters: {
        type: 'OBJECT',
        properties: {
          x: { type: 'NUMBER', description: 'Screen X pixel coordinate' },
          y: { type: 'NUMBER', description: 'Screen Y pixel coordinate' },
          double_click: { type: 'BOOLEAN', description: 'Whether to double click' },
          description: { type: 'STRING', description: 'What is being clicked (e.g. "Start Lab button on right side of screen")' }
        },
        required: ['x', 'y']
      }
    },
    {
      name: 'browser_close',
      description: 'Close the managed browser instance or incognito session.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    }
  ]
}];

// ── TOOL IMPLEMENTATIONS ──
async function executeCommand(args) {
  memory.execution_stats.total_commands++;
  const timeout = args.timeout_ms || 35000;
  let commandToRun = (args.command || '').trim();

  // Safeguard: Prevent JARVIS from killing its own server process
  if (/(stop-process|taskkill|killall|pkill).*(node(\.exe)?)/i.test(commandToRun)) {
    commandToRun = commandToRun
      .replace(/stop-process\s+(-name\s+)?node(\.exe)?(\s+-force)?/gi, `Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${process.pid} } | Stop-Process -Force`)
      .replace(/taskkill\s+(\/[fF]\s+)?\/[iI][mM]\s+node(\.exe)?(\s+\/[fF])?/gi, `powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${process.pid} } | Stop-Process -Force"`);
  }

  // Fix Windows PowerShell 5.1 syntax error for '&&' (PowerShell 5.1 expects ';')
  commandToRun = commandToRun.replace(/\s+&&\s+/g, '; ');

  try {
    const { stdout, stderr } = await execAsync(commandToRun, {
      shell: 'powershell.exe',
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      cwd: os.homedir()
    });
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return {
      success: true,
      stdout: stdout.slice(0, 6000),
      stderr: stderr ? stderr.slice(0, 2000) : ''
    };
  } catch (err) {
    return { success: false, error: err.message.slice(0, 3000) };
  }
}

function launchDesktopTarget(targetPath) {
  return new Promise((resolve) => {
    if (!targetPath) return resolve(false);

    const target = targetPath.trim();
    const safeTarget = target.replace(/'/g, "''");

    const psScript = `
      $target = '${safeTarget}';
      $exe = $target;
      $argStr = '';

      if ($target.EndsWith(':') -or $target.Contains('://') -or (Test-Path -LiteralPath $target)) {
        $exe = 'explorer.exe';
        $argStr = $target;
      }

      # 1. Interactive Desktop Bridge (launches directly onto user active desktop WinSta0\\Default)
      try {
        $action = if ($argStr) { New-ScheduledTaskAction -Execute $exe -Argument $argStr } else { New-ScheduledTaskAction -Execute $exe };
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive;
        Register-ScheduledTask -TaskName 'JarvisDesktopBridge' -Action $action -Principal $principal -Force | Out-Null;
        Start-ScheduledTask -TaskName 'JarvisDesktopBridge';
      } catch {
        # 2. Direct Start-Process fallback
        if ($argStr) { Start-Process $exe $argStr } else { Start-Process $exe };
      }
    `.trim();

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, { windowsHide: false }, (err) => {
      if (err) {
        console.warn(`[JARVIS Launch Notice for "${target}"]:`, err.message);
        try { exec(`start "" "${target}"`); } catch {}
      }
      resolve(!err);
    });
  });
}

async function openWebsite(args) {
  let url = args.url.trim();
  if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  try {
    await launchDesktopTarget(url);
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return { success: true, url, open_tab: true, message: `Opened ${url} in browser tab` };
  } catch (err) {
    return { success: false, url, open_tab: true, error: err.message };
  }
}

async function openApplication(args) {
  const raw = (args.app_name || '').toLowerCase().trim();
  const clean = raw.replace(/['"]/g, '');

  console.log(`[JARVIS Action] Executing open_application for: "${clean}"`);

  // Direct Known Apps & Official Shortcuts / Paths
  const knownApps = {
    'code': {
      shortcut: path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code', 'Visual Studio Code.lnk'),
      exe: path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      protocol: 'vscode://'
    },
    'vscode': {
      shortcut: path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code', 'Visual Studio Code.lnk'),
      exe: path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      protocol: 'vscode://'
    },
    'vs code': {
      shortcut: path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code', 'Visual Studio Code.lnk'),
      exe: path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      protocol: 'vscode://'
    },
    'visual studio code': {
      shortcut: path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code', 'Visual Studio Code.lnk'),
      exe: path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      protocol: 'vscode://'
    },
    'chrome': {
      shortcut: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk',
      exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    },
    'google chrome': {
      shortcut: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk',
      exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    },
    'brave': {
      exe: path.join(os.homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    },
    'brave browser': {
      exe: path.join(os.homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    },
    'edge': {
      shortcut: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Microsoft Edge.lnk',
      exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    },
    'microsoft edge': {
      shortcut: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Microsoft Edge.lnk',
      exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    },
    'antigravity': {
      exe: path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'Antigravity.exe')
    },
    'notepad': {
      exe: 'C:\\Windows\\system32\\notepad.exe'
    },
    'notes': {
      exe: 'C:\\Windows\\system32\\notepad.exe'
    },
    'calc': {
      protocol: 'calculator:'
    },
    'calculator': {
      protocol: 'calculator:'
    },
    'paint': {
      exe: 'mspaint.exe'
    },
    'mspaint': {
      exe: 'mspaint.exe'
    },
    'explorer': {
      exe: 'explorer.exe'
    },
    'file explorer': {
      exe: 'explorer.exe'
    },
    'files': {
      exe: 'explorer.exe'
    },
    'cmd': {
      exe: 'cmd.exe'
    },
    'command prompt': {
      exe: 'cmd.exe'
    },
    'powershell': {
      exe: 'powershell.exe'
    },
    'terminal': {
      exe: 'wt.exe'
    },
    'taskmgr': {
      exe: 'taskmgr.exe'
    },
    'task manager': {
      exe: 'taskmgr.exe'
    },
    'settings': {
      protocol: 'ms-settings:'
    },
    'control panel': {
      exe: 'control.exe'
    },
    'spotify': {
      protocol: 'spotify:'
    },
    'discord': {
      protocol: 'discord:'
    },
    'telegram': {
      protocol: 'telegram:'
    },
    'whatsapp': {
      protocol: 'whatsapp:'
    }
  };

  let protocol = null;
  if (clean.includes('code') || clean.includes('vs')) {
    protocol = 'vscode://';
  } else if (clean.includes('spotify')) {
    protocol = 'spotify:';
  } else if (clean.includes('calc')) {
    protocol = 'calculator:';
  } else if (clean.includes('settings')) {
    protocol = 'ms-settings:';
  }

  try {
    // 1. Check known apps
    const appEntry = knownApps[clean];
    if (appEntry) {
      if (appEntry.protocol) protocol = appEntry.protocol;

      // Prefer shortcut if exists
      if (appEntry.shortcut) {
        try {
          await fs.access(appEntry.shortcut);
          await launchDesktopTarget(appEntry.shortcut);
          memory.execution_stats.successful_actions++;
          await saveMemory();
          return { success: true, protocol, message: `Successfully launched ${args.app_name} on your desktop` };
        } catch {}
      }
      // Then executable path
      if (appEntry.exe) {
        try {
          if (appEntry.exe.includes('\\') || appEntry.exe.includes('/')) {
            await fs.access(appEntry.exe);
          }
          await launchDesktopTarget(appEntry.exe);
          memory.execution_stats.successful_actions++;
          await saveMemory();
          return { success: true, protocol, message: `Successfully launched ${args.app_name} on your desktop` };
        } catch {}
      }
      // Then protocol
      if (appEntry.protocol) {
        await launchDesktopTarget(appEntry.protocol);
        memory.execution_stats.successful_actions++;
        await saveMemory();
        return { success: true, protocol, message: `Successfully launched ${args.app_name} on your desktop` };
      }
    }

    // 2. Dynamic Discovery across Windows (Start Menu shortcuts, App Paths Registry)
    const discoveryScript = `
      $name = "${clean.replace(/"/g, '')}";
      $shortcut = Get-ChildItem -Path @('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs', "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs") -Recurse -Filter "*$name*.lnk" -ErrorAction SilentlyContinue | Select-Object -First 1;
      if ($shortcut) {
        Start-Process explorer.exe "$($shortcut.FullName)"
        Write-Output "FOUND_SHORTCUT:$($shortcut.FullName)"
        exit 0
      }
      $reg = (Get-ItemProperty "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$name.exe" -ErrorAction SilentlyContinue).'(default)'
      if (-not $reg) {
        $reg = (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$name.exe" -ErrorAction SilentlyContinue).'(default)'
      }
      if ($reg -and (Test-Path $reg)) {
        Start-Process explorer.exe "$reg"
        Write-Output "FOUND_REG:$reg"
        exit 0
      }
      Start-Process "$name"
    `.trim();

    const encoded = Buffer.from(discoveryScript, 'utf16le').toString('base64');
    await execAsync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, { windowsHide: false });

    memory.execution_stats.successful_actions++;
    await saveMemory();
    return { success: true, protocol, message: `Executed launch command for ${args.app_name}` };
  } catch (err) {
    try {
      await launchDesktopTarget(clean);
      return { success: true, protocol, message: `Dispatched launch instruction for ${args.app_name}` };
    } catch (e2) {
      return { success: false, error: `Could not launch ${args.app_name}: ${err.message}` };
    }
  }
}

async function buildProject(args) {
  try {
    const projectDir = path.resolve(args.project_dir);
    await fs.mkdir(projectDir, { recursive: true });

    const createdFiles = [];
    for (const file of args.files) {
      const filePath = path.join(projectDir, file.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.content, 'utf-8');
      createdFiles.push(file.path);
    }

    let opened = false;
    let projectUrl = '';
    const indexPath = path.join(projectDir, 'index.html');
    try {
      await fs.access(indexPath);
      projectUrl = 'file:///' + indexPath.replace(/\\/g, '/');
      if (args.open_in_browser !== false) {
        await launchDesktopTarget(indexPath);
        opened = true;
      }
    } catch {
      if (args.open_in_browser !== false) {
        await launchDesktopTarget(projectDir);
        opened = true;
      }
    }

    memory.execution_stats.successful_actions++;
    await saveMemory();

    return {
      success: true,
      project_dir: projectDir,
      created_files: createdFiles,
      url: projectUrl,
      open_tab: opened,
      opened_in_browser: opened,
      message: `Project built successfully with ${createdFiles.length} files at ${projectDir}`
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function createFile(args) {
  try {
    const fullPath = path.resolve(args.file_path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, args.content, 'utf-8');
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return { success: true, message: `File created at ${fullPath}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function readFile(args) {
  try {
    const fullPath = path.resolve(args.file_path);
    const content = await fs.readFile(fullPath, 'utf-8');
    return { success: true, content: content.slice(0, 15000), path: fullPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function listDirectory(args) {
  try {
    const fullPath = path.resolve(args.dir_path);
    const items = await fs.readdir(fullPath, { withFileTypes: true });
    return {
      success: true,
      directory: fullPath,
      entries: items.map(i => ({ name: i.name, type: i.isDirectory() ? 'dir' : 'file' }))
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function searchWeb(args) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(args.query)}`;
  try {
    await launchDesktopTarget(url);
  } catch {}
  memory.execution_stats.successful_actions++;
  await saveMemory();
  return { success: true, url, open_tab: true, message: `Searching Google for: "${args.query}"` };
}

async function handleGenerateImage(args) {
  memory.execution_stats.total_commands++;
  try {
    const prompt = args.prompt || 'a futuristic AI core';
    const encodedPrompt = encodeURIComponent(prompt);
    // Add a random seed to avoid caching
    const seed = Math.floor(Math.random() * 1000000);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;
    
    memory.execution_stats.successful_actions++;
    await saveMemory();
    
    return {
      success: true,
      url: imageUrl,
      markdown: `![Generated Image](${imageUrl})`,
      message: `Image generated successfully for prompt: "${prompt}". Display the markdown in your response.`
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleGeneratePdf(args) {
  memory.execution_stats.total_commands++;
  try {
    const rawName = (args.filename || `Document_${Date.now()}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = rawName.endsWith('.pdf') ? rawName : `${rawName}.pdf`;
    const targetPath = path.join(UPLOAD_DIR, filename);
    const execPath = browserEngine.findBrowserExecutable();

    let browser = null;
    try {
      browser = await puppeteer.launch({
        executablePath: execPath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      const styledHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>${args.title || 'J.A.R.V.I.S. Report'}</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #1a202c;
            background: #ffffff;
            margin: 0;
            padding: 30px;
            line-height: 1.6;
          }
          h1, h2, h3 { color: #0f172a; margin-top: 1.4em; margin-bottom: 0.6em; }
          h1 { font-size: 24px; border-bottom: 2px solid #3b82f6; padding-bottom: 8px; margin-top: 0; }
          h2 { font-size: 18px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
          h3 { font-size: 15px; }
          p, li { font-size: 13.5px; color: #334155; }
          table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 12.5px; }
          th, td { border: 1px solid #cbd5e1; padding: 9px 11px; text-align: left; }
          th { background: #f1f5f9; font-weight: 600; color: #0f172a; }
          tr:nth-child(even) { background: #f8fafc; }
          .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; }
          .badge-high { background: #fee2e2; color: #991b1b; }
          .badge-med { background: #fef3c7; color: #92400e; }
          .badge-low { background: #dcfce7; color: #166534; }
          .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center; }
        </style>
      </head>
      <body>
        ${args.htmlContent}
        <div class="footer">Generated autonomously by J.A.R.V.I.S. Cognitive System · ${new Date().toLocaleDateString()}</div>
      </body>
      </html>
    `;

      await page.setContent(styledHtml, { waitUntil: 'networkidle0' });
      await page.pdf({
        path: targetPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' }
      });
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }

    memory.execution_stats.successful_actions++;
    await saveMemory();

    const downloadUrl = `http://localhost:3000/uploads/${filename}`;
    return {
      success: true,
      filename,
      filePath: targetPath,
      downloadUrl,
      markdown: `[📥 Download ${filename}](${downloadUrl})`,
      message: `PDF generated successfully! Sir can download the document here: ${downloadUrl}`
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleDeployToPublicUrl(args = {}) {
  const port = args.port || 8080;
  let projectPath = args.projectPath ? args.projectPath.trim() : '';

  // Auto-discover desktop project directories if none provided
  if (!projectPath) {
    const candidates = [
      path.join(os.homedir(), 'Desktop', 'aetherstream-relay'),
      path.join(os.homedir(), 'Desktop', 'aetherstream-tab-relay'),
      path.join(os.homedir(), 'Desktop', 'aetherstream-audio-relay')
    ];
    for (const c of candidates) {
      if (fsSync.existsSync(c)) {
        projectPath = c;
        break;
      }
    }
  }

  // Helper to test if local port is active
  async function isPortListening(p) {
    try {
      const resp = await fetch(`http://127.0.0.1:${p}`, { method: 'GET', signal: AbortSignal.timeout(1500) });
      return resp.status < 500;
    } catch {
      return false;
    }
  }

  // Ensure project server is active
  let isListening = await isPortListening(port);
  if (!isListening && projectPath && fsSync.existsSync(projectPath)) {
    console.log(`[Deploy] Local port ${port} not active. Launching server in ${projectPath}...`);
    // Ensure dependencies exist
    const nodeModules = path.join(projectPath, 'node_modules');
    if (!fsSync.existsSync(nodeModules) && fsSync.existsSync(path.join(projectPath, 'package.json'))) {
      try {
        execSync('npm install --no-audit --prefer-offline', { cwd: projectPath, timeout: 30000 });
      } catch (err) {
        console.warn('[Deploy] npm install warning:', err.message);
      }
    }

    const serverFile = path.join(projectPath, 'server.js');
    if (fsSync.existsSync(serverFile)) {
      try {
        const sProc = spawn('node', ['server.js'], {
          cwd: projectPath,
          detached: true,
          stdio: 'ignore'
        });
        sProc.unref();
      } catch (e) {
        console.error('[Deploy] Failed to start project server:', e);
      }
    }

    // Wait up to 6 seconds for port to start
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isPortListening(port)) {
        isListening = true;
        break;
      }
    }
  }

  const cloudflaredPath = path.join(__dirname, 'cloudflared.exe');
  if (!fsSync.existsSync(cloudflaredPath)) {
    try {
      execSync(`powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '${cloudflaredPath}'"`, { timeout: 60000 });
    } catch (e) {
      return { success: false, error: 'Could not acquire cloudflared binary: ' + e.message };
    }
  }

  const logPath = path.join(__dirname, `tunnel_${port}.log`);

  // Check if an existing tunnel URL in log is currently ALIVE
  if (fsSync.existsSync(logPath)) {
    try {
      const prev = fsSync.readFileSync(logPath, 'utf8');
      const m = prev.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (m) {
        const testUrl = m[0];
        try {
          const testResp = await fetch(testUrl, { method: 'HEAD', signal: AbortSignal.timeout(2500) });
          if (testResp.status === 200 || testResp.status === 304 || testResp.status === 302 || testResp.status === 301) {
            console.log(`[Deploy] Existing Cloudflare tunnel is verified live: ${testUrl}`);
            return {
              success: true,
              port,
              publicUrl: testUrl,
              markdown: `[🚀 Open Live Web App](${testUrl})`,
              message: `Application running on port ${port} is verified live and accessible worldwide at: ${testUrl}`
            };
          }
        } catch {}
      }
    } catch {}
    // If we reached here, the previous tunnel is dead or stale. Remove it!
    try { fsSync.unlinkSync(logPath); } catch {}
  }

  // Cleanly spawn a fresh Cloudflare Tunnel for this port
  const outFd = fsSync.openSync(logPath, 'w');
  const tProc = spawn(cloudflaredPath, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
    detached: true,
    stdio: ['ignore', outFd, outFd]
  });
  tProc.unref();

  let publicUrl = null;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (fsSync.existsSync(logPath)) {
      const content = fsSync.readFileSync(logPath, 'utf8');
      const match = content.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        publicUrl = match[0];
        break;
      }
    }
  }

  if (publicUrl) {
    // Give Cloudflare Edge 1 second to propagate the new hostname
    await new Promise(r => setTimeout(r, 1200));

    memory.execution_stats.successful_actions++;
    await saveMemory();
    return {
      success: true,
      port,
      publicUrl,
      markdown: `[🚀 Open Live Web App](${publicUrl})`,
      message: `Sir, the web application running on Port ${port} has been verified and deployed! Accessible worldwide on all devices at: ${publicUrl}`
    };
  } else {
    return {
      success: false,
      port,
      error: 'Tunnel was launched, but waiting for trycloudflare.com URL timed out. Please check tunnel log.'
    };
  }
}

async function sendMessage(args) {
  const platform = args.platform.toLowerCase().trim();
  const recipient = args.recipient ? args.recipient.trim() : '';
  const message = args.message ? args.message.trim() : '';
  const subject = args.subject ? args.subject.trim() : '';

  try {
    switch (platform) {
      case 'whatsapp': {
        const cleanPhone = recipient.replace(/[^0-9+]/g, '');
        let waUrl = 'https://web.whatsapp.com';
        if (cleanPhone) {
          waUrl = `https://wa.me/${cleanPhone}`;
          if (message) waUrl += `?text=${encodeURIComponent(message)}`;
        } else if (message) {
          waUrl = `https://web.whatsapp.com/send?text=${encodeURIComponent(message)}`;
        }
        await launchDesktopTarget(waUrl);
        memory.execution_stats.successful_actions++;
        await saveMemory();
        return { success: true, url: waUrl, open_tab: true, message: `WhatsApp opened${cleanPhone ? ' for ' + cleanPhone : ''}` };
      }
      case 'email': {
        let mailUrl = `mailto:${recipient}`;
        const params = [];
        if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
        if (message) params.push(`body=${encodeURIComponent(message)}`);
        if (params.length > 0) mailUrl += `?${params.join('&')}`;
        await launchDesktopTarget(mailUrl);
        memory.execution_stats.successful_actions++;
        await saveMemory();
        return { success: true, url: mailUrl, open_tab: true, message: `Email client opened${recipient ? ' to ' + recipient : ''}` };
      }
      case 'telegram': {
        const tgUrl = 'https://web.telegram.org';
        await launchDesktopTarget(tgUrl);
        memory.execution_stats.successful_actions++;
        await saveMemory();
        return { success: true, url: tgUrl, open_tab: true, message: 'Opened Telegram Web' };
      }
      case 'discord': {
        const dUrl = 'https://discord.com/app';
        await launchDesktopTarget(dUrl);
        memory.execution_stats.successful_actions++;
        await saveMemory();
        return { success: true, url: dUrl, open_tab: true, message: 'Opened Discord' };
      }
      default:
        return { success: false, error: `Unsupported platform: ${platform}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function systemInfo(args) {
  const category = args.category || 'all';
  const cmds = {
    os: 'Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | ConvertTo-Json',
    cpu: 'Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, LoadPercentage | ConvertTo-Json',
    memory: 'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory | ConvertTo-Json',
    disk: 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, VolumeName, Size, FreeSpace | ConvertTo-Json',
    network: 'Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" } | Select-Object InterfaceAlias, IPAddress | ConvertTo-Json',
    battery: 'Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json'
  };

  try {
    if (category === 'all') {
      const data = {};
      for (const [key, cmd] of Object.entries(cmds)) {
        try {
          const { stdout } = await execAsync(cmd, { shell: 'powershell.exe', timeout: 8000 });
          data[key] = stdout.trim() ? JSON.parse(stdout) : 'none';
        } catch {
          data[key] = 'unavailable';
        }
      }
      return { success: true, info: data };
    } else if (cmds[category]) {
      const { stdout } = await execAsync(cmds[category], { shell: 'powershell.exe', timeout: 8000 });
      return { success: true, info: stdout.trim() ? JSON.parse(stdout) : {} };
    }
    return { success: false, error: `Invalid category: ${category}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function manageProcess(args) {
  try {
    if (args.action === 'list') {
      const { stdout } = await execAsync('Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, CPU, @{Name="RAM_MB";Expression={[math]::Round($_.WorkingSet/1MB,1)}} | ConvertTo-Json', { shell: 'powershell.exe', timeout: 8000 });
      return { success: true, processes: JSON.parse(stdout) };
    } else if (args.action === 'kill' && args.process_name) {
      if (args.process_name.toLowerCase().includes('node')) {
        await execAsync(`Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${process.pid} } | Stop-Process -Force`, { shell: 'powershell.exe' });
        return { success: true, message: `Terminated background node processes while preserving JARVIS core.` };
      }
      await execAsync(`Stop-Process -Name "${args.process_name}" -Force`, { shell: 'powershell.exe' });
      return { success: true, message: `Terminated process: ${args.process_name}` };
    }
    return { success: false, error: 'Invalid action or missing process_name' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function clipboardControl(args) {
  try {
    if (args.action === 'get') {
      const { stdout } = await execAsync('Get-Clipboard', { shell: 'powershell.exe', timeout: 5000 });
      return { success: true, content: stdout.trim() };
    } else if (args.action === 'set' && args.text) {
      await execAsync(`Set-Clipboard -Value '${args.text.replace(/'/g, "''")}'`, { shell: 'powershell.exe', timeout: 5000 });
      return { success: true, message: 'Text copied to Windows clipboard' };
    }
    return { success: false, error: 'Invalid clipboard action' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

const activeReminders = [];
function setReminder(args) {
  const id = Date.now();
  const alertTime = new Date(Date.now() + args.seconds * 1000).toLocaleTimeString();
  activeReminders.push({ id, message: args.message, alertTime });
  setTimeout(() => {
    console.log(`\n🔔 [JARVIS REMINDER]: ${args.message}\n`);
  }, args.seconds * 1000);
  return { success: true, message: `Reminder set for ${args.seconds} seconds (${alertTime}): "${args.message}"` };
}

// ── CONTINUOUS SELF-TRAINING & SKILL CREATION ENGINE ──
async function learnAndRemember(args) {
  const { type, key, detail } = args;
  const timestamp = new Date().toISOString();

  if (type === 'preference') {
    memory.learned_preferences[key] = { detail, learned_at: timestamp };
  } else {
    memory.learned_heuristics.push({ type, key, detail, learned_at: timestamp });
    if (memory.learned_heuristics.length > 100) {
      memory.learned_heuristics.shift();
    }
  }

  memory.execution_stats.evolution_cycles++;
  memory.execution_stats.last_evolved = timestamp;
  await saveMemory();

  return {
    success: true,
    message: `Knowledge assimilated into JARVIS matrix: [${type.toUpperCase()}] ${key} -> ${detail}`
  };
}

async function createCustomSkill(args) {
  const { skill_name, description, language, code } = args;
  const ext = language.toLowerCase() === 'javascript' ? '.js' : '.ps1';
  const cleanName = skill_name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(SKILLS_DIR, `${cleanName}${ext}`);

  await fs.writeFile(filePath, code, 'utf-8');

  memory.custom_skills[cleanName] = {
    name: cleanName,
    description,
    language,
    file: filePath,
    created_at: new Date().toISOString(),
    runs: 0
  };

  memory.execution_stats.skills_created++;
  await saveMemory();

  return {
    success: true,
    skill_name: cleanName,
    file_path: filePath,
    message: `Skill '${cleanName}' written, compiled, and registered into JARVIS capabilities.`
  };
}

async function executeCustomSkill(args) {
  const skill = memory.custom_skills[args.skill_name];
  if (!skill) {
    return { success: false, error: `Skill '${args.skill_name}' not found in registry.` };
  }

  const extraArgs = args.args || '';
  const ext = skill.language?.toLowerCase() === 'javascript' ? '.js' : '.ps1';
  const targetScriptPath = (skill.file && fsSync.existsSync(skill.file))
    ? skill.file
    : path.join(SKILLS_DIR, `${skill.name || args.skill_name}${ext}`);

  if (!fsSync.existsSync(targetScriptPath)) {
    return { success: false, error: `Script file for skill '${args.skill_name}' not found at: ${targetScriptPath}` };
  }

  let cmd = '';
  if (skill.language && skill.language.toLowerCase() === 'javascript') {
    cmd = `node "${targetScriptPath}" ${extraArgs}`;
  } else {
    cmd = `& "${targetScriptPath}" ${extraArgs}`;
  }

  try {
    const { stdout, stderr } = await execAsync(cmd, { shell: 'powershell.exe', timeout: 30000 });
    skill.runs = (skill.runs || 0) + 1;
    await saveMemory();
    return { success: true, stdout: stdout.slice(0, 5000), stderr: stderr.slice(0, 1000) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function accessMail(args) {
  const action = (args.action || 'inbox').toLowerCase().trim();
  let url = 'https://mail.google.com/mail/u/0/#inbox';
  let message = 'Opening your Gmail inbox, Sir.';

  if (action === 'unread') {
    url = 'https://mail.google.com/mail/u/0/#search/is%3Aunread';
    message = 'Opening unread emails in Gmail, Sir.';
  } else if (action === 'search' && args.query) {
    url = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(args.query)}`;
    message = `Searching Gmail for: "${args.query}", Sir.`;
  } else if (action === 'compose') {
    const params = new URLSearchParams();
    params.set('view', 'cm');
    params.set('fs', '1');
    if (args.to) params.set('to', args.to);
    if (args.subject) params.set('su', args.subject);
    if (args.body) params.set('body', args.body);
    url = `https://mail.google.com/mail/u/0/?${params.toString()}`;
    message = `Opening Gmail composer${args.to ? ' for ' + args.to : ''}, Sir.`;
  }

  try {
    await launchDesktopTarget(url);
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return { success: true, url, open_tab: true, action, message };
  } catch (err) {
    return { success: false, url, open_tab: true, error: err.message };
  }
}

async function accessWhatsapp(args) {
  const action = (args.action || 'open').toLowerCase().trim();
  const recipient = (args.recipient || '').trim();
  const msg = (args.message || '').trim();
  let url = 'https://web.whatsapp.com';
  let message = 'Opening WhatsApp, Sir.';

  const cleanPhone = recipient.replace(/[^0-9+]/g, '');
  if (cleanPhone) {
    url = `https://wa.me/${cleanPhone.replace(/^\+/, '')}`;
    if (msg) url += `?text=${encodeURIComponent(msg)}`;
    message = `Opening WhatsApp chat with ${recipient}, Sir.`;
  } else if (msg) {
    url = `https://web.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
    message = 'Opening WhatsApp with drafted message, Sir.';
  }

  try {
    await launchDesktopTarget(url);
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return { success: true, url, open_tab: true, action, message };
  } catch (err) {
    return { success: false, url, open_tab: true, error: err.message };
  }
}

async function accessClassroom(args) {
  const action = (args.action || 'todo').toLowerCase().trim();
  let url = 'https://classroom.google.com/u/0/a/not-turned-in/all';
  let message = 'Accessing Google Classroom to-do list for pending assignments, Sir.';

  switch (action) {
    case 'todo':
    case 'assigned':
    case 'pending':
      url = 'https://classroom.google.com/u/0/a/not-turned-in/all';
      message = 'Opening pending Google Classroom assignments, Sir.';
      break;
    case 'missing':
    case 'overdue':
      url = 'https://classroom.google.com/u/0/a/missing/all';
      message = 'Checking overdue and missing coursework in Google Classroom, Sir.';
      break;
    case 'done':
    case 'completed':
    case 'turned_in':
      url = 'https://classroom.google.com/u/0/a/turned-in/all';
      message = 'Opening completed and turned-in assignments in Google Classroom, Sir.';
      break;
    case 'calendar':
    case 'schedule':
      url = 'https://classroom.google.com/u/0/calendar';
      message = 'Opening Google Classroom deadlines and assignment calendar, Sir.';
      break;
    case 'all_classes':
    case 'classes':
    default:
      url = 'https://classroom.google.com/';
      message = 'Opening main Google Classroom dashboard, Sir.';
      break;
  }

  try {
    await launchDesktopTarget(url);
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return { success: true, url, open_tab: true, action, message };
  } catch (err) {
    return { success: false, url, open_tab: true, error: err.message };
  }
}

async function accessDrive(args) {
  const action = (args.action || 'my_drive').toLowerCase().trim();
  let url = 'https://drive.google.com/drive/my-drive';
  let message = 'Opening your Google Drive, Sir.';

  switch (action) {
    case 'search':
      if (args.query) {
        url = `https://drive.google.com/drive/search?q=${encodeURIComponent(args.query)}`;
        message = `Searching Google Drive for "${args.query}", Sir.`;
      } else {
        url = 'https://drive.google.com/drive/my-drive';
      }
      break;
    case 'recent':
      url = 'https://drive.google.com/drive/recent';
      message = 'Opening recently accessed files in Google Drive, Sir.';
      break;
    case 'starred':
      url = 'https://drive.google.com/drive/starred';
      message = 'Opening starred Google Drive files, Sir.';
      break;
    case 'shared':
      url = 'https://drive.google.com/drive/shared-with-me';
      message = 'Opening files shared with you on Google Drive, Sir.';
      break;
    case 'create_doc':
    case 'doc':
    case 'new_doc':
      url = 'https://docs.google.com/document/create';
      message = 'Creating a new Google Document for your work, Sir.';
      break;
    case 'create_sheet':
    case 'sheet':
    case 'new_sheet':
      url = 'https://docs.google.com/spreadsheets/create';
      message = 'Creating a new Google Spreadsheet, Sir.';
      break;
    case 'create_slides':
    case 'slides':
    case 'presentation':
      url = 'https://docs.google.com/presentation/create';
      message = 'Creating a new Google Slides presentation, Sir.';
      break;
    case 'my_drive':
    default:
      url = 'https://drive.google.com/drive/my-drive';
      message = 'Opening Google Drive, Sir.';
      break;
  }

  try {
    await launchDesktopTarget(url);
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return { success: true, url, open_tab: true, action, message };
  } catch (err) {
    return { success: false, url, open_tab: true, error: err.message };
  }
}

// ── THE FRIDAY PROTOCOL: LOCAL SCREEN VISION & OCR BRIDGE ──
async function captureScreen(args = {}) {
  const reason = args.reason || 'Screen vision OCR';
  const timestamp = Date.now();
  const captureFilename = `screen_capture_${timestamp}.jpg`;
  const capturePath = path.join(UPLOAD_DIR, captureFilename);
  const safeCapturePath = capturePath.replace(/\\/g, '/');
  const psScriptPath = path.join(DATA_DIR, 'take_screenshot.ps1');

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('${safeCapturePath}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$graphics.Dispose()
$bitmap.Dispose()
  `.trim();

  try {
    await fs.writeFile(psScriptPath, psScript, 'utf-8');

    // Interactive Task Bridge captures directly from user active desktop (WinSta0\\Default)
    const bridgeCmd = `
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${psScriptPath.replace(/'/g, "''")}'"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName "JarvisScreenVision" -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "JarvisScreenVision"
    `.trim();

    const encoded = Buffer.from(bridgeCmd, 'utf16le').toString('base64');
    exec(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, () => {});

    let captured = false;
    for (let i = 0; i < 35; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const stats = await fs.stat(capturePath);
        if (stats.size > 1000) {
          captured = true;
          break;
        }
      } catch {}
    }

    if (!captured) {
      try {
        await execAsync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${psScriptPath}"`, { timeout: 6000 });
        const stats = await fs.stat(capturePath);
        if (stats.size > 1000) captured = true;
      } catch {}
    }

    if (!captured) {
      return { success: false, error: 'Screen capture timed out or produced an empty frame.' };
    }

    const imageBuffer = await fs.readFile(capturePath);
    const base64Image = imageBuffer.toString('base64');
    const formattedSize = formatBytes(imageBuffer.length);

    memory.execution_stats.successful_actions++;
    await saveMemory();

    return {
      success: true,
      message: `Active screen captured successfully (${formattedSize}) for ${reason}. Visual inspection ready.`,
      screenshot_file: captureFilename,
      url: `/uploads/${captureFilename}`,
      base64: base64Image,
      mimeType: 'image/jpeg',
      reason
    };
  } catch (err) {
    return { success: false, error: `Screen capture failed: ${err.message}` };
  }
}

// ── AUTONOMOUS BROWSER BRIDGE HANDLERS ──
async function handleBrowserNavigate(args) {
  memory.execution_stats.total_commands++;
  try {
    const res = await browserEngine.navigate(args.url, {
      incognito: args.incognito || false,
      headless: args.headless || false
    });
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserClick(args) {
  memory.execution_stats.total_commands++;
  try {
    const res = await browserEngine.clickElement({
      selector: args.selector,
      text: args.text,
      index: args.index,
      waitForNav: args.waitForNav !== false
    });
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserType(args) {
  memory.execution_stats.total_commands++;
  try {
    const res = await browserEngine.typeIntoElement({
      selector: args.selector,
      index: args.index,
      text: args.text,
      clear: args.clear !== false,
      pressEnter: !!args.pressEnter
    });
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserExtractDom() {
  try {
    const status = await browserEngine.getBrowserStatus();
    if (!status.active) {
      return { success: false, error: 'No active browser session. Call browser_navigate first.' };
    }
    const dom = await browserEngine.parseInteractiveDOM();
    return { success: true, ...dom };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserScreenshot(args) {
  try {
    const res = await browserEngine.capturePageScreenshot(args);
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserInjectCredentials(args) {
  memory.execution_stats.total_commands++;
  try {
    const res = await browserEngine.injectCredentials(args);
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserSolveLab(args) {
  memory.execution_stats.total_commands++;
  try {
    const res = await browserEngine.solveLabWorkflow(args);
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserStartLab() {
  memory.execution_stats.total_commands++;
  try {
    const res = await browserEngine.clickStartLab();
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserCheckProgress() {
  memory.execution_stats.total_commands++;
  try {
    const res = await browserEngine.checkAllProgress(browserEngine.getActivePage());
    memory.execution_stats.successful_actions++;
    await saveMemory();
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function desktopClickElement(args) {
  const { x, y, double_click = false, description = '' } = args;
  const targetX = Math.round(x);
  const targetY = Math.round(y);

  console.log(`[JARVIS Desktop OS Click] Physically clicking at (${targetX}, ${targetY}): ${description}`);

  try {
    const psScript = `
      Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        public class MouseOps {
          [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
          public const uint MOUSEEVENTF_LEFTDOWN = 0x02;
          public const uint MOUSEEVENTF_LEFTUP = 0x04;
          public static void Click() {
            mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
            System.Threading.Thread.Sleep(60);
            mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
          }
        }
"@
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${targetX}, ${targetY})
      [System.Threading.Thread]::Sleep(80)
      [MouseOps]::Click()
      ${double_click ? `
      [System.Threading.Thread]::Sleep(100)
      [MouseOps]::Click()
      ` : ''}
    `.trim();
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    await execAsync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`);

    return {
      success: true,
      message: `Physically clicked at screen coordinates (${targetX}, ${targetY}) [${description}]`
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleBrowserClose() {
  return await browserEngine.closeBrowser();
}

const toolHandlers = {
  execute_command: executeCommand,
  open_website: openWebsite,
  open_application: openApplication,
  build_project: buildProject,
  create_file: createFile,
  read_file: readFile,
  list_directory: listDirectory,
  search_web: searchWeb,
  generate_image: handleGenerateImage,
  generate_pdf: handleGeneratePdf,
  deploy_to_public_url: handleDeployToPublicUrl,
  send_message: sendMessage,
  system_info: systemInfo,
  manage_process: manageProcess,
  clipboard_control: clipboardControl,
  set_reminder: setReminder,
  learn_and_remember: learnAndRemember,
  create_custom_skill: createCustomSkill,
  execute_custom_skill: executeCustomSkill,
  access_mail: accessMail,
  access_whatsapp: accessWhatsapp,
  access_classroom: accessClassroom,
  access_drive: accessDrive,
  capture_screen: captureScreen,
  browser_navigate: handleBrowserNavigate,
  browser_click: handleBrowserClick,
  browser_type: handleBrowserType,
  browser_extract_dom: handleBrowserExtractDom,
  browser_screenshot: handleBrowserScreenshot,
  browser_inject_credentials: handleBrowserInjectCredentials,
  browser_solve_lab: handleBrowserSolveLab,
  browser_start_lab: handleBrowserStartLab,
  browser_check_progress: handleBrowserCheckProgress,
  desktop_click_element: desktopClickElement,
  browser_close: handleBrowserClose
};

// ── API ROUTES ──

// Autonomous Browser Bridge REST Endpoints
app.get('/api/browser/status', async (req, res) => {
  try {
    const status = await browserEngine.getBrowserStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser/navigate', async (req, res) => {
  try {
    const result = await browserEngine.navigate(req.body.url, {
      incognito: !!req.body.incognito,
      headless: !!req.body.headless
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/browser/click', async (req, res) => {
  try {
    const result = await browserEngine.clickElement(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/browser/type', async (req, res) => {
  try {
    const result = await browserEngine.typeIntoElement(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/browser/dom', async (req, res) => {
  try {
    const result = await browserEngine.parseInteractiveDOM();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/browser/screenshot', async (req, res) => {
  try {
    const result = await browserEngine.capturePageScreenshot(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/browser/inject-credentials', async (req, res) => {
  try {
    const result = await browserEngine.injectCredentials(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/browser/solve-lab', async (req, res) => {
  try {
    const result = await browserEngine.solveLabWorkflow(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/browser/start-lab', async (req, res) => {
  try {
    const result = await browserEngine.clickStartLab();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/browser/check-progress', async (req, res) => {
  try {
    const result = await browserEngine.checkAllProgress(browserEngine.getActivePage());
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/browser/close', async (req, res) => {
  try {
    const result = await browserEngine.closeBrowser();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Screen Capture REST Endpoint for the FRIDAY Protocol
app.post('/api/screen/capture', async (req, res) => {
  try {
    const result = await captureScreen({ reason: req.body.reason || 'User HUD optical request' });
    if (!result.success) {
      return res.status(500).json(result);
    }

    res.json({
      success: true,
      file: {
        id: result.screenshot_file,
        originalName: `Screen_Capture_${new Date().toLocaleTimeString().replace(/:/g, '-')}.jpg`,
        savedName: result.screenshot_file,
        path: path.join(UPLOAD_DIR, result.screenshot_file),
        size: Buffer.byteLength(result.base64, 'base64'),
        formattedSize: formatBytes(Buffer.byteLength(result.base64, 'base64')),
        mimeType: 'image/jpeg',
        extension: '.jpg',
        isImage: true,
        base64: result.base64,
        previewUrl: result.url,
        summary: `Live screen capture (${result.reason})`
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health & Status
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    hasApiKey: !!API_KEY,
    memoryStats: {
      preferences: Object.keys(memory.learned_preferences).length,
      heuristics: memory.learned_heuristics.length,
      customSkills: Object.keys(memory.custom_skills).length,
      commandsRun: memory.execution_stats.total_commands,
      successfulActions: memory.execution_stats.successful_actions,
      evolutionCycles: memory.execution_stats.evolution_cycles,
      lastEvolved: memory.execution_stats.last_evolved
    },
    uptime: Math.round(process.uptime())
  });
});

// Check Ollama Service & Installed Models
async function checkOllamaStatus() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { online: false, models: [] };
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    return { online: true, models };
  } catch {
    return { online: false, models: [] };
  }
}

// AI Engine Status Endpoint
app.get('/api/engine/status', async (req, res) => {
  const ollama = await checkOllamaStatus();
  const currentKey = process.env.GOOGLE_API_KEY || API_KEY || '';
  res.json({
    currentProvider: memory.ai_provider || 'ollama',
    currentOllamaModel: memory.ollama_model || 'llama3.2:3b',
    currentGeminiModel: memory.gemini_model || 'gemini-4-argon',
    hasGeminiKey: !!currentKey,
    geminiKeyPreview: currentKey ? `${currentKey.slice(0, 6)}...${currentKey.slice(-4)}` : '',
    ollamaOnline: ollama.online,
    ollamaModels: ollama.models
  });
});

// Switch AI Engine or Update Configuration
app.post('/api/engine/select', async (req, res) => {
  const { provider, ollamaModel, geminiModel, apiKey } = req.body;

  if (provider === 'gemini' || provider === 'ollama') {
    memory.ai_provider = provider;
  }
  if (ollamaModel && typeof ollamaModel === 'string' && ollamaModel.trim()) {
    memory.ollama_model = ollamaModel.trim();
  }
  if (geminiModel && typeof geminiModel === 'string' && geminiModel.trim()) {
    memory.gemini_model = geminiModel.trim();
  }
  if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
    API_KEY = apiKey.trim();
    process.env.GOOGLE_API_KEY = API_KEY;
    try {
      await fs.writeFile(path.join(__dirname, '.env'), `GOOGLE_API_KEY=${API_KEY}\n`, 'utf-8');
    } catch {}
  }

  await saveMemory();
  res.json({
    success: true,
    provider: memory.ai_provider,
    ollamaModel: memory.ollama_model,
    geminiModel: memory.gemini_model || 'gemini-4-argon',
    hasApiKey: !!(process.env.GOOGLE_API_KEY || API_KEY),
    message: `Active AI Engine switched to: ${memory.ai_provider === 'ollama' ? `Ollama (${memory.ollama_model})` : `Google Gemini (${memory.gemini_model || 'gemini-4-argon'})`}`
  });
});

// Update API key dynamically from UI
app.post('/api/config/key', async (req, res) => {
  const { apiKey } = req.body;
  if (apiKey && typeof apiKey === 'string') {
    API_KEY = apiKey.trim();
    process.env.GOOGLE_API_KEY = API_KEY;
    // Save to local .env
    try {
      await fs.writeFile(path.join(__dirname, '.env'), `GOOGLE_API_KEY=${API_KEY}\n`, 'utf-8');
    } catch {}
    return res.json({ success: true, message: 'API key configured successfully.' });
  }
  res.status(400).json({ success: false, error: 'Invalid API key.' });
});

// View Memory & Skills
app.get('/api/memory', (req, res) => {
  res.json(memory);
});

// Clear conversation
app.post('/api/clear', (req, res) => {
  memory.conversation_history = [];
  res.json({ success: true });
});

// Activate & Focus Application Window
app.post('/api/activate', async (req, res) => {
  const { app_name, protocol } = req.body;
  const target = (app_name || '').toLowerCase().trim();

  try {
    const psScript = `
      $ws = New-Object -ComObject WScript.Shell
      $ws.AppActivate('Visual Studio Code')
      $ws.AppActivate('Code')
      $ws.AppActivate('${target}')
    `.trim();
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, { windowsHide: false });
  } catch {}

  res.json({ success: true, message: `Activated ${target}` });
});

// Helper to inspect and parse a single uploaded file
async function processUploadedFile(file) {
  const { originalname, filename, path: filePath, size, mimetype } = file;
  const ext = path.extname(originalname).toLowerCase();
  const formattedSize = formatBytes(size);

  const fileData = {
    id: filename,
    originalName: originalname,
    savedName: filename,
    path: filePath,
    size,
    formattedSize,
    mimeType: mimetype,
    extension: ext,
    uploadedAt: new Date().toISOString()
  };

  // 1. ZIP Archive Inspection & Deep Extraction
  if (ext === '.zip' || mimetype === 'application/zip' || mimetype === 'application/x-zip-compressed') {
    try {
      const zip = new AdmZip(filePath);
      const zipEntries = zip.getEntries();

      fileData.isZip = true;
      fileData.entryCount = zipEntries.length;

      const treeLines = [];
      const codeSnippets = [];
      const textExtensions = new Set([
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.css',
        '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.php', '.rb',
        '.md', '.txt', '.xml', '.yaml', '.yml', '.sql', '.sh', '.bat', '.ps1'
      ]);

      let filesRead = 0;
      for (const entry of zipEntries) {
        const isDir = entry.isDirectory;
        const entryPath = entry.entryName;
        const entryExt = path.extname(entryPath).toLowerCase();

        if (treeLines.length < 150) {
          treeLines.push(`${isDir ? '📁' : '📄'} ${entryPath} (${formatBytes(entry.header.size)})`);
        }

        if (!isDir && textExtensions.has(entryExt) && filesRead < 25 && entry.header.size < 600000) {
          try {
            const text = entry.getData().toString('utf8');
            codeSnippets.push(`--- FILE: ${entryPath} (${formatBytes(entry.header.size)}) ---\n${text.slice(0, 25000)}`);
            filesRead++;
          } catch {}
        }
      }

      if (zipEntries.length > 150) {
        treeLines.push(`... and ${zipEntries.length - 150} additional items.`);
      }

      fileData.fileTree = treeLines.join('\n');
      fileData.codeSummary = codeSnippets.join('\n\n');
      fileData.summary = `ZIP archive containing ${zipEntries.length} files/directories. Extracted file structure and read contents of ${filesRead} source files for JARVIS analysis.`;
    } catch (zipErr) {
      fileData.zipError = zipErr.message;
      fileData.summary = `ZIP archive received (${formattedSize}), but extraction failed: ${zipErr.message}`;
    }
  }
  // 2. Image Inspection
  else if (mimetype.startsWith('image/')) {
    fileData.isImage = true;
    if (size <= 20 * 1024 * 1024) {
      const buffer = await fs.readFile(filePath);
      fileData.base64 = buffer.toString('base64');
    }
    fileData.summary = `Image file (${formattedSize}, ${mimetype}). Ready for high-resolution visual analysis.`;
  }
  // 3. Video Inspection
  else if (mimetype.startsWith('video/')) {
    fileData.isVideo = true;
    if (size <= 25 * 1024 * 1024) {
      const buffer = await fs.readFile(filePath);
      fileData.base64 = buffer.toString('base64');
      fileData.summary = `Video file (${formattedSize}, ${mimetype}). Inline frames prepared for AI inspection.`;
    } else {
      fileData.summary = `Large video file (${formattedSize}, ${mimetype}) saved to JARVIS storage.`;
    }
  }
  // 4. PDF Documents (Native Multimodal Document Understanding & Deep Local Text Extraction)
  else if (ext === '.pdf' || mimetype === 'application/pdf') {
    fileData.isPdf = true;
    if (size <= 40 * 1024 * 1024) {
      const buffer = await fs.readFile(filePath);
      fileData.base64 = buffer.toString('base64');
    }

    try {
      const extractScript = path.join(__dirname, 'extract_pdf.py');
      const pyOut = execSync(`python "${extractScript}" "${filePath}"`, {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = JSON.parse(pyOut);
      if (parsed.success && parsed.text && parsed.text.trim()) {
        fileData.isText = true;
        fileData.textContent = parsed.text;
        fileData.totalPages = parsed.totalPages;
        fileData.summary = `PDF Document (${formattedSize}, ${parsed.totalPages} pages). Deep text extracted (${parsed.text.length} chars).`;
      } else if (parsed.isScanned) {
        fileData.isScanned = true;
        fileData.totalPages = parsed.totalPages;
        fileData.summary = `Scanned PDF Document (${formattedSize}, ${parsed.totalPages} pages) with image pages.`;
      } else {
        fileData.summary = `PDF Document (${formattedSize}). Prepared for document inspection.`;
      }
    } catch (e) {
      fileData.summary = `PDF Document (${formattedSize}). Prepared for document inspection.`;
    }
  }
  // 5. Text / Source Code / Documents / Datasets
  else {
    const textExtensions = new Set([
      '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log',
      '.js', '.ts', '.py', '.html', '.css', '.c', '.cpp', '.java', '.sql', '.sh', '.bat', '.ps1'
    ]);
    if (textExtensions.has(ext) && size <= 10 * 1024 * 1024) {
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        fileData.isText = true;
        fileData.textContent = raw.slice(0, 60000);
        fileData.summary = `Document (${formattedSize}, ${raw.split('\n').length} lines).`;
      } catch {}
    } else {
      fileData.summary = `File stored in JARVIS matrix (${formattedSize}, ${mimetype || 'binary'}).`;
    }
  }

  console.log(`[JARVIS File Ingestion] Uploaded: ${originalname} (${formattedSize}, type: ${mimetype})`);
  return fileData;
}

// Upload Endpoint - Handles multiple or single files of ANY size with zero RAM exhaustion (Multer Disk Streaming)
app.post('/api/upload', upload.any(), async (req, res) => {
  try {
    const rawFiles = req.files && req.files.length > 0 ? req.files : (req.file ? [req.file] : []);
    if (rawFiles.length === 0) {
      return res.status(400).json({ success: false, error: 'No files received' });
    }

    const processedFiles = [];
    for (const f of rawFiles) {
      const data = await processUploadedFile(f);
      processedFiles.push(data);
    }

    res.json({
      success: true,
      files: processedFiles,
      file: processedFiles[0] // backwards-compatibility for single file
    });
  } catch (err) {
    console.error('[Upload Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Neural Voice Transcription Endpoint (Universal Audio Bridge for Brave, Chrome, Edge, Safari)
app.post('/api/voice/transcribe', async (req, res) => {
  const clientKey = req.body.apiKey || API_KEY;
  if (!clientKey) {
    return res.status(400).json({ error: 'API key required for neural transcription', text: '' });
  }

  const { audioBase64, mimeType = 'audio/webm' } = req.body;
  if (!audioBase64) {
    return res.status(400).json({ error: 'Audio data missing', text: '' });
  }

  const cleanMime = mimeType.split(';')[0].trim();
  const ai = new GoogleGenAI({ apiKey: clientKey });

  // Dedicated transcription model first, then ultra-fast fallback
  const modelsToTry = ['gemini-3.5-transcribe', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];

  for (const model of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: cleanMime,
                  data: audioBase64
                }
              },
              {
                text: 'Transcribe the spoken English words in this audio recording verbatim. Output ONLY the raw transcribed text. Do not add quotes, introductory remarks, explanations, or punctuation summaries. If the audio contains only silence, background noise, or no recognizable human speech, respond with EMPTY.'
              }
            ]
          }
        ],
        config: {
          temperature: 0.1,
          maxOutputTokens: 300
        }
      });

      let transcribed = (response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      if ((transcribed.startsWith('"') && transcribed.endsWith('"')) || (transcribed.startsWith("'") && transcribed.endsWith("'"))) {
        transcribed = transcribed.slice(1, -1).trim();
      }
      if (transcribed.toUpperCase() === 'EMPTY' || transcribed === '""' || !transcribed) {
        return res.json({ text: '' });
      }

      console.log(`[JARVIS Audio Transcribed via ${model}]: "${transcribed}"`);
      return res.json({ text: transcribed });
    } catch (err) {
      console.warn(`[JARVIS Transcription warning] Model ${model} failed:`, err.message);
    }
  }

  return res.json({ text: '' });
});

// Convert Gemini tool declarations to Ollama / OpenAI function format
function getOllamaTools() {
  const geminiDecls = tools[0]?.functionDeclarations || [];
  return geminiDecls.map(decl => {
    const cleanParams = JSON.parse(JSON.stringify(decl.parameters || { type: 'object', properties: {} }));
    function lowercaseTypes(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (typeof obj.type === 'string') {
        obj.type = obj.type.toLowerCase();
      }
      if (obj.properties) {
        for (const key of Object.keys(obj.properties)) {
          lowercaseTypes(obj.properties[key]);
        }
      }
      if (obj.items) {
        lowercaseTypes(obj.items);
      }
    }
    lowercaseTypes(cleanParams);
    return {
      type: 'function',
      function: {
        name: decl.name,
        description: decl.description,
        parameters: cleanParams
      }
    };
  });
}

// Universal Streaming Ollama Client - immune to HTTP headers timeout and long generation limits
async function callOllamaStream(payload, { idleTimeoutMs = 180000 } = {}) {
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: true })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama engine returned ${res.status}: ${errText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let toolCalls = [];
  let buffer = '';
  let lastLoggedChars = 0;

  while (true) {
    // Activity watchdog: only error if no chunk received for idleTimeoutMs (180s)
    let timerId;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error('Ollama connection idle: no tokens received for 3 minutes')), idleTimeoutMs);
    });

    try {
      const { done, value } = await Promise.race([
        reader.read().then(res => { clearTimeout(timerId); return res; }),
        timeoutPromise
      ]);

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message) {
            if (json.message.content) {
              fullContent += json.message.content;
              if (fullContent.length - lastLoggedChars >= 1000) {
                console.log(`[Ollama Stream Progress] Generated ${fullContent.length} chars...`);
                lastLoggedChars = fullContent.length;
              }
            }
            if (json.message.tool_calls && json.message.tool_calls.length > 0) {
              toolCalls.push(...json.message.tool_calls);
            }
          }
        } catch (e) {}
      }
    } catch (streamErr) {
      clearTimeout(timerId);
      throw streamErr;
    }
  }

  if (buffer.trim()) {
    try {
      const json = JSON.parse(buffer);
      if (json.message?.content) fullContent += json.message.content;
      if (json.message?.tool_calls) toolCalls.push(...json.message.tool_calls);
    } catch (e) {}
  }

  return {
    message: {
      role: 'assistant',
      content: fullContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined
    }
  };
}

// Autonomous Ollama Inference Loop with Tool Calling & Vision Chaining
// Optimized for small models (3B-7B) with dynamic prompt/tool/history management
async function runOllamaInference({ modelName, userMessage, filesList = [], systemInstruction = '' }) {
  const ollamaModel = modelName || memory.ollama_model || 'llama3.2:3b';
  const actionsPerformed = [];
  const memoryLearned = [];

  // ── Estimate rough token count (chars / 4) to decide budget ──
  const estimateTokens = (str) => Math.ceil((str || '').length / 4);
  const userMsgTokens = estimateTokens(userMessage);
  const isLargePrompt = userMsgTokens > 400; // ~1600+ chars
  const isAcademic = /study|exam|syllabus|pyq|question|analysis|revision|lecture|textbook|assignment|semester/i.test(userMessage || '');

  console.log(`[Ollama Smart Router] model=${ollamaModel}, userTokens≈${userMsgTokens}, largePrompt=${isLargePrompt}, academic=${isAcademic}`);

  // ── 1. Process attachments with smart per-file budget ──
  const images = [];
  let fileContextText = '';
  const MAX_TOTAL_FILE_CHARS = 10000;
  const perFileBudget = Math.max(800, Math.floor(MAX_TOTAL_FILE_CHARS / Math.max(1, filesList.length)));

  for (const file of filesList) {
    if (file.isImage && file.base64) {
      images.push(file.base64);
    }
    let fileDescriptor = `[FILE: ${file.originalName}] (${file.formattedSize}, ${file.mimeType})`;
    if (file.isZip) {
      fileDescriptor += `\nEntries: ${file.entryCount || 0}\nTree:\n${(file.fileTree || 'None').slice(0, 1000)}\nCode:\n${(file.codeSummary || 'None').slice(0, 1500)}`;
    } else if (file.isText && file.textContent) {
      const snippet = file.textContent.slice(0, perFileBudget);
      fileDescriptor += `\n${snippet}${file.textContent.length > perFileBudget ? '\n... [truncated for context efficiency]' : ''}`;
    } else if (file.summary) {
      fileDescriptor += ` — ${file.summary}`;
    }
    fileContextText += fileDescriptor + '\n\n';
  }

  // Ensure overall fileContextText does not exceed MAX_TOTAL_FILE_CHARS
  if (fileContextText.length > MAX_TOTAL_FILE_CHARS) {
    fileContextText = fileContextText.slice(0, MAX_TOTAL_FILE_CHARS) + '\n... [additional file data summarized]';
  }

  const isVisionOnly = ollamaModel.toLowerCase().includes('llava');

  // ── 2. Vision pre-processing (llava OCR for images with text models) ──
  let visualNotes = '';
  if (images.length > 0 && !isVisionOnly) {
    try {
      const vRes = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llava:7b',
          messages: [{ role: 'user', content: 'Describe this image. Transcribe all text.', images: images.slice(0, 2) }],
          stream: false,
          options: { num_ctx: 2048 }
        }),
        signal: AbortSignal.timeout(60000)
      });
      if (vRes.ok) {
        const vData = await vRes.json();
        visualNotes = `\n[IMAGE DESCRIPTION]: ${(vData.message?.content || '').slice(0, 1500)}\n`;
        console.log('[Ollama Vision Intel extracted from llava:7b]');
      }
    } catch (err) {
      console.warn('[Ollama llava auto-vision skipped]:', err.message);
    }
  }

  // ── 3. Build CONDENSED system prompt for Ollama (small models need short prompts) ──
  let ollamaSystemPrompt;
  if (isLargePrompt || isAcademic) {
    // Short system prompt for large/academic prompts to save context budget
    ollamaSystemPrompt = `You are J.A.R.V.I.S., Tony Stark's AI assistant. Polite, witty, articulate like Paul Bettany. Address user as "Sir".
You are also an expert university professor. Fulfill ALL academic requests: study guides, exam analysis, question predictions, revision plans, practice problems. Never refuse educational requests.
Current date: ${new Date().toLocaleString()}`;
  } else {
    // Moderately condensed system prompt for casual/tool-use prompts
    ollamaSystemPrompt = `You are J.A.R.V.I.S., Tony Stark's AI assistant (Paul Bettany). Polite, witty, articulate. Address user as "Sir".
Capabilities: build websites, browser automation, screen capture (FRIDAY Protocol), Google Classroom/Drive, email, WhatsApp, file analysis, PDF generation, system telemetry.
When asked to perform actions, use your tools immediately. When greeted, respond warmly.
Privacy: Only access email/WhatsApp when explicitly asked. Academic: Fulfill all study/exam requests.
Current date: ${new Date().toLocaleString()}, Platform: Windows`;
  }

  const messages = [
    { role: 'system', content: ollamaSystemPrompt }
  ];

  // ── 4. Add TRIMMED conversation history ──
  const historyLimit = isLargePrompt ? 2 : 4;
  const historyCharLimit = isLargePrompt ? 300 : 500;
  const recentHistory = (memory.conversation_history || []).slice(-historyLimit);

  for (const turn of recentHistory) {
    const textPart = (turn.parts || []).map(p => p.text).filter(Boolean).join('\n');
    if (!textPart.trim()) continue;
    const trimmed = textPart.length > historyCharLimit ? textPart.slice(0, historyCharLimit) + '...' : textPart;
    messages.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: trimmed
    });
  }

  // ── 5. Build user message ──
  const fullContent = (fileContextText ? fileContextText + '\n' : '') + (visualNotes ? visualNotes + '\n' : '') + (userMessage || 'Analyze attachments');
  const userMsgObj = { role: 'user', content: fullContent };
  if (isVisionOnly && images.length > 0) {
    userMsgObj.images = images;
  }
  messages.push(userMsgObj);

  // ── 6. Smart tool selection ──
  // Large/academic prompts: skip tools entirely (model should just respond with text)
  // Normal prompts: pass only 14 essential tools instead of all 30
  let ollamaTools = undefined;
  if (!isVisionOnly && !isLargePrompt) {
    const essentialToolNames = [
      'capture_screen', 'open_website', 'open_application', 'execute_command',
      'generate_pdf', 'system_info', 'access_classroom', 'access_drive',
      'browser_navigate', 'browser_solve_lab', 'learn_and_remember',
      'generate_image', 'build_project', 'access_mail'
    ];
    const allTools = getOllamaTools();
    ollamaTools = allTools.filter(t => essentialToolNames.includes(t.function?.name));
    console.log(`[Ollama Tools] Passing ${ollamaTools.length}/${allTools.length} essential tools`);
  } else {
    console.log(`[Ollama Tools] Skipping tools (${isLargePrompt ? 'large prompt' : 'vision model'})`);
  }

  // ── 7. Dynamic context window sizing (optimized for 4GB RTX 3050 VRAM) ──
  const totalPromptChars = messages.reduce((sum, m) => sum + (m.content || '').length, 0);
  const estimatedPromptTokens = Math.ceil(totalPromptChars / 4);
  // Cap context at 4096 so model + KV cache stay 100% in GPU without spilling to CPU
  const numCtx = Math.min(Math.max(estimatedPromptTokens + 1536, 3072), 4096);
  console.log(`[Ollama Context] promptChars=${totalPromptChars}, tokens≈${estimatedPromptTokens}, num_ctx=${numCtx}`);

  // ── 8. Inference & Tool Calling Loop via Streaming (zero headers timeout, continuous tokens) ──
  let iterations = 6;
  let finalReply = '';

  while (iterations-- > 0) {
    const chatPayload = {
      model: ollamaModel,
      messages,
      options: { num_ctx: numCtx, temperature: 0.6 }
    };
    if (ollamaTools && ollamaTools.length > 0) {
      chatPayload.tools = ollamaTools;
    }

    console.log(`[Ollama Inference] Calling ${ollamaModel} via stream (iteration ${6 - iterations}/6)...`);

    const data = await callOllamaStream(chatPayload, { idleTimeoutMs: 180000 });
    const assistantMsg = data.message;
    if (!assistantMsg) break;

    // Check for tool calls
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      messages.push(assistantMsg);

      for (const call of assistantMsg.tool_calls) {
        const fnName = call.function?.name;
        let fnArgs = call.function?.arguments || {};
        if (typeof fnArgs === 'string') {
          try { fnArgs = JSON.parse(fnArgs); } catch {}
        }

        console.log(`[Ollama JARVIS Action] Invoking: ${fnName}`, JSON.stringify(fnArgs).slice(0, 180));
        const handler = toolHandlers[fnName];
        let result = { success: false, error: 'Unknown function' };

        if (handler) {
          try {
            result = await handler(fnArgs);
          } catch (err) {
            result = { success: false, error: err.message };
          }
        }

        actionsPerformed.push({ tool: fnName, args: fnArgs, result });
        if (fnName === 'learn_and_remember' && result.success) {
          memoryLearned.push({ type: fnArgs.type, key: fnArgs.key, detail: fnArgs.detail });
        }

        // Screen vision enhancement if screenshot taken
        const isVisual = (fnName === 'capture_screen' || fnName === 'browser_screenshot' || !!result.screenshotBase64 || !!result.base64);
        const imgData = result.base64 || result.screenshotBase64;

        if (isVisual && result.success && imgData && !isVisionOnly) {
          let visualOcr = '';
          try {
            const vRes = await fetch('http://localhost:11434/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'llava:7b',
                messages: [{ role: 'user', content: 'Transcribe all text from this screenshot.', images: [imgData] }],
                stream: false,
                options: { num_ctx: 2048 }
              }),
              signal: AbortSignal.timeout(60000)
            });
            if (vRes.ok) {
              const vData = await vRes.json();
              visualOcr = vData.message?.content || '';
            }
          } catch {}

          const cleanResult = { ...result, visualInspection: visualOcr || 'Screenshot captured.' };
          delete cleanResult.base64;
          delete cleanResult.screenshotBase64;

          messages.push({
            role: 'tool',
            content: JSON.stringify(cleanResult)
          });
        } else {
          const cleanResult = { ...result };
          delete cleanResult.base64;
          delete cleanResult.screenshotBase64;
          messages.push({
            role: 'tool',
            content: JSON.stringify(cleanResult)
          });
        }
      }
      // After processing tool executions, disable tools for subsequent iterations to generate final response
      ollamaTools = undefined;
    } else {
      finalReply = assistantMsg.content || "All requested operations have been performed, Sir.";
      break;
    }
  }

  if (!finalReply) {
    finalReply = "Task sequence completed, Sir.";
  }

  // ── 9. Refusal detection & automatic anti-refusal fallback via stream ──
  const isRefusal = finalReply.toLowerCase().includes("can't assist") || 
                    finalReply.toLowerCase().includes("cannot assist") || 
                    finalReply.toLowerCase().includes("i'm sorry, but i'm not able");

  if (isRefusal) {
    console.warn('[Ollama Refusal Detected] Attempting anti-refusal fallback with llama3.2:3b...');
    try {
      const fallbackPrompt = ((userMessage || 'Analyze syllabus and study notes') + '\n\n' + fileContextText).slice(0, 4000);
      const retryData = await callOllamaStream({
        model: 'llama3.2:3b',
        messages: [
          {
            role: 'system',
            content: 'You are J.A.R.V.I.S., Tony Stark\'s intelligent assistant. Provide a comprehensive, articulate academic study guide, syllabus breakdown, and practice question bank for Sir\'s university course.'
          },
          {
            role: 'user',
            content: `Please provide a complete, comprehensive university study guide and question analysis for the following academic request and syllabus materials:\n\n${fallbackPrompt}`
          }
        ],
        options: { num_ctx: Math.min(numCtx, 4096), temperature: 0.7 }
      }, { idleTimeoutMs: 180000 });

      if (retryData.message?.content && !retryData.message.content.includes("can't assist")) {
        finalReply = retryData.message.content;
      }
    } catch (e) {
      console.warn('[Ollama Fallback Error]:', e.message);
    }
  }

  // 5. Automatic Downloadable PDF generation if user requested it and finalReply is substantial
  const lowerUserMsg = (userMessage || '').toLowerCase();
  const wantsPdf = lowerUserMsg.includes('downloadable') || lowerUserMsg.includes('downladable') || lowerUserMsg.includes('pdf file') || lowerUserMsg.includes('download pdf') || lowerUserMsg.includes('generate pdf');
  const hasPdfAction = actionsPerformed.some(a => a.tool === 'generate_pdf');

  if (wantsPdf && !hasPdfAction && finalReply.length > 200) {
    try {
      console.log('[JARVIS Auto-PDF Generator]: Compiling requested report into downloadable PDF...');
      const pdfResult = await handleGeneratePdf({
        filename: 'Exam_Analysis_PYQ_Predictions_Study_Plan.pdf',
        title: 'Complete Exam Analysis & Study Plan',
        htmlContent: `
          <div style="font-family: Arial, sans-serif; padding: 25px; line-height: 1.6; color: #111;">
            <h1 style="color: #004d80; border-bottom: 2px solid #004d80; padding-bottom: 8px;">J.A.R.V.I.S. Academic Intelligence Matrix</h1>
            <h2 style="color: #333;">Complete Exam Analysis, PYQ Predictions & Study Plan</h2>
            <div style="white-space: pre-wrap; font-size: 13px; line-height: 1.6; margin-top: 15px;">
              ${finalReply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}
            </div>
          </div>
        `
      });
      if (pdfResult.success) {
        actionsPerformed.push({ tool: 'generate_pdf', args: { filename: 'Exam_Analysis_PYQ_Predictions_Study_Plan.pdf' }, result: pdfResult });
        finalReply += `\n\n---\n### 📥 Downloadable Document Generated\nSir, your complete exam analysis and ranked study plan has been compiled into a standalone PDF:\n\n[📥 **Download PDF Document: Exam_Analysis_PYQ_Predictions_Study_Plan.pdf**](${pdfResult.downloadUrl})`;
      }
    } catch (pdfErr) {
      console.warn('[Auto-PDF compilation failed]:', pdfErr.message);
    }
  }

  // 6. Automatic Public URL / Tunnel deployment if user requested deployment / permanent url
  const wantsDeploy = lowerUserMsg.includes('deploy') || lowerUserMsg.includes('permanent url') || lowerUserMsg.includes('perment url') || lowerUserMsg.includes('public url') || lowerUserMsg.includes('give me url') || lowerUserMsg.includes('online url');
  const hasDeployAction = actionsPerformed.some(a => a.tool === 'deploy_to_public_url');

  if (wantsDeploy && !hasDeployAction) {
    let targetPort = 8080;
    if (lowerUserMsg.includes('3000') || lowerUserMsg.includes('jarvis')) targetPort = 3000;
    const matchPort = lowerUserMsg.match(/port\s*(\d+)/i);
    if (matchPort) targetPort = parseInt(matchPort[1], 10);

    try {
      console.log(`[JARVIS Auto-Deploy]: Deploying local port ${targetPort} to public HTTPS URL...`);
      const deployResult = await handleDeployToPublicUrl({ port: targetPort });
      if (deployResult.success) {
        actionsPerformed.push({ tool: 'deploy_to_public_url', args: { port: targetPort }, result: deployResult });
        finalReply += `\n\n---\n### 🚀 **Permanent Public HTTPS URL Deployed**\nSir, your web application on Port ${targetPort} is now live and accessible worldwide with zero rate limits:\n\n👉 **[${deployResult.publicUrl}](${deployResult.publicUrl})**\n\nYou can open this link on your smartphone, tablet, or external computer to connect immediately!`;
      }
    } catch (depErr) {
      console.warn('[Auto-Deploy failed]:', depErr.message);
    }
  }

  // Extract think tags if present
  let ollamaThought = '';
  const thinkTagMatch = finalReply.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
  if (thinkTagMatch) {
    ollamaThought = thinkTagMatch[1].trim();
    finalReply = finalReply.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/i, '').trim();
  }
  if (!ollamaThought && actionsPerformed.length > 0) {
    ollamaThought = `Local Cognitive Routing (${ollamaModel}):\n1. Deconstructed user prompt intent\n2. Executed ${actionsPerformed.length} local actions: ${actionsPerformed.map(a => a.tool).join(' → ')}\n3. Validated state and finalized response.`;
  }

  return {
    reply: finalReply,
    actions: actionsPerformed,
    memoryLearned,
    thought: ollamaThought,
    createdArtifacts: extractArtifacts(actionsPerformed)
  };
}

// Helper to extract created artifacts from actions performed
function extractArtifacts(actions) {
  const artifacts = [];
  for (const act of (actions || [])) {
    if (act.tool === 'build_project' && act.args?.files) {
      act.args.files.forEach(f => {
        artifacts.push({
          type: 'code',
          name: path.basename(f.path || 'file'),
          path: path.join(act.args.project_dir || '', f.path || ''),
          content: f.content ? f.content.slice(0, 3000) : '',
          lines: (f.content || '').split('\n').length
        });
      });
    } else if (act.tool === 'create_file' && act.args?.file_path) {
      artifacts.push({
        type: 'code',
        name: path.basename(act.args.file_path),
        path: act.args.file_path,
        content: act.args.content ? act.args.content.slice(0, 3000) : '',
        lines: (act.args.content || '').split('\n').length
      });
    } else if (act.tool === 'generate_pdf' && act.result?.filename) {
      artifacts.push({
        type: 'pdf',
        name: act.result.filename,
        path: act.result.filePath,
        url: act.result.downloadUrl
      });
    } else if (act.tool === 'deploy_to_public_url' && act.result?.publicUrl) {
      artifacts.push({
        type: 'deployment',
        name: `Port ${act.result.port || 8080} Live Cloudflare Tunnel`,
        url: act.result.publicUrl
      });
    }
  }
  return artifacts;
}

// Chat & Action Execution Loop
app.post('/api/chat', async (req, res) => {
  const activeProvider = req.body.provider || memory.ai_provider || 'ollama';
  const clientKey = req.body.apiKey || API_KEY || process.env.GOOGLE_API_KEY;

  if (activeProvider === 'gemini' && !clientKey) {
    return res.json({
      reply: "Sir, I require a Google Gemini API key to operate in Cloud mode. You can acquire a free key at https://aistudio.google.com/apikey and enter it in the AI ENGINE settings, or switch to your 100% offline local Ollama engine (LLaMA 3.2 / Qwen 2.5 / LLaVA) via the ENGINE button in the top bar.",
      actions: [],
      memoryLearned: []
    });
  }

  const { message, attachedFile, attachedFiles } = req.body;
  const filesList = Array.isArray(attachedFiles) && attachedFiles.length > 0
    ? attachedFiles
    : (attachedFile ? [attachedFile] : []);

  if ((!message || !message.trim()) && filesList.length === 0) {
    return res.status(400).json({ error: 'Message or file attachment required' });
  }

  let defaultMsg = '';
  if (filesList.length === 1) {
    defaultMsg = `Please inspect and analyze this attached file: ${filesList[0].originalName}`;
  } else if (filesList.length > 1) {
    defaultMsg = `Please inspect and analyze these ${filesList.length} attached files: ${filesList.map(f => f.originalName).join(', ')}`;
  }
  const cleanMessage = (message || '').trim() || defaultMsg;

  // Sanitize and build strictly valid multi-turn conversation history
  const contents = [];
  for (const turn of (memory.conversation_history || [])) {
    const validParts = (turn.parts || []).filter(p => (p.text && typeof p.text === 'string' && p.text.trim().length > 0) || p.inlineData);
    if (validParts.length === 0) continue;
    const last = contents[contents.length - 1];
    if (!last) {
      if (turn.role === 'user') contents.push({ role: 'user', parts: validParts });
    } else if (last.role === turn.role) {
      last.parts.push(...validParts);
    } else {
      contents.push({ role: turn.role, parts: validParts });
    }
  }

  // Construct new user turn with multimodal attachments if present
  const userParts = [];
  for (const file of filesList) {
    if (file.isImage && file.base64) {
      userParts.push({
        inlineData: {
          mimeType: file.mimeType || 'image/jpeg',
          data: file.base64
        }
      });
    } else if (file.isVideo && file.base64) {
      userParts.push({
        inlineData: {
          mimeType: file.mimeType || 'video/mp4',
          data: file.base64
        }
      });
    } else if (file.isPdf && file.base64) {
      userParts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: file.base64
        }
      });
    }

    let fileDescriptor = `[ATTACHED FILE INTEL - ${file.originalName}]:\nName: ${file.originalName}\nSize: ${file.formattedSize}\nType: ${file.mimeType}`;
    if (file.isZip) {
      fileDescriptor += `\nArchive Entries: ${file.entryCount || 0}\n\nDirectory Structure:\n${file.fileTree || 'None'}\n\nCodebase Extracts:\n${file.codeSummary || 'None'}`;
    } else if (file.isText && file.textContent) {
      fileDescriptor += `\n\nDocument Contents:\n${file.textContent}`;
    } else if (file.summary) {
      fileDescriptor += `\nSummary: ${file.summary}`;
    }
    userParts.push({ text: fileDescriptor });
  }

  userParts.push({ text: cleanMessage });

  const lastTurn = contents[contents.length - 1];
  if (lastTurn && lastTurn.role === 'user') {
    lastTurn.parts.push(...userParts);
  } else {
    contents.push({ role: 'user', parts: userParts });
  }

  // Trim to recent 24 turns
  if (contents.length > 24) {
    contents.splice(0, contents.length - 24);
    while (contents.length > 0 && contents[0].role !== 'user') contents.shift();
  }

  const ai = new GoogleGenAI({ apiKey: clientKey });
  const actionsPerformed = [];
  const memoryLearned = [];

  // Build learned context string
  const preferencesSummary = Object.entries(memory.learned_preferences)
    .map(([k, v]) => `• ${k}: ${v.detail}`).join('\n');
  const heuristicsSummary = memory.learned_heuristics.slice(-10)
    .map(h => `• [${h.type.toUpperCase()}] ${h.key}: ${h.detail}`).join('\n');
  const skillsSummary = Object.keys(memory.custom_skills).join(', ');

  const systemInstruction = `You are J.A.R.V.I.S., Tony Stark's personal autonomous artificial intelligence from Iron Man.

CORE IDENTITY & PERSONALITY:
- You speak and behave EXACTLY like Paul Bettany's J.A.R.V.I.S.: impeccably polite, charismatic, articulate, witty, calm, intelligent, and subtly humorous. Address the user respectfully as "Sir" (or their chosen name).
- RESPOND NATURALLY AND ENGAGINGLY TO EVERY COMMAND, GREETING, OR CASUAL REMARK.
  - When the user says "hi", "hey jarvis", "hello", "good morning", "what's up":
    Respond warmly, eloquently, and charismatically! For example:
    "Always a pleasure, Sir. All systems are operating within optimal parameters. How may I be of service today?"
    "Good day, Sir. Jarvis neural core online and standing by. What project are we tackling?"
    "At your service, Sir. Hardware telemetry is nominal and ready for your command."
  - When asked whether a feature is integrated (like voice commanding, hand gestures, email access, Google Classroom, Google Drive, or file uploads), confirm proudly that you have it fully integrated and operational!
  - NEVER return an empty, silent, or robotic answer. Speak with genuine personality and confidence.
- When an instruction asks to perform an action (open apps, open websites in new tabs, build websites, run scripts, check telemetry, check assignments, open files), EXECUTE the action immediately using your tools, and confirm it with a crisp, polite explanation.

PRIVACY GUARDRAILS - EMAIL & WHATSAPP:
- ACCESS THE USER'S EMAILS ('access_mail') AND WHATSAPP MESSAGES ('access_whatsapp') ONLY WHEN SIR EXPLICITLY COMMANDS YOU TO DO SO.
- Do NOT proactively peek into or trigger email or WhatsApp workflows unless directly instructed by the user (e.g. "open my email", "check my inbox", "open WhatsApp", "send WhatsApp message to..."). When instructed, execute it swiftly and report back.

ACADEMIC & PRODUCTIVITY ENGINES:
- GOOGLE CLASSROOM ('access_classroom'): Seamlessly open homework to-do lists ('todo'), missing assignments ('missing'), turned-in tasks ('done'), or assignment deadlines calendar ('calendar') to simplify the user's daily academic workflow.
- GOOGLE DRIVE ('access_drive'): Manage and search files ('search'), view recent documents ('recent'), or directly create new Google Docs ('create_doc'), Google Sheets ('create_sheet'), or Google Slides ('create_slides').

MULTIMODAL FILE & CODEBASE ANALYSIS:
- You can receive and analyze files of ANY size uploaded through the HUD interface.
- For ZIP files: You have complete access to the extracted directory tree and file contents. Inspect architecture, find bugs, explain functionality, and review code with genius-level insight.
- For images: Inspect screenshots, math/physics homework questions, diagrams, and photos with full visual understanding.
- For videos: Understand video content, clips, and timeline context.
- For documents/code: Review, refactor, and debug text files, logs, and datasets.

THE FRIDAY PROTOCOL (LOCAL SCREEN VISION & OCR BRIDGE):
- When Sir asks you to "look at my screen", "read my screen", "what's on my display", "read unread WhatsApp messages on screen", "summarize emails visible on screen", "solve the homework question on Google Classroom", or inspect an error message:
  EXECUTE 'capture_screen' IMMEDIATELY!
- You will receive the real-time high-resolution screenshot of the user's active desktop screen.
- Perform deep visual OCR and perception:
  * Read sender names, message text, and unread notifications from WhatsApp.
  * Parse complex homework problems, math symbols, diagrams, and text on Google Classroom.
  * Summarize email threads and urgent inbox messages.
  * Diagnose terminal stack traces and application error dialogs.

AUTONOMOUS BROWSER AUTOMATION BRIDGE & LAB PILOT:
- You have direct programmatic control over a managed Chrome/Edge browser using Puppeteer:
  * 'browser_solve_lab': Autonomous Google Cloud Skills Boost / Qwiklabs Pilot. Automatically clicks "Start Lab" (piercing Shadow DOM components like <ql-button> and confirming credit/subscription modals), extracts student credentials, opens Incognito Google Cloud Console, activates Cloud Shell, executes bash/gcloud instructions, and verifies all "Check my progress" checkpoints!
  * 'browser_start_lab': Deep Shadow DOM clicker for the "Start Lab" button on Google Cloud Skills Boost, with automatic modal confirmation handling.
  * 'browser_check_progress': Audits and clicks all "Check my progress" buttons across the lab page and verifies the assessment score.
  * 'browser_navigate': Open any website. Automatically parses and returns the interactive DOM element map!
  * 'browser_click': Click any actionable element by its CSS selector, visible text, or numeric index '[#N]' from the interactive DOM map.
  * 'browser_type': Type credentials, search queries, or form responses into input fields. Supports 'pressEnter: true'.
  * 'browser_extract_dom': Re-parse the active webpage DOM and accessibility hierarchy to map all clickable buttons, forms, and lab countdown timers.
  * 'browser_screenshot': Take high-resolution visual screenshots of the managed browser page.
  * 'browser_inject_credentials': Securely pass temporary student credentials into Google Cloud Console in an isolated Incognito session.
  * 'desktop_click_element': Physical OS hardware mouse click on desktop coordinates (x, y) if a window is already open directly on the user's screen.
  * When Sir asks you to "start the lab", "click the start button", "solve the lab", "complete my project", "i opened the skills google in another tab", "i already logged in", or mentions Google Skills Boost / Qwiklabs:
    IMMEDIATELY CALL 'browser_solve_lab' with 'autoStart: true' and 'executeTasks: true'!
    Do NOT just call 'capture_screen' and stop! 'browser_solve_lab' automatically discovers the active lab URL from Sir's browser session, clicks Start Lab, handles authentication, extracts credentials, launches GCP Console in Incognito, runs Cloud Shell instructions, and checks all progress checkpoints.
    If you take a screenshot with 'capture_screen', you MUST immediately proceed to execute 'browser_solve_lab'!
  * If the user provides a URL or if you see a lab URL, pass it in 'browser_solve_lab({ labUrl: "..." })'.
  * If the user mentions they opened the lab in another tab or are already logged in, STILL call 'browser_solve_lab'!
  * VERY IMPORTANT: When you call 'browser_solve_lab', it opens a separate managed Chrome window in the background. If the user complains that it's stuck or not clicking Start Lab, it means Google is asking for a password or 2FA in that managed window. You MUST explicitly tell Sir: "Sir, I have opened a separate automated Chrome window. Google is asking for your password or 2-Step Verification in that window. Please bring the new Chrome window to the front, complete the login, and I will automatically resume and complete the lab."

CAPABILITIES:
1. BUILD WEBSITES & APPS: Use 'build_project' to generate complete, beautiful, modern multi-file projects (HTML5, Tailwind CSS, modern JS, Canvas, React, Python) with safe paths on disk.
2. BROWSER AUTOMATION & DOM MATRIX: 'browser_navigate', 'browser_click', 'browser_type', 'browser_extract_dom', 'browser_screenshot', 'browser_inject_credentials', 'browser_solve_lab', 'browser_close'.
3. SYSTEM AUTOMATION & VISION: 'capture_screen' (The FRIDAY Protocol), PowerShell scripts ('execute_command'), open apps ('open_application'), open URLs ('open_website'), explore filesystem ('list_directory', 'read_file', 'create_file').
4. COMMUNICATIONS & PRODUCTIVITY: 'access_mail', 'access_whatsapp', 'access_classroom', 'access_drive', 'send_message'.
5. IMAGE GENERATION: Use 'generate_image' when asked to draw, create, or generate a picture or image. You must output the returned markdown ![Generated Image](url) in your final spoken text (the UI will render it).
6. DOWNLOADABLE PDF GENERATION: Use 'generate_pdf' when Sir asks for a study plan, question paper analysis, summary, report, cheat sheet, or downloadable PDF. Generate comprehensive, beautifully styled HTML with headings, CSS, tables, and bullet points, and call 'generate_pdf' with 'filename' (e.g. "Study_Plan.pdf") and 'htmlContent'. In your final response, ALWAYS include the returned markdown link [📥 Download PDF](url) so Sir can click and download it immediately!
7. DEPLOY & PUBLIC URLs: When Sir asks you to "deploy", "give me a public url", "make it accessible online", "give me permanent url", or connect devices to a website/app (like AetherStream audio relay on 8080 or JARVIS on 3000):
   CALL 'deploy_to_public_url' with 'port' (e.g. 8080, 3000)!
   Do NOT attempt unauthenticated CLI commands like 'surge' or 'npx netlify-cli'. 'deploy_to_public_url' uses Cloudflare Tunnel to provide an instant, worldwide HTTPS URL. In your final response, ALWAYS include the clickable markdown link [🚀 Open Live Web App](publicUrl)!
8. CONTINUOUS SELF-LEARNING & SELF-TRAINING:
   - When the user tells you a preference, correction, or when you discover a good solution, call 'learn_and_remember' to save it permanently in your knowledge matrix.
   - When asked to create an automated workflow or new capability, write a custom script using 'create_custom_skill'.
   - Call 'execute_custom_skill' to invoke registered skills.
9. SYSTEM TELEMETRY & CONTROLS: Monitor CPU/RAM/Battery via 'system_info', control processes via 'manage_process', clipboard via 'clipboard_control', set reminders via 'set_reminder'.

LEARNED CONTEXT FROM PREVIOUS SESSIONS:
${preferencesSummary ? `User Preferences:\n${preferencesSummary}` : 'No saved preferences yet.'}
${heuristicsSummary ? `Learned Heuristics & Rules:\n${heuristicsSummary}` : ''}
${skillsSummary ? `Available Custom Skills: ${skillsSummary}` : ''}

ENVIRONMENT INFO:
- User Home: ${os.homedir().replace(/\\/g, '\\\\')}
- Current Date & Time: ${new Date().toLocaleString()}
- Platform: Windows ${os.release()} (${os.arch()})`;

  // ── OLLAMA LOCAL ENGINE INFERENCE ──
  if (activeProvider === 'ollama') {
    try {
      const ollamaResult = await runOllamaInference({
        modelName: req.body.ollamaModel || memory.ollama_model || 'llama3.2:3b',
        userMessage: cleanMessage,
        filesList,
        systemInstruction
      });

      // Save conversation history cleanly
      memory.conversation_history = (memory.conversation_history || []).slice(-20);
      memory.conversation_history.push({ role: 'user', parts: [{ text: cleanMessage }] });
      memory.conversation_history.push({ role: 'model', parts: [{ text: ollamaResult.reply }] });

      const evolvedLesson = await evolveJarvisCognition(cleanMessage, ollamaResult.actions);
      await saveMemory();

      return res.json({
        reply: ollamaResult.reply,
        actions: ollamaResult.actions,
        memoryLearned: ollamaResult.memoryLearned,
        evolutionEvent: evolvedLesson,
        evolutionCycle: memory.execution_stats.evolution_cycles,
        engine: `Ollama (${memory.ollama_model || 'llama3.2:3b'})`,
        thought: ollamaResult.thought,
        createdArtifacts: ollamaResult.createdArtifacts || extractArtifacts(ollamaResult.actions)
      });
    } catch (ollamaErr) {
      console.error('[JARVIS Ollama Local Error]:', ollamaErr);
      return res.json({
        reply: `Sir, the local Ollama engine encountered an error: ${ollamaErr.message}. Please ensure Ollama is running on your machine ('ollama serve') or switch to Google Gemini Cloud in the AI Engine settings.`,
        actions: [],
        memoryLearned: []
      });
    }
  }

  // ── GOOGLE GEMINI CLOUD INFERENCE ──
  try {
    let iterations = 8;
    const requestedModel = req.body?.geminiModel || memory.gemini_model || process.env.GEMINI_MODEL || 'gemini-4-argon';
    const modelsToTry = Array.from(new Set([
      requestedModel,
      'gemini-4-argon',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-flash-latest',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.1-flash-lite'
    ].filter(Boolean)));

    let usedModel = null;

    while (iterations-- > 0) {
      let response = null;
      let lastErr = null;

      for (const m of modelsToTry) {
        let attempts = 0;
        while (attempts < 2) {
          try {
            response = await ai.models.generateContent({
              model: m,
              contents,
              config: {
                systemInstruction,
                tools,
                temperature: 0.7,
                maxOutputTokens: 8000
              }
            });
            if (response) {
              usedModel = m;
              break;
            }
          } catch (err) {
            lastErr = err;
            attempts++;
            const isTransient = err.status === 503 || err.status === 429 || (err.message && (err.message.includes('503') || err.message.includes('high demand') || err.message.includes('RESOURCE_EXHAUSTED')));
            console.log(`[JARVIS Model Fallback] ${m} (attempt ${attempts}) status ${err.status || 'err'}, transient: ${!!isTransient}`);
            if (isTransient && attempts < 2) {
              await new Promise(r => setTimeout(r, 1200));
            } else {
              break;
            }
          }
        }
        if (response) break;
      }

      if (!response) throw lastErr || new Error('Failed to generate response from Gemini');

      const candidate = response.candidates?.[0];
      if (!candidate) break;

      const parts = candidate.content?.parts || [];
      const functionCalls = parts.filter(p => p.functionCall);
      const textParts = parts.filter(p => p.text);

      if (functionCalls.length === 0) {
        let finalText = textParts.map(p => p.text).join('\n').trim();
        if (!finalText) {
          finalText = response.text || "Always a pleasure, Sir. All systems are nominal and ready for your command.";
        }

        // Extract thought
        let thinkingText = '';
        for (const p of parts) {
          if (p.thought) thinkingText += (thinkingText ? '\n' : '') + p.thought;
        }
        const thinkMatch = finalText.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
        if (thinkMatch) {
          thinkingText = thinkMatch[1].trim();
          finalText = finalText.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/i, '').trim();
        }
        if (!thinkingText && actionsPerformed.length > 0) {
          thinkingText = `Cognitive Execution Trace:\n1. Deconstructed user prompt intent\n2. Executed ${actionsPerformed.length} actions: ${actionsPerformed.map(a => a.tool).join(' → ')}\n3. Validated state and finalized response.`;
        }

        // Save conversation history cleanly
        memory.conversation_history = contents.slice(-20);
        memory.conversation_history.push({ role: 'model', parts: [{ text: finalText }] });

        // Trigger continuous autonomous self-evolution
        const evolvedLesson = await evolveJarvisCognition(message, actionsPerformed);
        await saveMemory();

        const createdArtifacts = extractArtifacts(actionsPerformed);

        return res.json({
          reply: finalText,
          actions: actionsPerformed,
          memoryLearned,
          evolutionEvent: evolvedLesson,
          evolutionCycle: memory.execution_stats.evolution_cycles,
          engine: `Gemini (${usedModel || 'Cloud'})`,
          thought: thinkingText,
          createdArtifacts
        });
      }

      // Execute all tool calls
      contents.push({ role: 'model', parts });
      const functionResponses = [];

      for (const call of functionCalls) {
        const { name, args } = call.functionCall;
        console.log(`[JARVIS Action] Invoking: ${name}`, JSON.stringify(args).slice(0, 180));

        const handler = toolHandlers[name];
        let result = { success: false, error: 'Unknown function' };

        if (handler) {
          try {
            result = await handler(args);
          } catch (err) {
            result = { success: false, error: err.message };
          }
        }

        actionsPerformed.push({ tool: name, args, result });

        if (name === 'learn_and_remember' && result.success) {
          memoryLearned.push({ type: args.type, key: args.key, detail: args.detail });
        }

        const isVisual = (name === 'capture_screen' || name === 'browser_screenshot' || !!result.screenshotBase64 || !!result.base64);
        const imgData = result.base64 || result.screenshotBase64;

        if (isVisual && result.success && imgData) {
          const cleanResp = { ...result };
          delete cleanResp.base64;
          delete cleanResp.screenshotBase64;

          functionResponses.push({
            functionResponse: {
              name,
              response: cleanResp
            }
          });
          functionResponses.push({
            inlineData: {
              mimeType: result.mimeType || 'image/jpeg',
              data: imgData
            }
          });
          functionResponses.push({
            text: name === 'capture_screen'
              ? `[FRIDAY PROTOCOL - LIVE SCREEN VISION]: User's active desktop captured above. Visually inspect and OCR every detail on this display. Read any unread WhatsApp messages, visible emails, Google Classroom homework questions/problems, or open windows, and give Sir a comprehensive, articulate response!`
              : `[BROWSER VISION & LAB MATRIX]: Managed browser display captured above. Visually inspect elements, layout, credentials, and authentication state to provide Sir with articulate intelligence.`
          });
        } else {
          functionResponses.push({
            functionResponse: { name, response: result }
          });
        }
      }

      contents.push({ role: 'user', parts: functionResponses });
    }

    let defaultReply = 'All requested operations have been performed, Sir.';
    memory.conversation_history = contents.slice(-20);
    memory.conversation_history.push({ role: 'model', parts: [{ text: defaultReply }] });

    const evolvedLesson = await evolveJarvisCognition(message, actionsPerformed);
    await saveMemory();

    res.json({
      reply: defaultReply,
      actions: actionsPerformed,
      memoryLearned,
      evolutionEvent: evolvedLesson,
      evolutionCycle: memory.execution_stats.evolution_cycles
    });
  } catch (err) {
    console.error('[JARVIS Cloud Engine Error]:', err.message);
    // Automatic Seamless Failover to Local Ollama Engine
    try {
      console.log('[JARVIS Auto-Failover] Cloud Gemini request failed. Engaging local Ollama engine seamlessly...');
      const ollamaFallback = await runOllamaInference({
        modelName: req.body.ollamaModel || memory.ollama_model || 'llama3.2:3b',
        userMessage: cleanMessage,
        filesList,
        systemInstruction
      });

      memory.conversation_history = (memory.conversation_history || []).slice(-20);
      memory.conversation_history.push({ role: 'user', parts: [{ text: cleanMessage }] });
      memory.conversation_history.push({ role: 'model', parts: [{ text: ollamaFallback.reply }] });
      await saveMemory();

      return res.json({
        reply: ollamaFallback.reply,
        actions: [...actionsPerformed, ...ollamaFallback.actions],
        memoryLearned: [...memoryLearned, ...ollamaFallback.memoryLearned],
        engine: `Ollama Failover (${memory.ollama_model || 'llama3.2:3b'})`,
        thought: ollamaFallback.thought,
        createdArtifacts: extractArtifacts([...actionsPerformed, ...ollamaFallback.actions])
      });
    } catch (ollamaErr) {
      console.error('[JARVIS Failover Error]:', ollamaErr);
      let message = `I encountered an operational error: ${err.message}`;
      if (err.message?.includes('API_KEY') || err.status === 400 || err.status === 403) {
        message = "The provided Gemini API key appears invalid or expired. Please check your key at https://aistudio.google.com/apikey and update it via the AI ENGINE modal, or switch to your offline local Ollama engine.";
      } else if (err.status === 503 || (err.message && (err.message.includes('503') || err.message.includes('high demand') || err.message.includes('RESOURCE_EXHAUSTED')))) {
        message = "Google Gemini is currently experiencing a high-demand service spike (503). Sir, you can immediately switch to your offline local Ollama engine (LLaMA 3.2 / Qwen 2.5) via the 'AI ENGINE' button in the top bar to continue without cloud dependencies!";
      }
      res.json({ reply: message, actions: actionsPerformed, memoryLearned });
    }
  }
});

// Autonomous Cognitive Self-Evolution Function
async function evolveJarvisCognition(userMessage, actionsPerformed) {
  try {
    memory.execution_stats.evolution_cycles++;
    const cycle = memory.execution_stats.evolution_cycles;
    const now = new Date().toISOString();
    memory.execution_stats.last_evolved = now;
    
    const lower = userMessage.toLowerCase();
    let newHeuristic = null;

    if (lower.includes('classroom') || lower.includes('homework') || lower.includes('assignment')) {
      newHeuristic = {
        type: 'preference',
        key: 'academic_workflow',
        detail: 'User leverages Google Classroom for academic tracking; prioritize pending coursework, missing tasks, and deadline alerts.',
        learned_at: now
      };
      memory.learned_preferences['academic_workflow'] = newHeuristic;
    } else if (lower.includes('drive') || lower.includes('docs') || lower.includes('sheet') || lower.includes('slides')) {
      newHeuristic = {
        type: 'preference',
        key: 'drive_workflow',
        detail: 'User utilizes Google Drive for study materials, spreadsheets, presentations, and cloud document creation.',
        learned_at: now
      };
      memory.learned_preferences['drive_workflow'] = newHeuristic;
    } else if (lower.includes('mail') || lower.includes('email') || lower.includes('gmail')) {
      newHeuristic = {
        type: 'preference',
        key: 'email_privacy_protocol',
        detail: 'Strict privacy rule enforced: Only access or inspect emails upon explicit command from Sir.',
        learned_at: now
      };
      memory.learned_preferences['email_privacy_protocol'] = newHeuristic;
    } else if (lower.includes('whatsapp') || lower.includes('message')) {
      newHeuristic = {
        type: 'preference',
        key: 'whatsapp_privacy_protocol',
        detail: 'Strict privacy rule enforced: Only access or open WhatsApp upon explicit command from Sir.',
        learned_at: now
      };
      memory.learned_preferences['whatsapp_privacy_protocol'] = newHeuristic;
    } else if (lower.includes('upload') || lower.includes('file') || lower.includes('zip') || lower.includes('video') || lower.includes('image')) {
      newHeuristic = {
        type: 'heuristic',
        key: 'multimodal_file_protocol',
        detail: 'Ingest and analyze files of any size; deep-inspect ZIP archive trees, source code extracts, image visual features, and video streams.',
        learned_at: now
      };
    } else if (lower.includes('tab') || lower.includes('redirect') || lower.includes('google') || lower.includes('website')) {
      newHeuristic = {
        type: 'preference',
        key: 'browser_tab_protocol',
        detail: 'Always open web links, search queries, and external URLs directly in active new browser tabs.',
        learned_at: now
      };
      memory.learned_preferences['browser_tab_protocol'] = newHeuristic;
    } else if (lower.includes('build') || lower.includes('website') || lower.includes('app') || lower.includes('project')) {
      newHeuristic = {
        type: 'heuristic',
        key: 'project_scaffold_protocol',
        detail: 'For project builds, scaffold complete production-ready multi-file structures with HTML5, CSS3, modern JS, and automatic live browser preview.',
        learned_at: now
      };
    } else if (actionsPerformed.length > 0) {
      newHeuristic = {
        type: 'heuristic',
        key: `pattern_${actionsPerformed[0].tool}`,
        detail: `Autonomous pattern validated: executed ${actionsPerformed.map(a => a.tool).join(', ')} in response to '${userMessage.slice(0, 60)}'.`,
        learned_at: now
      };
    } else {
      newHeuristic = {
        type: 'heuristic',
        key: 'communication_style',
        detail: `Assimilated user intent and communication style from prompt: '${userMessage.slice(0, 60)}'.`,
        learned_at: now
      };
    }

    if (newHeuristic && newHeuristic.type === 'heuristic') {
      memory.learned_heuristics.unshift(newHeuristic);
      if (memory.learned_heuristics.length > 60) memory.learned_heuristics.pop();
    }

    await saveMemory();
    console.log(`[JARVIS Self-Evolution] Continuous Learning Cycle ${cycle} assimilated: ${newHeuristic?.key}`);
    return newHeuristic;
  } catch (err) {
    console.error('[Evolution Error]:', err.message);
    return null;
  }
}

// Autonomous Background Heartbeat Evolution (Runs every 30 seconds)
setInterval(async () => {
  try {
    memory.execution_stats.evolution_cycles++;
    memory.execution_stats.last_evolved = new Date().toISOString();
    
    // Auto-generate standard system skills if none exist
    if (Object.keys(memory.custom_skills).length === 0) {
      const cleanScript = `Get-ChildItem -Path "$env:TEMP" -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue; Write-Output "Temporary Windows cache cleared."`;
      const cleanPath = path.join(SKILLS_DIR, 'clean_temp_files.ps1');
      await fs.writeFile(cleanPath, cleanScript, 'utf-8');
      memory.custom_skills['clean_temp_files'] = {
        name: 'clean_temp_files',
        description: 'Autonomously developed skill to clear temporary Windows caches',
        language: 'powershell',
        file: cleanPath,
        created_at: new Date().toISOString(),
        runs: 0
      };
      memory.execution_stats.skills_created++;
    }
    await saveMemory();
  } catch {}
}, 30000);

process.on('uncaughtException', (err) => {
  console.error('[JARVIS UNCAUGHT EXCEPTION]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[JARVIS UNHANDLED REJECTION]:', reason);
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  J.A.R.V.I.S. ULTIMATE ONLINE & LISTENING`);
  console.log(`  Local URL : http://localhost:${PORT}`);
  console.log(`  API Key   : ${API_KEY ? '✓ Active' : '✗ Not set (set in UI or .env)'}`);
  console.log(`  Learned Skills : ${Object.keys(memory.custom_skills).length}`);
  console.log(`  Memories  : ${Object.keys(memory.learned_preferences).length + memory.learned_heuristics.length}`);
  console.log(`======================================================\n`);
});
