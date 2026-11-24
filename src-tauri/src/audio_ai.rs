use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hound::{SampleFormat, WavSpec, WavWriter};
use keyring::Entry;
use reqwest::{multipart, Client};
use core_foundation::base::TCFType;
use core_media::{format_description::CMAudioFormatDescription, sample_buffer::{CMSampleBuffer, CMSampleBufferRef}};
use objc2::{define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol};
use dispatch2::DispatchQueue;
use screen_capture_kit::{shareable_content::{SCShareableContent, SCWindow}, stream::{SCContentFilter, SCStream, SCStreamConfiguration, SCStreamDelegate, SCStreamOutput, SCStreamOutputType}};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io::Cursor, path::PathBuf, sync::{Arc, Mutex, OnceLock}, time::Instant};
use tauri::Manager;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "com.local.meeting-notes";
const TARGET_RATE: u32 = 16_000;
const TRANSCRIBE_CHUNK_SECONDS: usize = 480;

fn capture_error(code: isize) -> String {
    if code == -3801 {
        "Screen capture permission was declined. Open System Settings → Privacy & Security → Screen & System Audio Recording, enable Meeting Notes, then quit and reopen the app. Also make sure Meeting Notes is enabled under Microphone.".into()
    } else {
        format!("ScreenCaptureKit error {code}. Check Screen & System Audio Recording and Microphone permissions in System Settings.")
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider: String,
    pub model: String,
    pub endpoint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub id: String,
    pub audio_path: String,
    pub duration_seconds: u64,
    pub started_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub task: String,
    pub owner: Option<String>,
    pub due_date: Option<String>,
    pub priority: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct MeetingNotes {
    pub summary: String,
    pub objective: String,
    pub participants: Vec<String>,
    pub decisions: Vec<String>,
    #[serde(alias = "action_items")]
    pub action_items: Vec<ActionItem>,
    pub risks: Vec<String>,
    pub next_steps: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedMeeting {
    pub transcript: String,
    pub segments: Vec<TranscriptPart>,
    pub speaker_count: usize,
    pub notes: MeetingNotes,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPart {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker_id: Option<String>,
    pub text: String,
}

#[derive(Default)]
struct AudioData {
    samples: Vec<i16>,
    phase: f64,
}

impl AudioData {
    fn append(&mut self, sample: CMSampleBufferRef) {
        let sample = unsafe { CMSampleBuffer::wrap_under_get_rule(sample) };
        let Some(description) = sample.get_format_description() else { return; };
        let audio = unsafe { CMAudioFormatDescription::wrap_under_get_rule(description.as_concrete_TypeRef()) };
        let Some(format) = audio.get_stream_basic_description() else { return; };
        let Some(mut block) = sample.get_data_buffer() else { return; };
        let Ok(bytes) = block.get_data(0) else { return; };
        let channels = format.mChannelsPerFrame.max(1) as usize;
        let bytes_per_frame = format.mBytesPerFrame as usize;
        let bytes_per_sample = (format.mBitsPerChannel / 8) as usize;
        if bytes_per_frame == 0 || bytes_per_sample == 0 || bytes_per_frame < bytes_per_sample * channels { return; }
        let is_float = format.mFormatFlags & 1 != 0;
        let rate = format.mSampleRate;
        if rate <= 0.0 { return; }
        for frame in bytes.chunks_exact(bytes_per_frame) {
            let mut mono = 0.0_f32;
            for channel in 0..channels {
                let start = channel * bytes_per_sample;
                let value = if is_float && bytes_per_sample == 4 {
                    f32::from_ne_bytes(frame[start..start + 4].try_into().unwrap_or([0; 4]))
                } else if !is_float && bytes_per_sample == 2 {
                    i16::from_ne_bytes(frame[start..start + 2].try_into().unwrap_or([0; 2])) as f32 / 32768.0
                } else { return; };
                mono += value / channels as f32;
            }
            self.phase += TARGET_RATE as f64 / rate;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
                self.samples.push((mono.clamp(-1.0, 1.0) * 32767.0).round() as i16);
            }
        }
    }
}

struct AudioOutputIvars { audio: Arc<Mutex<AudioData>> }
define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = AudioOutputIvars]
    struct AudioOutput;
    unsafe impl NSObjectProtocol for AudioOutput {}
    unsafe impl SCStreamOutput for AudioOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn stream_did_output_sample_buffer(&self, _stream: &SCStream, sample_buffer: CMSampleBufferRef, _of_type: SCStreamOutputType) {
            if let Ok(mut audio) = self.ivars().audio.lock() { audio.append(sample_buffer); }
        }
    }
    unsafe impl SCStreamDelegate for AudioOutput {}
);

