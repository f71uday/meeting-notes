# Meeting Notes architecture

## Product and visual direction

An offline-first desktop library for people who need useful decisions and follow-ups from real conversations. The dashboard uses a pale mineral canvas (`#F7F8F6`), paper white (`#FFFFFF`), pine (`#24765B`), ink (`#202823`), and quiet sage (`#B4D3BD`). Typography uses the macOS system stack so the interface feels native and keeps bundle size small. The layout is left aligned, with a stable navigation rail and one focused content column. The waveform is the single expressive visual cue; status, collections, and action ownership carry the rest of the visual hierarchy.

```text
┌──────────────┬───────────────────────────────────────────────┐
│ Workspace   │ Breadcrumb                  Search             │
│ Navigation  ├───────────────────────────────────────────────┤
│ Collections │ Welcome + Start meeting                      │
│ Privacy     │ Capture strip + waveform                      │
│ Profile     │ Meeting counts                                │
│             │ Recent meetings                               │
│             │ Action and insight follow-ups                 │
└─────────────┴───────────────────────────────────────────────┘
```

## Technical architecture

- **Desktop shell:** Tauri 2 hosts a React 18 + TypeScript SPA built with Vite. Rust owns native capabilities, filesystem paths, keychain access, permissions, and app lifecycle. Frontend code never shells out to external programs.
- **UI:** Tailwind CSS supplies utility styling; Lucide supplies icons. `components.json` prepares shadcn/ui conventions. Domain-specific components should be added locally as accessible primitives and promoted to shadcn components when their behavior matches the library.
- **Persistence:** Tauri SQL plugin with SQLite stores meeting metadata, speakers, timestamped transcript segments, minutes JSON, action items, and nonsecret preferences. Versioned Rust-side migrations initialize schema on open. Audio lives under Tauri's app-local data directory, partitioned by meeting ID. Delete uses a transaction for metadata plus explicit removal of the recording file.
- **Secrets:** Provider API keys belong in macOS Keychain through the Rust `keyring` crate. The webview sends a token once to a dedicated command and only receives a saved/not-saved state; no command returns a saved secret. Never store a key in webview storage, logs, settings JSON, or the database. Provider selection and endpoint/model preferences are stored in SQLite. Endpoint URLs reject embedded credentials, query strings, and fragments.
- **Services:** `AudioCapture` emits timestamped PCM frames; `AudioPipeline` resamples, mixes, meters, and writes durable chunks; `TranscriptionProvider` consumes chunks and returns partial/final segments; `DiarizationProvider` assigns speaker IDs; `MeetingAnalysisProvider` produces validated structured MoM; `MeetingRepository` persists changes; `ExportProvider` renders output formats. Tauri commands are the boundary between UI and native services. An event channel carries recording state, level, transcript, and processing progress to the UI.
- **Reliability:** Record chunks to disk before handing them to an online provider. Persist each finalized transcript segment immediately. A failed provider request leaves audio and transcript available for retry. Long-running analysis runs outside the UI thread, has cancellation and bounded retries for rate limits/timeouts, and reports explicit progress.

## macOS audio capture and limits

The first capture implementation uses the maintained `screencapturekit` Rust bindings for `SCStream` and sample buffers. It captures system audio and microphone audio, downsamples to mono 16 kHz PCM, mixes the streams, and writes a WAV under the app's recordings folder. Capture is explicitly started and stopped by the user. Transcription and analysis currently run after stop; live partial transcripts are future work.

ScreenCaptureKit is Apple's supported high-performance path and supplies audio sample buffers. Screen recording authorization is required; explain why capture is needed, detect denial, and offer a route to System Settings. The system picker and permission prompt remain visible. Audio capture does not mean every conferencing app is guaranteed to yield clean remote speech: app-specific audio routing, headphones, protected content, OS privacy policy, muted output, and macOS version can affect results. A meeting app may expose one mixed output stream; that does not identify remote speakers. Microphone recording is separately opt-in and can contain echo. Always show an in-app recording state and level meter.

Target macOS 15+ because the current ScreenCaptureKit API uses its microphone capture input. The user grants Screen Recording / System Audio Recording and Microphone permissions. This implementation captures audio only and does not retain screen frames. Test browsers and native Zoom/Teams clients on physical Macs with speaker output and headphones; document tested OS/app versions. Audio quality depends on app routing, device configuration, protected content, and permission state; speaker identity is not available from the mixed capture.

