use std::{
    env,
    fs,
    fs::OpenOptions,
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::models::{LectureSession, SessionStatus, TranscriptSegment, TranscriptionModelInfo};

const SESSIONS_FILE_NAME: &str = "sessions.json";
const SESSIONS_DIR_NAME: &str = "sessions";
const SESSION_METADATA_FILE_NAME: &str = "session.json";
const CONCAT_INPUTS_FILE_NAME: &str = "concat-inputs.txt";
const NORMALIZED_AUDIO_FILE_NAME: &str = "normalized.wav";
const PROCESSED_TRANSCRIPT_FILE_NAME: &str = "transcript.txt";
const POLISHED_TRANSCRIPT_FILE_NAME: &str = "transcript-polished.txt";
const TRANSCRIPT_JSON_FILE_NAME: &str = "transcript.json";
const LIVE_PREVIEW_AUDIO_FILE_NAME: &str = "live-preview.wav";
const LIVE_TRANSCRIPT_JSON_FILE_NAME: &str = "live-transcript.json";
const WAV_HEADER_LEN: u64 = 44;
const DEFAULT_WHISPER_MODEL_FILE_NAMES: [&str; 8] = [
    "ggml-large-v3-turbo.bin",
    "ggml-small.bin",
    "ggml-base.bin",
    "ggml-tiny.bin",
    "ggml-base.en.bin",
    "ggml-small.en.bin",
    "ggml-tiny.en.bin",
    "ggml-large-v3-turbo-q5_0.bin",
];

fn ensure_parent_dir(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("The sessions path must have a parent directory.")?;
    fs::create_dir_all(parent).context("Failed to create the application data directory.")?;
    Ok(())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf> {
    app
        .path()
        .app_local_data_dir()
        .context("Failed to resolve the local app data directory.")
}

pub fn sessions_file_path(app: &AppHandle) -> Result<PathBuf> {
    let base_dir = app_data_dir(app)?;

    Ok(base_dir.join(SESSIONS_FILE_NAME))
}

fn sessions_root_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app_data_dir(app)?.join(SESSIONS_DIR_NAME))
}

pub fn session_dir_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(sessions_root_dir(app)?.join(session_id))
}

fn session_metadata_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?.join(SESSION_METADATA_FILE_NAME))
}

fn processed_transcript_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(PROCESSED_TRANSCRIPT_FILE_NAME))
}

fn polished_transcript_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(POLISHED_TRANSCRIPT_FILE_NAME))
}

fn live_preview_audio_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(LIVE_PREVIEW_AUDIO_FILE_NAME))
}

fn normalized_audio_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(NORMALIZED_AUDIO_FILE_NAME))
}

fn transcript_json_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(TRANSCRIPT_JSON_FILE_NAME))
}

fn live_transcript_json_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(LIVE_TRANSCRIPT_JSON_FILE_NAME))
}

fn concat_inputs_path(app: &AppHandle, session_id: &str) -> Result<PathBuf> {
    Ok(session_dir_path(app, session_id)?
        .join("processed")
        .join(CONCAT_INPUTS_FILE_NAME))
}

pub fn ensure_session_paths(app: &AppHandle, session: &mut LectureSession) -> Result<bool> {
    let session_dir = session_dir_path(app, &session.id)?;
    let normalized_audio = normalized_audio_path(app, &session.id)?;
    let processed_path = processed_transcript_path(app, &session.id)?;
    let polished_path = polished_transcript_path(app, &session.id)?;
    let live_preview_audio = live_preview_audio_path(app, &session.id)?;

    fs::create_dir_all(session_dir.join("audio"))
        .context("Failed to create the session audio directory.")?;
    fs::create_dir_all(session_dir.join("processed"))
        .context("Failed to create the session processed directory.")?;

    let mut changed = false;

    let session_dir_value = session_dir.display().to_string();
    if session.session_dir.as_deref() != Some(session_dir_value.as_str()) {
        session.session_dir = Some(session_dir_value);
        changed = true;
    }

    let processed_value = processed_path.display().to_string();
    if session.processed_transcript_path.as_deref() != Some(processed_value.as_str()) {
        session.processed_transcript_path = Some(processed_value);
        changed = true;
    }

    let polished_value = polished_path.display().to_string();
    if session.polished_transcript_path.as_deref() != Some(polished_value.as_str()) {
        session.polished_transcript_path = Some(polished_value);
        changed = true;
    }

    let normalized_audio_value = normalized_audio.display().to_string();
    if session.normalized_audio_path.as_deref() != Some(normalized_audio_value.as_str()) {
        session.normalized_audio_path = Some(normalized_audio_value);
        changed = true;
    }

    let live_preview_audio_value = live_preview_audio.display().to_string();
    if session.live_preview_audio_path.as_deref() != Some(live_preview_audio_value.as_str()) {
        session.live_preview_audio_path = Some(live_preview_audio_value);
        changed = true;
    }

    Ok(changed)
}

