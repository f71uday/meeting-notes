import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, Check, CircleHelp, ExternalLink, FileText, Info, Link2, LoaderCircle, Mic2, Square, Video, Waves } from "lucide-react";
import { openDatabase } from "../../services/database";
import { ProviderConfig } from "../../types/meeting";

interface RecordingInfo { id: string; audioPath: string; durationSeconds: number; startedAt: string; }
interface ProcessedMeeting { transcript: string; speakerCount: number; segments: { startMs: number; endMs: number; speakerId?: string | null; text: string }[]; notes: { summary: string; objective: string; participants: string[]; decisions: string[]; actionItems: { task: string; owner?: string | null; dueDate?: string | null; priority: string }[]; risks: string[]; nextSteps: string[] }; }
const defaults: Record<"analysis" | "transcription", ProviderConfig> = {
  analysis: { provider: "openai", model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1" },
  transcription: { provider: "openai", model: "gpt-transcribe", endpoint: "https://api.openai.com/v1" },
};
const id = () => crypto.randomUUID();

async function providerConfig(role: "analysis" | "transcription") {
  const db = await openDatabase();
  const rows = await db.select<{ value: string }[]>("SELECT value FROM provider_preferences WHERE key = ?", [`${role}.config`]);
  return rows[0]?.value ? { ...defaults[role], ...JSON.parse(rows[0].value) as ProviderConfig } : defaults[role];
}
function timeLabel(total: number) { return `${Math.floor(total / 60).toString().padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`; }

export default function NewMeetingPage() {
  const [meetingUrl, setMeetingUrl] = useState("");
  const [title, setTitle] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openingParticipant, setOpeningParticipant] = useState(false);
  const [recording, setRecording] = useState<RecordingInfo | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<ProcessedMeeting | null>(null);
  const [retryRecordingId, setRetryRecordingId] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - new Date(recording.startedAt).getTime()) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  const openMeet = async () => {
    setOpening(true); setMessage(""); setError(false);
    try { await invoke("open_google_meet", { meetingUrl }); setMessage("Google Meet opened in your browser. Start recording here when everyone is ready."); }
    catch (reason) { setError(true); setMessage(typeof reason === "string" ? reason : "Could not open this Google Meet link."); }
    finally { setOpening(false); }
  };

  const openParticipant = async () => {
    setOpeningParticipant(true); setMessage(""); setError(false);
    try {
      await invoke("open_meet_participant", { meetingUrl });
      setMessage("Chrome opened with a separate Meet participant profile. Sign into the Google account you want this participant to use, then click Join in Meet. Start recording here once it has joined.");
    } catch (reason) {
      setError(true); setMessage(typeof reason === "string" ? reason : "Could not open a separate Meet participant window.");
    } finally { setOpeningParticipant(false); }
  };

  const startRecording = async () => {
    setMessage(""); setError(false);
    let started: RecordingInfo | null = null;
    try {
      const info = await invoke<RecordingInfo>("start_meeting_recording");
      started = info;
      const db = await openDatabase();
      const meetingTitle = title.trim() || `Meeting · ${new Date().toLocaleString()}`;
      await db.execute("INSERT INTO meetings (id, title, started_at, status, audio_path) VALUES (?, ?, ?, 'recording', ?)", [info.id, meetingTitle, info.startedAt, info.audioPath]);
      setRecording(info); setElapsed(0); setResult(null);
      setMessage("Recording meeting audio and your microphone. Stop recording to transcribe and create notes.");
      if (meetingUrl.trim()) void invoke("open_google_meet", { meetingUrl }).catch(() => undefined);
    } catch (reason) {
      if (started) await invoke("stop_meeting_recording").catch(() => undefined);
      setError(true); setMessage(typeof reason === "string" ? reason : "Could not start audio capture.");
    }
  };

  const processRecording = async (recordingId: string, durationSeconds: number) => {
    setProcessing(true); setError(false); setMessage("Transcribing the meeting audio and creating notes… This can take a few minutes.");
    const db = await openDatabase();
    try {
      const [transcriptionConfig, analysisConfig] = await Promise.all([providerConfig("transcription"), providerConfig("analysis")]);
      const processed = await invoke<ProcessedMeeting>("process_meeting_audio", { recordingId, transcriptionConfig, analysisConfig });
      const lengthMs = durationSeconds * 1000;
      await db.execute("DELETE FROM transcript_segments WHERE meeting_id = ?", [recordingId]);
      await db.execute("DELETE FROM speakers WHERE meeting_id = ?", [recordingId]);
      await db.execute("DELETE FROM action_items WHERE meeting_id = ?", [recordingId]);
      const speakerIds = new Map<string, string>();
      for (const segment of processed.segments) {
        if (!segment.speakerId || speakerIds.has(segment.speakerId)) continue;
        const speakerId = id(); speakerIds.set(segment.speakerId, speakerId);
        await db.execute("INSERT INTO speakers (id, meeting_id, label) VALUES (?, ?, ?)", [speakerId, recordingId, segment.speakerId]);
      }
      for (const segment of processed.segments) {
        await db.execute("INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, speaker_id, text) VALUES (?, ?, ?, ?, ?, ?)", [id(), recordingId, segment.startMs, segment.endMs || lengthMs, segment.speakerId ? speakerIds.get(segment.speakerId) ?? null : null, segment.text]);
      }
      const notes = processed.notes;
      await db.execute("UPDATE meetings SET status = 'ready', summary = ?, minutes_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [notes.summary, JSON.stringify(notes), recordingId]);
      for (const item of notes.actionItems ?? []) {
        await db.execute("INSERT INTO action_items (id, meeting_id, task, owner, due_date, priority, source_start_ms) VALUES (?, ?, ?, ?, ?, ?, 0)", [id(), recordingId, item.task, item.owner ?? null, item.dueDate ?? null, ["low", "normal", "high", "urgent"].includes(item.priority) ? item.priority : "normal"]);
      }
      let audioDeleted = false;
      try { await invoke("delete_meeting_recording", { recordingId }); audioDeleted = true; }
      catch { /* Keep the saved meeting usable if file deletion itself fails. */ }
      if (audioDeleted) await db.execute("UPDATE meetings SET audio_path = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [recordingId]).catch(() => undefined);
      setRetryRecordingId(null); setResult(processed); setMessage(audioDeleted ? "Transcript and meeting notes saved on this Mac. The raw audio recording was deleted." : "Transcript and notes were saved, but the raw audio file could not be deleted.");
    } catch (reason) {
      await db.execute("UPDATE meetings SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [recordingId]).catch(() => undefined);
      setRetryRecordingId(recordingId);
      setError(true); setMessage(typeof reason === "string" ? reason : "The meeting could not be processed. Check your provider settings and try again.");
    } finally { setProcessing(false); }
  };

  const stopRecording = async () => {
    if (!recording || processing) return;
    setProcessing(true); setError(false); setMessage("Stopping recording and preparing transcription…");
    try {
      const info = await invoke<RecordingInfo>("stop_meeting_recording");
      const duration = info.durationSeconds || elapsed;
      const db = await openDatabase();
      await db.execute("UPDATE meetings SET status = 'processing', duration_seconds = ?, audio_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [duration, info.audioPath, recording.id]);
      setRecording(null);
      await processRecording(recording.id, duration);
    } catch (reason) {
      setError(true); setMessage(typeof reason === "string" ? reason : "Could not finish the recording.");
      setRecording(null); setProcessing(false);
    }
  };

  return (
    <div className="new-meeting-page">
      <div className="new-meeting-title"><span className="new-meeting-icon"><Video size={20} /></span><div><h1>Capture a meeting</h1><p>Record meeting audio locally, then create a transcript and notes with your chosen AI providers.</p></div></div>
      {!recording && !processing && !result && <>
        <section className="meet-join-panel">
          <div className="meet-panel-heading"><div><span className="meet-brand-dot" /><span>Google Meet</span></div><span className="meet-local-label">Local companion</span></div>
          <label className="meet-link-field"><span>Meeting link <small>optional</small></span><div><Link2 size={16} /><input type="url" value={meetingUrl} onChange={(event) => setMeetingUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && meetingUrl.trim()) void openMeet(); }} placeholder="https://meet.google.com/abc-defg-hij" /></div></label>
          {meetingUrl.trim() && <div className="meet-open-actions"><button className="meet-open-button secondary" onClick={openMeet} disabled={opening || openingParticipant}>{opening ? "Opening…" : "Open Google Meet"}<ExternalLink size={15} /></button><button className="meet-open-button secondary" onClick={openParticipant} disabled={opening || openingParticipant}>{openingParticipant ? "Opening participant…" : "Open as separate participant"}<ExternalLink size={15} /></button></div>}
          <label className="settings-field meeting-name-field"><span>Meeting name</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly product sync" /></label>
        </section>
        <div className="recording-consent"><input id="recording-consent" type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)} /><label htmlFor="recording-consent">I have informed participants and have their consent to record this meeting.</label></div>
        <button className="start-capture-button" onClick={startRecording} disabled={!consentConfirmed}><Mic2 size={17} />Start recording</button>
        {retryRecordingId && <button className="retry-processing-button" onClick={() => void processRecording(retryRecordingId, elapsed)}>Retry transcription and notes</button>}
        <div className="companion-note"><Info size={17} /><div><b>Separate participant setup</b><p>Open as separate participant launches a dedicated Chrome profile. Sign in once with the Google account for that participant, then join manually in Meet. Keep its microphone and camera off to avoid echo. Raw audio is deleted after successful processing; if processing fails, it stays locally so you can retry.</p></div></div>
        <div className="meet-flow"><div><span>1</span><b>Open participant</b><small>Sign in and join in Chrome.</small></div><ArrowUpRight size={16} /><div><span>2</span><b>Start recording</b><small>Confirm consent and capture audio.</small></div><ArrowUpRight size={16} /><div><span>3</span><b>Stop for notes</b><small>Transcript and notes are saved locally.</small></div></div>
      </>}
      {recording && <section className="active-recording-panel"><div className="active-recording-heading"><span className="recording-live-dot" /><div><h2>Recording meeting</h2><p>System audio and microphone are being captured on this Mac.</p></div></div><div className="recording-clock"><Waves size={19} />{timeLabel(elapsed)}</div><p className="recording-consent-reminder"><CircleHelp size={15} /> Keep the recording indicator visible and let participants know recording is active.</p><button className="stop-capture-button" onClick={() => void stopRecording()} disabled={processing}><Square size={15} fill="currentColor" />Stop and create notes</button></section>}
      {processing && <section className="processing-panel"><LoaderCircle className="spin" size={22} /><div><b>Creating your meeting notes</b><p>{message}</p><small>Large meetings may take a few minutes.</small></div></section>}
      {message && !processing && <div className={`meet-result ${error ? "error" : ""}`} role="status">{!error && !recording && <Check size={15} />}{message}</div>}
      {result && <section className="meeting-result-panel"><div className="result-panel-heading"><span className="result-panel-icon"><FileText size={17} /></span><div><h2>Meeting notes</h2><p>Saved locally · review before sharing</p></div></div><p className="generated-summary">{result.notes.summary}</p>{result.speakerCount > 0 && <p className="speaker-count">Detected {result.speakerCount} distinct speaking voice{result.speakerCount === 1 ? "" : "s"}. Silent attendees aren’t counted.</p>}<h3>Transcript</h3><div className="transcript-text">{result.segments.map((segment, index) => <p className="transcript-segment" key={index}>{segment.speakerId && <b>{segment.speakerId}: </b>}{segment.text}</p>)}</div>{result.notes.decisions.length > 0 && <><h3>Decisions</h3><ul>{result.notes.decisions.map((item, index) => <li key={index}>{item}</li>)}</ul></>}{result.notes.actionItems.length > 0 && <><h3>Action items</h3><ul>{result.notes.actionItems.map((item, index) => <li key={index}>{item.task}{item.owner ? ` — ${item.owner}` : ""}{item.dueDate ? ` · ${item.dueDate}` : ""}</li>)}</ul></>}<button className="meet-open-button" onClick={() => { setResult(null); setMessage(""); setTitle(""); setMeetingUrl(""); }}>Start another meeting</button></section>}
    </div>
  );
}
