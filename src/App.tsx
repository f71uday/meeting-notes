import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AudioLines, CalendarDays, Check, ChevronDown, Clock3, FileText, FolderClosed,
  LayoutDashboard, ListTodo, Plus, Settings2, Waves,
} from "lucide-react";
import SettingsPage from "./features/settings/SettingsPage";
import NewMeetingPage from "./features/meetings/NewMeetingPage";
import { openDatabase } from "./services/database";

type Page = "Dashboard" | "New meeting" | "All meetings" | "Action items" | "Settings" | "Meeting detail";
interface MeetingRow { id: string; title: string; started_at: string; duration_seconds: number | null; status: string; summary: string | null; minutes_json: string | null; }
interface ActionRow { id: string; meeting_id: string; meeting_title: string; task: string; owner: string | null; due_date: string | null; priority: string; status: string; completion_notes: string | null; }
interface TranscriptRow { start_ms: number; end_ms: number; text: string; speaker_label: string | null; }

function dateLabel(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function durationLabel(seconds: number | null) { if (!seconds) return "—"; return `${Math.floor(seconds / 60)} min`; }

function App() {
  const [page, setPage] = useState<Page>("Dashboard");
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingRow | null>(null);
  const [transcript, setTranscript] = useState<TranscriptRow[]>([]);
  const [meetingActions, setMeetingActions] = useState<ActionRow[]>([]);
  const [completingActionId, setCompletingActionId] = useState<string | null>(null);
  const [completionNotes, setCompletionNotes] = useState("");
  const [loadError, setLoadError] = useState("");
  const todayLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const db = await openDatabase();
        const [meetingRows, actionRows] = await Promise.all([
          db.select<MeetingRow[]>("SELECT id, title, started_at, duration_seconds, status, summary, minutes_json FROM meetings ORDER BY started_at DESC"),
          db.select<ActionRow[]>("SELECT a.id, a.meeting_id, m.title AS meeting_title, a.task, a.owner, a.due_date, a.priority, a.status, a.completion_notes FROM action_items a JOIN meetings m ON m.id = a.meeting_id WHERE a.status != 'complete' ORDER BY CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, a.due_date"),
        ]);
        if (active) { setMeetings(meetingRows); setActions(actionRows); setLoadError(""); }
      } catch { if (active) setLoadError("Your local meeting library could not be loaded."); }
    })();
    return () => { active = false; };
  }, [page]);

  useEffect(() => {
    let active = true;
    if (page !== "Meeting detail" || !selectedMeetingId) return;
    void (async () => {
      try {
        const db = await openDatabase();
        const [meetingRows, transcriptRows, actionRows] = await Promise.all([
          db.select<MeetingRow[]>("SELECT id, title, started_at, duration_seconds, status, summary, minutes_json FROM meetings WHERE id = ?", [selectedMeetingId]),
          db.select<TranscriptRow[]>("SELECT ts.start_ms, ts.end_ms, ts.text, s.label AS speaker_label FROM transcript_segments ts LEFT JOIN speakers s ON s.id = ts.speaker_id WHERE ts.meeting_id = ? ORDER BY ts.start_ms", [selectedMeetingId]),
          db.select<ActionRow[]>("SELECT a.id, a.meeting_id, m.title AS meeting_title, a.task, a.owner, a.due_date, a.priority, a.status, a.completion_notes FROM action_items a JOIN meetings m ON m.id = a.meeting_id WHERE a.meeting_id = ? ORDER BY a.created_at", [selectedMeetingId]),
        ]);
        if (active) { setSelectedMeeting(meetingRows[0] ?? null); setTranscript(transcriptRows); setMeetingActions(actionRows); }
      } catch { if (active) setLoadError("This meeting’s saved notes could not be loaded."); }
    })();
    return () => { active = false; };
  }, [page, selectedMeetingId]);

  const openMeeting = (meetingId: string) => { setSelectedMeetingId(meetingId); setPage("Meeting detail"); };
  const completeAction = async (action: ActionRow) => {
    const notes = completionNotes.trim();
    if (!notes) return;
    try {
      const db = await openDatabase();
      await db.execute("UPDATE action_items SET status = 'complete', completion_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [notes, action.id]);
      setActions((items) => items.filter((item) => item.id !== action.id));
      setMeetingActions((items) => items.map((item) => item.id === action.id ? { ...item, status: "complete", completion_notes: notes } : item));
      setCompletingActionId(null); setCompletionNotes("");
    } catch { setLoadError("The action item could not be updated."); }
  };
  const deleteMeeting = async () => {
    if (!selectedMeeting || !window.confirm(`Delete “${selectedMeeting.title}” and its transcript, minutes, action items, and stored audio?`)) return;
    try {
      await invoke("delete_meeting_recording", { recordingId: selectedMeeting.id });
      const db = await openDatabase();
      await db.execute("DELETE FROM meetings WHERE id = ?", [selectedMeeting.id]);
      setMeetings((items) => items.filter((item) => item.id !== selectedMeeting.id));
      setActions((items) => items.filter((item) => item.meeting_id !== selectedMeeting.id));
      setPage("All meetings"); setSelectedMeeting(null); setSelectedMeetingId(null); setLoadError("");
    } catch { setLoadError("The meeting or its recording could not be deleted."); }
  };
  const totalSeconds = meetings.reduce((sum, meeting) => sum + (meeting.duration_seconds ?? 0), 0);
  const completedCount = meetings.filter((meeting) => meeting.status === "ready").length;
  const minutes = (() => { try { return selectedMeeting?.minutes_json ? JSON.parse(selectedMeeting.minutes_json) as Record<string, unknown> : null; } catch { return null; } })();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><AudioLines size={19} strokeWidth={2.2} /></div><span>Meeting Notes</span></div>
        <div className="workspace-switch"><div className="workspace-avatar">M</div><span><b>Meeting library</b><small>Stored on this Mac</small></span><ChevronDown size={14} /></div>
        <div className="nav-label">Workspace</div>
        <nav aria-label="Main navigation">
          <button className={`nav-item ${page === "Dashboard" ? "active" : ""}`} onClick={() => setPage("Dashboard")}><LayoutDashboard size={17} />Dashboard</button>
          <button className={`nav-item ${page === "New meeting" ? "active" : ""}`} onClick={() => setPage("New meeting")}><Plus size={17} />New meeting<span className="nav-shortcut">⌘ N</span></button>
          <button className={`nav-item ${page === "All meetings" || page === "Meeting detail" ? "active" : ""}`} onClick={() => setPage("All meetings")}><FolderClosed size={17} />All meetings<span className="nav-count">{meetings.length}</span></button>
          <button className={`nav-item ${page === "Action items" ? "active" : ""}`} onClick={() => setPage("Action items")}><ListTodo size={17} />Action items<span className="nav-count">{actions.length}</span></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note"><span className="privacy-icon"><Check size={13} /></span><div><b>Your notes stay yours</b><small>Stored on this Mac</small></div></div>
          <button className={`nav-item ${page === "Settings" ? "active" : ""}`} onClick={() => setPage("Settings")}><Settings2 size={17} />Settings</button>
          <div className="profile"><div className="profile-avatar">M</div><span><b>Local workspace</b><small>On this Mac</small></span></div>
        </div>
      </aside>

      <main className="main-pane">
        <header className="topbar" onMouseDown={(event) => { if (event.button === 0) void getCurrentWindow().startDragging(); }}><div className="breadcrumb"><span>Workspace</span><span className="slash">/</span><b>{page === "Meeting detail" ? "Meeting details" : page}</b></div></header>
        {loadError && <div className="library-error" role="alert">{loadError}</div>}
        {page === "Dashboard" && <div className="page-content">
          <div className="welcome-row"><div><div className="date-line"><CalendarDays size={14} /> {todayLabel}</div><h1>Your meetings,<br />made meaningful.</h1><p>Your saved transcripts, minutes, and action items.</p></div><button className="primary-button" onClick={() => setPage("New meeting")}><Plus size={17} />Start a meeting</button></div>
          <section className="recording-banner"><div className="recording-copy"><div className="recording-icon"><AudioLines size={20} /></div><div><div className="banner-title">Ready when you are</div><div className="banner-subtitle">Capture a conversation and keep its notes here.</div></div></div><div className="banner-wave"><Waves size={25} /></div><button className="banner-button" onClick={() => setPage("New meeting")}>Start recording</button></section>
          <section className="stats-row" aria-label="Meeting statistics">
            <div className="stat"><span className="stat-icon green"><FileText size={16} /></span><div><b>{completedCount}</b><span>Meetings with notes</span></div></div>
            <div className="stat"><span className="stat-icon amber"><ListTodo size={16} /></span><div><b>{actions.length}</b><span>Open action items</span></div></div>
            <div className="stat"><span className="stat-icon violet"><Clock3 size={16} /></span><div><b>{(totalSeconds / 3600).toFixed(1)}h</b><span>Recorded time</span></div></div>
          </section>
          <section className="meetings-section"><div className="section-heading"><div><h2>Recent meetings</h2><p>Your saved meeting history</p></div><button className="text-button" onClick={() => setPage("All meetings")}>View all <span>↗</span></button></div>
            {meetings.length === 0 ? <div className="library-empty"><FileText size={22} /><b>No meetings saved yet</b><span>Start a meeting to create your first transcript and minutes.</span></div> : <div className="meeting-table"><div className="table-head"><span>Meeting</span><span>Status</span><span>Started</span><span>Duration</span><span /></div>{meetings.slice(0, 5).map((meeting, index) => <button className="meeting-row" key={meeting.id} onClick={() => openMeeting(meeting.id)}><span className="meeting-name"><span className={`meeting-symbol symbol-${index % 3}`}><AudioLines size={15} /></span><span><b>{meeting.title}</b><small>{dateLabel(meeting.started_at)}</small></span></span><span><span className={`tag tag-${index % 3}`}>{meeting.status}</span></span><span>{dateLabel(meeting.started_at)}</span><span className="duration-cell">{durationLabel(meeting.duration_seconds)}</span><span className="row-arrow">↗</span></button>)}</div>}
          </section>
          <footer className="footer-note"><Waves size={13} /> Transcripts and minutes are stored in your local meeting library.</footer>
        </div>}
        {page === "New meeting" && <NewMeetingPage />}
        {page === "Settings" && <SettingsPage />}
        {page === "All meetings" && <div className="library-page"><div className="library-heading"><div><h1>All meetings</h1><p>Transcripts and minutes saved on this Mac.</p></div><button className="primary-button" onClick={() => setPage("New meeting")}><Plus size={16} />New meeting</button></div>{meetings.length === 0 ? <div className="library-empty"><FileText size={22} /><b>No meetings saved yet</b><span>Completed meetings will appear here.</span></div> : <div className="meeting-table"><div className="table-head"><span>Meeting</span><span>Status</span><span>Started</span><span>Duration</span><span /></div>{meetings.map((meeting, index) => <button className="meeting-row" key={meeting.id} onClick={() => openMeeting(meeting.id)}><span className="meeting-name"><span className={`meeting-symbol symbol-${index % 3}`}><AudioLines size={15} /></span><span><b>{meeting.title}</b><small>{dateLabel(meeting.started_at)}</small></span></span><span><span className={`tag tag-${index % 3}`}>{meeting.status}</span></span><span>{dateLabel(meeting.started_at)}</span><span>{durationLabel(meeting.duration_seconds)}</span><span className="row-arrow">↗</span></button>)}</div>}</div>}
        {page === "Meeting detail" && <div className="library-page"><button className="text-button" onClick={() => setPage("All meetings")}>← All meetings</button>{!selectedMeeting ? <div className="library-empty">Meeting not found.</div> : <><div className="library-heading meeting-detail-heading"><div><h1>{selectedMeeting.title}</h1><p>{dateLabel(selectedMeeting.started_at)} · {durationLabel(selectedMeeting.duration_seconds)} · {selectedMeeting.status}</p></div><button className="remove-token-button" onClick={() => void deleteMeeting()}>Delete meeting</button></div>{selectedMeeting.summary && <section className="meeting-detail-card"><h2>Summary</h2><p>{selectedMeeting.summary}</p></section>}{minutes && <section className="meeting-detail-card"><h2>Minutes</h2>{typeof minutes.objective === "string" && <><h3>Objective</h3><p>{minutes.objective}</p></>}{(["participants", "decisions", "risks", "nextSteps"] as const).map((key) => Array.isArray(minutes[key]) && (minutes[key] as string[]).length > 0 && <div key={key}><h3>{key === "nextSteps" ? "Next steps" : key[0].toUpperCase() + key.slice(1)}</h3><ul>{(minutes[key] as string[]).map((value, index) => <li key={index}>{value}</li>)}</ul></div>)}</section>}{meetingActions.length > 0 && <section className="meeting-detail-card"><h2>Tracked action items</h2>{meetingActions.map((action) => <div className="saved-action" key={action.id}><div><b>{action.task}</b><small>{action.status === "complete" ? `Completed · ${action.completion_notes ?? ""}` : `Open${action.owner ? ` · ${action.owner}` : ""}${action.due_date ? ` · Due ${action.due_date}` : ""}`}</small></div></div>)}</section>}<section className="meeting-detail-card"><h2>Transcript</h2>{transcript.length === 0 ? <p>No transcript segments were saved for this meeting.</p> : <div className="saved-transcript">{transcript.map((segment, index) => <p key={`${segment.start_ms}-${index}`}>{segment.speaker_label && <b>{segment.speaker_label}: </b>}{segment.text}</p>)}</div>}</section></>}</div>}
        {page === "Action items" && <div className="library-page"><div className="library-heading"><div><h1>Action items</h1><p>Tasks extracted from your saved meeting minutes.</p></div></div>{actions.length === 0 ? <div className="library-empty"><ListTodo size={22} /><b>No open action items</b><span>Action items from processed meetings will appear here.</span></div> : <div className="meeting-detail-card">{actions.map((action) => <div className="saved-action" key={action.id}><div><b>{action.task}</b><small>{action.meeting_title}{action.owner ? ` · ${action.owner}` : ""}{action.due_date ? ` · Due ${action.due_date}` : ""}</small>{completingActionId === action.id && <div className="completion-editor"><textarea value={completionNotes} onChange={(event) => setCompletionNotes(event.target.value)} placeholder="What did you do, and how did you complete it?" /><button className="save-settings-button" onClick={() => void completeAction(action)} disabled={!completionNotes.trim()}>Save completion</button><button className="text-button" onClick={() => { setCompletingActionId(null); setCompletionNotes(""); }}>Cancel</button></div>}</div><span className="tag">{action.priority}</span>{completingActionId !== action.id && <button className="text-button" onClick={() => { setCompletingActionId(action.id); setCompletionNotes(""); }}>Mark done</button>}</div>)}</div>}</div>}
      </main>
    </div>
  );
}

export default App;