fn quote_concat_path(path: &str) -> String {
    path.replace('\'', "'\\''")
}

fn current_target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        "unsupported-target"
    }
}

fn resolve_ffmpeg_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = env::var("LECLOG_FFMPEG_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }

    let target_triple = current_target_triple();
    let local_sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("ffmpeg-{target_triple}"));
    if local_sidecar.exists() {
        return local_sidecar;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join(format!("ffmpeg-{target_triple}")),
            resource_dir
                .join("binaries")
                .join(format!("ffmpeg-{target_triple}")),
        ] {
            if candidate.exists() {
                return candidate;
            }
        }
    }

    PathBuf::from("ffmpeg")
}

fn resolve_whisper_cli_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = env::var("LECLOG_WHISPER_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }

    let target_triple = current_target_triple();
    let local_sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("whisper-cli-{target_triple}"));
    if local_sidecar.exists() {
        return local_sidecar;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join(format!("whisper-cli-{target_triple}")),
            resource_dir
                .join("binaries")
                .join(format!("whisper-cli-{target_triple}")),
        ] {
            if candidate.exists() {
                return candidate;
            }
        }
    }

    for candidate in [
        PathBuf::from("/opt/homebrew/bin/whisper-cli"),
        PathBuf::from("/usr/local/bin/whisper-cli"),
    ] {
        if candidate.exists() {
            return candidate;
        }
    }

    PathBuf::from("whisper-cli")
}