impl AudioOutput {
    fn new(audio: Arc<Mutex<AudioData>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(AudioOutputIvars { audio });
        unsafe { msg_send![super(this), init] }
    }
}

struct CaptureObjects { stream: Retained<SCStream>, _system_output: Retained<AudioOutput>, _microphone_output: Retained<AudioOutput> }
// ScreenCaptureKit streams and their NSObject output objects are designed to
// receive and stop capture across dispatch queues; the output state is mutex protected.
unsafe impl Send for CaptureObjects {}

struct ActiveRecording {
    capture: CaptureObjects,
    system_audio: Arc<Mutex<AudioData>>,
    microphone: Arc<Mutex<AudioData>>,
    id: String,
    path: PathBuf,
    started: Instant,
    started_at: String,
}

static ACTIVE: OnceLock<Mutex<Option<ActiveRecording>>> = OnceLock::new();
fn active() -> &'static Mutex<Option<ActiveRecording>> { ACTIVE.get_or_init(|| Mutex::new(None)) }
static RECORDINGS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
fn recordings() -> &'static Mutex<HashMap<String, PathBuf>> { RECORDINGS.get_or_init(|| Mutex::new(HashMap::new())) }

#[tauri::command]
pub fn start_meeting_recording(app: tauri::AppHandle) -> Result<RecordingInfo, String> {
    let mut slot = active().lock().map_err(|_| "Recorder is unavailable.".to_string())?;
    if slot.is_some() { return Err("A recording is already in progress.".into()); }

    let system_audio = Arc::new(Mutex::new(AudioData::default()));
    let microphone = Arc::new(Mutex::new(AudioData::default()));
    let id = Uuid::new_v4().to_string();
    let started_at = chrono_now();
    let mut path = app.path().app_data_dir().map_err(|e| format!("Could not locate app data folder: {e}"))?;
    path.push("recordings");
    fs::create_dir_all(&path).map_err(|e| format!("Could not create recordings folder: {e}"))?;
    path.push(format!("{id}.wav"));

    let (content_tx, content_rx) = std::sync::mpsc::channel();
    SCShareableContent::get_shareable_content_with_completion_closure(move |content, error| {
        let result = content.map(|content| Retained::into_raw(content) as usize)
            .ok_or_else(|| error.map(|e| capture_error(e.code())).unwrap_or_else(|| "No shareable display was returned.".into()));
        let _ = content_tx.send(result);
    });
    let content_ptr = content_rx.recv_timeout(std::time::Duration::from_secs(20))
        .map_err(|_| "macOS did not return screen-capture permission in time. Check Screen & System Audio Recording in System Settings.".to_string())??;
    let content = unsafe { Retained::from_raw(content_ptr as *mut SCShareableContent) }.ok_or("macOS returned no screen content.")?;
    let display = content.displays().firstObject().ok_or("No display is available for audio capture.")?;
    let empty_windows = NSArray::<SCWindow>::new();
    let filter = SCContentFilter::init_with_display_exclude_windows(SCContentFilter::alloc(), &display, &empty_windows);
    let config = SCStreamConfiguration::new();
    config.set_width(2);
    config.set_height(2);
    config.set_captures_audio(true);
    config.set_sample_rate(48_000.0);
    config.set_channel_count(2);
    config.set_excludes_current_process_audio(true);
    // ScreenCaptureKit added microphone input capture in macOS 15.
    unsafe { let _: () = msg_send![&config, setCaptureMicrophone: true]; }

    let system_output = AudioOutput::new(Arc::clone(&system_audio));
    let microphone_output = AudioOutput::new(Arc::clone(&microphone));
    let delegate_protocol: &ProtocolObject<dyn SCStreamDelegate> = ProtocolObject::from_ref(&*system_output);
    let stream = SCStream::init_with_filter(SCStream::alloc(), &filter, &config, delegate_protocol);
    let queue = DispatchQueue::new("com.local.meeting-notes.capture", None);
    let system_protocol: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*system_output);
    stream.add_stream_output(system_protocol, SCStreamOutputType::Audio, &queue)
        .map_err(|e| format!("Could not attach system audio capture: {}", e.code()))?;
    let microphone_protocol: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*microphone_output);
    stream.add_stream_output(microphone_protocol, SCStreamOutputType(2), &queue)
        .map_err(|e| format!("Could not attach microphone capture: {}", e.code()))?;
    let (start_tx, start_rx) = std::sync::mpsc::channel();
    stream.start_capture(move |error| { let _ = start_tx.send(error.map(|e| e.code())); });
    match start_rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(None) => {}
        Ok(Some(code)) => return Err(format!("macOS could not start audio capture. {}", capture_error(code))),
        Err(_) => return Err("macOS did not start audio capture in time. Check Screen Recording and Microphone permissions.".into()),
    }

    let capture = CaptureObjects { stream, _system_output: system_output, _microphone_output: microphone_output };
    *slot = Some(ActiveRecording { capture, system_audio, microphone, id: id.clone(), path: path.clone(), started: Instant::now(), started_at: started_at.clone() });
    Ok(RecordingInfo { id, audio_path: path.to_string_lossy().into_owned(), duration_seconds: 0, started_at })
}

