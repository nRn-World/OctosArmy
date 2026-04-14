import React, { useState, useEffect, useRef } from "react";
import logoImg from "../Logo/OSAI-no-bg (1).ico";
import { 
  Terminal, 
  Play, 
  Settings, 
  Folder, 
  FileCode, 
  Clock, 
  Activity, 
  CheckCircle2, 
  AlertCircle,
  Cpu,
  RefreshCw,
  Trash2,
  ChevronRight,
  ChevronDown,
  Shield
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  runAgentPipeline,
  runOllamaServerPipeline,
  useOllamaEngine,
  AgentLog,
  AGENT_IDS,
} from "./services/agentService";
import { parseJsonResponse } from "./utils/api";
import { apiUrl } from "./config/apiBase";

const AGENTS = [
  { id: "scout", name: "Scouten", icon: Activity, color: "text-blue-400" },
  { id: "brainstormer", name: "Brainstormern", icon: Cpu, color: "text-purple-400" },
  { id: "coder", name: "Kodaren", icon: Terminal, color: "text-green-400" },
  { id: "reviewer", name: "Granskaren", icon: CheckCircle2, color: "text-yellow-400" },
  { id: "auditor", name: "Auditören", icon: Clock, color: "text-cyan-400" },
  { id: "security", name: "Säkerhetsspecialisten", icon: Shield, color: "text-red-400" },
];

const THEME = {
  bg: "bg-[#0A0A0B]",
  card: "bg-[#151518]",
  border: "border-[#2A2A2E]",
  accent: "text-[#00FF9D]",
  accentBg: "bg-[#00FF9D]",
  muted: "text-[#8E8E93]",
};

