# J.A.R.V.I.S. ULTIMATE — Autonomous Cognitive Operating System

![J.A.R.V.I.S. Core](https://img.shields.io/badge/J.A.R.V.I.S.-Core%20OS%20v4.9-00f0ff?style=for-the-badge&logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-100%25%20Offline%20Free-000000?style=for-the-badge&logo=ollama&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Google%20Gemini-Cloud%20Dual--Engine-4285F4?style=for-the-badge&logo=google&logoColor=white)
![Puppeteer](https://img.shields.io/badge/Puppeteer-Autonomous%20Browser-40B5A4?style=for-the-badge&logo=puppeteer&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

> *"Just rather that you didn't, sir. But as always, at your service."*  
> **J.A.R.V.I.S. (Just A Rather Very Intelligent System)** is a full-stack, autonomous artificial intelligence assistant inspired by Tony Stark's iconic AI. Operating both **100% offline via local open-source LLMs (Ollama)** and through **Google Gemini Cloud**, J.A.R.V.I.S. does not merely generate text—it observes your screen, pilots your browser, automates labs, executes system commands, inspects multi-gigabyte codebases, and writes downloadable reports.

---

## ⚡ Key Capabilities & Architecture

### 🧠 1. Dual-Engine Intelligence Matrix
- **100% Free Offline Local Engine (Ollama)**:
  - Supports `llama3.2:3b`, `qwen2.5-coder:7b`, and `llava:7b` (multimodal vision).
  - Optimized streaming client (`callOllamaStream`) with an activity-based token watchdog—immune to HTTP headers timeouts and long generation limits.
  - VRAM-conscious context window management (`num_ctx: 3072–4096`) keeping model execution 100% on GPU without spilling into system RAM.
- **Google Gemini Cloud Engine**:
  - Full multimodal understanding via official `@google/genai` SDK.
  - **Automatic Seamless Failover**: If Gemini cloud quota is exhausted (HTTP 429) or token limits are exceeded, J.A.R.V.I.S. automatically fails over to the local Ollama engine without throwing errors to the user.
- **Live In-HUD Engine Switcher**: Toggle engines, select models, or update API keys dynamically from the Iron Man HUD.

### 🌐 2. Autonomous Browser Pilot & Google Skills Lab Auto-Pilot
- Programmatic Puppeteer-core integration controlling Chrome, Edge, or Brave:
  - Deep interactive DOM element mapping (`browser_extract_dom`, `browser_click`, `browser_type`).
  - **Google Cloud Skills Boost / Qwiklabs Auto-Pilot (`browser_solve_lab`)**:
    - Pierces Shadow DOM components (e.g. `<ql-button>`) and confirms quota/subscription modals.
    - Captures temporary student credentials.
    - Launches isolated Incognito Google Cloud Console and authenticates.
    - Connects to Cloud Shell, runs bash/gcloud instructions, and verifies all "Check my progress" checkpoints autonomously.

### 👁️ 3. The FRIDAY Protocol (Screen Vision & Real-Time OCR)
- Instant high-resolution screen capture and OCR bridge (`capture_screen`).
- Reads WhatsApp notifications, incoming emails, Google Classroom homework problems, terminal stack traces, and active application windows directly from your display.

### 📄 4. Multimodal Document Ingestion & Deep PDF Engine
- **Streaming Multer File Ingestion**: Upload files of any size (ZIP archives, PDFs, high-res images, video recordings) with zero RAM overflow.
- **Deep PDF Text Extraction (`extract_pdf.py`)**: Uses Python `pypdf` to parse textbooks, syllabus outlines, and past exam papers (PYQs).
- **Autonomous Downloadable PDF Generator (`generate_pdf`)**: Automatically styles, formats, and renders comprehensive study plans, exam analyses, and cheat sheets into downloadable PDF documents via Puppeteer with 1-click download links.

### 🎓 5. Academic & Productivity Ecosystem
- **Google Classroom Integration (`access_classroom`)**: Audits homework to-do lists, missing assignments, completed tasks, and submission deadline calendars.
- **Google Drive Integration (`access_drive`)**: Searches files and generates Google Docs, Sheets, or Slides.
- **Strict Privacy Protocols**: Email (`access_mail`) and WhatsApp (`access_whatsapp`) access are strictly guarded and triggered only upon explicit command from Sir.

### 🔄 6. Continuous Self-Learning & Custom Skills
- **Self-Evolution Engine**: Analyzes executed tasks and assimilates cognitive heuristics into persistent memory (`data/memory.json`).
- **Autonomous Skill Authoring (`create_custom_skill`, `execute_custom_skill`)**: J.A.R.V.I.S. can write, register, and execute reusable PowerShell and Node.js automation scripts.

### 🎙️ 7. Futuristic Iron Man HUD Interface
- **Cyberpunk Arc Reactor HUD**: Real-time reactor pulsing, system telemetry monitors (CPU, RAM, Disk, Battery, Network IP), and memory status streams.
- **Hands-Free Neural Voice**: Continuous speech recognition and speech synthesis (Paul Bettany cadence).
- **Holographic Hand Gesture Vision**: MediaPipe hand-tracking via webcam for gesture control.

---

## 🚀 Quick Start Guide

### Prerequisites
1. **Node.js**: v18.0.0 or higher ([Download Node.js](https://nodejs.org/))
2. **Python**: Python 3.8+ (for PDF text extraction)
3. **Web Browser**: Google Chrome, Microsoft Edge, or Brave installed.
4. **Ollama (Recommended for 100% Free Local Execution)**:
   - Install Ollama from [ollama.com](https://ollama.com/)
   - Pull the recommended models:
     ```bash
     ollama pull llama3.2:3b
     ollama pull qwen2.5-coder:7b
     ollama pull llava:7b
     ```

---

### Windows (1-Click Launch)
Simply double-click:
```bat
START-JARVIS.cmd
```
or
```bat
START_JARVIS.bat
```
This automatically verifies dependencies, starts the backend server, and opens `http://localhost:3000` in your default browser.

---

### Manual / Cross-Platform Setup (Linux & macOS)

1. **Clone the repository**:
   ```bash
   git clone https://github.com/karthik-reddy-10/jarvis.git
   cd jarvis
   ```

2. **Install Node.js dependencies**:
   ```bash
   npm install
   ```

3. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **(Optional) Configure Gemini API Key**:
   Create a `.env` file if you wish to use Google Gemini Cloud:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and add your Google Gemini API Key from [Google AI Studio](https://aistudio.google.com/apikey).
   *(Note: You can skip this step entirely if using Ollama locally!)*

5. **Start J.A.R.V.I.S.**:
   ```bash
   npm start
   ```

6. **Open the HUD**:
   Navigate to [http://localhost:3000](http://localhost:3000).

---

## 📁 Repository Structure

```
jarvis/
├── public/
│   ├── index.html            # Futuristic Iron Man HUD Frontend
│   ├── audio/                # System sound effects & chimes
│   └── mediapipe/            # MediaPipe vision assets
├── data/
│   ├── memory.json           # Persistent memory & learned preferences
│   └── skills/               # Reusable custom automation scripts
│       └── clean_temp_files.ps1
├── uploads/                  # Upload directory & generated PDF reports
│   └── .gitkeep
├── browser-engine.js         # Puppeteer Autonomous Browser & Lab Pilot
├── extract_pdf.py            # Deep PDF text extraction engine
├── server.js                 # Express server & Dual-Engine Cognitive Loop
├── package.json              # Project metadata & dependencies
├── requirements.txt          # Python dependencies (pypdf)
├── .env.example              # Template for environment configuration
├── .gitignore                # Git ignore rules
├── START-JARVIS.cmd          # 1-click Windows starter script
└── START_JARVIS.bat          # Alternative Windows batch starter
```

---

## 🛡️ Privacy & Guardrails
- **Zero Cloud Leakage in Ollama Mode**: When operating via Ollama, all file attachments, prompts, screen captures, and telemetry remain 100% on your local machine.
- **Strict Privacy Guardrails**: Access to sensitive services like email, WhatsApp, and private folders is gated behind explicit user confirmation.
- **Credential Safety**: Student and lab credentials extracted during browser automation are isolated to transient Incognito memory and never saved to disk.

---

## 📜 License
This project is open-source and available under the [MIT License](LICENSE).