#[tauri::command]
pub fn stop_meeting_recording() -> Result<RecordingInfo, String> {
    let recording = active().lock().map_err(|_| "Recorder is unavailable.".to_string())?.take().ok_or("No recording is in progress.")?;
    let (stop_tx, stop_rx) = std::sync::mpsc::channel();
    recording.capture.stream.stop_capture(move |error| { let _ = stop_tx.send(error.map(|e| e.code())); });
    match stop_rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(None) => {}
        Ok(Some(code)) => return Err(format!("Could not stop audio capture (error {code}).")),
        Err(_) => return Err("Audio capture did not stop in time.".into()),
    }
    let system = recording.system_audio.lock().map_err(|_| "System audio buffer is unavailable.")?;
    let microphone = recording.microphone.lock().map_err(|_| "Microphone buffer is unavailable.")?;
    let count = system.samples.len().max(microphone.samples.len());
    if count == 0 { return Err("No audio was captured. Check Screen Recording and Microphone permissions, then try again.".into()); }
    let spec = WavSpec { channels: 1, sample_rate: TARGET_RATE, bits_per_sample: 16, sample_format: SampleFormat::Int };
    let mut writer = WavWriter::create(&recording.path, spec).map_err(|e| format!("Could not save recording: {e}"))?;
    for i in 0..count {
        let remote = system.samples.get(i).copied();
        let local = microphone.samples.get(i).copied();
        let value = match (remote, local) {
            (Some(a), Some(b)) => ((i32::from(a) + i32::from(b)) / 2) as i16,
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => 0,
        };
        writer.write_sample(value).map_err(|e| format!("Could not write recording: {e}"))?;
    }
    writer.finalize().map_err(|e| format!("Could not finish recording: {e}"))?;
    recordings().lock().map_err(|_| "Recording index is unavailable.".to_string())?.insert(recording.id.clone(), recording.path.clone());
    Ok(RecordingInfo { id: recording.id, audio_path: recording.path.to_string_lossy().into_owned(), duration_seconds: recording.started.elapsed().as_secs(), started_at: recording.started_at })
}