export default function App() {
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeAgents, setActiveAgents] = useState<string[]>(AGENT_IDS);
  const [schedule, setSchedule] = useState("0 * * * *");
  const [mission, setMission] = useState("");
  const [isFetchingLogs, setIsFetchingLogs] = useState(false);
  const [agentInstructions, setAgentInstructions] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState(AGENTS);
  const [isConfigExpanded, setIsConfigExpanded] = useState(false);
  const [isSchedulerExpanded, setIsSchedulerExpanded] = useState(false);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [selectedMonths, setSelectedMonths] = useState<number[]>([]);
  const [selectedDom, setSelectedDom] = useState<number[]>([]);
  const [selectedTimes, setSelectedTimes] = useState<string[]>(["08:00"]);
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([]);
  const [newRootPath, setNewRootPath] = useState("");
  const [workspaceFiles, setWorkspaceFiles] = useState<{root: string, files: string[]}[]>([]);
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  const [selectedAgentFilter, setSelectedAgentFilter] = useState<string | null>(null);
  
  // Confirmation states
  const [showConfirm1, setShowConfirm1] = useState(false);
  const [showConfirm2, setShowConfirm2] = useState(false);
  const [timer1, setTimer1] = useState(0);
  const [timer2, setTimer2] = useState(0);
  const [isAddingRoot, setIsAddingRoot] = useState(false);

  // Update states
  const [updateDownloaded, setUpdateDownloaded] = useState<{version: string} | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState<{version: string} | null>(null);

  const DAYS = [
    { id: 1, label: "Mån" },
    { id: 2, label: "Tis" },
    { id: 3, label: "Ons" },
    { id: 4, label: "Tor" },
    { id: 5, label: "Fre" },
    { id: 6, label: "Lör" },
    { id: 0, label: "Sön" },
  ];

  const MONTHS = [
    { id: 1, label: "Jan" }, { id: 2, label: "Feb" }, { id: 3, label: "Mar" },
    { id: 4, label: "Apr" }, { id: 5, label: "Maj" }, { id: 6, label: "Jun" },
    { id: 7, label: "Jul" }, { id: 8, label: "Aug" }, { id: 9, label: "Sep" },
    { id: 10, label: "Okt" }, { id: 11, label: "Nov" }, { id: 12, label: "Dec" },
  ];

  useEffect(() => {
    // Sync UI to Cron
    const parts = schedule.split(" ");
    if (parts.length >= 5) {
      const min = parts[0];
      const hour = parts[1];
      const dom = parts[2];
      const mon = parts[3];
      const dow = parts[4];

      if (hour !== "*" && min !== "*") {
        const hours = hour.split(",");
        const mins = min.split(",");
        // Simplified: assume same minutes for all hours if multiple hours provided
        // or just take the first pair for UI sync
        const times = hours.map((h, i) => {
          const m = mins[i] || mins[0];
          return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
        });
        setSelectedTimes(times);
      }
      
      if (dow !== "*") setSelectedDays(dow.split(",").map(Number));
      if (mon !== "*") setSelectedMonths(mon.split(",").map(Number));
      if (dom !== "*") setSelectedDom(dom.split(",").map(Number));
    }
  }, []);

  const generateCron = (times: string[], days: number[], months: number[], doms: number[]) => {
    const hours = Array.from(new Set(times.map(t => parseInt(t.split(":")[0]).toString()))).sort((a,b) => parseInt(a)-parseInt(b)).join(",");
    const minutes = Array.from(new Set(times.map(t => parseInt(t.split(":")[1]).toString()))).sort((a,b) => parseInt(a)-parseInt(b)).join(",");
    
    const dowStr = days.length === 0 ? "*" : days.sort().join(",");
    const monStr = months.length === 0 ? "*" : months.sort().join(",");
    const domStr = doms.length === 0 ? "*" : doms.sort().join(",");
    
    const newCron = `${minutes} ${hours} ${domStr} ${monStr} ${dowStr}`;
    setSchedule(newCron);
    return newCron;
  };

  const toggleDay = (dayId: number) => {
    const newDays = selectedDays.includes(dayId) ? selectedDays.filter(id => id !== dayId) : [...selectedDays, dayId];
    setSelectedDays(newDays);
    generateCron(selectedTimes, newDays, selectedMonths, selectedDom);
  };

  const toggleMonth = (monId: number) => {
    const newMonths = selectedMonths.includes(monId) ? selectedMonths.filter(id => id !== monId) : [...selectedMonths, monId];
    setSelectedMonths(newMonths);
    generateCron(selectedTimes, selectedDays, newMonths, selectedDom);
  };

  const toggleDom = (domId: number) => {
    const newDoms = selectedDom.includes(domId) ? selectedDom.filter(id => id !== domId) : [...selectedDom, domId];
    setSelectedDom(newDoms);
    generateCron(selectedTimes, selectedDays, selectedMonths, newDoms);
  };

  const addTime = () => {
    const newTimes = [...selectedTimes, "12:00"];
    setSelectedTimes(newTimes);
    generateCron(newTimes, selectedDays, selectedMonths, selectedDom);
  };

  const removeTime = (index: number) => {
    if (selectedTimes.length <= 1) return;
    const newTimes = selectedTimes.filter((_, i) => i !== index);
    setSelectedTimes(newTimes);
    generateCron(newTimes, selectedDays, selectedMonths, selectedDom);
  };

  const updateTime = (index: number, time: string) => {
    const newTimes = [...selectedTimes];
    newTimes[index] = time;
    setSelectedTimes(newTimes);
    generateCron(newTimes, selectedDays, selectedMonths, selectedDom);
  };
  const logEndRef = useRef<HTMLDivElement>(null);
  const consoleContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchWorkspace();
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  // Listen for update events from electron main process
  useEffect(() => {
    const el = (window as any).electron;
    if (!el) return;
    el.onUpdateAvailable?.((info: {version: string}) => setUpdateAvailable(info));
    el.onUpdateDownloaded?.((info: {version: string}) => setUpdateDownloaded(info));
  }, []);

  useEffect(() => {
    if (isAutoScrollEnabled && consoleContainerRef.current) {
      consoleContainerRef.current.scrollTop = consoleContainerRef.current.scrollHeight;
    }
  }, [logs, isAutoScrollEnabled]);

  // Timer logic for confirmations
  useEffect(() => {
    let interval: any;
    if (showConfirm1 && timer1 > 0) {
      interval = setInterval(() => setTimer1(prev => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [showConfirm1, timer1]);

  useEffect(() => {
    let interval: any;
    if (showConfirm2 && timer2 > 0) {
      interval = setInterval(() => setTimer2(prev => prev - 1), 1000);
    }
    return () => clearInterval(interval);
  }, [showConfirm2, timer2]);

  const handleConsoleScroll = () => {
    if (!consoleContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = consoleContainerRef.current;
    
    // Check if we are near the bottom (within 100px)
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
    
    // Only update state if it actually changed to avoid unnecessary re-renders
    if (isAutoScrollEnabled !== isNearBottom) {
      setIsAutoScrollEnabled(isNearBottom);
    }
  };

  const fetchWorkspace = async () => {
    try {
      if ((window as any).electron) {
        const roots = await (window as any).electron.getRoots();
        setWorkspaceRoots(roots || []);
        const workspaces = await (window as any).electron.getWorkspace();
        setWorkspaceFiles(workspaces || []);
        return;
      }
      const res = await fetch(apiUrl("/api/workspace"));
      const data = (await parseJsonResponse(res)) as { workspaces: {root: string, files: string[]}[] };
      setWorkspaceFiles(data.workspaces || []);
      const rRes = await fetch(apiUrl("/api/workspace/roots"));
      const rData = await rRes.json();
      setWorkspaceRoots(rData.roots || []);
    } catch (e: any) {
      console.error(e);
    }
  };

  const addWorkspacePath = async (pathToAdd: string) => {
    let p = pathToAdd.trim();
    if (!p || isAddingRoot) return;
    setIsAddingRoot(true);
    p = p.replace(/[\\/]+$/, "");
    try {
      addLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `Lägger till mapp: ${p}...`,
        type: "info",
      });
      if ((window as any).electron) {
        const newRoots = await (window as any).electron.setRoots([...workspaceRoots, p]);
        setWorkspaceRoots(newRoots);
        setNewRootPath("");
        addLog({
          timestamp: new Date().toISOString(),
          agent: "System",
          message: `KLART! Behörighet beviljad för: ${p}`,
          type: "success",
        });
        await fetchWorkspace();
        return;
      }
      const res = await fetch(apiUrl("/api/workspace/roots"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roots: [...workspaceRoots, p] }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Serverfel");
      }
      const data = await res.json();
      setWorkspaceRoots(data.roots);
      setNewRootPath("");
      addLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `KLART! Behörighet beviljad för: ${p}`,
        type: "success",
      });
      setTimeout(() => fetchWorkspace(), 200);
    } catch (e: any) {
      addLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `Fel: ${e.message}`,
        type: "error",
      });
    } finally {
      setIsAddingRoot(false);
    }
  };

  const removeWorkspacePath = async (p: string) => {
    try {
      const newRoots = workspaceRoots.filter(r => r !== p);
      if ((window as any).electron) {
        const updated = await (window as any).electron.setRoots(newRoots);
        setWorkspaceRoots(updated);
        addLog({
          timestamp: new Date().toISOString(),
          agent: "System",
          message: `Behörighet borttagen: ${p}`,
          type: "info",
        });
        await fetchWorkspace();
        return;
      }
      const res = await fetch(apiUrl("/api/workspace/roots"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roots: newRoots }),
      });
      const data = await res.json();
      setWorkspaceRoots(data.roots);
      addLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `Behörighet borttagen: ${p}`,
        type: "info",
      });
      await fetchWorkspace();
    } catch (e: any) {
      console.error(e);
    }
  };

  const handleBrowseFolder = async () => {
    try {
      // Use the secure bridge from preload.js
      if ((window as any).electron && (window as any).electron.pickFolder) {
        addLog({
          timestamp: new Date().toISOString(),
          agent: "System",
          message: "Öppnar inbyggd mappväljare...",
          type: "info"
        });
        const pickedPath = await (window as any).electron.pickFolder();
        if (pickedPath) {
          setNewRootPath(pickedPath);
          addWorkspacePath(pickedPath);
        }
        return;
      }
      
      // Fallback to API (for browser/dev mode)
      const res = await fetch(apiUrl("/api/workspace/pick"), { method: "POST" });
      const data = await res.json();
      if (data.path) {
        setNewRootPath(data.path);
        addWorkspacePath(data.path);
      }
    } catch (e: any) {
      addLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: `Kunde inte öppna mappväljaren: ${e.message}`,
        type: "error"
      });
    }
  };

  const fetchLogs = async () => {
    if (isFetchingLogs) return;
    setIsFetchingLogs(true);
    try {
      const res = await fetch(apiUrl("/api/logs"));
      const data = await res.json();
      if (Array.isArray(data)) {
        setLogs(data.slice(-500));
      }
    } catch (e) {
      // Server not ready yet – silently ignore
    } finally {
      setIsFetchingLogs(false);
    }
  };

  const addLog = async (log: AgentLog) => {
    // Always update local UI immediately
    setLogs(prev => [...prev.slice(-499), log]);
    // Try to sync to server (best-effort)
    try {
      await fetch(apiUrl("/api/logs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(log)
      });
    } catch (e) {
      // Server not ready – log is still shown locally
    }
  };

  const testAIConnection = async () => {
    if (useOllamaEngine()) {
      addLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: "Testing connection to Ollama...",
        type: "info",
      });
      try {
        const res = await fetch(apiUrl("/api/ollama/health"));
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || res.statusText);
        }
        addLog({
          timestamp: new Date().toISOString(),
          agent: "System",
          message: `Ollama är nåbar på ${data.base || "localhost"}.`,
          type: "success",
        });
      } catch (err: any) {
        addLog({
          timestamp: new Date().toISOString(),
          agent: "System",
          message: `Ollama-kontroll misslyckades: ${err.message}. Körs Ollama?`,
          type: "error",
        });
      }
      return;
    }

    addLog({
      timestamp: new Date().toISOString(),
      agent: "System",
      message: "Testing Gemini API key (Vite env)...",
      type: "info",
    });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || String(apiKey).trim() === "") {
      addLog({
        timestamp: new Date().toISOString(),
        agent: "System",
        message: "Ingen Gemini API-nyckel — pipelinen använder Ollama när du kör den.",
        type: "warning",
      });
      return;
    }

    addLog({
      timestamp: new Date().toISOString(),
      agent: "System",
      message: "Gemini key present. Run pipeline to use Gemini multi-agent flow.",
      type: "success",
    });
  };

  const executePipeline = async () => {
    if (isRunning) return;
    setIsRunning(true);
    addLog({
      timestamp: new Date().toISOString(),
      agent: "System",
      message: "Manual pipeline execution started.",
      type: "info",
    });

    addLog({
      timestamp: new Date().toISOString(),
      agent: "System",
      message: "Manual pipeline execution started.",
      type: "info",
    });

    if (useOllamaEngine()) {
      try {
        await runOllamaServerPipeline(addLog, mission);
      } catch (e: any) {
        addLog({
          timestamp: new Date().toISOString(),
          agent: "System",
          message: e.message || String(e),
          type: "error",
        });
      }
      setIsRunning(false);
      return;
    }

    const agentNames = agents.reduce((acc, agent) => ({ ...acc, [agent.id]: agent.name }), {});

    await runAgentPipeline(
      workspaceFiles.flatMap(w => w.files),
      addLog,
      async (path) => {
        const res = await fetch(
          apiUrl(`/api/files/read?filePath=${encodeURIComponent(path)}`)
        );
        const data = await res.json();
        return data.content;
      },
      async (path, content) => {
        await fetch(apiUrl("/api/files/write"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: path, content }),
        });
        fetchWorkspace();
      },
      mission,
      agentInstructions,
      agentNames
    );

    setIsRunning(false);
  };

  const handleRunPipeline = () => {
    setTimer1(15);
    setShowConfirm1(true);
  };

  const clearLogs = async () => {
    setLogs([]);
    try {
      await fetch(apiUrl("/api/logs/clear"), { method: "POST" });
    } catch (e) {
      // Server sync failed – local clear is sufficient
    }
  };

  const updateSchedule = async () => {
    await fetch(apiUrl("/api/schedule"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cronExpr: schedule })
    });
    addLog({
      timestamp: new Date().toISOString(),
      agent: "System",
      message: `Schema uppdaterat till: ${schedule}`,
      type: "success"
    });
  };

  return (
    <div className={`min-h-screen ${THEME.bg} text-white font-mono selection:bg-[#00FF9D] selection:text-black`}>

      {/* Update downloaded banner */}
      {updateDownloaded && (
        <div className="fixed top-0 left-0 right-0 z-[200] flex items-center justify-between gap-4 px-6 py-3 bg-[#00FF9D] text-black font-bold text-sm shadow-2xl">
          <span>🚀 Version {updateDownloaded.version} är nedladdad och redo att installeras!</span>
          <div className="flex gap-3">
            <button
              onClick={() => (window as any).electron?.restartAndInstall()}
              className="px-4 py-1.5 rounded-lg bg-black text-[#00FF9D] font-black text-xs hover:bg-gray-900 transition-all"
            >
              STARTA OM &amp; UPPDATERA
            </button>
            <button
              onClick={() => setUpdateDownloaded(null)}
              className="px-4 py-1.5 rounded-lg bg-black/20 text-black font-bold text-xs hover:bg-black/30 transition-all"
            >
              SENARE
            </button>
          </div>
        </div>
      )}

      {/* Update available banner (downloading) */}
      {updateAvailable && !updateDownloaded && (
        <div className="fixed top-0 left-0 right-0 z-[200] flex items-center justify-between gap-4 px-6 py-3 bg-blue-600 text-white font-bold text-sm shadow-2xl">
          <span>⬇️ Version {updateAvailable.version} laddas ner i bakgrunden...</span>
          <button
            onClick={() => setUpdateAvailable(null)}
            className="px-4 py-1.5 rounded-lg bg-white/20 text-white text-xs hover:bg-white/30 transition-all"
          >
            OK
          </button>
        </div>
      )}

      <header className={`h-16 border-b ${THEME.border} flex items-center justify-between px-6 sticky top-0 z-50 ${THEME.bg}`}>
        <div className="flex items-center gap-3">
          <img
            src={logoImg}
            alt="OctosArmy Logo"
            className="w-14 h-14 scale-[1.8] object-contain"
          />
          <div>
            <h1 className="text-xl font-bold tracking-tighter">Octos<span className="animate-text-sweep drop-shadow-[0_0_8px_rgba(0,255,157,0.5)]">Army</span></h1>
            <p className={`text-[10px] ${THEME.muted} uppercase tracking-widest`}>Multi-Agent Control System</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border ${THEME.border} bg-black/50`}>
            <Shield className="w-4 h-4 text-green-500" />
            <span className="text-xs font-medium text-green-500">SANDLÅDA AKTIV</span>
          </div>
          <button 
            onClick={handleRunPipeline}
            disabled={isRunning}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold transition-all ${
              isRunning 
                ? "bg-gray-800 text-gray-500 cursor-not-allowed" 
                : "bg-[#00FF9D] text-black hover:shadow-[0_0_20px_rgba(0,255,157,0.4)] active:scale-95"
            }`}
          >
            {isRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
            {isRunning ? "KÖÖÖR..." : "KÖR PIPELINE"}
          </button>
        </div>
      </header>

      <main className="p-6 grid grid-cols-12 gap-6 max-w-[1600px] mx-auto">
        {/* Left Column: Workspace & Config */}
        <div className="col-span-12 lg:col-span-4 space-y-6">
          {/* Workspace Explorer */}
          <section className={`${THEME.card} border ${THEME.border} rounded-xl overflow-hidden shadow-2xl`}>
            <div className={`px-4 py-4 border-b ${THEME.border} flex items-center justify-between bg-white/5`}>
              <div className="flex items-center gap-3">
                <Folder className="w-5 h-5 text-blue-400" />
                <h2 className="text-sm font-bold uppercase tracking-[0.15em]">Arbetsytor & Behörigheter</h2>
              </div>
              <span className={`text-[11px] font-mono ${THEME.muted}`}>{workspaceRoots.length}/6 Mappar</span>
            </div>
            
            <div className="p-5 space-y-6">
              {/* Add New Permission */}
              <div className="space-y-3">
                <label className={`text-[10px] ${THEME.muted} font-bold uppercase tracking-widest block`}>Lägg till ny mappbehörighet</label>
                <div className="flex gap-2">
                  <div className="flex-1 group">
                    <input 
                      type="text" 
                      value={newRootPath}
                      onChange={(e) => setNewRootPath(e.target.value)}
                      className={`w-full bg-black/40 border ${THEME.border} rounded-lg px-4 py-2.5 text-xs focus:outline-none focus:border-[#00FF9D]/50 focus:ring-1 focus:ring-[#00FF9D]/20 transition-all font-mono hover:bg-black/60`}
                      placeholder="Ange sökväg (t.ex. D:\PROJEKT)"
                    />
                  </div>
                  <button 
                    onClick={(e) => {
                      e.preventDefault();
                      handleBrowseFolder();
                    }}
                    className={`p-2.5 rounded-lg border ${THEME.border} bg-white/5 hover:bg-white/10 hover:border-[#00FF9D]/30 text-gray-400 hover:text-[#00FF9D] transition-all flex items-center justify-center min-w-[42px] cursor-pointer`}
                    title="Bläddra i datorn"
                  >
                    <Folder className="w-5 h-5" />
                  </button>
                  <button 
                    onClick={() => addWorkspacePath(newRootPath)}
                    disabled={isAddingRoot}
                    className={`px-5 py-2.5 rounded-lg text-xs font-black transition-all ${
                      isAddingRoot 
                        ? "bg-yellow-500 text-black cursor-wait" 
                        : "bg-[#00FF9D] text-black hover:scale-105 active:scale-95 shadow-[0_4px_15px_rgba(0,255,157,0.2)]"
                    }`}
                  >
                    {isAddingRoot ? "LÄGGER TILL..." : "LÄGG TILL"}
                  </button>
                </div>
              </div>

              {/* Roots List */}
              <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                <AnimatePresence mode="popLayout">
                  {workspaceRoots.map((path, index) => (
                    <motion.div 
                      key={path}
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9, x: -20 }}
                      className={`relative p-4 rounded-xl border ${THEME.border} bg-white/[0.02] hover:bg-white/[0.04] transition-all group`}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className={`text-[10px] font-black text-blue-500 uppercase tracking-tighter`}>Mapp #{index + 1}</span>
                        <button 
                          onClick={() => removeWorkspacePath(path)}
                          className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="bg-black/40 p-3 rounded-lg border border-white/5 mb-3">
                        <p className="text-[11px] font-mono text-gray-300 break-all leading-relaxed whitespace-pre-wrap">{path}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)] animate-pulse" />
                        <span className="text-[10px] text-green-500/80 font-bold uppercase tracking-widest">Behörighet Aktiv</span>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>

                {workspaceRoots.length === 0 && (
                  <div className="py-12 flex flex-col items-center justify-center border-2 border-dashed border-white/5 rounded-2xl bg-white/[0.01]">
                    <Shield className="w-8 h-8 text-gray-700 mb-3" />
                    <p className={`text-[11px] ${THEME.muted} font-medium`}>Inga aktiva behörigheter</p>
                  </div>
                )}
              </div>
            </div>
          </section>


          {/* Mission Objective */}
          <section className={`${THEME.card} border ${THEME.border} rounded-xl overflow-hidden`}>
            <div className={`px-4 py-3 border-b ${THEME.border} flex items-center justify-between bg-white/5`}>
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-orange-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider">Uppdragsmål</h2>
              </div>
              <button 
                onClick={testAIConnection}
                className="text-[9px] px-2 py-1 rounded border border-orange-400/30 text-orange-400 hover:bg-orange-400/10 transition-all"
              >
                TESTA AI-ANSLUTNING
              </button>
            </div>
            <div className="p-4 space-y-3">
              <label className={`text-[10px] ${THEME.muted} uppercase block`}>Instruktioner till agenter</label>
              <textarea 
                value={mission}
                onChange={(e) => setMission(e.target.value)}
                className={`w-full h-24 bg-black border ${THEME.border} rounded px-3 py-2 text-xs focus:outline-none focus:border-[#00FF9D] font-mono resize-none`}
                placeholder="Beskriv vad agenterna ska göra... (t.ex. 'Hitta och fixa alla minnesläckor')"
              />
              <p className={`text-[9px] ${THEME.muted} italic`}>
                Dessa instruktioner skickas direkt till Gemma 4-agenterna för analys.
              </p>
            </div>
          </section>

          {/* Agent Configuration */}
          <section className={`${THEME.card} border ${THEME.border} rounded-xl overflow-hidden`}>
            <button 
              onClick={() => setIsConfigExpanded(!isConfigExpanded)}
              className={`w-full px-4 py-3 border-b ${THEME.border} flex items-center justify-between bg-white/5 hover:bg-white/10 transition-all`}
            >
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-purple-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider">Agent Configuration</h2>
              </div>
              <ChevronDown className={`w-4 h-4 transition-transform ${isConfigExpanded ? "rotate-180" : ""}`} />
            </button>
            
            {isConfigExpanded && (
              <div className="p-4 space-y-3">
                {agents.map(agent => (
                  <div key={agent.id} className={`rounded-lg border ${expandedAgentId === agent.id ? "border-purple-500/50 bg-purple-500/5" : "border-white/5 bg-black/20"} overflow-hidden transition-all`}>
                    <div className="flex items-center justify-between p-3">
                      <div 
                        className="flex items-center gap-3 cursor-pointer flex-1"
                        onClick={() => setExpandedAgentId(expandedAgentId === agent.id ? null : agent.id)}
                      >
                        <div className={`w-2 h-2 rounded-full ${activeAgents.includes(agent.id) ? "bg-[#00FF9D]" : "bg-gray-600"}`} />
                        <div>
                          <p className={`text-xs font-bold ${agent.color}`}>{agent.name}</p>
                          <p className={`text-[9px] ${THEME.muted}`}>{agent.role}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <input 
                          type="checkbox" 
                          checked={activeAgents.includes(agent.id)}
                          onChange={() => {
                            setActiveAgents(prev => 
                              prev.includes(agent.id) ? prev.filter(id => id !== agent.id) : [...prev, agent.id]
                            );
                          }}
                          className="w-4 h-4 accent-[#00FF9D]"
                        />
                        <ChevronDown 
                          className={`w-3 h-3 text-gray-500 cursor-pointer transition-transform ${expandedAgentId === agent.id ? "rotate-180" : ""}`}
                          onClick={() => setExpandedAgentId(expandedAgentId === agent.id ? null : agent.id)}
                        />
                      </div>
                    </div>

                    {expandedAgentId === agent.id && (
                      <div className="px-3 pb-3 space-y-3 border-t border-white/5 pt-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-[9px] text-gray-500 uppercase">Namn</label>
                            <input 
                              type="text"
                              value={agent.name}
                              onChange={(e) => {
                                const newName = e.target.value;
                                setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, name: newName } : a));
                              }}
                              className="w-full bg-black border border-white/10 rounded px-2 py-1 text-[10px] focus:outline-none focus:border-purple-500"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[9px] text-gray-500 uppercase">Färg</label>
                            <div className="flex flex-wrap gap-1">
                              {[
                                { text: "text-blue-400", bg: "bg-blue-400" },
                                { text: "text-purple-400", bg: "bg-purple-400" },
                                { text: "text-green-400", bg: "bg-green-400" },
                                { text: "text-yellow-400", bg: "bg-yellow-400" },
                                { text: "text-cyan-400", bg: "bg-cyan-400" },
                                { text: "text-red-400", bg: "bg-red-400" },
                                { text: "text-orange-400", bg: "bg-orange-400" },
                                { text: "text-pink-400", bg: "bg-pink-400" },
                                { text: "text-white", bg: "bg-white" }
                              ].map(colorObj => (
                                <button
                                  key={colorObj.text}
                                  onClick={() => setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, color: colorObj.text } : a))}
                                  className={`w-4 h-4 rounded-full border border-white/20 ${colorObj.bg} ${agent.color === colorObj.text ? "ring-2 ring-white ring-offset-1 ring-offset-black" : ""}`}
                                  title={colorObj.text.replace("text-", "")}
                                />
                              ))}
                            </div>
                          </div>
                        </div>
                        
                        <div className="space-y-1">
                          <label className="text-[9px] text-gray-500 uppercase">Specifik Instruktion</label>
                          <textarea 
                            value={agentInstructions[agent.id] || ""}
                            onChange={(e) => setAgentInstructions(prev => ({ ...prev, [agent.id]: e.target.value }))}
                            className={`w-full h-16 bg-black/40 border ${THEME.border} rounded px-2 py-1.5 text-[10px] focus:outline-none focus:border-[#00FF9D] font-mono resize-none`}
                            placeholder={`Vad ska ${agent.name} fokusera på?`}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Scheduler */}
          <section className={`${THEME.card} border ${THEME.border} rounded-xl overflow-hidden`}>
            <button 
              onClick={() => setIsSchedulerExpanded(!isSchedulerExpanded)}
              className={`w-full px-4 py-3 border-b ${THEME.border} flex items-center justify-between bg-white/5 hover:bg-white/10 transition-all`}
            >
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-yellow-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider">Avancerad Schemaläggning</h2>
              </div>
              <ChevronDown className={`w-4 h-4 transition-transform ${isSchedulerExpanded ? "rotate-180" : ""}`} />
            </button>
            
            {isSchedulerExpanded && (
              <div className="p-4 space-y-6">
                {/* Month Selection */}
                <div className="space-y-3">
                  <label className={`text-[10px] ${THEME.muted} uppercase block`}>Välj Månader</label>
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                    {MONTHS.map((mon) => (
                      <button
                        key={mon.id}
                        onClick={() => toggleMonth(mon.id)}
                        className={`py-1.5 rounded border text-[9px] font-bold transition-all flex items-center justify-center ${
                          selectedMonths.includes(mon.id)
                            ? "border-[#00FF9D] bg-[#00FF9D]/10 text-[#00FF9D]"
                            : `${THEME.border} bg-black/30 text-gray-500 hover:border-gray-500`
                        }`}
                      >
                        {mon.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Day of Month Selection */}
                <div className="space-y-3">
                  <label className={`text-[10px] ${THEME.muted} uppercase block`}>Välj Datum i Månaden</label>
                  <div className="grid grid-cols-7 gap-1">
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((dom) => (
                      <button
                        key={dom}
                        onClick={() => toggleDom(dom)}
                        className={`h-8 rounded border text-[9px] font-bold transition-all flex items-center justify-center ${
                          selectedDom.includes(dom)
                            ? "border-[#00FF9D] bg-[#00FF9D]/10 text-[#00FF9D]"
                            : `${THEME.border} bg-black/30 text-gray-500 hover:border-gray-500`
                        }`}
                      >
                        {dom}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Day Selection */}
                <div className="space-y-3">
                  <label className={`text-[10px] ${THEME.muted} uppercase block`}>Välj Veckodagar</label>
                  <div className="flex flex-wrap gap-2">
                    {DAYS.map((day) => (
                      <button
                        key={day.id}
                        onClick={() => toggleDay(day.id)}
                        className={`w-10 h-10 rounded-lg border text-[10px] font-bold transition-all flex items-center justify-center ${
                          selectedDays.includes(day.id)
                            ? "border-[#00FF9D] bg-[#00FF9D]/10 text-[#00FF9D]"
                            : `${THEME.border} bg-black/30 text-gray-500 hover:border-gray-500`
                        }`}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Time Selection */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className={`text-[10px] ${THEME.muted} uppercase block`}>Välj Tidpunkter</label>
                    <button 
                      onClick={addTime}
                      className="text-[10px] text-[#00FF9D] hover:underline flex items-center gap-1"
                    >
                      + Lägg till tid
                    </button>
                  </div>
                  <div className="space-y-2 max-h-[150px] overflow-y-auto pr-2">
                    {selectedTimes.map((time, index) => (
                      <div key={index} className="flex items-center gap-2 group">
                        <input 
                          type="time" 
                          value={time}
                          onChange={(e) => updateTime(index, e.target.value)}
                          className={`flex-1 bg-black border ${THEME.border} rounded px-3 py-2 text-sm font-bold focus:outline-none focus:border-[#00FF9D] text-[#00FF9D] [color-scheme:dark]`}
                        />
                        {selectedTimes.length > 1 && (
                          <button 
                            onClick={() => removeTime(index)}
                            className="p-2 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className={`text-[9px] ${THEME.muted} leading-relaxed`}>
                    Agenterna körs vid alla valda tidpunkter de dagar som matchar dina inställningar.
                  </p>
                </div>

                {/* Manual/Preview */}
                <div className="pt-4 border-t border-white/5">
                  <div className="flex items-center justify-between mb-2">
                    <label className={`text-[10px] ${THEME.muted} uppercase`}>Genererat Cron-uttryck</label>
                    <span className="text-[10px] font-mono text-[#00FF9D]">{schedule}</span>
                  </div>
                  <button 
                    onClick={updateSchedule}
                    className={`w-full py-3 rounded bg-[#00FF9D] text-black font-bold text-xs hover:shadow-[0_0_20px_rgba(0,255,157,0.4)] active:scale-95 transition-all flex items-center justify-center gap-2`}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    AKTIVERA SCHEMA
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Right Column: Console & Status */}
        <div className="col-span-12 lg:col-span-8 space-y-6">
          {/* Agent Status Grid */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
            {agents.map(agent => {
              const isActive = isRunning && activeAgents.includes(agent.id);
              const isSelected = selectedAgentFilter === agent.id;
              const agentLogCount = logs.filter(l => l.agent === agent.id).length;
              return (
                <motion.button
                  key={agent.id}
                  onClick={() => setSelectedAgentFilter(isSelected ? null : agent.id)}
                  whileHover={{ scale: 1.03, y: -2 }}
                  whileTap={{ scale: 0.97 }}
                  className={`${THEME.card} border rounded-xl p-4 flex flex-col items-center text-center relative overflow-hidden cursor-pointer transition-all
                    ${isSelected 
                      ? `border-${agent.color.replace('text-', '')}/50 shadow-[0_0_15px_rgba(0,0,0,0.3)]` 
                      : `${THEME.border} hover:border-white/20`
                    }
                  `}
                >
                  {isActive && (
                    <motion.div 
                      layoutId="active-glow"
                      className="absolute inset-0 bg-[#00FF9D]/5 animate-pulse"
                    />
                  )}
                  {isSelected && (
                    <div className={`absolute inset-0 bg-gradient-to-t from-${agent.color.replace('text-', '')}/10 to-transparent`} />
                  )}
                  <div className={`p-2 rounded-full mb-2 relative z-10 ${isActive ? "bg-[#00FF9D]/20" : isSelected ? "bg-white/10" : "bg-white/5"}`}>
                    <agent.icon className={`w-4 h-4 ${isActive ? THEME.accent : agent.color}`} />
                  </div>
                  <p className={`text-[10px] font-bold truncate w-full relative z-10 ${agent.color}`}>{agent.name}</p>
                  <p className={`text-[8px] ${THEME.muted} uppercase relative z-10`}>
                    {isActive ? "Arbetar" : isSelected ? "Filtrerad" : "Vilar"}
                  </p>
                  {agentLogCount > 0 && !isSelected && (
                    <div className="absolute top-2 right-2 bg-blue-500 w-2 h-2 rounded-full animate-pulse" />
                  )}
                </motion.button>
              );
            })}
          </div>

          {/* Console Output */}
          <section className={`${THEME.card} border ${THEME.border} rounded-xl overflow-hidden flex flex-col h-[600px]`}>
            <div className={`px-4 py-3 border-b ${THEME.border} flex items-center justify-between bg-white/5`}>
              <div className="flex items-center gap-3">
                <Terminal className="w-4 h-4 text-[#00FF9D]" />
                <h2 className="text-xs font-bold uppercase tracking-wider">Uppdragskonsol</h2>
                {selectedAgentFilter && (
                  <div className="flex items-center gap-2 px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/20">
                    <span className="text-[10px] font-bold text-blue-400 uppercase tracking-tighter">Ser just nu: {AGENTS.find(a => a.id === selectedAgentFilter)?.name}</span>
                    <button 
                      onClick={() => setSelectedAgentFilter(null)}
                      className="text-[10px] text-blue-400 hover:text-white font-black"
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
              <button 
                onClick={() => setLogs([])}
                className={`p-1.5 rounded hover:bg-white/5 ${THEME.muted} hover:text-white transition-all`}
                title="Rensa konsol"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <div 
              ref={consoleContainerRef}
              onScroll={handleConsoleScroll}
              className="h-[500px] overflow-y-auto p-4 font-mono text-[11px] selection:bg-[#00FF9D]/30 custom-scrollbar bg-black/20"
            >
              <div className="space-y-1">
                {logs
                  .filter(log => !selectedAgentFilter || log.agent === selectedAgentFilter || log.agent === "System")
                  .map((log, i) => (
                    <motion.div 
                      key={i}
                      initial={{ opacity: 0, x: -5 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="group flex gap-3 py-1 hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors"
                    >
                      <span className="text-gray-600 shrink-0 select-none">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                      <span className={`font-bold shrink-0 w-24 select-none ${
                        log.agent === "System" ? "text-purple-400" : 
                        AGENTS.find(a => a.id === log.agent)?.color || "text-gray-400"
                      }`}>
                        {log.agent}
                      </span>
                      <span className="text-gray-600 shrink-0 select-none opacity-0 group-hover:opacity-100 transition-opacity">{">"}</span>
                      <span className={`break-all leading-relaxed ${
                        log.type === "error" ? "text-red-400" :
                        log.type === "success" ? "text-[#00FF9D]" :
                        log.type === "warning" ? "text-orange-300" :
                        "text-gray-300"
                      }`}>
                        {log.message}
                      </span>
                    </motion.div>
                  ))}
                {logs.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center opacity-20 grayscale py-20">
                    <Terminal className="w-12 h-12 mb-4" />
                    <p className="text-sm font-bold uppercase tracking-[0.2em]">Tyst Läge</p>
                  </div>
                )}
                <div ref={logEndRef} />
              </div>
            </div>
            <div className={`px-4 py-2 border-t ${THEME.border} bg-black/50 flex items-center justify-between`}>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#00FF9D] animate-pulse" />
                  <span className={`text-[9px] ${THEME.muted}`}>UPLINK STABLE</span>
                </div>
                {!isAutoScrollEnabled && (
                  <button 
                    onClick={() => setIsAutoScrollEnabled(true)}
                    className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#00FF9D]/10 border border-[#00FF9D]/20"
                  >
                    <RefreshCw className="w-2.5 h-2.5 text-[#00FF9D]" />
                    <span className="text-[8px] text-[#00FF9D] font-bold">AUTOSCROLL PAUSAD</span>
                  </button>
                )}
              </div>
              <span className={`text-[9px] ${THEME.muted}`}>v{import.meta.env.VITE_APP_VERSION}-STABLE</span>
            </div>
          </section>
        </div>
      </main>

      {/* Confirmation HUD 1 */}
      <AnimatePresence>
        {showConfirm1 && (
          <motion.div 
            initial={{ opacity: 0, y: 50, scale: 0.9 }} 
            animate={{ opacity: 1, y: 0, scale: 1 }} 
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[100] w-full max-w-lg px-6"
          >
            <div className={`bg-[#1A1A1E]/90 backdrop-blur-xl border-2 border-yellow-500/50 rounded-2xl p-6 shadow-[0_20px_50px_rgba(0,0,0,0.5),0_0_30px_rgba(234,179,8,0.2)]`}>
              <div className="flex items-start gap-5">
                <div className="w-12 h-12 rounded-xl bg-yellow-500/10 flex items-center justify-center border border-yellow-500/20 shrink-0">
                  <AlertCircle className="w-6 h-6 text-yellow-500" />
                </div>
                <div className="flex-1 space-y-4">
                  <div>
                    <h2 className="text-lg font-bold text-white">Är du säker på att du vill göra denna ändring nu?!</h2>
                    <p className={`text-xs ${THEME.muted} mt-1`}>Kika runt i appen och verifiera allt. Klockan tickar...</p>
                  </div>
                  
                  <div className="flex gap-3">
                    <button 
                      onClick={() => {
                        setShowConfirm1(false);
                        setTimer1(0);
                      }}
                      className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs font-bold transition-all"
                    >
                      CANCEL
                    </button>
                    <button 
                      disabled={timer1 > 0}
                      onClick={() => {
                        setShowConfirm1(false);
                        setTimer1(0);
                        setTimer2(15);
                        setShowConfirm2(true);
                      }}
                      className={`flex-1 px-4 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                        timer1 > 0 
                        ? "bg-gray-800 text-gray-500 cursor-not-allowed" 
                        : "bg-yellow-500 text-black hover:shadow-[0_0_20px_rgba(234,179,8,0.4)]"
                      }`}
                    >
                      YES {timer1 > 0 && `(${timer1}s)`}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirmation HUD 2 */}
      <AnimatePresence>
        {showConfirm2 && (
          <motion.div 
            initial={{ opacity: 0, y: 50, scale: 0.9 }} 
            animate={{ opacity: 1, y: 0, scale: 1 }} 
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[101] w-full max-w-lg px-6"
          >
            <div className={`bg-[#1A1A1E]/95 backdrop-blur-2xl border-2 border-red-500/50 rounded-2xl p-6 shadow-[0_20px_50px_rgba(0,0,0,0.6),0_0_40px_rgba(239,68,68,0.3)]`}>
              <div className="flex items-start gap-5">
                <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center border border-red-500/20 shrink-0">
                  <Shield className="w-6 h-6 text-red-500 animate-pulse" />
                </div>
                <div className="flex-1 space-y-4">
                  <div>
                    <h2 className="text-lg font-bold text-white italic">Har du kontrollerat att du valt rätt mapp, och att ändringarna träder i kraft nu?!</h2>
                    <p className={`text-[10px] text-red-400 font-bold uppercase tracking-wider mt-1`}>SISTA VARNINGEN — VERIFIERA EN GÅNG TILL</p>
                  </div>
                  
                  <div className="flex gap-3">
                    <button 
                      onClick={() => {
                        setShowConfirm2(false);
                        setTimer2(0);
                      }}
                      className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 hover:bg-white/5 text-xs font-bold transition-all"
                    >
                      CANCEL
                    </button>
                    <button 
                      disabled={timer2 > 0}
                      onClick={() => {
                        setShowConfirm2(false);
                        setTimer2(0);
                        executePipeline();
                      }}
                      className={`flex-1 px-4 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                        timer2 > 0 
                        ? "bg-gray-800 text-gray-500 cursor-not-allowed" 
                        : "bg-red-600 text-white hover:shadow-[0_0_30px_rgba(239,68,68,0.5)] animate-pulse"
                      }`}
                    >
                      CONFIRM {timer2 > 0 && `(${timer2}s)`}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
