use keyring::Entry;
use std::process::Command;
use tauri::Manager;

mod audio_ai;

const KEYRING_SERVICE: &str = "com.local.meeting-notes";

fn provider_entry(role: &str, provider: &str) -> Result<Entry, String> {
    let valid_role = matches!(role, "analysis" | "transcription");
    let valid_provider = matches!(provider, "openai" | "gemini" | "openrouter" | "ollama" | "custom");
    if !valid_role || !valid_provider {
        return Err("Unsupported provider credential.".into());
    }
    Entry::new(KEYRING_SERVICE, &format!("{role}:{provider}"))
        .map_err(|_| "macOS Keychain could not be opened.".to_string())
}

#[tauri::command]
fn save_provider_token(role: String, provider: String, token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() || token.len() > 16_384 {
        return Err("Enter a valid provider token.".into());
    }
    provider_entry(&role, &provider)?
        .set_password(token)
        .map_err(|_| "The token could not be saved to macOS Keychain.".to_string())
}

#[tauri::command]
fn has_provider_token(role: String, provider: String) -> Result<bool, String> {
    match provider_entry(&role, &provider)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("macOS Keychain could not read this provider token.".into()),
    }
}

#[tauri::command]
fn delete_provider_token(role: String, provider: String) -> Result<(), String> {
    match provider_entry(&role, &provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("The provider token could not be removed from macOS Keychain.".into()),
    }
}

fn checked_meet_url(meeting_url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(meeting_url).map_err(|_| "Enter a valid Google Meet link.".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("meet.google.com") {
        return Err("Use a link hosted at https://meet.google.com.".into());
    }
    Ok(parsed)
}

#[tauri::command]
fn open_google_meet(meeting_url: String) -> Result<(), String> {
    let parsed = checked_meet_url(&meeting_url)?;
    Command::new("open")
        .arg(parsed.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|_| "Google Meet could not be opened in your browser.".to_string())
}

#[tauri::command]
fn open_meet_participant(app: tauri::AppHandle, meeting_url: String) -> Result<(), String> {
    let parsed = checked_meet_url(&meeting_url)?;
    let mut profile = app.path().app_data_dir().map_err(|e| format!("Could not locate app data folder: {e}"))?;
    profile.push("meet-participant-chrome");
    std::fs::create_dir_all(&profile).map_err(|e| format!("Could not create the participant browser profile: {e}"))?;
    Command::new("open")
        .args(["-n", "-a", "Google Chrome", "--args"])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--new-window")
        .arg(parsed.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|_| "Could not open Google Chrome. Install Chrome to use the separate participant window.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![tauri_plugin_sql::Migration {
        version: 1,
        description: "create_local_meeting_library",
        sql: include_str!("../migrations/001_initial.sql"),
        kind: tauri_plugin_sql::MigrationKind::Up,
    }, tauri_plugin_sql::Migration {
        version: 2,
        description: "store_action_completion_notes",
        sql: include_str!("../migrations/002_action_completion_notes.sql"),
        kind: tauri_plugin_sql::MigrationKind::Up,
    }];
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default()
            .add_migrations("sqlite:meetings.db", migrations)
            .build())
        .invoke_handler(tauri::generate_handler![
            save_provider_token,
            has_provider_token,
            delete_provider_token,
            open_google_meet,
            open_meet_participant,
            audio_ai::start_meeting_recording,
            audio_ai::stop_meeting_recording,
            audio_ai::delete_meeting_recording,
            audio_ai::process_meeting_audio
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Meeting Assistant");
}