#[tauri::command]
pub fn delete_meeting_recording(app: tauri::AppHandle, recording_id: String) -> Result<(), String> {
    Uuid::parse_str(&recording_id).map_err(|_| "Invalid meeting recording identifier.".to_string())?;
    let path = recordings().lock()
        .map_err(|_| "Recording index is unavailable.".to_string())?
        .remove(&recording_id)
        .or_else(|| app.path().app_data_dir().ok().map(|dir| dir.join("recordings").join(format!("{recording_id}.wav"))));
    if let Some(path) = path {
        match fs::remove_file(&path) {
            Ok(()) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(format!("Could not delete the local audio recording: {e}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn process_meeting_audio(
    recording_id: String,
    transcription_config: ProviderConfig,
    analysis_config: ProviderConfig,
) -> Result<ProcessedMeeting, String> {
    validate_config(&transcription_config)?;
    validate_config(&analysis_config)?;
    let audio_path = recordings().lock().map_err(|_| "Recording index is unavailable.".to_string())?.get(&recording_id).cloned().ok_or("This audio was not recorded by Meeting Notes. Start a new recording first.")?;
    let bytes = fs::read(&audio_path).map_err(|e| format!("Could not read captured audio: {e}"))?;
    let mut reader = hound::WavReader::new(Cursor::new(bytes)).map_err(|e| format!("Captured audio is invalid: {e}"))?;
    let samples: Vec<i16> = reader.samples::<i16>().filter_map(Result::ok).collect();
    if samples.is_empty() { return Err("The recording did not contain readable audio.".into()); }
    let client = Client::builder().timeout(std::time::Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let diarize = transcription_config.provider == "openrouter" && transcription_config.model == "microsoft/mai-transcribe-2";
    // The diarization model is efficient on longer audio and benefits from
    // fewer boundaries where provider-local speaker IDs can reset.
    let chunk_seconds = if diarize { TRANSCRIBE_CHUNK_SECONDS } else if transcription_config.provider == "openrouter" { 60 } else { TRANSCRIBE_CHUNK_SECONDS };
    let chunk_size = TARGET_RATE as usize * chunk_seconds;
    let mut transcript_parts = Vec::new();
    let mut segments = Vec::new();
    for (index, chunk) in samples.chunks(chunk_size).enumerate() {
        let wav = wav_bytes(chunk)?;
        let offset_ms = (index * chunk_seconds * 1000) as u64;
        let (part, mut chunk_segments) = transcribe_chunk(&client, &transcription_config, wav, diarize).await?;
        if !part.trim().is_empty() { transcript_parts.push(part.trim().to_string()); }
        for segment in &mut chunk_segments {
            segment.start_ms += offset_ms;
            segment.end_ms += offset_ms;
        }
        segments.extend(chunk_segments);
        log::info!("Transcribed audio chunk {}", index + 1);
    }
    let transcript = if diarize {
        segments.iter().map(|s| format!("{}: {}", s.speaker_id.as_deref().unwrap_or("Speaker"), s.text)).collect::<Vec<_>>().join("\n")
    } else { transcript_parts.join("\n\n") };
    if transcript.trim().is_empty() { return Err("The transcription provider returned an empty transcript.".into()); }
    if segments.is_empty() {
        segments.push(TranscriptPart { start_ms: 0, end_ms: (samples.len() as u64 * 1000) / u64::from(TARGET_RATE), speaker_id: None, text: transcript.clone() });
    }
    let speaker_count = segments.iter().filter_map(|s| s.speaker_id.as_ref()).collect::<std::collections::HashSet<_>>().len();
    let notes = create_notes(&client, &analysis_config, &transcript).await?;
    Ok(ProcessedMeeting { transcript, segments, speaker_count, notes })
}

fn wav_bytes(samples: &[i16]) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let spec = WavSpec { channels: 1, sample_rate: TARGET_RATE, bits_per_sample: 16, sample_format: SampleFormat::Int };
        let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
        for sample in samples { writer.write_sample(*sample).map_err(|e| e.to_string())?; }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

fn token_for(config: &ProviderConfig, role: &str, optional: bool) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYRING_SERVICE, &format!("{role}:{}", config.provider)).map_err(|_| "macOS Keychain is unavailable.".to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) if optional => Ok(None),
        Err(keyring::Error::NoEntry) => Err(format!("Paste an API token for {} in Settings first.", config.provider)),
        Err(_) => Err("Could not read the API token from macOS Keychain.".into()),
    }
}

fn validate_config(config: &ProviderConfig) -> Result<(), String> {
    if config.model.trim().is_empty() || config.model.len() > 200 {
        return Err("Enter a model name in Settings before processing this meeting.".into());
    }
    let endpoint = url::Url::parse(&config.endpoint).map_err(|_| "Enter a valid provider API endpoint in Settings.")?;
    let local_http = config.provider == "ollama" && endpoint.scheme() == "http"
        && matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if (endpoint.scheme() != "https" && !local_http) || !endpoint.username().is_empty() || endpoint.password().is_some() || endpoint.query().is_some() || endpoint.fragment().is_some() {
        return Err("Provider endpoints must use HTTPS. Only local Ollama may use HTTP, at localhost.".into());
    }
    Ok(())
}

async fn transcribe_chunk(client: &Client, config: &ProviderConfig, wav: Vec<u8>, diarize: bool) -> Result<(String, Vec<TranscriptPart>), String> {
    let key = token_for(config, "transcription", config.provider == "ollama")?;
    if config.provider == "gemini" {
        let key = key.ok_or("Paste a Google Gemini API token in Settings first.")?;
        let endpoint = format!("{}/v1beta/models/{}:generateContent", config.endpoint.trim_end_matches('/'), config.model);
        let response = client.post(endpoint).header("x-goog-api-key", key)
            .json(&serde_json::json!({"contents":[{"parts":[{"text":"Transcribe this meeting audio verbatim. Return only the spoken words."},{"inline_data":{"mime_type":"audio/wav","data":BASE64.encode(&wav)}}]}]}))
            .send().await.map_err(|e| format!("Gemini transcription request failed: {e}"))?;
        let value = checked_json(response).await?;
        let text = value["candidates"][0]["content"]["parts"][0]["text"].as_str().map(str::to_owned).ok_or_else(|| "Gemini returned no transcript.".to_string())?;
        let duration = (wav.len() as u64 * 1000) / (TARGET_RATE as u64 * 2);
        return Ok((text.clone(), vec![TranscriptPart { start_ms: 0, end_ms: duration, speaker_id: None, text }]));
    }
    if !matches!(config.provider.as_str(), "openai" | "openrouter" | "custom" | "ollama") {
        return Err("This transcription provider is not supported yet. Choose OpenAI, OpenRouter, Gemini, Ollama, or a custom OpenAI-compatible endpoint.".into());
    }
    let endpoint = format!("{}/audio/transcriptions", config.endpoint.trim_end_matches('/'));
    let mut request = client.post(endpoint);
    if config.provider == "openrouter" && diarize {
        request = request.json(&serde_json::json!({
            "model": config.model,
            "input_audio": { "data": BASE64.encode(&wav), "format": "wav" },
            "response_format": "verbose_json",
            "timestamp_granularities": ["segment"],
            "provider": { "options": { "azure": { "diarization": { "enabled": true } } } }
        }));
    } else {
        let file = multipart::Part::bytes(wav).file_name("meeting.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
        let form = multipart::Form::new().part("file", file).text("model", config.model.clone()).text("response_format", "json");
        request = request.multipart(form);
    }
    if let Some(key) = key { request = request.bearer_auth(key); }
    let value = checked_json(request.send().await.map_err(|e| format!("Transcription request failed: {e}"))?).await?;
    let text = value["text"].as_str().map(str::to_owned).ok_or_else(|| "Transcription provider returned no text.".to_string())?;
    let segments = value["segments"].as_array().map(|items| items.iter().filter_map(|item| {
        let text = item["text"].as_str()?.to_string();
        let start_ms = (item["start"].as_f64()? * 1000.0).max(0.0) as u64;
        let end_ms = (item["end"].as_f64()? * 1000.0).max(0.0) as u64;
        let speaker_id = item.get("speaker").filter(|v| !v.is_null()).map(|v| {
            let raw = v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string());
            if raw.starts_with("speaker") { raw } else { format!("Speaker {}", raw.parse::<usize>().map(|n| n + 1).unwrap_or(1)) }
        });
        Some(TranscriptPart { start_ms, end_ms, speaker_id, text })
    }).collect::<Vec<_>>()).unwrap_or_default();
    Ok((text, segments))
}

async fn create_notes(client: &Client, config: &ProviderConfig, transcript: &str) -> Result<MeetingNotes, String> {
    let key = token_for(config, "analysis", config.provider == "ollama")?;
    let instruction = format!("Create accurate meeting notes from this transcript. Do not invent facts, participants, owners, or dates. Return only a JSON object with keys summary (string), objective (string), participants (string array), decisions (string array), action_items (array of objects with task, owner (string or null), due_date (string or null), priority (low|normal|high|urgent)), risks (string array), next_steps (string array). Transcript:\n{}", transcript);
    let text = if config.provider == "gemini" {
        let key = key.ok_or("Paste a Google Gemini API token in Settings first.")?;
        let endpoint = format!("{}/v1beta/models/{}:generateContent", config.endpoint.trim_end_matches('/'), config.model);
        let response = client.post(endpoint).header("x-goog-api-key", key)
            .json(&serde_json::json!({"contents":[{"parts":[{"text":instruction}]}],"generationConfig":{"responseMimeType":"application/json"}}))
            .send().await.map_err(|e| format!("Gemini notes request failed: {e}"))?;
        let value = checked_json(response).await?;
        value["candidates"][0]["content"]["parts"][0]["text"].as_str().map(str::to_owned).ok_or("Gemini returned no meeting notes.".to_string())?
    } else if matches!(config.provider.as_str(), "openai" | "openrouter" | "custom" | "ollama") {
        let endpoint = format!("{}/chat/completions", config.endpoint.trim_end_matches('/'));
        let mut request = client.post(endpoint).json(&serde_json::json!({"model":config.model,"messages":[{"role":"system","content":"Return only valid JSON matching the requested schema. Ground every item in the transcript."},{"role":"user","content":instruction}],"temperature":0.2}));
        if let Some(key) = key { request = request.bearer_auth(key); }
        let value = checked_json(request.send().await.map_err(|e| format!("Meeting notes request failed: {e}"))?).await?;
        value["choices"][0]["message"]["content"].as_str().map(str::to_owned).ok_or("Analysis provider returned no meeting notes.".to_string())?
    } else {
        return Err("This analysis provider is not supported yet. Choose OpenAI, Gemini, OpenRouter, Ollama, or a custom OpenAI-compatible endpoint.".into());
    };
    let json = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let json = if json.starts_with('{') { json.to_string() } else {
        let start = json.find('{').ok_or("AI notes response did not contain JSON.")?;
        let end = json.rfind('}').ok_or("AI notes response did not contain complete JSON.")?;
        json[start..=end].to_string()
    };
    serde_json::from_str(&json).map_err(|e| format!("Could not read structured meeting notes: {e}"))
}

async fn checked_json(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response.text().await.map_err(|e| format!("Could not read provider response: {e}"))?;
    if !status.is_success() {
        let detail = body.chars().take(300).collect::<String>();
        return Err(format!("AI provider returned HTTP {}: {}", status.as_u16(), detail));
    }
    serde_json::from_str(&body).map_err(|e| format!("AI provider returned invalid JSON: {e}"))
}

fn chrono_now() -> String {
    chrono::Utc::now().to_rfc3339()
}
