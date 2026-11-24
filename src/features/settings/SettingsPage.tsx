import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Eye, EyeOff, KeyRound, LoaderCircle, Save, ShieldCheck, Trash2 } from "lucide-react";
import { openDatabase } from "../../services/database";

type Provider = "openai" | "gemini" | "openrouter" | "ollama" | "custom";
type Role = "analysis" | "transcription";
interface Config { provider: Provider; model: string; endpoint: string; }
const providerOptions: { id: Provider; label: string }[] = [
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "ollama", label: "Ollama · local" },
  { id: "custom", label: "Custom OpenAI-compatible" },
];
const defaults: Record<Role, Config> = {
  analysis: { provider: "openai", model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1" },
  transcription: { provider: "openai", model: "gpt-transcribe", endpoint: "https://api.openai.com/v1" },
};
const endpoints: Partial<Record<Provider, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

function providerLabel(id: Provider) { return providerOptions.find((item) => item.id === id)?.label ?? "Local Whisper"; }

function ProviderPanel({ role, title, description }: { role: Role; title: string; description: string }) {
  const [config, setConfig] = useState<Config>(defaults[role]);
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const db = await openDatabase();
        const saved = await db.select<{ value: string }[]>("SELECT value FROM provider_preferences WHERE key = ?", [`${role}.config`]);
        const loaded = saved[0]?.value ? { ...defaults[role], ...JSON.parse(saved[0].value) as Partial<Config> } : defaults[role];
        const migrateOpenRouterDefault = role === "transcription" && loaded.provider === "openrouter" && loaded.model === "openai/whisper-1";
        if (migrateOpenRouterDefault) {
          loaded.model = "microsoft/mai-transcribe-2";
          await db.execute("UPDATE provider_preferences SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?", [JSON.stringify(loaded), `${role}.config`]);
        }
        const compatible = role === "analysis" || ["openai", "gemini", "openrouter", "custom"].includes(loaded.provider) ? loaded : defaults[role];
        if (active) setConfig(compatible);
        const selected = compatible.provider;
        const storedToken = await invoke<boolean>("has_provider_token", { role, provider: selected });
        if (active) setHasToken(storedToken);
      } catch {
        if (active) setMessage("Could not load saved settings. Reopen Settings to try again.");
      }
    })();
    return () => { active = false; };
  }, [role]);

  const updateProvider = async (provider: Provider) => {
    setConfig((current) => ({
      ...current,
      provider,
      endpoint: endpoints[provider] ?? (provider === "gemini" ? "https://generativelanguage.googleapis.com" : provider === "custom" ? "" : current.endpoint),
      model: provider === "gemini" ? (role === "analysis" ? "gemini-2.5-flash" : "gemini-2.5-flash")
        : provider === "openrouter" ? (role === "analysis" ? "openai/gpt-4o-mini" : "microsoft/mai-transcribe-2")
          : provider === "ollama" ? "qwen2.5:7b"
            : provider === "custom" ? "" : defaults[role].model,
    }));
    try { setHasToken(await invoke<boolean>("has_provider_token", { role, provider })); }
    catch { setHasToken(false); }
    setMessage("");
  };

  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      if (config.provider === "custom" || config.provider === "ollama" || config.provider === "gemini") {
        const endpoint = new URL(config.endpoint);
        if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          throw "Use an HTTP(S) endpoint without credentials in the URL. Store tokens in the Keychain field.";
        }
      }
      const db = await openDatabase();
      await db.execute(
        "INSERT INTO provider_preferences (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
        [`${role}.config`, JSON.stringify(config)],
      );
      if (token.trim()) {
        await invoke("save_provider_token", { role, provider: config.provider, token });
        setHasToken(true);
        setToken("");
      }
      setMessage("Settings saved on this Mac.");
    } catch (error) {
      setMessage(typeof error === "string" ? error : "Settings could not be saved.");
    } finally { setBusy(false); }
  };

  const removeToken = async () => {
    setBusy(true);
    try {
      await invoke("delete_provider_token", { role, provider: config.provider });
      setHasToken(false);
      setMessage("Saved token removed from Keychain.");
    } catch (error) {
      setMessage(typeof error === "string" ? error : "Token could not be removed.");
    } finally { setBusy(false); }
  };

  return (
    <section className="settings-panel">
      <div className="settings-panel-heading"><div><h2>{title}</h2><p>{description}</p></div><span className="settings-role-icon"><KeyRound size={17} /></span></div>
      <div className="settings-fields">
        <label className="settings-field"><span>Provider</span><select value={config.provider} onChange={(event) => void updateProvider(event.target.value as Provider)}>{providerOptions.filter((item) => role === "analysis" || ["openai", "gemini", "openrouter", "custom"].includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="settings-field"><span>Model</span><input value={config.model} onChange={(event) => setConfig({ ...config, model: event.target.value })} placeholder="Enter model name" /></label>
        {(config.provider === "custom" || config.provider === "ollama") && <label className="settings-field"><span>Base URL</span><input value={config.endpoint} onChange={(event) => setConfig({ ...config, endpoint: event.target.value })} placeholder="https://your-provider.example/v1" /></label>}
        {config.provider === "gemini" && <label className="settings-field"><span>API endpoint</span><input value={config.endpoint} onChange={(event) => setConfig({ ...config, endpoint: event.target.value })} /></label>}
        <label className="settings-field"><span>API token <small>{config.provider === "ollama" ? "optional" : "stored in macOS Keychain"}</small></span><div className="secret-input"><input type={showToken ? "text" : "password"} autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={hasToken ? "A token is saved securely" : "Paste your provider token"} /><button type="button" aria-label={showToken ? "Hide token" : "Show token"} onClick={() => setShowToken(!showToken)}>{showToken ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
      </div>
      <div className="settings-panel-footer">
        <div className="credential-status">{hasToken ? <><ShieldCheck size={15} /><span>Token saved securely for {providerLabel(config.provider)}</span></> : <><KeyRound size={14} /><span>{config.provider === "ollama" ? "Local model · token optional" : "No token saved for this provider"}</span></>}</div>
        <div className="settings-actions">{hasToken && <button className="remove-token-button" onClick={removeToken} disabled={busy}><Trash2 size={14} />Remove token</button>}<button className="save-settings-button" onClick={save} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}Save settings</button></div>
      </div>
      {message && <div className={`settings-message ${message.includes("could not") || message.includes("Could not") ? "error" : ""}`} role="status">{message.includes("saved") && <Check size={13} />}{message}</div>}
    </section>
  );
}

export default function SettingsPage() {
  return (
    <div className="settings-page">
      <div className="settings-title"><div className="settings-title-icon"><KeyRound size={19} /></div><div><h1>AI providers</h1><p>Choose which services handle transcription and meeting notes.</p></div></div>
      <div className="settings-privacy"><ShieldCheck size={17} /><span><b>Your tokens stay on this Mac.</b> They’re stored in Keychain and never saved to the meeting database.</span></div>
      <ProviderPanel role="analysis" title="Meeting notes" description="Creates summaries, decisions, minutes, and action items." />
      <ProviderPanel role="transcription" title="Transcription" description="Transcribes audio and, with OpenRouter’s MAI Transcribe 2, labels speakers and estimates the number of distinct voices." />
      <p className="settings-footnote">Meeting audio is transcribed after you stop recording. The transcript is sent to your transcription provider, then to the meeting notes provider. OpenAI, OpenRouter, Gemini, and custom OpenAI-compatible endpoints are supported for transcription.</p>
    </div>
  );
}