fn resolve_whisper_model_path(app: &AppHandle, preferred_model_id: Option<&str>) -> Option<PathBuf> {
    if let Ok(path) = env::var("LECLOG_WHISPER_MODEL_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Some(preferred_model_id) = preferred_model_id {
        let preferred_model_id = preferred_model_id.trim();
        if !preferred_model_id.is_empty() {
            for dir in model_search_dirs(app) {
                let candidate = dir.join(preferred_model_id);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    for dir in model_search_dirs(app) {
        for file_name in DEFAULT_WHISPER_MODEL_FILE_NAMES {
            let candidate = dir.join(file_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

fn model_search_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut search_dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models")];

    if let Ok(data_dir) = app_data_dir(app) {
        search_dirs.push(data_dir.join("models"));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        search_dirs.push(resource_dir.join("models"));
        search_dirs.push(resource_dir);
    }

    search_dirs
}

fn run_ffmpeg(app: &AppHandle, args: &[&str]) -> Result<()> {
    let ffmpeg_path = resolve_ffmpeg_path(app);
    let output = Command::new(&ffmpeg_path)
        .args(args)
        .output()
        .with_context(|| format!("Failed to launch ffmpeg at {}.", ffmpeg_path.display()))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!("ffmpeg failed: {}", stderr.trim());
}

fn run_whisper_cli(app: &AppHandle, args: &[&str]) -> Result<()> {
    let whisper_cli_path = resolve_whisper_cli_path(app);
    let output = Command::new(&whisper_cli_path)
        .args(args)
        .output()
        .with_context(|| {
            format!(
                "Failed to launch whisper-cli at {}.",
                whisper_cli_path.display()
            )
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!("whisper-cli failed: {}", stderr.trim());
}

fn read_offset_ms(segment: &Value, key: &str) -> Option<u64> {
    segment
        .get("offsets")
        .and_then(|offsets| offsets.get(key))
        .and_then(Value::as_u64)
        .or_else(|| segment.get(key).and_then(Value::as_u64))
}

fn parse_transcript_segments_with_finality(
    raw_json: &str,
    is_final: bool,
    max_end_ms: Option<u64>,
) -> Result<Vec<TranscriptSegment>> {
    let payload: Value =
        serde_json::from_str(raw_json).context("Failed to parse the whisper transcript JSON.")?;
    let items = payload
        .get("transcription")
        .and_then(Value::as_array)
        .or_else(|| payload.get("segments").and_then(Value::as_array))
        .context("The whisper transcript JSON did not contain any segments.")?;

    let mut segments = Vec::new();
    for item in items {
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let text = normalize_transcript_text(text);
        if text.is_empty() {
            continue;
        }

        let start_ms = read_offset_ms(item, "from").unwrap_or(0);
        let end_ms = read_offset_ms(item, "to").unwrap_or(start_ms.saturating_add(1));
        let capped_end_ms = max_end_ms
            .map(|limit| end_ms.min(limit))
            .unwrap_or(end_ms)
            .max(start_ms.saturating_add(1));

        segments.push(TranscriptSegment {
            id: Uuid::new_v4().to_string(),
            start_ms,
            end_ms: capped_end_ms,
            text,
            is_final,
        });
    }

    if segments.is_empty() {
        anyhow::bail!("whisper.cpp completed, but no transcript text was produced.");
    }

    Ok(rewrite_transcript_segments(segments, is_final))
}

fn squeeze_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_punctuation_spacing(value: &str) -> String {
    value
        .replace(" 。", "。")
        .replace(" 、", "、")
        .replace(" ？", "？")
        .replace(" ！", "！")
        .replace(" .", ".")
        .replace(" ,", ",")
        .replace(" ?", "?")
        .replace(" !", "!")
}

fn collapse_repeated_punctuation(value: &str) -> String {
    let mut normalized = value.to_string();
    for (from, to) in [
        ("。。", "。"),
        ("、、", "、"),
        ("？？", "？"),
        ("！！", "！"),
        ("..", "."),
        (",,", ","),
        ("??", "?"),
        ("!!", "!"),
    ] {
        while normalized.contains(from) {
            normalized = normalized.replace(from, to);
        }
    }
    normalized
}

fn has_terminal_punctuation(value: &str) -> bool {
    let trimmed = value.trim_end();
    trimmed.ends_with('。')
        || trimmed.ends_with('！')
        || trimmed.ends_with('？')
        || trimmed.ends_with('.')
        || trimmed.ends_with('!')
        || trimmed.ends_with('?')
}

fn looks_like_question(value: &str) -> bool {
    let trimmed = value.trim_end();
    trimmed.ends_with('か')
        || trimmed.ends_with("ですか")
        || trimmed.ends_with("ますか")
        || trimmed.ends_with("でしょうか")
}

fn normalize_transcript_text(text: &str) -> String {
    let mut normalized = collapse_repeated_punctuation(&normalize_punctuation_spacing(
        &squeeze_whitespace(text),
    ))
    .trim()
    .to_string();
    if normalized.is_empty() {
        return normalized;
    }

    if normalized.ends_with('、') || normalized.ends_with(',') {
        normalized.pop();
        normalized = normalized.trim_end().to_string();
    }

    normalized
}

fn finalize_sentence_text(text: &str, is_final: bool) -> String {
    let mut normalized = normalize_transcript_text(text);
    if normalized.is_empty() {
        return normalized;
    }

    if is_final && !has_terminal_punctuation(&normalized) {
        if looks_like_question(&normalized) {
            normalized.push('？');
        } else {
            normalized.push('。');
        }
    }

    normalized
}

fn merge_transcript_text(left: &str, right: &str) -> String {
    if left.is_empty() {
        return right.to_string();
    }

    if right.is_empty() {
        return left.to_string();
    }

    let right_starts_with_punctuation =
        right.starts_with('、') || right.starts_with('。') || right.starts_with('？') || right.starts_with('！');
    let needs_space = left
        .chars()
        .last()
        .is_some_and(|value| value.is_ascii_alphanumeric())
        && right
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric());

    if right_starts_with_punctuation {
        format!("{left}{right}")
    } else if needs_space {
        format!("{left} {right}")
    } else {
        format!("{left}{right}")
    }
}

fn is_terminal_punctuation(char: char) -> bool {
    matches!(char, '。' | '？' | '！' | '.' | '?' | '!')
}

fn likely_sentence_boundary(text: &str, is_final: bool) -> bool {
    if has_terminal_punctuation(text) {
        return true;
    }

    if !is_final {
        return false;
    }

    let trimmed = text.trim_end_matches(['、', ',', ' ']);
    let char_len = trimmed.chars().count();
    let common_japanese_endings = [
        "です",
        "ます",
        "でした",
        "ました",
        "ません",
        "ください",
        "ましょう",
        "と思います",
        "になります",
        "ということです",
        "なんですね",
        "ですよね",
        "ですね",
        "でしたね",
        "でしょう",
        "でしょうか",
        "ですか",
        "ますか",
    ];

    (char_len >= 8 && common_japanese_endings.iter().any(|ending| trimmed.ends_with(ending)))
        || char_len >= 28
}

fn split_text_into_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut buffer = String::new();

    for char in text.chars() {
        buffer.push(char);
        if is_terminal_punctuation(char) {
            let sentence = buffer.trim();
            if !sentence.is_empty() {
                sentences.push(sentence.to_string());
            }
            buffer.clear();
        }
    }

    let remainder = buffer.trim();
    if !remainder.is_empty() {
        sentences.push(remainder.to_string());
    }

    sentences
}

fn split_segment_into_sentences(segment: TranscriptSegment) -> Vec<TranscriptSegment> {
    let sentences = split_text_into_sentences(&segment.text);
    if sentences.len() <= 1 {
        return vec![segment];
    }

    let sentence_count = sentences.len();
    let total_chars = sentences
        .iter()
        .map(|sentence| sentence.chars().count().max(1))
        .sum::<usize>()
        .max(1) as u64;
    let total_duration = segment.end_ms.saturating_sub(segment.start_ms).max(1);

    let mut cursor = segment.start_ms;
    let mut consumed_chars = 0u64;
    let mut rewritten = Vec::new();

    for (index, sentence) in sentences.into_iter().enumerate() {
        let sentence_chars = sentence.chars().count().max(1) as u64;
        consumed_chars = consumed_chars.saturating_add(sentence_chars);
        let end_ms = if index == 0 && sentence_chars == total_chars {
            segment.end_ms
        } else if index + 1 == sentence_count {
            segment.end_ms
        } else if consumed_chars >= total_chars {
            segment.end_ms
        } else {
            segment.start_ms + total_duration.saturating_mul(consumed_chars) / total_chars
        }
        .max(cursor.saturating_add(1))
        .min(segment.end_ms);

        rewritten.push(TranscriptSegment {
            id: Uuid::new_v4().to_string(),
            start_ms: cursor,
            end_ms,
            text: sentence,
            is_final: segment.is_final,
        });

        cursor = end_ms;
    }

    if let Some(last) = rewritten.last_mut() {
        last.end_ms = segment.end_ms.max(last.start_ms.saturating_add(1));
    }

    rewritten
}

fn should_insert_space_between_sentences(left: &str, right: &str) -> bool {
    left.chars()
        .last()
        .is_some_and(|value| value.is_ascii_alphanumeric())
        && right
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_alphanumeric())
}

pub fn polish_transcript_text(segments: &[TranscriptSegment]) -> String {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current_paragraph = String::new();
    let mut current_sentence_count = 0usize;
    let mut last_end_ms: Option<u64> = None;
    let mut last_text: Option<String> = None;

    for segment in segments {
        let sentence = finalize_sentence_text(&segment.text, true);
        if sentence.is_empty() {
            continue;
        }

        if last_text.as_deref() == Some(sentence.as_str()) {
            last_end_ms = Some(segment.end_ms);
            continue;
        }

        let gap_ms = last_end_ms
            .map(|end_ms| segment.start_ms.saturating_sub(end_ms))
            .unwrap_or(0);
        let paragraph_char_len = current_paragraph.chars().count();
        let paragraph_break = !current_paragraph.is_empty()
            && (gap_ms >= 3200
                || (current_sentence_count >= 4 && paragraph_char_len >= 70)
                || (gap_ms >= 1800 && sentence.ends_with('？')));

        if paragraph_break {
            paragraphs.push(current_paragraph.trim().to_string());
            current_paragraph.clear();
            current_sentence_count = 0;
        }

        if current_paragraph.is_empty() {
            current_paragraph.push_str(&sentence);
        } else if should_insert_space_between_sentences(&current_paragraph, &sentence) {
            current_paragraph.push(' ');
            current_paragraph.push_str(&sentence);
        } else {
            current_paragraph.push_str(&sentence);
        }

        current_sentence_count += 1;
        last_end_ms = Some(segment.end_ms);
        last_text = Some(sentence);
    }

    if !current_paragraph.trim().is_empty() {
        paragraphs.push(current_paragraph.trim().to_string());
    }

    paragraphs.join("\n\n")
}

fn rewrite_transcript_segments(
    segments: Vec<TranscriptSegment>,
    is_final: bool,
) -> Vec<TranscriptSegment> {
    let mut rewritten = Vec::new();
    let mut active: Option<TranscriptSegment> = None;

    for segment in segments {
        if let Some(current) = active.as_mut() {
            current.text = merge_transcript_text(&current.text, &segment.text);
            current.end_ms = segment.end_ms;
            current.is_final = segment.is_final;

            if likely_sentence_boundary(&current.text, is_final) {
                let finalized = TranscriptSegment {
                    id: Uuid::new_v4().to_string(),
                    start_ms: current.start_ms,
                    end_ms: current.end_ms,
                    text: finalize_sentence_text(&current.text, is_final),
                    is_final: segment.is_final,
                };
                rewritten.extend(split_segment_into_sentences(finalized));
                active = None;
            }
            continue;
        }

        let mut next = segment;
        next.text = normalize_transcript_text(&next.text);
        if next.text.is_empty() {
            continue;
        }

        if likely_sentence_boundary(&next.text, is_final) {
            next.text = finalize_sentence_text(&next.text, is_final);
            rewritten.extend(split_segment_into_sentences(next));
        } else {
            active = Some(next);
        }
    }

    if let Some(mut remainder) = active {
        remainder.text = finalize_sentence_text(&remainder.text, is_final);
        rewritten.extend(split_segment_into_sentences(remainder));
    }

    rewritten
}

pub fn start_audio_segment(
    app: &AppHandle,
    session: &mut LectureSession,
    extension: &str,
    mime_type: &str,
) -> Result<()> {
    ensure_session_paths(app, session)?;

    let segment_index = session.audio_file_paths.len() + 1;
    let segment_path = session_dir_path(app, &session.id)?
        .join("audio")
        .join(format!(
            "segment-{segment_index:03}.{}",
            extension.trim_start_matches('.')
        ));

    ensure_parent_dir(&segment_path)?;
    fs::write(&segment_path, []).context("Failed to initialize the audio segment file.")?;

    let path_value = segment_path.display().to_string();
    session.active_audio_file_path = Some(path_value.clone());
    session.audio_file_paths.push(path_value);
    session.audio_mime_type = Some(mime_type.to_string());

    Ok(())
}

pub fn append_audio_chunk(session: &LectureSession, chunk: &[u8]) -> Result<()> {
    let path = session
        .active_audio_file_path
        .as_ref()
        .map(PathBuf::from)
        .context("There is no active audio segment for this session.")?;
    ensure_parent_dir(&path)?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .context("Failed to open the active audio segment file.")?;
    file.write_all(chunk)
        .context("Failed to append the audio chunk to disk.")?;
    Ok(())
}

pub fn finish_audio_segment(session: &mut LectureSession) {
    session.active_audio_file_path = None;
}

fn sanitize_file_stem(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char == '-' || char == '_' {
                char
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        String::from("imported-media")
    } else {
        sanitized
    }
}

fn guess_media_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "mp3" => Some("audio/mpeg"),
        "m4a" => Some("audio/mp4"),
        "wav" => Some("audio/wav"),
        "aac" => Some("audio/aac"),
        "ogg" | "oga" => Some("audio/ogg"),
        "opus" => Some("audio/opus"),
        "flac" => Some("audio/flac"),
        "webm" => Some("audio/webm"),
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        _ => None,
    }
}

pub fn import_media_file(app: &AppHandle, session: &mut LectureSession, source_path: &Path) -> Result<()> {
    if !source_path.exists() || !source_path.is_file() {
        anyhow::bail!("The dropped file does not exist: {}", source_path.display());
    }

    ensure_session_paths(app, session)?;

    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("media");
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("imported-media");
    let sanitized_stem = sanitize_file_stem(stem);
    let destination_path = session_dir_path(app, &session.id)?
        .join("audio")
        .join(format!("{sanitized_stem}.{}", extension.trim_start_matches('.')));

    ensure_parent_dir(&destination_path)?;
    fs::copy(source_path, &destination_path).with_context(|| {
        format!(
            "Failed to copy the imported media file from {} to {}.",
            source_path.display(),
            destination_path.display()
        )
    })?;

    session.active_audio_file_path = None;
    session.audio_file_paths = vec![destination_path.display().to_string()];
    session.audio_mime_type = guess_media_mime_type(source_path).map(str::to_string);
    session.capture_target_label = Some(
        source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
    );

    Ok(())
}

pub fn rollback_last_audio_segment(session: &mut LectureSession) -> Result<()> {
    let Some(last_path) = session.audio_file_paths.pop() else {
        session.active_audio_file_path = None;
        return Ok(());
    };

    session.active_audio_file_path = None;
    let path = PathBuf::from(last_path);
    if path.exists() {
        fs::remove_file(path).context("Failed to remove the incomplete capture file.")?;
    }
    Ok(())
}

fn persist_session_snapshot(app: &AppHandle, session: &LectureSession) -> Result<()> {
    let path = session_metadata_path(app, &session.id)?;
    ensure_parent_dir(&path)?;

    let payload =
        serde_json::to_string_pretty(session).context("Failed to serialize session metadata.")?;
    fs::write(path, payload).context("Failed to write session metadata.")?;
    Ok(())
}

pub fn load_sessions(app: &AppHandle) -> Result<Vec<LectureSession>> {
    let path = sessions_file_path(app)?;
    ensure_parent_dir(&path)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&path).context("Failed to read sessions.json.")?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }

    let sessions =
        serde_json::from_str::<Vec<LectureSession>>(&raw).context("Failed to parse sessions.json.")?;
    Ok(sessions)
}

pub fn persist_sessions(app: &AppHandle, sessions: &[LectureSession]) -> Result<()> {
    let path = sessions_file_path(app)?;
    ensure_parent_dir(&path)?;

    let payload =
        serde_json::to_string_pretty(sessions).context("Failed to serialize session data.")?;
    fs::write(path, payload).context("Failed to write session data to disk.")?;

    for session in sessions {
        persist_session_snapshot(app, session)?;
    }

    Ok(())
}

pub fn write_processed_transcript(app: &AppHandle, session: &LectureSession) -> Result<()> {
    let path = if let Some(path) = &session.processed_transcript_path {
        PathBuf::from(path)
    } else {
        processed_transcript_path(app, &session.id)?
    };
    ensure_parent_dir(&path)?;

    let mut output = String::new();
    output.push_str(&format!("# {}\n\n", session.title));
    output.push_str(&format!("Status: {:?}\n", session.status));
    output.push_str(&format!("Duration: {} ms\n", session.duration_ms));
    output.push_str(&format!("Capture files: {}\n", session.audio_file_paths.len()));
    if let Some(mime_type) = &session.audio_mime_type {
        output.push_str(&format!("Capture MIME type: {mime_type}\n"));
    }
    if let Some(capture_target_label) = &session.capture_target_label {
        output.push_str(&format!("Capture target: {capture_target_label}\n"));
    }
    if let Some(normalized_audio_path) = &session.normalized_audio_path {
        output.push_str(&format!("Normalized audio: {normalized_audio_path}\n"));
    }
    output.push('\n');

    if let Some(polished_transcript_text) = &session.polished_transcript_text {
        output.push_str("## Polished Transcript\n\n");
        output.push_str(polished_transcript_text.trim());
        output.push_str("\n\n");
    }

    if session.segments.is_empty() {
        output.push_str("No transcript segments were captured for this session.\n");
    } else {
        for segment in &session.segments {
            output.push_str(&format!(
                "[{} - {}] {}\n",
                segment.start_ms, segment.end_ms, segment.text
            ));
        }
    }

    fs::write(path, output).context("Failed to write processed transcript artifact.")?;
    Ok(())
}

pub fn write_polished_transcript(app: &AppHandle, session: &LectureSession) -> Result<()> {
    let polished_text = session
        .polished_transcript_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("No polished transcript text is available for this session.")?;
    let path = if let Some(path) = &session.polished_transcript_path {
        PathBuf::from(path)
    } else {
        polished_transcript_path(app, &session.id)?
    };
    ensure_parent_dir(&path)?;
    fs::write(path, format!("{polished_text}\n"))
        .context("Failed to write polished transcript artifact.")?;
    Ok(())
}

pub fn list_transcription_models(app: &AppHandle) -> Result<Vec<TranscriptionModelInfo>> {
    let recommended_path = resolve_whisper_model_path(app, None);
    let mut models = Vec::new();

    for dir in model_search_dirs(app) {
        if !dir.exists() {
            continue;
        }

        for entry in fs::read_dir(&dir)
            .with_context(|| format!("Failed to read model directory {}.", dir.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !(file_name.starts_with("ggml-")
                && (file_name.ends_with(".bin") || file_name.ends_with(".gguf")))
            {
                continue;
            }

            let metadata = entry.metadata()?;
            models.push(TranscriptionModelInfo {
                id: file_name.to_string(),
                label: file_name
                    .trim_start_matches("ggml-")
                    .trim_end_matches(".bin")
                    .trim_end_matches(".gguf")
                    .replace('-', " "),
                path: path.display().to_string(),
                size_bytes: metadata.len(),
                recommended: recommended_path.as_ref().is_some_and(|value| value == &path),
            });
        }
    }

    models.sort_by(|left, right| right.recommended.cmp(&left.recommended).then(left.id.cmp(&right.id)));
    Ok(models)
}

fn transcribe_audio_path(
    app: &AppHandle,
    audio_path: &Path,
    transcript_json_path: &Path,
    is_final: bool,
    preferred_model_id: Option<&str>,
    language: &str,
    prompt: Option<&str>,
    max_end_ms: Option<u64>,
) -> Result<Vec<TranscriptSegment>> {
    if !audio_path.exists() {
        anyhow::bail!("The audio file does not exist: {}", audio_path.display());
    }
    let model_path = resolve_whisper_model_path(app, preferred_model_id).context(
        "No local Whisper model was found. Set LECLOG_WHISPER_MODEL_PATH or place a ggml model under src-tauri/models or the app local data models directory.",
    )?;

    ensure_parent_dir(&transcript_json_path)?;

    let output_base = transcript_json_path.with_extension("");
    let output_base_str = output_base.to_string_lossy().to_string();
    let audio_path_str = audio_path.to_string_lossy().to_string();
    let model_path_str = model_path.to_string_lossy().to_string();
    let mut args = vec![
        String::from("--language"),
        language.to_string(),
        String::from("--model"),
        model_path_str,
        String::from("--file"),
        audio_path_str,
        String::from("--output-json"),
        String::from("--output-json-full"),
        String::from("--output-file"),
        output_base_str,
        String::from("--no-prints"),
        String::from("--carry-initial-prompt"),
    ];
    if let Some(prompt) = prompt {
        let trimmed_prompt = prompt.trim();
        if !trimmed_prompt.is_empty() {
            args.push(String::from("--prompt"));
            args.push(trimmed_prompt.to_string());
        }
    }
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();

    run_whisper_cli(app, &arg_refs)?;

    let raw_transcript = fs::read(&transcript_json_path).with_context(|| {
        format!(
            "Failed to read the whisper transcript JSON at {}.",
            transcript_json_path.display()
        )
    })?;
    let raw_transcript = String::from_utf8_lossy(&raw_transcript).into_owned();

    parse_transcript_segments_with_finality(&raw_transcript, is_final, max_end_ms)
}

fn resolve_whisper_language(preferred_language: Option<&str>) -> String {
    preferred_language
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            env::var("LECLOG_WHISPER_LANGUAGE")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| String::from("auto"))
}

fn resolve_whisper_prompt(prompt_terms: Option<&str>) -> Option<String> {
    prompt_terms
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            env::var("LECLOG_WHISPER_PROMPT")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

fn wav_duration_ms(path: &Path, sample_rate: u32) -> Result<u64> {
    let file_len = fs::metadata(path)
        .with_context(|| format!("Failed to read WAV metadata at {}.", path.display()))?
        .len();
    if file_len <= WAV_HEADER_LEN {
        return Ok(0);
    }

    let data_bytes = file_len - WAV_HEADER_LEN;
    let bytes_per_second = u64::from(sample_rate) * 2;
    if bytes_per_second == 0 {
        return Ok(0);
    }

    Ok(data_bytes.saturating_mul(1000) / bytes_per_second)
}

pub fn transcribe_normalized_audio(
    app: &AppHandle,
    session: &LectureSession,
    preferred_model_id: Option<&str>,
    preferred_language: Option<&str>,
    prompt_terms: Option<&str>,
) -> Result<Vec<TranscriptSegment>> {
    let normalized_audio_path = session
        .normalized_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a normalized audio file.")?;
    let transcript_json_path = transcript_json_path(app, &session.id)?;
    let language = resolve_whisper_language(preferred_language);
    let prompt = resolve_whisper_prompt(prompt_terms);

    transcribe_audio_path(
        app,
        &normalized_audio_path,
        &transcript_json_path,
        true,
        preferred_model_id,
        &language,
        prompt.as_deref(),
        None,
    )
}

pub fn transcribe_live_preview_audio(
    app: &AppHandle,
    session: &LectureSession,
    preferred_model_id: Option<&str>,
    preferred_language: Option<&str>,
    prompt_terms: Option<&str>,
) -> Result<Vec<TranscriptSegment>> {
    let live_preview_audio_path = session
        .live_preview_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a live preview audio file.")?;
    if !live_preview_audio_path.exists()
        || fs::metadata(&live_preview_audio_path)
            .map(|metadata| metadata.len() <= WAV_HEADER_LEN)
            .unwrap_or(true)
    {
        return Ok(Vec::new());
    }
    let transcript_json_path = live_transcript_json_path(app, &session.id)?;
    let language = resolve_whisper_language(preferred_language);
    let prompt = resolve_whisper_prompt(prompt_terms);
    let sample_rate = session.live_preview_sample_rate.unwrap_or(16_000);
    let max_end_ms = Some(wav_duration_ms(&live_preview_audio_path, sample_rate)?);

    transcribe_audio_path(
        app,
        &live_preview_audio_path,
        &transcript_json_path,
        false,
        preferred_model_id,
        &language,
        prompt.as_deref(),
        max_end_ms,
    )
}

pub fn normalize_audio_for_transcript(app: &AppHandle, session: &LectureSession) -> Result<()> {
    if session.audio_file_paths.is_empty() {
        return Ok(());
    }

    let normalized_audio_path = session
        .normalized_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a normalized audio output path.")?;
    ensure_parent_dir(&normalized_audio_path)?;
    let normalized_audio_str = normalized_audio_path.to_string_lossy().to_string();

    if session.audio_file_paths.len() == 1 {
        run_ffmpeg(
            app,
            &[
                "-y",
                "-i",
                &session.audio_file_paths[0],
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                &normalized_audio_str,
            ],
        )?;
        return Ok(());
    }

    let concat_inputs_path = concat_inputs_path(app, &session.id)?;
    ensure_parent_dir(&concat_inputs_path)?;
    let concat_manifest = session
        .audio_file_paths
        .iter()
        .map(|path| format!("file '{}'", quote_concat_path(path)))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&concat_inputs_path, concat_manifest)
        .context("Failed to write ffmpeg concat manifest.")?;

    let concat_inputs_str = concat_inputs_path.to_string_lossy().to_string();
    run_ffmpeg(
        app,
        &[
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            &concat_inputs_str,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            &normalized_audio_str,
        ],
    )?;

    Ok(())
}

pub fn prepare_sessions_on_startup(app: &AppHandle, sessions: &mut [LectureSession]) -> Result<bool> {
    let mut changed = false;

    for session in sessions {
        if ensure_session_paths(app, session)? {
            changed = true;
        }

        if session.status == SessionStatus::Recording {
            session.status = SessionStatus::Paused;
            session.last_resumed_at = None;
            finish_audio_segment(session);
            changed = true;
        }
    }

    Ok(changed)
}

fn write_wav_header(
    file: &mut fs::File,
    sample_rate: u32,
    channels: u16,
    data_bytes_len: u32,
) -> Result<()> {
    let byte_rate = sample_rate * channels as u32 * 2;
    let block_align = channels * 2;
    let riff_chunk_size = 36 + data_bytes_len;

    file.seek(SeekFrom::Start(0))
        .context("Failed to seek to the beginning of the WAV file.")?;
    file.write_all(b"RIFF")?;
    file.write_all(&riff_chunk_size.to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&channels.to_le_bytes())?;
    file.write_all(&sample_rate.to_le_bytes())?;
    file.write_all(&byte_rate.to_le_bytes())?;
    file.write_all(&block_align.to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_bytes_len.to_le_bytes())?;
    Ok(())
}

pub fn initialize_live_preview_audio(
    app: &AppHandle,
    session: &mut LectureSession,
    sample_rate: u32,
    reset: bool,
) -> Result<bool> {
    ensure_session_paths(app, session)?;

    let preview_path = session
        .live_preview_audio_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or(live_preview_audio_path(app, &session.id)?);
    ensure_parent_dir(&preview_path)?;

    let mut changed = false;

    if reset || !preview_path.exists() {
        let mut file = fs::File::create(&preview_path)
            .context("Failed to create the live preview audio file.")?;
        write_wav_header(&mut file, sample_rate, 1, 0)?;
        changed = true;
    }

    let preview_path_value = preview_path.display().to_string();
    if session.live_preview_audio_path.as_deref() != Some(preview_path_value.as_str()) {
        session.live_preview_audio_path = Some(preview_path_value);
        changed = true;
    }

    if session.live_preview_sample_rate != Some(sample_rate) {
        session.live_preview_sample_rate = Some(sample_rate);
        changed = true;
    }

    Ok(changed)
}

pub fn append_live_preview_chunk_to_path(
    path: &Path,
    sample_rate: u32,
    chunk: &[u8],
) -> Result<()> {
    if chunk.is_empty() {
        return Ok(());
    }

    ensure_parent_dir(path)?;
    let exists = path.exists();
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .context("Failed to open the live preview audio file.")?;

    if !exists || file.metadata()?.len() < WAV_HEADER_LEN {
        file.set_len(0)?;
        write_wav_header(&mut file, sample_rate, 1, 0)?;
    }

    file.seek(SeekFrom::End(0))
        .context("Failed to seek to the end of the live preview audio file.")?;
    file.write_all(chunk)
        .context("Failed to append live preview audio.")?;

    let file_len = file
        .metadata()
        .context("Failed to read the live preview audio metadata.")?
        .len();
    let data_len = file_len.saturating_sub(WAV_HEADER_LEN) as u32;
    write_wav_header(&mut file, sample_rate, 1, data_len)?;

    Ok(())
}

pub fn append_live_preview_chunk(session: &LectureSession, chunk: &[u8]) -> Result<()> {
    let path = session
        .live_preview_audio_path
        .as_ref()
        .map(PathBuf::from)
        .context("The session is missing a live preview audio path.")?;
    let sample_rate = session
        .live_preview_sample_rate
        .context("The session is missing a live preview sample rate.")?;

    append_live_preview_chunk_to_path(&path, sample_rate, chunk)
}

#[cfg(test)]
mod tests {
    use super::{parse_transcript_segments_with_finality, polish_transcript_text};
    use crate::models::TranscriptSegment;

    #[test]
    fn rewrites_whisper_cpp_json_into_sentence_segments() {
        let raw = r#"{
          "result": { "language": "ja" },
          "transcription": [
            {
              "offsets": { "from": 0, "to": 8500 },
              "text": "今日は授業を始めます"
            },
            {
              "offsets": { "from": 8500, "to": 12000 },
              "text": "よろしくお願いします"
            }
          ]
        }"#;

        let segments =
            parse_transcript_segments_with_finality(raw, true, None)
                .expect("segments should parse");
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 8500);
        assert_eq!(segments[0].text, "今日は授業を始めます。");
        assert_eq!(segments[1].start_ms, 8500);
        assert_eq!(segments[1].end_ms, 12000);
        assert_eq!(segments[1].text, "よろしくお願いします。");
        assert!(segments.iter().all(|segment| segment.is_final));
    }

    #[test]
    fn merges_draft_segments_without_forcing_terminal_punctuation() {
        let raw = r#"{
          "result": { "language": "ja" },
          "transcription": [
            {
              "offsets": { "from": 0, "to": 4000 },
              "text": "次に"
            },
            {
              "offsets": { "from": 4000, "to": 9000 },
              "text": "分散システムについて"
            }
          ]
        }"#;

        let segments =
            parse_transcript_segments_with_finality(raw, false, None)
                .expect("segments should parse");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "次に分散システムについて");
        assert!(!segments[0].is_final);
    }

    #[test]
    fn builds_polished_transcript_paragraphs() {
        let polished = polish_transcript_text(&[
            TranscriptSegment {
                id: String::from("1"),
                start_ms: 0,
                end_ms: 1800,
                text: String::from("今日は授業を始めます。"),
                is_final: true,
            },
            TranscriptSegment {
                id: String::from("2"),
                start_ms: 1800,
                end_ms: 3600,
                text: String::from("まず前回の復習をします。"),
                is_final: true,
            },
            TranscriptSegment {
                id: String::from("3"),
                start_ms: 7600,
                end_ms: 9200,
                text: String::from("質問はありますか？"),
                is_final: true,
            },
        ]);

        assert_eq!(
            polished,
            "今日は授業を始めます。まず前回の復習をします。\n\n質問はありますか？"
        );
    }
}
