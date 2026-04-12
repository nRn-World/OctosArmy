# OctosArmy 🐙

Ett kraftfullt, fler-agents kontrollsystem för AI-driven filhantering. OctosArmy använder specifikt tränade drönar-agenter för att övervaka, hantera, städa och administrera filer i sandlåde-miljöer utan risk för systemkrascher.

## Funktioner
- 🛡️ **Säker Sandlåda (Sandboxing)** - Agenterna kan aldrig komma åt filer eller mappar som du inte uttryckligen har aktiverat rötter för.
- 🤖 **Elit-Teamet** - Agenterna är indelade i specialiserade roller (Scout, Brainstormer, Kodare, Granskare, Auditör, Säkerhetsspecialist) med strenga instruktioner om att ALDRIG gissa sig fram.
- ♻️ **Sömlös Integration** - Byggd på Node.js, React och integrerad i Windows som en tyst bakgrundsapp (Electron).
- 🤫 **Automatiska Uppdateringar** - Bakgrundsuppdateringar som installerar sig själva ifrån GitHub, helt utan brandväggsvarningar eller extra klick.

## Installation för Användare
1. Ladda ner \`OctosArmy Setup.exe\` från under fliken [Releases](https://github.com/nRn-World/OctosArmy/releases).
2. Starta programmet (Installerar utan frågor och startar tyst i bakgrunden, nås via ett fönster).
3. Uppdateringar laddas automatisk ned och installeras när programmet startas upp.

## För Utvecklare (Open Source)
Vill du vara med och bygga tillsammans med oss och hundratals andra utvecklare? Läs \`CONTRIBUTING.md\`!

### Kom igång lokalt
1. Klona repot: \`git clone https://github.com/nRn-World/OctosArmy.git\`
2. Installera beroenden: \`npm install\`
3. Lägg till din egna \`.env\`-fil baserat på \`.env.example\`
4. Kör utvecklingsmiljön med inbyggd Electron: \`npm run dev:electron\`
5. Bygg .exe-fil för produktion: \`npm run dist\`

---

## Byggt med
- **Electron** & **React** (Vite)
- **Express.js** & **TypeScript**
- **Ollama** / **LLM-modeller**
- **Tailwind CSS**

## Licens
MIT-licens. Läs \`LICENSE\` för mer information.
