# 🤖 OctosArmy: Multi-Agent Control System

![Banner](Screenshots/Start.png)

**OctosArmy** is a powerful, AI-driven file management platform that uses a team of autonomous agents to carry out complex missions in your Windows environment. With advanced Command & Control logic and a secure sandbox, OctosArmy keeps you in full control of your data while the AI does the heavy lifting.

---

## ✨ Key Features

*   **Hierarchical Agent Team:** Scout, Brainstormer, Coder, Reviewer, Auditor, and Security Specialist collaborate to solve your tasks.
*   **Secure Sandbox (Folder Permissions):** AI agents can *only* touch folders you have explicitly granted them access to.
*   **Self-Correcting Logic:** If Agent 4 (Reviewer) is not satisfied with the work, the mission is automatically sent back to Agent 1 for a restart.
*   **Local AI Engine:** All processing runs locally on your machine via Ollama for maximum privacy.
*   **Advanced Scheduling:** Run your AI pipelines automatically based on time or events.
*   **Runs in the Background:** Minimizes to the system tray to quietly monitor and run scheduled missions without interrupting you.
*   **Seamless Updates:** Built-in auto-updater with UI notifications that downloads new versions automatically in the background.

---

## 📸 Screenshots

### Dashboard & Workspaces
![Start Screen](Screenshots/Start2.png)
*Keep track of your folders and permissions in real time.*

### Agent Configuration
![Agents](Screenshots/Agents.png)
*See how the different agents work together in the chain.*

### Mission Console
![Mission Progress](Screenshots/Finish.png)
*Detailed logging of every step the agents take.*

---

## 🚀 Getting Started (Important!)

OctosArmy requires a local AI engine to function.

### 1. Install Ollama
Download and install **Ollama** from [ollama.com](https://ollama.com).

### 2. Pull Models
Open your terminal (PowerShell or CMD) and run the following commands to download the models you want to use (at least one):
```bash
ollama pull gemma4:e4b
ollama pull deepseek-r1:14b
ollama pull qwen2.5-coder:32b
```

### 3. Install OctosArmy
Download the latest version from [Releases](../../releases) and run `OctosArmy-Setup-<version>.exe`.

When the app starts, you can choose which model the agents should use directly in the UI.

---

## 🧾 Versions

### v1.1.36
*   **Ollama Model Selector:** Choose a model directly in the app (Gemma 4:e4b, Deepseek-r1:14b, Qwen 2.5-Coder:32b).
*   **Persistence:** Your model choice is saved locally and used for all agent runs.

## 👩‍💻 For Developers (Development Setup)

Want to help develop OctosArmy? Here's how to get your local development environment running:

### 1. Clone the repository
```bash
git clone https://github.com/nRn-World/OctosArmy.git
cd OctosArmy
```

### 2. Install dependencies
```bash
npm install
```

### 3. Start development mode
Builds the UI, starts Electron and the backend (including the API on port 3000).
```bash
npm run dev:electron
```

If you only want to run the backend without Electron (e.g. for API testing):
```bash
npm run dev
```

---

## 🛠 Tech Stack
*   **Frontend:** React, Tailwind CSS, Motion (motion/react)
*   **Backend:** Node.js (Express), Electron
*   **AI:** Ollama (Gemma 4:e4b / Deepseek-r1:14b / Qwen 2.5-Coder:32b)
*   **Infrastructure:** IPC Bridge for secure Windows communication

---

## 🤝 Community & Contributing
We welcome contributions! OctosArmy is built to grow.
*   Found a bug? Open an [Issue](../../issues).
*   Want to contribute code? See our [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 🛡 Security
Your privacy is our priority. Because OctosArmy runs locally, no file data is sent to the cloud. Read more in our [SECURITY.md](SECURITY.md).

---

☕ **Support development**: [Buy me a coffee 💜](https://ko-fi.com/nrnworld)

Created by ❤️ © nRn World