Google Meet integration is a local companion workflow: the app validates and opens a Meet link in the user's browser; it does not impersonate the user or enter as a second attendee. The app captures system and microphone audio locally after the user confirms participant consent. Google announced the Meet Media API shutdown for January 15, 2027; see Google's [Meet API release notes](https://developers.google.com/workspace/meet/release-notes).

## Transcription and diarization

The current implementation splits the saved WAV into eight-minute requests after recording stops. It uses the selected transcription provider independently from the notes provider. Transcript timing and speaker diarization are not yet emitted; current results are stored as a single transcript segment.

Current adapters: OpenAI-compatible audio transcription, Gemini audio transcription, OpenAI-compatible chat completions, Gemini notes generation, and Ollama/OpenRouter for analysis. Provider-neutral interfaces:

```ts
export interface AudioChunk {
  meetingId: string; sequence: number; startMs: number; endMs: number;
  sampleRate: number; channels: number; mimeType: string; bytes: Uint8Array;
}
export interface TranscriptUpdate {
  segments: TranscriptSegment[]; final: boolean; language?: string;
}
export interface TranscriptionProvider {
  readonly id: string;
  startSession(config: TranscriptionConfig): Promise<void>;
  processAudioChunk(chunk: AudioChunk): Promise<TranscriptUpdate>;
  stopSession(): Promise<TranscriptUpdate>;
}
export interface DiarizationProvider {
  assignSpeakers(audio: AudioChunk[], segments: TranscriptSegment[]): Promise<TranscriptSegment[]>;
}
export interface MeetingAnalysisProvider {
  analyze(input: AnalysisInput, signal?: AbortSignal): Promise<MeetingMinutes>;
}
```

Provider responses map to a stable internal segment schema. For first release use timestamped speech-to-text and optional provider diarization; fall back to sequential Speaker N labels and manual correction. Never infer a person's real identity from voice. User-assigned names remain editable. Cloud diarization is provider-dependent and can degrade with overlap, short turns, noise, or mixed far-end audio, so preserve confidence/uncertainty and make correction easy.

## Structured meeting output

The analysis contract is schema validated before persistence. `MeetingMinutes` contains details (including unknowns), objective, participants, executive summary, agenda, timestamp-linked discussion points, decisions, action items with explicit owner/deadline uncertainty, pending issues, risks/dependencies, next steps, and proposed next agenda. The prompt requires evidence timestamps and distinguishes explicit statements from suggested follow-ups. Missing owners and dates are represented as `null` and rendered as “Unassigned” / “Not specified”; they are never guessed.

## Initial SQLite model

The first migration is in `src-tauri/migrations/001_initial.sql`.

| Table | Purpose and key relations |
| --- | --- |
| `meetings` | Title, start, duration, status, summary, minutes JSON and app-local audio path. |
| `speakers` | Per-meeting speaker labels and optional user-assigned display names. |
| `transcript_segments` | Ordered start/end milliseconds, text, edit flag, optional speaker. |
| `action_items` | Task, optional owner/date, priority/status, source meeting and timestamp. |
| `provider_preferences` | Nonsecret provider IDs, model IDs, endpoint config, fallback choices. |

Keys are UUID strings. Timestamps are ISO-8601 UTC strings; display timezone is local. Transcript is append/upsert-friendly and retains edited text while future raw-provider payloads can be stored separately if needed. Add later migrations for provider profiles, export jobs, tags, and audit/history if product needs warrant them. Audio itself never belongs in SQLite.

## UI screen map

- **Dashboard:** welcome and one-click capture; recent meetings; counts and an evidence-linked action item.
- **New meeting / recording:** title, capture source choice, prominent recording state and elapsed time, level meter, live transcript, pause/resume/stop, and system permission recovery.
- **All meetings:** searchable, sortable history and collection filters.
- **Meeting detail:** Overview, Transcript, Meeting Minutes, Decisions, Action Items, Audio Recording tabs. Transcript edits and speaker rename/correction preserve timestamps.
- **Action items:** searchable/filterable status tracker with owner, due date, priority, and source-meeting navigation.
- **Settings:** independent transcription and analysis providers, model/endpoints, Keychain credential entry, connection test, fallback order, local model management, data retention, export/privacy controls.
- **Minutes editor:** editable sections, per-section regeneration, source timestamp links, copy and export (Markdown/TXT first, PDF/DOCX later).

## Milestones

1. **Desktop foundation:** Tauri/React/TypeScript shell, navigation, design system, SQLite migration and architecture docs.
2. **Recording and AI processing (current):** ScreenCaptureKit system/microphone recording, consent confirmation, provider selection and Keychain credentials, post-stop transcription and meeting notes.
3. **Live transcription:** provider streaming, timestamped segments and incremental persistence.
4. **Diarization:** speaker assignment, rename/correction workflow and confidence handling.
5. **Meeting intelligence:** validated provider-neutral analysis, summary/decisions/action items/MoM and retry/cancel flow.
6. **Meeting management:** history/search, details, editing, action tracker and retention/deletion.
7. **Export and release polish:** Markdown/TXT/PDF/DOCX, accessibility/performance, signing, packaging and tested compatibility matrix.

Tauri recommends Vite for SPA frontends and provides a SQLite SQL plugin with Rust-side migrations; see [Tauri frontend configuration](https://v2.tauri.app/start/frontend/) and [SQL plugin](https://v2.tauri.app/plugin/sql/).
