use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::collections::HashMap;
use std::time::Instant;
use chrono::Utc;
use include_dir::{include_dir, Dir};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use url::Url;
use uuid::Uuid;

use crate::db::{Database, PartDeletionTarget};
use crate::models::*;
use crate::telegram::TelegramEngine;
use crate::sync_ext::{MutexExt, RwLockExt};

static THUMBNAILS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/resources/thumbnails");

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveUploadPart {
    pub idx: usize,
    pub offset: u64,
    pub size: u64,
    pub slice_count: usize,
    pub status: String,
    pub received_slices: Vec<usize>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub telegram_file_id: Option<String>,
    #[serde(default)]
    pub telegram_message_id: Option<i64>,
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ActiveUploadSession {
    pub id: String,
    pub file_id: String,
    pub blob_id: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub folder_id: Option<String>,
    pub part_size: u64,
    pub slice_size: u64,
    pub client_key: Option<String>,
    pub parts: Vec<ActiveUploadPart>,
    pub created_at: i64,
    /// active while receiving slices, finalizing while the file record is saved.
    pub status: String,
    /// First few MB of part 0, kept for metadata/thumbnail extraction.
    #[serde(skip)]
    pub preview: Option<Vec<u8>>,
    /// Native uploads: the on-disk source the feeder streams parts from.
    /// source_size/source_mtime identify the file for auto-resume — if either
    /// changed the session is failed rather than resuming corrupt data.
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub source_size: Option<u64>,
    #[serde(default)]
    pub source_mtime: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct VideoMeta {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration: Option<f64>,
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AudioMeta {
    pub duration: Option<f64>,
    pub metadata_json: Option<String>,
}

pub fn parse_video_metadata(ext: &str, buf: &[u8]) -> VideoMeta {
    let mut meta = VideoMeta::default();
    meta.duration = parse_mp4_duration(buf);

    let mut codec_name: Option<String> = None;
    if buf.windows(4).any(|w| w == b"avc1") {
        codec_name = Some("H.264 / AVC".to_string());
    } else if buf.windows(4).any(|w| w == b"hvc1" || w == b"hev1") {
        codec_name = Some("H.265 / HEVC".to_string());
    } else if buf.windows(4).any(|w| w == b"vp09") {
        codec_name = Some("VP9".to_string());
    } else if buf.windows(4).any(|w| w == b"av01") {
        codec_name = Some("AV1".to_string());
    } else if buf.windows(4).any(|w| w == b"apcn" || w == b"apch" || w == b"apco") {
        codec_name = Some("Apple ProRes".to_string());
    }

    // Parse track dimensions from tkhd atom
    if let Some(pos) = buf.windows(4).position(|w| w == b"tkhd") {
        let data = &buf[pos + 4..];
        if data.len() >= 84 {
            let version = data[0];
            let (w_offset, h_offset) = if version == 0 { (76, 80) } else { (88, 92) };
            if data.len() >= h_offset + 4 {
                let w_raw = u32::from_be_bytes([data[w_offset], data[w_offset + 1], data[w_offset + 2], data[w_offset + 3]]) >> 16;
                let h_raw = u32::from_be_bytes([data[h_offset], data[h_offset + 1], data[h_offset + 2], data[h_offset + 3]]) >> 16;
                if w_raw > 0 && h_raw > 0 && w_raw <= 8192 && h_raw <= 8192 {
                    meta.width = Some(w_raw as i64);
                    meta.height = Some(h_raw as i64);
                }
            }
        }
    }

    let aspect = if let (Some(w), Some(h)) = (meta.width, meta.height) {
        let gcd = |mut a: i64, mut b: i64| -> i64 { while b != 0 { let t = b; b = a % b; a = t; } a.abs() };
        let d = gcd(w, h);
        if d > 0 && d <= 1000 { format!("{}:{}", w / d, h / d) } else { "".to_string() }
    } else {
        "".to_string()
    };

    let mut json_obj = serde_json::json!({
        "format": ext.to_uppercase(),
        "aspectRatio": aspect,
    });
    if let Some(d) = meta.duration {
        json_obj["duration"] = serde_json::json!(d);
    }
    if let (Some(w), Some(h)) = (meta.width, meta.height) {
        json_obj["width"] = serde_json::json!(w);
        json_obj["height"] = serde_json::json!(h);
        json_obj["dimensions"] = serde_json::json!(format!("{} × {}", w, h));
    }
    if let Some(ref c) = codec_name {
        json_obj["codec"] = serde_json::json!(c);
    }

    meta.metadata_json = Some(json_obj.to_string());
    meta
}

pub fn parse_audio_metadata(ext: &str, buf: &[u8]) -> AudioMeta {
    let mut meta = AudioMeta::default();
    let mut title: Option<String> = None;
    let mut artist: Option<String> = None;
    let mut album: Option<String> = None;
    let mut year: Option<String> = None;
    let mut genre: Option<String> = None;

    // ID3v2 for MP3
    if buf.len() >= 10 && &buf[0..3] == b"ID3" {
        let tag_size = ((buf[6] as usize & 0x7F) << 21)
            | ((buf[7] as usize & 0x7F) << 14)
            | ((buf[8] as usize & 0x7F) << 7)
            | (buf[9] as usize & 0x7F);
        let limit = (10 + tag_size).min(buf.len());
        let mut idx = 10;
        while idx + 10 < limit {
            let frame_id = &buf[idx..idx + 4];
            if frame_id[0] == 0 { break; }
            let frame_len = u32::from_be_bytes([buf[idx + 4], buf[idx + 5], buf[idx + 6], buf[idx + 7]]) as usize;
            if frame_len == 0 || idx + 10 + frame_len > limit { break; }
            let frame_data = &buf[idx + 10..idx + 10 + frame_len];

            let extract_text = |d: &[u8]| -> Option<String> {
                if d.is_empty() { return None; }
                let enc = d[0];
                let text_bytes = &d[1..];
                match enc {
                    0 | 3 => std::str::from_utf8(text_bytes).ok().map(|s| s.trim_matches('\0').trim().to_string()),
                    1 => {
                        let u16s: Vec<u16> = text_bytes.chunks_exact(2)
                            .map(|c| u16::from_le_bytes([c[0], c[1]]))
                            .collect();
                        String::from_utf16(&u16s).ok().map(|s| s.trim_matches('\0').trim().to_string())
                    }
                    _ => None,
                }
            };

            match frame_id {
                b"TIT2" => title = extract_text(frame_data),
                b"TPE1" => artist = extract_text(frame_data),
                b"TALB" => album = extract_text(frame_data),
                b"TYER" | b"TDRC" => year = extract_text(frame_data),
                b"TCON" => genre = extract_text(frame_data),
                b"TLEN" => {
                    if let Some(ms_str) = extract_text(frame_data) {
                        if let Ok(ms) = ms_str.parse::<f64>() {
                            meta.duration = Some(ms / 1000.0);
                        }
                    }
                }
                _ => {}
            }
            idx += 10 + frame_len;
        }
    }

    let mut json_obj = serde_json::json!({
        "format": ext.to_uppercase(),
    });
    if let Some(t) = title { json_obj["title"] = serde_json::json!(t); }
    if let Some(a) = artist { json_obj["artist"] = serde_json::json!(a); }
    if let Some(al) = album { json_obj["album"] = serde_json::json!(al); }
    if let Some(y) = year { json_obj["year"] = serde_json::json!(y); }
    if let Some(g) = genre { json_obj["genre"] = serde_json::json!(g); }
    if let Some(d) = meta.duration { json_obj["duration"] = serde_json::json!(d); }

    meta.metadata_json = Some(json_obj.to_string());
    meta
}

pub fn parse_pdf_metadata(buf: &[u8]) -> Option<String> {
    if !buf.starts_with(b"%PDF-") { return None; }
    let text = String::from_utf8_lossy(&buf[..buf.len().min(512 * 1024)]);
    let mut page_count: Option<usize> = None;
    if let Some(pos) = text.find("/Count ") {
        let rest = &text[pos + 7..];
        let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = num_str.parse::<usize>() {
            if n > 0 && n < 100_000 {
                page_count = Some(n);
            }
        }
    }
    let mut obj = serde_json::json!({ "format": "PDF" });
    if let Some(p) = page_count {
        obj["pageCount"] = serde_json::json!(p);
    }
    Some(obj.to_string())
}

#[derive(Debug, Clone)]
pub struct ParsedImageMeta {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub taken_at: Option<i64>,
    pub metadata_json: Option<String>,
}

fn parse_exif_date(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() >= 2 {
        let date_parts: Vec<i32> = parts[0].split(':').filter_map(|x| x.parse().ok()).collect();
        let time_parts: Vec<u32> = parts[1].split(':').filter_map(|x| x.parse().ok()).collect();
        if date_parts.len() == 3 && time_parts.len() >= 3 {
            use chrono::TimeZone;
            if let Some(dt) = chrono::Utc.with_ymd_and_hms(date_parts[0], date_parts[1] as u32, date_parts[2] as u32, time_parts[0], time_parts[1], time_parts[2]).single() {
                return Some(dt.timestamp_millis());
            }
        }
    }
    None
}

fn parse_jpeg_exif(bytes: &[u8]) -> (Option<String>, Option<String>, Option<String>, Option<u32>, Option<String>, Option<String>, Option<String>, Option<i64>) {
    let mut make = None;
    let mut model = None;
    let mut lens = None;
    let mut iso = None;
    let mut shutter_speed = None;
    let mut f_number = None;
    let mut focal_length = None;
    let mut taken_at = None;

    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return (make, model, lens, iso, shutter_speed, f_number, focal_length, taken_at);
    }

    let mut idx = 2;
    while idx + 4 < bytes.len() {
        if bytes[idx] == 0xFF {
            let marker = bytes[idx + 1];
            if marker == 0xE1 && idx + 14 < bytes.len() {
                let len = u16::from_be_bytes([bytes[idx + 2], bytes[idx + 3]]) as usize;
                let payload_end = (idx + 2 + len).min(bytes.len());
                let payload = &bytes[idx + 4..payload_end];
                if payload.starts_with(b"Exif\0\0") && payload.len() >= 14 {
                    let tiff = &payload[6..];
                    let le = tiff.starts_with(b"II");
                    let be = tiff.starts_with(b"MM");
                    if le || be {
                        let read_u16 = |d: &[u8]| -> u16 {
                            if le { u16::from_le_bytes([d[0], d[1]]) } else { u16::from_be_bytes([d[0], d[1]]) }
                        };
                        let read_u32 = |d: &[u8]| -> u32 {
                            if le { u32::from_le_bytes([d[0], d[1], d[2], d[3]]) } else { u32::from_be_bytes([d[0], d[1], d[2], d[3]]) }
                        };

                        if tiff.len() >= 8 {
                            let ifd0_offset = read_u32(&tiff[4..8]) as usize;
                            if ifd0_offset + 2 <= tiff.len() {
                                let num_entries = read_u16(&tiff[ifd0_offset..ifd0_offset + 2]) as usize;
                                let mut exif_ifd_offset = None;

                                for i in 0..num_entries.min(64) {
                                    let entry_start = ifd0_offset + 2 + i * 12;
                                    if entry_start + 12 > tiff.len() { break; }
                                    let tag = read_u16(&tiff[entry_start..entry_start + 2]);
                                    let count = read_u32(&tiff[entry_start + 4..entry_start + 8]) as usize;
                                    let val_offset = read_u32(&tiff[entry_start + 8..entry_start + 12]) as usize;

                                    let read_str = |off: usize, cnt: usize| -> Option<String> {
                                        if off + cnt <= tiff.len() {
                                            std::str::from_utf8(&tiff[off..off + cnt]).ok()
                                                .map(|s| s.trim_matches('\0').trim().to_string())
                                                .filter(|s| !s.is_empty())
                                        } else { None }
                                    };

                                    match tag {
                                        0x010F => make = if count <= 4 { read_str(entry_start + 8, count) } else { read_str(val_offset, count) },
                                        0x0110 => model = if count <= 4 { read_str(entry_start + 8, count) } else { read_str(val_offset, count) },
                                        0x0132 => {
                                            if let Some(date_s) = if count <= 4 { read_str(entry_start + 8, count) } else { read_str(val_offset, count) } {
                                                taken_at = parse_exif_date(&date_s);
                                            }
                                        }
                                        0x8769 => exif_ifd_offset = Some(val_offset),
                                        _ => {}
                                    }
                                }

                                if let Some(sub_offset) = exif_ifd_offset {
                                    if sub_offset + 2 <= tiff.len() {
                                        let sub_entries = read_u16(&tiff[sub_offset..sub_offset + 2]) as usize;
                                        for i in 0..sub_entries.min(64) {
                                            let entry_start = sub_offset + 2 + i * 12;
                                            if entry_start + 12 > tiff.len() { break; }
                                            let tag = read_u16(&tiff[entry_start..entry_start + 2]);
                                            let count = read_u32(&tiff[entry_start + 4..entry_start + 8]) as usize;
                                            let val_offset = read_u32(&tiff[entry_start + 8..entry_start + 12]) as usize;

                                            match tag {
                                                0x829A => {
                                                    if val_offset + 8 <= tiff.len() {
                                                        let num = read_u32(&tiff[val_offset..val_offset + 4]);
                                                        let den = read_u32(&tiff[val_offset + 4..val_offset + 8]);
                                                        if den > 0 {
                                                            shutter_speed = Some(if num == 1 || den > num {
                                                                format!("1/{}s", (den as f64 / num as f64).round() as u32)
                                                            } else {
                                                                format!("{:.1}s", num as f64 / den as f64)
                                                            });
                                                        }
                                                    }
                                                }
                                                0x829D => {
                                                    if val_offset + 8 <= tiff.len() {
                                                        let num = read_u32(&tiff[val_offset..val_offset + 4]);
                                                        let den = read_u32(&tiff[val_offset + 4..val_offset + 8]);
                                                        if den > 0 {
                                                            f_number = Some(format!("f/{:.1}", num as f64 / den as f64));
                                                        }
                                                    }
                                                }
                                                0x8827 => {
                                                    let val = read_u16(&tiff[entry_start + 8..entry_start + 10]);
                                                    iso = Some(val as u32);
                                                }
                                                0x9003 => {
                                                    let read_str = |off: usize, cnt: usize| -> Option<String> {
                                                        if off + cnt <= tiff.len() {
                                                            std::str::from_utf8(&tiff[off..off + cnt]).ok()
                                                                .map(|s| s.trim_matches('\0').trim().to_string())
                                                                .filter(|s| !s.is_empty())
                                                        } else { None }
                                                    };
                                                    if let Some(date_s) = if count <= 4 { read_str(entry_start + 8, count) } else { read_str(val_offset, count) } {
                                                        taken_at = parse_exif_date(&date_s);
                                                    }
                                                }
                                                0x920A => {
                                                    if val_offset + 8 <= tiff.len() {
                                                        let num = read_u32(&tiff[val_offset..val_offset + 4]);
                                                        let den = read_u32(&tiff[val_offset + 4..val_offset + 8]);
                                                        if den > 0 {
                                                            focal_length = Some(format!("{:.1} mm", num as f64 / den as f64));
                                                        }
                                                    }
                                                }
                                                0xA434 => {
                                                    let read_str = |off: usize, cnt: usize| -> Option<String> {
                                                        if off + cnt <= tiff.len() {
                                                            std::str::from_utf8(&tiff[off..off + cnt]).ok()
                                                                .map(|s| s.trim_matches('\0').trim().to_string())
                                                                .filter(|s| !s.is_empty())
                                                        } else { None }
                                                    };
                                                    lens = if count <= 4 { read_str(entry_start + 8, count) } else { read_str(val_offset, count) };
                                                }
                                                _ => {}
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                idx += 2 + len;
                continue;
            } else if marker == 0xD9 || marker == 0xDA {
                break;
            } else if marker != 0x00 && marker != 0xFF {
                let len = u16::from_be_bytes([bytes[idx + 2], bytes[idx + 3]]) as usize;
                idx += 2 + len;
                continue;
            }
        }
        idx += 1;
    }

    (make, model, lens, iso, shutter_speed, f_number, focal_length, taken_at)
}

pub fn parse_image_metadata(ext: &str, bytes: &[u8], size: u64) -> ParsedImageMeta {
    let mut width = None;
    let mut height = None;
    let mut taken_at = None;
    let mut format_name = ext.to_uppercase();
    let mut exif_make = None;
    let mut exif_model = None;
    let mut exif_lens = None;
    let mut exif_iso = None;
    let mut exif_shutter = None;
    let mut exif_fnumber = None;
    let mut exif_focal = None;

    match ext {
        "png" => {
            format_name = "PNG".to_string();
            if bytes.len() >= 24 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
                let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) as i64;
                let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]) as i64;
                width = Some(w);
                height = Some(h);
            }
        }
        "jpg" | "jpeg" => {
            format_name = "JPEG".to_string();
            if bytes.len() >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
                let (emake, emodel, elens, eiso, eshutter, efnumber, efocal, etaken) = parse_jpeg_exif(bytes);
                exif_make = emake;
                exif_model = emodel;
                exif_lens = elens;
                exif_iso = eiso;
                exif_shutter = eshutter;
                exif_fnumber = efnumber;
                exif_focal = efocal;
                taken_at = etaken;

                let mut idx = 2;
                while idx + 8 < bytes.len() {
                    if bytes[idx] == 0xFF {
                        let marker = bytes[idx + 1];
                        if marker == 0xC0 || marker == 0xC1 || marker == 0xC2 {
                            let h = u16::from_be_bytes([bytes[idx + 5], bytes[idx + 6]]) as i64;
                            let w = u16::from_be_bytes([bytes[idx + 7], bytes[idx + 8]]) as i64;
                            width = Some(w);
                            height = Some(h);
                            break;
                        } else if marker == 0xD9 || marker == 0xDA {
                            break;
                        } else if marker != 0x00 && marker != 0xFF {
                            let len = u16::from_be_bytes([bytes[idx + 2], bytes[idx + 3]]) as usize;
                            idx += 2 + len;
                            continue;
                        }
                    }
                    idx += 1;
                }
            }
        }
        "gif" => {
            format_name = "GIF".to_string();
            if bytes.len() >= 10 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
                let w = u16::from_le_bytes([bytes[6], bytes[7]]) as i64;
                let h = u16::from_le_bytes([bytes[8], bytes[9]]) as i64;
                width = Some(w);
                height = Some(h);
            }
        }
        "webp" => {
            format_name = "WebP".to_string();
            if bytes.len() >= 30 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
                if &bytes[12..16] == b"VP8 " && bytes.len() >= 30 {
                    let w = (u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3FFF) as i64;
                    let h = (u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3FFF) as i64;
                    width = Some(w);
                    height = Some(h);
                } else if &bytes[12..16] == b"VP8L" && bytes.len() >= 25 {
                    let b1 = bytes[21];
                    let b2 = bytes[22];
                    let b3 = bytes[23];
                    let b4 = bytes[24];
                    let w = (1 + (((b2 as u32 & 0x3F) << 8) | b1 as u32)) as i64;
                    let h = (1 + (((b4 as u32 & 0x0F) << 10) | ((b3 as u32) << 2) | ((b2 as u32) >> 6))) as i64;
                    width = Some(w);
                    height = Some(h);
                } else if &bytes[12..16] == b"VP8X" && bytes.len() >= 30 {
                    let w = 1 + (bytes[24] as i64 | ((bytes[25] as i64) << 8) | ((bytes[26] as i64) << 16));
                    let h = 1 + (bytes[27] as i64 | ((bytes[28] as i64) << 8) | ((bytes[29] as i64) << 16));
                    width = Some(w);
                    height = Some(h);
                }
            }
        }
        "svg" => {
            format_name = "SVG".to_string();
            width = Some(800);
            height = Some(600);
        }
        _ => {}
    }

    let mut json_obj = serde_json::json!({
        "format": format_name,
        "sizeBytes": size,
        "colorSpace": "sRGB",
        "hasAlpha": ext == "png" || ext == "webp" || ext == "gif",
    });

    if let (Some(w), Some(h)) = (width, height) {
        let gcd = |mut a: i64, mut b: i64| -> i64 { while b != 0 { let t = b; b = a % b; a = t; } a.abs() };
        let d = gcd(w, h);
        let aspect = if d > 0 && d <= 1000 { format!("{}:{}", w / d, h / d) } else { "".to_string() };
        json_obj["width"] = serde_json::json!(w);
        json_obj["height"] = serde_json::json!(h);
        json_obj["dimensions"] = serde_json::json!(format!("{} × {}", w, h));
        json_obj["aspectRatio"] = serde_json::json!(aspect);
    }
    if let Some(m) = exif_make { json_obj["make"] = serde_json::json!(m); }
    if let Some(m) = exif_model { json_obj["model"] = serde_json::json!(m); }
    if let Some(l) = exif_lens { json_obj["lens"] = serde_json::json!(l); }
    if let Some(i) = exif_iso { json_obj["iso"] = serde_json::json!(i); }
    if let Some(s) = exif_shutter { json_obj["shutterSpeed"] = serde_json::json!(s); }
    if let Some(f) = exif_fnumber { json_obj["fNumber"] = serde_json::json!(f); }
    if let Some(fl) = exif_focal { json_obj["focalLength"] = serde_json::json!(fl); }

    let metadata_json = Some(json_obj.to_string());

    ParsedImageMeta {
        width,
        height,
        taken_at,
        metadata_json,
    }
}

pub fn parse_mp4_duration(buf: &[u8]) -> Option<f64> {
    let mvhd_tag = b"mvhd";
    let pos = buf.windows(4).position(|w| w == mvhd_tag)?;
    if pos + 4 + 20 > buf.len() {
        return None;
    }
    let data = &buf[pos + 4..];
    let version = data[0];
    if version == 0 {
        if data.len() < 20 { return None; }
        let timescale = u32::from_be_bytes([data[8], data[9], data[10], data[11]]) as f64;
        let duration = u32::from_be_bytes([data[12], data[13], data[14], data[15]]) as f64;
        if timescale > 0.0 && duration > 0.0 {
            return Some(duration / timescale);
        }
    } else if version == 1 {
        if data.len() < 28 { return None; }
        let timescale = u32::from_be_bytes([data[16], data[17], data[18], data[19]]) as f64;
        let duration = u64::from_be_bytes([
            data[20], data[21], data[22], data[23],
            data[24], data[25], data[26], data[27],
        ]) as f64;
        if timescale > 0.0 && duration > 0.0 {
            return Some(duration / timescale);
        }
    }
    None
}

fn json_u64(v: &serde_json::Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    if let Some(f) = v.as_f64() {
        return f.is_finite().then(|| f.clamp(0.0, u64::MAX as f64) as u64);
    }
    if let Some(s) = v.as_str() {
        if let Ok(f) = s.trim().parse::<f64>() {
            return f.is_finite().then(|| f.clamp(0.0, u64::MAX as f64) as u64);
        }
    }
    None
}

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::Digest;
    let mut file = std::fs::File::open(path).map_err(|e| format!("cannot open staged part: {}", e))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = 0;
    for (idx, ch) in value.char_indices() {
        let next = idx + ch.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    &value[..end]
}

fn part_caption(name: &str, part_idx: usize, part_count: usize, file_id: &str, blob_id: &str, sha: &str) -> String {
    let build = |file_name: &str| format!(
        "#teledrive\nfile: {}\npart: {}/{}\nfile_id: {}\nblob: {}\nsha256: {}",
        file_name, part_idx + 1, part_count, file_id, blob_id, sha
    );
    let mut caption = build(name);
    if caption.len() > 1024 {
        // Captions are limited to 1024 bytes. Truncate on a char boundary so
        // multi-byte file names can never panic the request thread.
        let overhead = build("").len();
        let budget = 1024usize.saturating_sub(overhead);
        caption = build(truncate_utf8(name, budget));
    }
    truncate_utf8(&caption, 1024).to_string()
}

/// Stream an HTTP request body into the correct offset of a staged part file.
/// Slice uploads are validated by Content-Length before this is called, so a
/// short read means the client disconnected and the slice is not recorded.
fn write_body_at(request: &mut Request, path: &std::path::Path, offset: u64, expected: u64) -> Result<(), String> {
    use std::fs::OpenOptions;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create upload dir: {}", e))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("cannot open staged part: {}", e))?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| format!("cannot seek staged part: {}", e))?;

    let reader = request.as_reader();
    let mut remaining = expected;
    let mut buf = vec![0u8; 256 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let read = reader.read(&mut buf[..want]).map_err(|e| format!("cannot read slice body: {}", e))?;
        if read == 0 {
            return Err(format!("slice body ended {} bytes early", remaining));
        }
        file.write_all(&buf[..read]).map_err(|e| format!("cannot write staged part: {}", e))?;
        remaining -= read as u64;
    }
    file.flush().map_err(|e| format!("cannot flush staged part: {}", e))?;
    Ok(())
}

/// Concatenates several on-disk parts into one seekable-at-open stream. Used
/// by the built-in vault so downloads and previews never copy the file into a
/// temporary cache just to attach a Range header.
struct MultiFileReader {
    files: Vec<std::fs::File>,
    sizes: Vec<u64>,
    idx: usize,
    left: u64,
}

impl MultiFileReader {
    fn open(paths: &[PathBuf], skip: u64) -> std::io::Result<(Self, u64)> {
        let mut files = Vec::with_capacity(paths.len());
        let mut sizes = Vec::with_capacity(paths.len());
        let mut total = 0u64;
        for path in paths {
            let file = std::fs::File::open(path)?;
            let size = file.metadata()?.len();
            total += size;
            files.push(file);
            sizes.push(size);
        }

        let mut idx = 0usize;
        let mut skip = skip;
        while idx < files.len() && skip >= sizes[idx] {
            skip -= sizes[idx];
            idx += 1;
        }
        if skip > 0 && idx < files.len() {
            files[idx].seek(SeekFrom::Start(skip))?;
        }
        let left = sizes.get(idx).copied().unwrap_or(0).saturating_sub(skip);
        Ok((MultiFileReader { files, sizes, idx, left }, total))
    }
}

impl Read for MultiFileReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.idx < self.files.len() {
            if self.left == 0 {
                self.idx += 1;
                if self.idx >= self.files.len() {
                    return Ok(0);
                }
                self.left = self.sizes[self.idx];
                continue;
            }
            let want = buf.len().min(self.left as usize);
            if want == 0 {
                return Ok(0);
            }
            let read = self.files[self.idx].read(&mut buf[..want])?;
            if read == 0 {
                return Ok(0);
            }
            self.left -= read as u64;
            return Ok(read);
        }
        Ok(0)
    }
}

/// Parse a single-range `bytes=` header into (status, start, end).
fn parse_byte_range(range_header: Option<&str>, total_len: u64) -> (u16, u64, u64) {
    let mut status = 200u16;
    let mut start = 0u64;
    let mut end = total_len.saturating_sub(1);
    if let Some(range_val) = range_header {
        if let Some(range_spec) = range_val.strip_prefix("bytes=") {
            let pieces: Vec<&str> = range_spec.split('-').collect();
            let parsed_start = pieces.first().and_then(|s| s.parse::<u64>().ok());
            let parsed_end = pieces.get(1).and_then(|s| s.parse::<u64>().ok());
            match (parsed_start, parsed_end) {
                (Some(s), Some(e)) if s <= e && s < total_len => {
                    start = s;
                    end = e.min(total_len.saturating_sub(1));
                    status = 206;
                }
                (Some(s), None) if s < total_len => {
                    start = s;
                    status = 206;
                }
                (None, Some(suffix)) if suffix > 0 => {
                    start = total_len.saturating_sub(suffix);
                    status = 206;
                }
                _ => {}
            }
        }
    }
    (status, start, end)
}

/// Open a folder in the desktop file manager without opening a console window.
fn open_in_file_manager(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer.exe")
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn().map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ())
    }
}

/// Build a safe Content-Disposition value. Filenames come from uploads, so a
/// newline or quote must never be able to break the response headers.
fn content_disposition(filename: &str) -> String {
    let ascii: String = filename.chars()
        .map(|c| if c.is_ascii() && c != '"' && c != '\\' && !c.is_control() { c } else { '_' })
        .collect();
    if filename.is_ascii() {
        return format!("attachment; filename=\"{}\"", ascii);
    }
    let encoded: String = filename.as_bytes().iter().map(|b| {
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'~') {
            (*b as char).to_string()
        } else {
            format!("%{:02X}", b)
        }
    }).collect();
    format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", ascii, encoded)
}

/// Compact size text for user-facing error messages.
pub(crate) fn human_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    const TB: f64 = GB * 1024.0;
    let n = bytes as f64;
    if n >= TB {
        format!("{:.2} TB", n / TB)
    } else if n >= GB {
        format!("{:.2} GB", n / GB)
    } else if n >= MB {
        format!("{:.1} MB", n / MB)
    } else if n >= KB {
        format!("{:.1} KB", n / KB)
    } else {
        format!("{} B", bytes)
    }
}

#[derive(Clone)]
pub struct AppServer {
    pub db: Arc<Database>,
    pub telegram: Arc<TelegramEngine>,
    pub tokio_runtime: Arc<tokio::runtime::Runtime>,
    pub mirror: Arc<crate::mirror::MirrorEngine>,
    pub native_downloads: Arc<crate::native_downloads::NativeDownloadManager>,
    pub port: u16,
    pub active_uploads: Arc<RwLock<HashMap<String, ActiveUploadSession>>>,
    upload_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// Serializes create requests so two concurrent retries with the same
    /// clientKey cannot create duplicate sessions.
    create_lock: Arc<Mutex<()>>,
    /// Refcount of cache files currently being read or written — the LRU
    /// pruner and clear-cache never evict an in-use file.
    cache_in_use: Arc<Mutex<std::collections::HashMap<PathBuf, usize>>>,
    /// Dedup map for concurrent per-part stream fetches: a second request for
    /// a part being fetched waits on the shared flag instead of downloading
    /// it twice.
    pub(crate) part_inflight: Arc<Mutex<std::collections::HashMap<String, Arc<crate::part_stream::PartFetch>>>>,
    /// Sessions with a running native feeder — a retry or resume can never
    /// double-feed one upload.
    pub(crate) native_feeders: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl AppServer {
    pub fn new(db: Arc<Database>, telegram: Arc<TelegramEngine>, tokio_runtime: Arc<tokio::runtime::Runtime>, port: u16) -> Self {
        let mirror = Arc::new(crate::mirror::MirrorEngine::new(Arc::clone(&db)));
        let native_downloads = Arc::new(crate::native_downloads::NativeDownloadManager::new(
            Arc::clone(&db),
            Arc::clone(&telegram),
            Arc::clone(&tokio_runtime),
        ));
        let server = AppServer {
            db,
            telegram,
            tokio_runtime,
            mirror,
            native_downloads,
            port,
            active_uploads: Arc::new(RwLock::new(HashMap::new())),
            upload_locks: Arc::new(Mutex::new(HashMap::new())),
            create_lock: Arc::new(Mutex::new(())),
            cache_in_use: Arc::new(Mutex::new(HashMap::new())),
            part_inflight: Arc::new(Mutex::new(HashMap::new())),
            native_feeders: Arc::new(Mutex::new(std::collections::HashSet::new())),
        };
        server.load_persisted_uploads();
        server.start_native_feeders();
        server.trigger_mirror_sync();
        server
    }

    pub fn trigger_mirror_sync(&self) {
        let (path, enabled) = {
            let state = self.db.state.read_safe();
            (state.local_mirror_path.clone(), state.local_mirror_enabled)
        };
        if enabled {
            if let Some(path) = path {
                let mirror = Arc::clone(&self.mirror);
                std::thread::spawn(move || {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let _ = mirror.sync(&path);
                    }));
                });
            }
        }
    }

    pub fn get_cache_dir(&self) -> PathBuf {
        let state = self.db.state.read_safe();
        if state.local_mirror_enabled {
            if let Some(ref p) = state.local_mirror_path {
                let mirror_cache = PathBuf::from(p).join("cache");
                if std::fs::create_dir_all(&mirror_cache).is_ok() {
                    return mirror_cache;
                }
            }
        }
        let fallback = self.db.data_dir.join("cache");
        let _ = std::fs::create_dir_all(&fallback);
        fallback
    }

    pub fn get_thumbnails_dir(&self) -> PathBuf {
        let state = self.db.state.read_safe();
        if state.local_mirror_enabled {
            if let Some(ref p) = state.local_mirror_path {
                let mirror_thumbs = PathBuf::from(p).join("thumbnails");
                if std::fs::create_dir_all(&mirror_thumbs).is_ok() {
                    return mirror_thumbs;
                }
            }
        }
        let fallback = self.db.thumbnails_dir.clone();
        let _ = std::fs::create_dir_all(&fallback);
        fallback
    }

    pub fn remove_stream_cache(&self, fid: &str) {
        let fname = format!("stream-{}.bin", fid);
        let _ = std::fs::remove_file(self.db.data_dir.join("cache").join(&fname));
        let state = self.db.state.read_safe();
        if let Some(ref p) = state.local_mirror_path {
            let _ = std::fs::remove_file(PathBuf::from(p).join("cache").join(&fname));
        }
    }

    /// Long-lived cache files managed by TeleDrive's LRU: promoted stream
    /// files and folder-ZIP artifacts. Naming is strict so nothing user-owned
    /// in a mirror folder is ever touched.
    fn is_managed_cache_file(name: &str) -> bool {
        (name.starts_with("stream-") && name.ends_with(".bin"))
            || (name.starts_with("zip-") && name.ends_with(".zip"))
            || (name.starts_with("stream-tmp-") && name.ends_with(".bin"))
    }

    pub(crate) fn cache_acquire(&self, path: &Path) -> CacheUseGuard {
        {
            let mut map = self.cache_in_use.lock_safe();
            *map.entry(path.to_path_buf()).or_insert(0) += 1;
        }
        CacheUseGuard { map: Arc::clone(&self.cache_in_use), path: path.to_path_buf() }
    }

    fn cache_is_in_use(&self, path: &Path) -> bool {
        self.cache_in_use.lock_safe().get(path).map(|n| *n > 0).unwrap_or(false)
    }

    /// Best-effort mtime bump — makes a cache hit look "recently used".
    pub(crate) fn cache_touch(path: &Path) {
        if let Ok(f) = std::fs::File::options().write(true).open(path) {
            let _ = f.set_modified(std::time::SystemTime::now());
        }
    }

    fn stream_cache_files(&self) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
        let mut files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(self.get_cache_dir()) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() { continue; }
                let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
                if !Self::is_managed_cache_file(name) { continue; }
                if let Ok(m) = p.metadata() {
                    files.push((p, m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)));
                }
            }
        }
        files
    }

    /// LRU eviction: when the stream cache exceeds `cache_limit_gb`, delete
    /// least-recently-used managed files until below 90% of the limit. Files
    /// currently being served or written are never evicted.
    pub fn prune_stream_cache(&self) -> u64 {
        let limit_bytes = {
            let state = self.db.state.read_safe();
            state.cache_limit_gb.clamp(1, 500) * 1024 * 1024 * 1024
        };
        let mut files = self.stream_cache_files();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= limit_bytes { return 0; }
        files.sort_by_key(|f| f.2); // oldest first
        let target = limit_bytes * 9 / 10;
        let mut freed = 0u64;
        for (p, size, _) in files {
            if total <= target { break; }
            if self.cache_is_in_use(&p) { continue; }
            if std::fs::remove_file(&p).is_ok() {
                total = total.saturating_sub(size);
                freed += size;
            }
        }
        freed
    }

    /// POST /api/system/clear-cache — drop every managed cache file that is
    /// not in use; returns the freed byte count.
    pub fn clear_stream_cache(&self) -> u64 {
        let mut freed = 0u64;
        for (p, size, _) in self.stream_cache_files() {
            if self.cache_is_in_use(&p) { continue; }
            if std::fs::remove_file(&p).is_ok() {
                freed += size;
            }
        }
        freed
    }

    fn is_local_api(&self) -> bool {
        true
    }

    fn max_part_size_mb(&self) -> u64 {
        if self.is_local_api() {
            2000
        } else {
            45
        }
    }

    /// Video/audio parts are capped at MEDIA_PART_SIZE_MB so range requests
    /// and first-byte latency stay bounded: the local Bot API always fetches a
    /// whole part before a single byte is readable.
    pub(crate) fn part_size_for(&self, mime_type: &str) -> u64 {
        const MEDIA_PART_SIZE_MB: u64 = 64;
        let configured = self.effective_part_size_mb();
        if mime_type.starts_with("video/") || mime_type.starts_with("audio/") {
            configured.min(MEDIA_PART_SIZE_MB)
        } else {
            configured
        }
    }

    fn effective_part_size_mb(&self) -> u64 {
        let configured = self.db.state.read_safe().part_size_mb;
        let max_allowed = self.max_part_size_mb();
        if configured == 0 {
            if self.is_local_api() { 500 } else { 45 }
        } else {
            configured.clamp(5, max_allowed)
        }
    }

    pub(crate) fn upload_dir(&self, upload_id: &str) -> PathBuf {
        self.db.data_dir.join("uploads").join(upload_id)
    }

    pub(crate) fn part_file(&self, upload_id: &str, part_idx: usize) -> PathBuf {
        self.upload_dir(upload_id).join(format!("{}.part", part_idx))
    }

    /// Persist the resumable upload session next to its staged part files so
    /// closing the app does not lose an in-progress upload.
    pub(crate) fn persist_session(&self, session: &ActiveUploadSession) {
        let dir = self.upload_dir(&session.id);
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let Ok(json) = serde_json::to_string(session) else { return; };
        let tmp = dir.join(".session.tmp");
        let dest = dir.join("session.json");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &dest);
        }
    }

    pub(crate) fn persist_session_by_id(&self, upload_id: &str) {
        let session = self.active_uploads.read_safe().get(upload_id).cloned();
        if let Some(session) = session {
            self.persist_session(&session);
        }
    }

    fn load_persisted_uploads(&self) {
        let uploads_dir = self.db.data_dir.join("uploads");
        let Ok(entries) = std::fs::read_dir(&uploads_dir) else { return; };
        let now = Utc::now().timestamp_millis();
        let mut loaded = self.active_uploads.write_safe();
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(dir.join("session.json")) else { continue; };
            let Ok(mut session) = serde_json::from_str::<ActiveUploadSession>(&text) else {
                let _ = std::fs::remove_dir_all(&dir);
                continue;
            };
            if now - session.created_at > 48 * 3600 * 1000 {
                let _ = std::fs::remove_dir_all(&dir);
                continue;
            }
            // A crash during finalization is rolled back to active; the client
            // can safely call complete again.
            if session.status == "finalizing" {
                session.status = "active".to_string();
            }
            for part in &mut session.parts {
                // An upload that was in flight when the app closed was not
                // necessarily stored. Let the client re-send it.
                if part.status == "uploading" {
                    part.status = "pending".to_string();
                    part.started_at = None;
                }
                let path = self.part_file(&session.id, part.idx);
                if !path.exists() && part.status != "stored" {
                    part.received_slices.clear();
                    part.status = "pending".to_string();
                    part.sha256.clear();
                }
            }
            loaded.insert(session.id.clone(), session);
        }
    }

    pub(crate) fn upload_lock(&self, upload_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.upload_locks.lock_safe();
        locks.entry(upload_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(crate) fn drop_upload(&self, upload_id: &str) {
        self.active_uploads.write_safe().remove(upload_id);
        self.upload_locks.lock_safe().remove(upload_id);
        let _ = std::fs::remove_dir_all(self.upload_dir(upload_id));
    }

    fn delete_telegram_parts(&self, targets: &[PartDeletionTarget]) {
        if targets.is_empty() {
            return;
        }
        let bot_tokens: HashMap<String, String> = {
            let state = self.db.state.read_safe();
            state.bots.iter().map(|b| (b.id.clone(), b.token.clone())).collect()
        };
        let fallback_token = self.db.any_bot_token();
        let default_channel = self.telegram.channel_id.clone();

        let local_ids: Vec<i64> = targets.iter()
            .filter(|t| t.message_id < 0)
            .map(|t| t.message_id)
            .collect();
        if !local_ids.is_empty() {
            let telegram = Arc::clone(&self.telegram);
            let channel = default_channel.clone();
            let _ = self.tokio_runtime.block_on(async move {
                let _ = telegram.delete_messages("", &channel, &local_ids).await;
            });
        }

        let mut by_bot_and_channel: HashMap<(String, String), Vec<i64>> = HashMap::new();
        for t in targets {
            if t.message_id > 0 {
                let channel = if t.channel_id.is_empty() {
                    default_channel.clone()
                } else {
                    t.channel_id.clone()
                };
                by_bot_and_channel.entry((t.bot_id.clone(), channel)).or_default().push(t.message_id);
            }
        }

        let telegram = Arc::clone(&self.telegram);
        for ((bot_id, channel), message_ids) in by_bot_and_channel {
            let token = bot_tokens.get(&bot_id).cloned()
                .or_else(|| fallback_token.clone());
            if let Some(token) = token {
                let telegram = Arc::clone(&telegram);
                let _ = self.tokio_runtime.block_on(async move {
                    if let Err(e) = telegram.delete_messages(&token, &channel, &message_ids).await {
                        eprintln!("[delete] bot {} failed to delete {} messages in {}: {}", bot_id, message_ids.len(), channel, e);
                    }
                });
            }
        }
    }

    /// Remove all storage owned by an upload session: staged parts, any local
    /// vault parts already committed, Telegram messages, and its placeholder
    /// file/blob records. Used by cancel and by retrying a failed upload from
    /// scratch so abandoned parts cannot accumulate forever.
    pub(crate) fn discard_upload(&self, session: &ActiveUploadSession) {
        let stored_targets: Vec<PartDeletionTarget> = {
            let state = self.db.state.read_safe();
            state.parts.iter()
                .filter(|p| p.blob_id == session.blob_id && p.telegram_message_id != 0)
                .map(|p| PartDeletionTarget {
                    bot_id: p.bot_id.clone(),
                    channel_id: p.telegram_channel_id.clone(),
                    message_id: p.telegram_message_id,
                })
                .collect()
        };

        self.delete_telegram_parts(&stored_targets);

        {
            let mut state = self.db.state.write_safe();
            // A copy could theoretically share the blob; keep storage that a
            // surviving file still references.
            let shared = state.files.iter().any(|f| f.blob_id == session.blob_id && f.id != session.file_id);
            state.files.retain(|f| f.id != session.file_id);
            if !shared {
                state.blobs.retain(|b| b.id != session.blob_id);
                state.parts.retain(|p| p.blob_id != session.blob_id);
            }
        }
        self.db.save();
        self.drop_upload(&session.id);
    }

    fn set_upload_status(&self, upload_id: &str, status: &str) {
        let changed = if let Some(session) = self.active_uploads.write_safe().get_mut(upload_id) {
            session.status = status.to_string();
            true
        } else {
            false
        };
        if changed {
            self.persist_session_by_id(upload_id);
        }
    }

    /// Atomically move an upload into 'finalizing'. Only one completion or
    /// retry request can win, so two clients can never finalize the same file
    /// at once (which could create duplicate Telegram documents or records).
    pub(crate) fn try_begin_finalize(&self, upload_id: &str) -> bool {
        let lock = self.upload_lock(upload_id);
        let _guard = lock.lock_safe();
        let changed = {
            let mut uploads = self.active_uploads.write_safe();
            match uploads.get_mut(upload_id) {
                Some(session) if session.status != "finalizing" => {
                    session.status = "finalizing".to_string();
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.persist_session_by_id(upload_id);
        }
        changed
    }

    /// Finalize exactly once while holding the per-upload lock. Cancellation
    /// takes the same lock, so a DELETE and a completion cannot interleave.
    pub(crate) fn finalize_and_drop(&self, upload_id: &str) -> Result<serde_json::Value, String> {
        let result = {
            let lock = self.upload_lock(upload_id);
            let _guard = lock.lock_safe();
            let session = self.active_uploads.read_safe().get(upload_id).cloned();
            match session {
                Some(session) if session.status == "finalizing" => self.finalize_upload(&session),
                Some(_) => Err("upload is not being finalized".to_string()),
                None => Err("upload session not found".to_string()),
            }
        };
        match result {
            Ok(file) => {
                self.drop_upload(upload_id);
                self.trigger_mirror_sync();
                Ok(file)
            }
            Err(e) => {
                if e != "upload session not found" {
                    self.set_upload_status(upload_id, "active");
                }
                Err(e)
            }
        }
    }

    pub(crate) fn session_status(session: &ActiveUploadSession) -> &'static str {
        if session.parts.iter().any(|p| p.status == "failed") { "failed" } else { "active" }
    }

    fn part_status_label(part: &ActiveUploadPart) -> &'static str {
        match part.status.as_str() {
            "stored" => "stored",
            "failed" => "failed",
            "uploading" => "uploading",
            _ => "pending",
        }
    }

    fn upload_status_json(&self, session: &ActiveUploadSession) -> serde_json::Value {
        let parts_received = session.parts.iter().filter(|p| p.status == "stored").count();
        let bytes_stored: u64 = session.parts.iter().filter(|p| p.status == "stored").map(|p| p.size).sum();
        let slices_received: usize = session.parts.iter().map(|p| p.received_slices.len()).sum();
        let slices_total: usize = session.parts.iter().map(|p| p.slice_count).sum();
        serde_json::json!({
            "id": session.id,
            "fileId": session.file_id,
            "name": session.name,
            "size": session.size,
            "status": Self::session_status(session),
            "clientKey": session.client_key,
            "bytesStored": bytes_stored,
            "progress": {
                "partsReceived": parts_received,
                "partsTotal": session.parts.len(),
                "slicesReceived": slices_received,
                "slicesTotal": slices_total,
                "bytesStored": bytes_stored
            },
            "createdAt": session.created_at,
            "expiresAt": session.created_at + 48 * 3600 * 1000
        })
    }

    pub(crate) fn upload_dto_json(&self, session: &ActiveUploadSession) -> serde_json::Value {
        let parts: Vec<serde_json::Value> = session.parts.iter().map(|p| serde_json::json!({
            "idx": p.idx,
            "offset": p.offset,
            "size": p.size,
            "sliceCount": p.slice_count.max(1),
            "status": Self::part_status_label(p),
            "receivedSlices": p.received_slices,
        })).collect();
        serde_json::json!({
            "id": session.id,
            "fileId": session.file_id,
            "name": session.name,
            "size": session.size,
            "partSize": session.part_size,
            "sliceSize": session.slice_size,
            "status": Self::session_status(session),
            "native": session.source_path.is_some(),
            "parts": parts,
        })
    }

    fn upload_progress_json(&self, session: &ActiveUploadSession) -> serde_json::Value {
        let bot_names: HashMap<String, String> = {
            let state = self.db.state.read_safe();
            state.bots.iter().map(|b| (b.id.clone(), b.username.clone())).collect()
        };
        let parts: Vec<serde_json::Value> = session.parts.iter().map(|p| {
            let status = Self::part_status_label(p);
            let phase = if p.status == "uploading" {
                Some("sending")
            } else if p.status != "stored" && p.received_slices.len() >= p.slice_count.max(1) {
                Some("waiting-bot")
            } else {
                None
            };
            serde_json::json!({
                "idx": p.idx,
                "size": p.size,
                "status": status,
                "phase": phase,
                "startedAt": p.started_at,
                "queuePosition": 0,
                "botId": p.bot_id,
                "botUsername": p.bot_id.as_ref().and_then(|id| bot_names.get(id)).cloned(),
                "estRate": if p.status == "uploading" { serde_json::json!(8 * 1024 * 1024) } else { serde_json::Value::Null },
                "attempts": p.attempts,
                "lastError": p.last_error,
                "nextAttemptAt": serde_json::Value::Null,
            })
        }).collect();
        serde_json::json!({
            "id": session.id,
            "fileId": session.file_id,
            "status": Self::session_status(session),
            "fileStatus": if Self::session_status(session) == "failed" { "failed" } else { "uploading" },
            "serverNow": Utc::now().timestamp_millis(),
            "parts": parts,
        })
    }

    /// Try to reserve a fully-received part for Telegram. If the global upload
    /// limit is temporarily full, wait a little instead of silently orphaning
    /// the part after its last slice arrives.
    pub(crate) fn claim_part_wait(&self, upload_id: &str, part_idx: usize) -> Result<Option<ActiveUploadSession>, String> {
        let deadline = Instant::now() + std::time::Duration::from_secs(120);
        loop {
            if let Some(session) = self.claim_part(upload_id, part_idx) {
                return Ok(Some(session));
            }
            let state = {
                let map = self.active_uploads.read_safe();
                match map.get(upload_id).and_then(|s| s.parts.get(part_idx)) {
                    Some(p) => Some((p.status.clone(), p.received_slices.len(), p.slice_count.max(1))),
                    None => None,
                }
            };
            match state {
                None => return Err("upload session not found".to_string()),
                Some((status, received, total)) => {
                    if status == "stored" || status == "uploading" || status == "failed" {
                        return Ok(None);
                    }
                    if received < total {
                        return Ok(None);
                    }
                    if Instant::now() >= deadline {
                        return Err("Telegram upload slots are busy; retry shortly".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
        }
    }

    fn unique_file_name(&self, folder_id: Option<&str>, name: &str) -> String {
        let state = self.db.state.read_safe();
        let taken = |candidate: &str| state.files.iter().any(|f| {
            f.trashed_at.is_none()
                && f.folder_id.as_deref() == folder_id
                && f.name.eq_ignore_ascii_case(candidate)
        });
        if !taken(name) {
            return name.to_string();
        }
        let (stem, ext) = match name.rfind('.') {
            Some(idx) if idx > 0 => (&name[..idx], &name[idx..]),
            _ => (name, ""),
        };
        for n in 1..10_000 {
            let candidate = format!("{} ({}){}", stem, n, ext);
            if !taken(&candidate) {
                return candidate;
            }
        }
        format!("{}-{}", name, Uuid::new_v4())
    }

    /// Atomically move a fully-received part to 'uploading'. Only one request
    /// can win, which guarantees exactly one Telegram document per part.
    fn claim_part(&self, upload_id: &str, part_idx: usize) -> Option<ActiveUploadSession> {
        let lock = self.upload_lock(upload_id);
        let _guard = lock.lock_safe();
        let mut map = self.active_uploads.write_safe();
        let session = map.get(upload_id)?;
        let part = session.parts.get(part_idx)?;
        // Failed parts are only retried explicitly via /retry; otherwise a
        // permanent Telegram error would be retried forever by /complete.
        if part.status == "stored" || part.status == "uploading" || part.status == "failed" {
            return None;
        }
        if part.received_slices.len() < part.slice_count {
            return None;
        }

        let (explicit_limit, local_limit) = {
            let state = self.db.state.read_safe();
            let local = if state.storage_mode == "telegram" { 0 } else { state.bot_max_concurrent_uploads };
            (state.telegram_upload_concurrency, local)
        };
        let limit = if explicit_limit > 0 { explicit_limit } else { local_limit };
        if limit > 0 {
            let uploading = map.values()
                .flat_map(|s| s.parts.iter())
                .filter(|p| p.status == "uploading")
                .count();
            if uploading >= limit as usize {
                return None;
            }
        }

        // A previous process may have stored this part before the session was
        // updated; trust the durable record and do not upload it twice.
        let already_stored = {
            let state = self.db.state.read_safe();
            state.parts.iter().any(|p| p.blob_id == session.blob_id && p.part_index == part_idx as i64)
        };

        let session = map.get_mut(upload_id).unwrap();
        let part = session.parts.get_mut(part_idx).unwrap();
        if already_stored {
            part.status = "stored".to_string();
            return None;
        }
        part.status = "uploading".to_string();
        part.started_at = Some(Utc::now().timestamp_millis());
        part.last_error = None;

        // Keep a small prefix of part 0 for metadata/thumbnail extraction.
        if part_idx == 0 && session.preview.is_none() && part.size > 0 {
            let path = self.part_file(upload_id, 0);
            if let Ok(file) = std::fs::File::open(&path) {
                let mut buf = Vec::new();
                if file.take(4 * 1024 * 1024).read_to_end(&mut buf).is_ok() {
                    session.preview = Some(buf);
                }
            }
        }
        Some(session.clone())
    }

fn create_store_zip_and_hash(src_path: &Path, zip_path: &Path, entry_name: &str) -> Result<String, String> {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    let src_file = std::fs::File::open(src_path)
        .map_err(|e| format!("cannot open source file for zip: {}", e))?;
    let mut reader = std::io::BufReader::with_capacity(1024 * 1024, src_file);
    let dest_file = std::fs::File::create(zip_path)
        .map_err(|e| format!("cannot create zip file: {}", e))?;
    let mut writer = zip::ZipWriter::new(std::io::BufWriter::with_capacity(1024 * 1024, dest_file)).set_auto_large_file();
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    writer.start_file(entry_name, options)
        .map_err(|e| format!("cannot start zip entry: {}", e))?;
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
        writer.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    writer.finish()
        .map_err(|e| format!("cannot finalize zip: {}", e))?;
    Ok(format!("{:x}", hasher.finalize()))
}

    /// Upload one staged part wrapped in a store ZIP archive, then record it idempotently and mark it stored.
    pub(crate) fn send_part(&self, session: &ActiveUploadSession, part_idx: usize) -> Result<(), String> {
        let part = session.parts.get(part_idx).ok_or_else(|| "part not found".to_string())?;
        // A single-part native upload can send the source file itself — no
        // staging copy and no store-zip wrapper (downloaders unpack raw parts).
        let native_single = session.source_path.is_some() && session.parts.len() == 1;
        let path = if native_single {
            PathBuf::from(session.source_path.as_deref().unwrap_or_default())
        } else {
            self.part_file(&session.id, part_idx)
        };
        if !path.exists() {
            return Err(if native_single { "source file is missing" } else { "staged part file is missing" }.to_string());
        }
        self.telegram.bot_api.check_available()?;
        let base_filename = if session.parts.len() <= 1 {
            session.name.clone()
        } else {
            format!("{}.part{}", session.name, part_idx)
        };
        let (zip_path, sha) = if native_single {
            let s = sha256_file(&path)?;
            (path.clone(), s)
        } else {
            let z = path.with_extension(format!("zip.{}", part_idx));
            let s = Self::create_store_zip_and_hash(&path, &z, &base_filename)?;
            (z, s)
        };

        let caption = part_caption(&session.name, part_idx, session.parts.len(), &session.file_id, &session.blob_id, &sha);
        let channel = self.telegram.channel_id.clone();

        let deadline = Instant::now() + std::time::Duration::from_secs(120);
        let (bot_id, token) = loop {
            if let Some(bot) = self.db.acquire_optimal_bot() {
                break bot;
            }
            if Instant::now() >= deadline {
                let _ = std::fs::remove_file(&zip_path);
                return Err("all Telegram bots are busy".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        };

        let telegram = Arc::clone(&self.telegram);
        let upload_path = zip_path.clone();
        let upload_name = if native_single {
            base_filename.clone()
        } else {
            format!("{}.zip", base_filename)
        };
        let upload_caption = caption.clone();
        let upload_token = token.clone();
        let channel_for_upload = channel.clone();
        let is_native = session.source_path.is_some();
        let result = if is_native {
            // Native sessions reference the file by file:// so the Bot API
            // reads it directly — no loopback body copy. Multipart stays as an
            // automatic fallback on any file:// error (not a cloud fallback).
            let uri_token = upload_token.clone();
            let uri_ch = channel_for_upload.clone();
            let uri_path = upload_path.clone();
            let uri_cap = upload_caption.clone();
            let r = self.tokio_runtime.block_on(async move {
                telegram.upload_document_fileuri(&uri_token, &uri_ch, &uri_path, Some(&uri_cap)).await
            });
            match r {
                Ok(v) => Ok(v),
                Err(uri_err) => {
                    eprintln!("[TeleDrive] file:// upload failed ({}), falling back to multipart", uri_err);
                    let telegram = Arc::clone(&self.telegram);
                    let token = upload_token.clone();
                    let ch = channel.clone();
                    let name = upload_name.clone();
                    let p = upload_path.clone();
                    let cap = upload_caption.clone();
                    self.tokio_runtime.block_on(async move {
                        telegram.upload_document(&token, &ch, &name, &p, Some(&cap)).await
                    })
                }
            }
        } else {
            self.tokio_runtime.block_on(async move {
                telegram.upload_document(&upload_token, &channel_for_upload, &upload_name, &upload_path, Some(&upload_caption)).await
            })
        };
        if !native_single {
            let _ = std::fs::remove_file(&zip_path);
        }

        match result {
            Ok((message_id, telegram_file_id)) => {
                self.db.release_bot(&bot_id, true, part.size, None);

                let still_active = {
                    let lock = self.upload_lock(&session.id);
                    let _guard = lock.lock_safe();
                    let mut map = self.active_uploads.write_safe();
                    if let Some(current) = map.get_mut(&session.id) {
                        if let Some(p) = current.parts.get_mut(part_idx) {
                            p.status = "stored".to_string();
                            p.received_slices = (0..p.slice_count).collect();
                            p.telegram_file_id = Some(telegram_file_id.clone());
                            p.telegram_message_id = Some(message_id);
                            p.bot_id = Some(bot_id.clone());
                            p.sha256 = sha.clone();
                            p.started_at = None;
                            p.last_error = None;
                            true
                        } else { false }
                    } else { false }
                };

                if !still_active {
                    // Cancelled while the upload was in flight: delete the
                    // orphaned channel message instead of leaking storage.
                    let telegram = Arc::clone(&self.telegram);
                    let token = token.clone();
                    let channel = channel.clone();
                    let _ = self.tokio_runtime.block_on(async move {
                        telegram.delete_message(&token, &channel, message_id).await
                    });
                    return Ok(());
                }

                {
                    let mut state = self.db.state.write_safe();
                    if !state.parts.iter().any(|p| p.blob_id == session.blob_id && p.part_index == part_idx as i64) {
                        state.parts.push(PartRecord {
                            id: Uuid::new_v4().to_string(),
                            blob_id: session.blob_id.clone(),
                            part_index: part_idx as i64,
                            size: part.size,
                            sha256: sha.clone(),
                            telegram_file_id,
                            telegram_message_id: message_id,
                            telegram_channel_id: channel.clone(),
                            bot_id: bot_id.clone(),
                            created_at: Utc::now().timestamp_millis(),
                        });
                        state.parts.sort_by_key(|p| p.part_index);
                    }
                }
                self.db.save();
                if !native_single {
                    let _ = std::fs::remove_file(&path);
                }
                self.persist_session_by_id(&session.id);
                Ok(())
            }
            Err(e) => {
                self.db.release_bot(&bot_id, false, 0, Some(e.clone()));
                {
                    let lock = self.upload_lock(&session.id);
                    let _guard = lock.lock_safe();
                    let mut map = self.active_uploads.write_safe();
                    if let Some(current) = map.get_mut(&session.id) {
                        if let Some(p) = current.parts.get_mut(part_idx) {
                            let lower = e.to_lowercase();
                            let permanent = lower.contains("too big")
                                || lower.contains("file is too large")
                                || lower.contains("request entity too large")
                                || lower.contains("http 413");
                            p.attempts = if permanent { 5 } else { p.attempts + 1 };
                            p.status = if p.attempts >= 5 { "failed".to_string() } else { "pending".to_string() };
                            p.started_at = None;
                            p.last_error = Some(e.clone());
                        }
                    }
                }
                self.persist_session_by_id(&session.id);
                Err(e)
            }
        }
    }

    /// Validate and persist the completed file. Safe to call twice.
    pub(crate) fn finalize_upload(&self, session: &ActiveUploadSession) -> Result<serde_json::Value, String> {
        if session.parts.iter().any(|p| p.status != "stored") {
            return Err("not all parts are stored in Telegram".to_string());
        }

        let mut part_rows: Vec<PartRecord> = {
            let state = self.db.state.read_safe();
            state.parts.iter().filter(|p| p.blob_id == session.blob_id).cloned().collect()
        };
        // Rebuild durable rows from the session when a save raced with completion.
        for p in &session.parts {
            if part_rows.iter().any(|r| r.part_index == p.idx as i64) {
                continue;
            }
            match (p.telegram_file_id.as_ref(), p.telegram_message_id, p.bot_id.as_ref()) {
                (Some(file_id), Some(message_id), Some(bot_id)) => part_rows.push(PartRecord {
                    id: Uuid::new_v4().to_string(),
                    blob_id: session.blob_id.clone(),
                    part_index: p.idx as i64,
                    size: p.size,
                    sha256: p.sha256.clone(),
                    telegram_file_id: file_id.clone(),
                    telegram_message_id: message_id,
                    telegram_channel_id: self.telegram.channel_id.clone(),
                    bot_id: bot_id.clone(),
                    created_at: Utc::now().timestamp_millis(),
                }),
                _ => return Err(format!("part {} has no Telegram reference", p.idx)),
            }
        }
        part_rows.sort_by_key(|p| p.part_index);
        if part_rows.len() != session.parts.len() {
            return Err(format!("expected {} parts, found {}", session.parts.len(), part_rows.len()));
        }
        let total: u64 = part_rows.iter().map(|p| p.size).sum();
        if total != session.size {
            return Err(format!("part sizes sum to {}, expected {}", total, session.size));
        }
        for row in &part_rows {
            let expected = session.parts.get(row.part_index as usize)
                .ok_or_else(|| format!("unexpected part {}", row.part_index))?;
            if row.size != expected.size {
                return Err(format!("part {} size mismatch", row.part_index));
            }
        }

        let final_name = self.unique_file_name(session.folder_id.as_deref(), &session.name);
        let ext = std::path::Path::new(&final_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let category = match ext.as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => "image",
            "mp4" | "mkv" | "webm" | "mov" | "avi" => "video",
            "mp3" | "wav" | "ogg" | "flac" | "m4a" => "audio",
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" => "document",
            "zip" | "rar" | "7z" | "tar" | "gz" => "archive",
            _ => "other",
        }.to_string();

        let preview: &[u8] = session.preview.as_deref().unwrap_or(&[]);
        let parsed = if preview.is_empty() {
            ParsedImageMeta { width: None, height: None, taken_at: None, metadata_json: None }
        } else {
            parse_image_metadata(&ext, preview, session.size)
        };

        let mut has_thumb = 0;
        if !preview.is_empty() && (category == "image" || ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "webp") {
            let thumbs_dir = self.get_thumbnails_dir();
            let base = thumbs_dir.join(&session.file_id);
            let _ = std::fs::write(format!("{}.webp", base.display()), preview);
            let _ = std::fs::write(format!("{}.jpg", base.display()), preview);
            let _ = std::fs::write(format!("{}.png", base.display()), preview);
            let fallback_base = self.db.thumbnails_dir.join(&session.file_id);
            if fallback_base != base {
                let _ = std::fs::write(format!("{}.jpg", fallback_base.display()), preview);
            }
            has_thumb = 1;
        }

        let (file_width, file_height, file_duration, final_metadata, file_taken_at) = match category.as_str() {
            "image" => {
                (parsed.width, parsed.height, None, parsed.metadata_json, parsed.taken_at)
            }
            "video" => {
                let v = parse_video_metadata(&ext, preview);
                (v.width, v.height, v.duration, v.metadata_json, None)
            }
            "audio" => {
                let a = parse_audio_metadata(&ext, preview);
                (None, None, a.duration, a.metadata_json, None)
            }
            "document" if ext == "pdf" => {
                let m = parse_pdf_metadata(preview);
                (None, None, None, m, None)
            }
            "code" | "document" => {
                let m = std::str::from_utf8(preview).ok().map(|text| {
                    serde_json::to_string(&serde_json::json!({
                        "lines": text.lines().count(),
                        "words": text.split_whitespace().count(),
                        "characters": text.chars().count()
                    })).unwrap_or_default()
                });
                (None, None, None, m, None)
            }
            _ => (parsed.width, parsed.height, None, parsed.metadata_json, None)
        };

        let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
        sha2::Digest::update(&mut hasher, session.size.to_le_bytes());
        for p in &part_rows {
            sha2::Digest::update(&mut hasher, p.sha256.as_bytes());
        }
        let content_sha = format!("{:x}", sha2::Digest::finalize(hasher));

        let now = Utc::now().timestamp_millis();
        let file_rec = FileRecord {
            id: session.file_id.clone(),
            folder_id: session.folder_id.clone(),
            blob_id: session.blob_id.clone(),
            name: final_name,
            extension: ext,
            mime_type: session.mime_type.clone(),
            category,
            size: session.size,
            status: "ready".to_string(),
            description: "".to_string(),
            tags: "".to_string(),
            starred: 0,
            has_thumbnail: has_thumb,
            width: file_width,
            height: file_height,
            duration: file_duration,
            metadata: final_metadata,
            taken_at: file_taken_at,
            trashed_at: None,
            trash_root: 0,
            last_accessed_at: None,
            created_at: now,
            updated_at: now,
        };
        let blob_rec = BlobRecord {
            id: session.blob_id.clone(),
            size: session.size,
            sha256: content_sha,
            created_at: now,
        };

        {
            let mut state = self.db.state.write_safe();
            state.parts.retain(|p| p.blob_id != session.blob_id);
            state.parts.extend(part_rows);
            state.parts.sort_by_key(|p| p.part_index);
            state.blobs.retain(|b| b.id != session.blob_id);
            state.blobs.push(blob_rec);
            state.files.retain(|f| f.id != session.file_id);
            state.files.insert(0, file_rec.clone());
        }
        self.db.save();

        let dto = Database::to_file_dto(&file_rec, session.parts.len());
        serde_json::to_value(dto).map_err(|e| e.to_string())
    }

    /// Remove trash roots that have exceeded the retention window. Works for
    /// both local vault parts and legacy Telegram-backed parts.
    fn purge_expired_trash(&self, retention_days: i64) -> usize {
        let (files, folders, part_targets) = self.db.expired_trash_targets(retention_days);
        if files.is_empty() && folders.is_empty() {
            return 0;
        }
        self.delete_telegram_parts(&part_targets);
        self.db.purge_deleted_records(&files, &folders);
        files.len() + folders.len()
    }

    /// Periodic self-maintenance: expire old trash and sweep orphaned vault
    /// parts. Runs on startup and then once a day for long-running sessions.
    /// Remove resumable sessions that outlived their 48-hour window. Their
    /// staged files and any vault parts already stored for them are released.
    fn purge_expired_uploads(&self) -> usize {
        let cutoff = Utc::now().timestamp_millis() - 48 * 3600 * 1000;
        let expired: Vec<ActiveUploadSession> = {
            let uploads = self.active_uploads.read_safe();
            uploads.values()
                .filter(|s| s.status != "finalizing"
                    && s.created_at < cutoff
                    && !s.parts.iter().any(|p| p.status == "uploading"))
                .cloned()
                .collect()
        };
        for session in &expired {
            self.discard_upload(session);
        }
        expired.len()
    }

    fn run_housekeeping(&self) -> (usize, usize, usize, usize) {
        let purged = self.purge_expired_trash(crate::db::TRASH_RETENTION_DAYS);
        let expired_uploads = self.purge_expired_uploads();
        let staged_parts: std::collections::HashSet<String> = self.active_uploads.read_safe()
            .values()
            .flat_map(|session| session.parts.iter())
            .filter_map(|part| part.telegram_file_id.as_deref())
            .filter_map(|file_id| file_id.strip_prefix("local:"))
            .filter_map(|raw| raw.parse::<i64>().ok())
            .map(|id| id.unsigned_abs().to_string())
            .collect();
        let orphans = self.db.cleanup_orphan_vault_files(24 * 3600, &staged_parts);
        let stale_cache = self.db.cleanup_stale_cache_files(24 * 3600);
        // Abandoned download staging files older than a day, and stream-cache
        // files beyond the configured LRU limit.
        self.native_downloads.sweep_tmp_downloads(Some(std::time::Duration::from_secs(24 * 3600)));
        self.prune_stream_cache();
        (purged, expired_uploads, orphans, stale_cache)
    }

    /// Create a new text file or replace an existing file's contents, uploading
    /// directly to Telegram Cloud. Returns the file DTO.
    fn write_text_file(
        &self,
        replace_id: Option<&str>,
        folder_id: Option<String>,
        name: &str,
        content: &str,
    ) -> Result<serde_json::Value, (u16, String)> {
        const TEXT_LIMIT: usize = 10 * 1024 * 1024;
        if content.len() > TEXT_LIMIT {
            return Err((400, "content exceeds 10 MiB".to_string()));
        }

        let final_name = if let Some(id) = replace_id {
            let state = self.db.state.read_safe();
            match state.files.iter().find(|f| f.id == id && f.trashed_at.is_none()) {
                Some(file) => file.name.clone(),
                None => return Err((404, "File not found".to_string())),
            }
        } else {
            if let Some(ref folder) = folder_id {
                let state = self.db.state.read_safe();
                if !state.folders.iter().any(|f| f.id == *folder && f.trashed_at.is_none()) {
                    return Err((404, "Folder not found".to_string()));
                }
            }
            self.unique_file_name(folder_id.as_deref(), name)
        };

        let ext = std::path::Path::new(&final_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = match ext.as_str() {
            "md" | "markdown" => "text/markdown",
            "json" => "application/json",
            "csv" => "text/csv",
            "xml" => "application/xml",
            "html" | "htm" | "txt" => "text/plain",
            _ => "text/plain",
        }.to_string();

        let now = Utc::now().timestamp_millis();
        let blob_id = Uuid::new_v4().to_string();
        let target_file_id: String = replace_id.map(|s| s.to_string()).unwrap_or_else(|| Uuid::new_v4().to_string());
        let size = content.len() as u64;
        let sha = {
            let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
            sha2::Digest::update(&mut hasher, content.as_bytes());
            format!("{:x}", sha2::Digest::finalize(hasher))
        };

        // Write content to a temporary cache file to stream-upload to Telegram
        let temp_upload_path = self.db.cache_dir.join(format!("txt_{}.tmp", Uuid::new_v4()));
        std::fs::write(&temp_upload_path, content.as_bytes())
            .map_err(|e| (500, format!("cannot stage text file: {}", e)))?;

        let deadline = Instant::now() + std::time::Duration::from_secs(60);
        let (bot_id, token) = loop {
            if let Some(bot) = self.db.acquire_optimal_bot() {
                break bot;
            }
            if Instant::now() >= deadline {
                let _ = std::fs::remove_file(&temp_upload_path);
                return Err((500, "all Telegram bots are busy".to_string()));
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        };

        let telegram = Arc::clone(&self.telegram);
        let channel = self.telegram.channel_id.clone();
        let upload_path = temp_upload_path.clone();
        let upload_name = final_name.clone();
        let caption = part_caption(&final_name, 0, 1, &target_file_id, &blob_id, &sha);
        let upload_token = token.clone();
        let channel_for_upload = channel.clone();
        let result = self.tokio_runtime.block_on(async move {
            telegram.upload_document(&upload_token, &channel_for_upload, &upload_name, &upload_path, Some(&caption)).await
        });
        let _ = std::fs::remove_file(&temp_upload_path);

        let (message_id, file_id_str) = match result {
            Ok((msg_id, fid)) => {
                self.db.release_bot(&bot_id, true, size, None);
                (msg_id, fid)
            }
            Err(e) => {
                self.db.release_bot(&bot_id, false, 0, Some(e.clone()));
                return Err((500, format!("cannot upload text file to Telegram: {}", e)));
            }
        };

        let part = PartRecord {
            id: Uuid::new_v4().to_string(),
            blob_id: blob_id.clone(),
            part_index: 0,
            size,
            sha256: sha.clone(),
            telegram_file_id: file_id_str,
            telegram_message_id: message_id,
            telegram_channel_id: self.telegram.channel_id.clone(),
            bot_id,
            created_at: now,
        };
        let blob = BlobRecord { id: blob_id.clone(), size, sha256: sha, created_at: now };
        let metadata = serde_json::to_string(&serde_json::json!({
            "lines": content.lines().count(),
            "words": content.split_whitespace().count(),
            "characters": content.chars().count()
        })).ok();

        let mut old_part_files: Vec<std::path::PathBuf> = Vec::new();
        let mut old_message_ids: Vec<i64> = Vec::new();
        let file_id;
        {
            let mut state = self.db.state.write_safe();
            let old_blob = if let Some(id) = replace_id {
                let file = state.files.iter_mut()
                    .find(|f| f.id == id && f.trashed_at.is_none())
                    .ok_or_else(|| (404, "File not found".to_string()))?;
                let old = file.blob_id.clone();
                file.blob_id = blob_id.clone();
                file.size = size;
                file.extension = ext.clone();
                file.mime_type = mime.clone();
                file.category = crate::models::detect_category(&mime, &ext).to_string();
                file.metadata = metadata;
                file.status = "ready".to_string();
                file.updated_at = now;
                file_id = file.id.clone();
                Some(old)
            } else {
                let id = target_file_id.clone();
                let category = crate::models::detect_category(&mime, &ext).to_string();
                state.files.insert(0, FileRecord {
                    id: id.clone(),
                    folder_id,
                    blob_id: blob_id.clone(),
                    name: final_name,
                    extension: ext,
                    mime_type: mime,
                    category,
                    size,
                    status: "ready".to_string(),
                    description: String::new(),
                    tags: String::new(),
                    starred: 0,
                    has_thumbnail: 0,
                    width: None,
                    height: None,
                    duration: None,
                    metadata,
                    taken_at: None,
                    trashed_at: None,
                    trash_root: 0,
                    last_accessed_at: None,
                    created_at: now,
                    updated_at: now,
                });
                file_id = id;
                None
            };

            state.blobs.push(blob);
            state.parts.push(part);

            if let Some(old) = old_blob {
                if !state.files.iter().any(|f| f.blob_id == old) {
                    for p in state.parts.iter().filter(|p| p.blob_id == old) {
                        if p.telegram_message_id < 0 {
                            if let Some(path) = self.db.local_path_for_file_id(&p.telegram_file_id) {
                                old_part_files.push(path);
                            }
                        } else if p.telegram_message_id > 0 {
                            old_message_ids.push(p.telegram_message_id);
                        }
                    }
                    state.parts.retain(|p| p.blob_id != old);
                    state.blobs.retain(|b| b.id != old);
                }
            }
        }
        for path in old_part_files {
            let _ = std::fs::remove_file(path);
        }
        if !old_message_ids.is_empty() {
            let telegram = Arc::clone(&self.telegram);
            let channel = self.telegram.channel_id.clone();
            let token = self.db.any_bot_token().unwrap_or_default();
            let _ = self.tokio_runtime.block_on(async move {
                telegram.delete_messages(&token, &channel, &old_message_ids).await
            });
        }
        self.db.save();

        let state = self.db.state.read_safe();
        let file = state.files.iter().find(|f| f.id == file_id)
            .ok_or_else(|| (500, "File disappeared after save".to_string()))?;
        let part_count = state.parts.iter().filter(|p| p.blob_id == file.blob_id).count();
        serde_json::to_value(Database::to_file_dto(file, part_count))
            .map_err(|e| (500, e.to_string()))
    }

    /// Build a stored-format ZIP for the selected files/folders. The archive
    /// is written to the cache folder and served by GET /api/zip/:id.
    fn create_zip_archive(&self, file_ids: &[String], folder_ids: &[String]) -> Result<String, (u16, String)> {
        let entries = self.db.zip_entries(file_ids, folder_ids);
        if entries.is_empty() {
            return Err((400, "Select at least one file or folder to archive".to_string()));
        }

        let total_uncompressed: u64 = entries.iter()
            .filter_map(|(_, file)| file.as_ref().map(|f| f.size))
            .sum();
        let (free, total) = self.db.disk_space();
        const ZIP_RESERVE: u64 = 64 * 1024 * 1024;
        if total > 0 && free < total_uncompressed.saturating_add(ZIP_RESERVE) {
            return Err((507, format!(
                "Not enough free disk space to build this ZIP: need about {}, only {} available.",
                human_bytes(total_uncompressed.saturating_add(ZIP_RESERVE)), human_bytes(free)
            )));
        }

        let parts_by_blob: HashMap<String, Vec<PartRecord>> = {
            let state = self.db.state.read_safe();
            let mut map: HashMap<String, Vec<PartRecord>> = HashMap::new();
            for part in &state.parts {
                map.entry(part.blob_id.clone()).or_default().push(part.clone());
            }
            map
        };

        let cache_dir = self.db.data_dir.join("cache");
        std::fs::create_dir_all(&cache_dir)
            .map_err(|e| (500, format!("cannot create cache folder: {}", e)))?;
        let id = Uuid::new_v4().to_string();
        let path = cache_dir.join(format!("zip-{}.zip", id));

        let result = (|| -> Result<(), String> {
            let file = std::fs::File::create(&path)
                .map_err(|e| format!("cannot create ZIP file: {}", e))?;
            let mut writer = zip::ZipWriter::new(std::io::BufWriter::new(file)).set_auto_large_file();
            let dir_options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .unix_permissions(0o755);

            for (name, record) in &entries {
                match record {
                    None => {
                        writer.add_directory(name.as_str(), dir_options)
                            .map_err(|e| format!("cannot add folder to ZIP: {}", e))?;
                    }
                    Some(metadata) => {
                        let file_options = zip::write::SimpleFileOptions::default()
                            .compression_method(zip::CompressionMethod::Stored)
                            .large_file(metadata.size > u32::MAX as u64)
                            .unix_permissions(0o644);
                        writer.start_file(name.as_str(), file_options)
                            .map_err(|e| format!("cannot add {} to ZIP: {}", metadata.name, e))?;

                        let mut parts = parts_by_blob.get(&metadata.blob_id).cloned().unwrap_or_default();
                        parts.sort_by_key(|p| p.part_index);
                        let mut written = 0u64;

                        if parts.iter().all(|p| p.telegram_file_id.starts_with("local:")) {
                            for part in &parts {
                                let part_path = self.db.local_path_for_file_id(&part.telegram_file_id)
                                    .ok_or_else(|| format!("invalid local part for {}", metadata.name))?;
                                let mut source = std::fs::File::open(&part_path)
                                    .map_err(|e| format!("cannot read {}: {}", metadata.name, e))?;
                                written += std::io::copy(&mut source, &mut writer)
                                    .map_err(|e| format!("cannot write {} to ZIP: {}", metadata.name, e))?;
                            }
                        } else {
                            let temp = cache_dir.join(format!("zip-src-{}.bin", Uuid::new_v4()));
                            let telegram = Arc::clone(&self.telegram);
                            let download_path = temp.clone();
                            let download = self.tokio_runtime.block_on(async move {
                                telegram.download_parts_to_file(&parts, &download_path).await
                            });
                            match download {
                                Ok(got) if got == metadata.size => {
                                    let mut source = std::fs::File::open(&temp)
                                        .map_err(|e| format!("cannot read downloaded {}: {}", metadata.name, e))?;
                                    written = std::io::copy(&mut source, &mut writer)
                                        .map_err(|e| format!("cannot write {} to ZIP: {}", metadata.name, e))?;
                                }
                                Ok(got) => {
                                    let _ = std::fs::remove_file(&temp);
                                    return Err(format!(
                                        "{} changed while archiving ({} of {} bytes)",
                                        metadata.name, got, metadata.size
                                    ));
                                }
                                Err(e) => {
                                    let _ = std::fs::remove_file(&temp);
                                    return Err(format!("cannot download {} for ZIP: {}", metadata.name, e));
                                }
                            }
                            let _ = std::fs::remove_file(&temp);
                        }

                        if written != metadata.size {
                            return Err(format!(
                                "{} changed while archiving ({} of {} bytes)",
                                metadata.name, written, metadata.size
                            ));
                        }
                    }
                }
            }

            let mut output = writer.finish().map_err(|e| format!("cannot finish ZIP: {}", e))?;
            output.flush().map_err(|e| format!("cannot flush ZIP: {}", e))?;
            Ok(())
        })();

        match result {
            Ok(()) => Ok(id),
            Err(message) => {
                let _ = std::fs::remove_file(&path);
                Err((500, message))
            }
        }
    }

    pub fn start(&self) {
        let addr = format!("127.0.0.1:{}", self.port);
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("Failed to bind to {}: {}", addr, e);
                return;
            }
        };

        println!("TeleDrive native server listening on http://{}", addr);
        let server_ref = Arc::new(server);

        // High-concurrency worker thread pool matching multi-bot parallel throughput
        for _ in 0..32 {
            let s = Arc::clone(&server_ref);
            let handler = self.clone();
            std::thread::spawn(move || {
                for request in s.incoming_requests() {
                    // A panic in one request must never kill the worker or the
                    // accept loop — log it and keep serving.
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        handler.handle_request(request);
                    })).is_err() {
                        eprintln!("[TeleDrive] request handler panicked — connection dropped, worker continues");
                    }
                }
            });
        }

        // Housekeeping runs in the background so a slow Telegram deletion can
        // never delay the desktop window or the local API.
        let housekeeping = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(2));
            loop {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| housekeeping.run_housekeeping()));
                let (purged, expired_uploads, orphans, stale_cache) = match result {
                    Ok(v) => v,
                    Err(_) => {
                        eprintln!("[TeleDrive] housekeeping panicked — will retry next cycle");
                        std::thread::sleep(std::time::Duration::from_secs(3600));
                        continue;
                    }
                };
                if purged > 0 || expired_uploads > 0 || orphans > 0 || stale_cache > 0 {
                    println!(
                        "[TeleDrive] Cleanup: {} expired trash item(s), {} expired upload(s), {} orphan vault file(s), {} stale cache file(s)",
                        purged, expired_uploads, orphans, stale_cache
                    );
                }
                std::thread::sleep(std::time::Duration::from_secs(3600));
            }
        });
    }

    fn handle_request(&self, request: Request) {
        let raw_url = request.url().to_string();
        let parsed_url = Url::parse(&format!("http://127.0.0.1{}", raw_url)).unwrap_or_else(|_| Url::parse("http://127.0.0.1/").unwrap());
        let path = parsed_url.path().to_string();

        // The embedded app is same-origin, so a foreign Host/Origin means a
        // browser or DNS-rebinding attempt reached the loopback port.
        if let Some(host) = request.headers().iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Host"))
            .map(|h| h.value.as_str().to_string())
        {
            let allowed = host.eq_ignore_ascii_case(&format!("127.0.0.1:{}", self.port))
                || host.eq_ignore_ascii_case(&format!("localhost:{}", self.port));
            if !allowed {
                self.send_json(request, 403, &serde_json::json!({
                    "error": { "code": "FORBIDDEN", "message": "invalid host" }
                }));
                return;
            }
        }
        if let Some(origin) = request.headers().iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Origin"))
            .map(|h| h.value.as_str().to_string())
        {
            let allowed = origin.eq_ignore_ascii_case(&format!("http://127.0.0.1:{}", self.port))
                || origin.eq_ignore_ascii_case(&format!("http://localhost:{}", self.port));
            if !allowed {
                self.send_json(request, 403, &serde_json::json!({
                    "error": { "code": "FORBIDDEN", "message": "invalid origin" }
                }));
                return;
            }
        }

        // Every state-changing request must carry the app's custom header.
        // This blocks cross-site form/fetch CSRF against the loopback server.
        let method = request.method().clone();
        if matches!(method, Method::Post | Method::Put | Method::Patch | Method::Delete) {
            let header_ok = request.headers().iter().any(|h| {
                h.field.as_str().as_str().eq_ignore_ascii_case("X-Requested-With")
                    && h.value.as_str() == "teledrive"
            });
            if !header_ok {
                self.send_json(request, 403, &serde_json::json!({
                    "error": { "code": "FORBIDDEN", "message": "missing X-Requested-With header" }
                }));
                return;
            }
        }

        if path.starts_with("/api/") {
            self.handle_api(request, &path, &parsed_url);
        } else {
            self.handle_static(request, &path);
        }
    }

    fn send_json<T: serde::Serialize>(&self, request: Request, status: u16, data: &T) {
        let json = serde_json::to_string(data).unwrap_or_else(|_| "{}".to_string());
        let len = json.len();
        let cursor = Cursor::new(json.into_bytes());
        let response = Response::new(
            StatusCode(status),
            vec![
                Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap(),
                Header::from_bytes(&b"Content-Length"[..], len.to_string().as_bytes()).unwrap(),
            ],
            cursor,
            Some(len),
            None,
        );
        let _ = request.respond(response);
    }

    fn send_bytes(&self, request: Request, status: u16, mime: &str, bytes: Vec<u8>, filename: Option<&str>, cache_control: Option<&str>) {
        let total_len = bytes.len();
        let range_header = request.headers().iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Range"))
            .map(|h| h.value.as_str().to_string());

        // HTTP 206 Partial Content support for smooth audio/video scrubbing and chunk streaming
        if let (200, Some(range_val)) = (status, range_header) {
            if let Some(range_spec) = range_val.strip_prefix("bytes=") {
                let parts: Vec<&str> = range_spec.split('-').collect();
                let start: usize = parts.get(0).and_then(|s| s.parse().ok()).unwrap_or(0);
                let end: usize = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or_else(|| total_len.saturating_sub(1));

                if start < total_len && start <= end {
                    let end = end.min(total_len.saturating_sub(1));
                    let chunk_len = end - start + 1;
                    let sliced = bytes[start..=end].to_vec();

                    let mut headers = vec![
                        Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap(),
                        Header::from_bytes(&b"Content-Length"[..], chunk_len.to_string().as_bytes()).unwrap(),
                        Header::from_bytes(&b"Content-Range"[..], format!("bytes {}-{}/{}", start, end, total_len).as_bytes()).unwrap(),
                        Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap(),
                    ];
                    if let Some(cc) = cache_control {
                        if let Ok(h) = Header::from_bytes(&b"Cache-Control"[..], cc.as_bytes()) {
                            headers.push(h);
                        }
                    }
                    if let Some(fname) = filename {
                        let disposition = content_disposition(fname);
                        if let Ok(h) = Header::from_bytes(&b"Content-Disposition"[..], disposition.as_bytes()) {
                            headers.push(h);
                        }
                    }
                    let cursor = Cursor::new(sliced);
                    let response = Response::new(StatusCode(206), headers, cursor, Some(chunk_len), None);
                    let _ = request.respond(response);
                    return;
                }
            }
        }

        let len = bytes.len();
        let mut headers = vec![
            Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap(),
            Header::from_bytes(&b"Content-Length"[..], len.to_string().as_bytes()).unwrap(),
            Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap(),
        ];
        if let Some(cc) = cache_control {
            if let Ok(h) = Header::from_bytes(&b"Cache-Control"[..], cc.as_bytes()) {
                headers.push(h);
            }
        }
        if let Some(fname) = filename {
            let disposition = content_disposition(fname);
            if let Ok(h) = Header::from_bytes(&b"Content-Disposition"[..], disposition.as_bytes()) {
                headers.push(h);
            }
        }
        let cursor = Cursor::new(bytes);
        let response = Response::new(StatusCode(status), headers, cursor, Some(len), None);
        let _ = request.respond(response);
    }

    /// Serve a file from disk with byte-range support. Streaming from disk
    /// keeps memory flat for multi-gigabyte files.
    fn send_file(
        &self,
        request: Request,
        mime: &str,
        path: &std::path::Path,
        filename: Option<&str>,
        cache_control: Option<&str>,
        total_len: u64,
    ) {
        let mut file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(e) => {
                self.send_json(request, 500, &serde_json::json!({ "error": { "code": "READ_FAILED", "message": e.to_string() } }));
                return;
            }
        };
        let range_header = request.headers().iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Range"))
            .map(|h| h.value.as_str().to_string());
        let (status, start, end) = parse_byte_range(range_header.as_deref(), total_len);
        if start > 0 {
            if let Err(e) = file.seek(SeekFrom::Start(start)) {
                self.send_json(request, 500, &serde_json::json!({ "error": { "code": "READ_FAILED", "message": e.to_string() } }));
                return;
            }
        }
        self.respond_range(request, mime, file, filename, cache_control, status, start, end, total_len);
    }

    /// Serve local vault parts directly, with Range support. Nothing is copied
    /// or buffered, so a paused/resumed download can restart at any byte.
    fn send_local_parts(
        &self,
        request: Request,
        parts: &[PartRecord],
        mime: &str,
        filename: Option<&str>,
        total_len: u64,
    ) {
        let mut paths = Vec::with_capacity(parts.len());
        for part in parts {
            let Some(path) = self.db.local_path_for_file_id(&part.telegram_file_id) else {
                self.send_json(request, 500, &serde_json::json!({ "error": { "code": "LOCAL_PART_INVALID", "message": "part is not stored in the local vault" } }));
                return;
            };
            if !path.exists() {
                self.send_json(request, 404, &serde_json::json!({ "error": { "code": "LOCAL_PART_MISSING", "message": format!("local part {} is missing from the vault", part.telegram_file_id) } }));
                return;
            }
            paths.push(path);
        }

        let range_header = request.headers().iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Range"))
            .map(|h| h.value.as_str().to_string());
        let (status, start, end) = parse_byte_range(range_header.as_deref(), total_len);
        match MultiFileReader::open(&paths, start) {
            Ok((reader, actual_len)) if actual_len == total_len => {
                self.respond_range(request, mime, reader, filename, None, status, start, end, total_len);
            }
            Ok((_, actual_len)) => {
                eprintln!("Local vault size mismatch: got {}, expected {}", actual_len, total_len);
                self.send_json(request, 502, &serde_json::json!({ "error": { "code": "SIZE_MISMATCH", "message": "local vault content does not match the stored file size" } }));
            }
            Err(e) => {
                self.send_json(request, 500, &serde_json::json!({ "error": { "code": "READ_FAILED", "message": e.to_string() } }));
            }
        }
    }

    /// Build a ranged response around an already-positioned reader.
    #[allow(clippy::too_many_arguments)]
    fn respond_range<R: Read + Send + 'static>(
        &self,
        request: Request,
        mime: &str,
        reader: R,
        filename: Option<&str>,
        cache_control: Option<&str>,
        status: u16,
        start: u64,
        end: u64,
        total_len: u64,
    ) {
        let chunk_len = if total_len == 0 { 0 } else { end.saturating_sub(start) + 1 };
        let mut headers = vec![
            Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap(),
            Header::from_bytes(&b"Content-Length"[..], chunk_len.to_string().as_bytes()).unwrap(),
            Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap(),
        ];
        if status == 206 {
            headers.push(Header::from_bytes(
                &b"Content-Range"[..],
                format!("bytes {}-{}/{}", start, end, total_len).as_bytes(),
            ).unwrap());
        }
        if let Some(cc) = cache_control {
            if let Ok(h) = Header::from_bytes(&b"Cache-Control"[..], cc.as_bytes()) {
                headers.push(h);
            }
        }
        if let Some(fname) = filename {
            let disposition = content_disposition(fname);
            if let Ok(h) = Header::from_bytes(&b"Content-Disposition"[..], disposition.as_bytes()) {
                headers.push(h);
            }
        }
        let response = Response::new(
            StatusCode(status),
            headers,
            reader.take(chunk_len),
            Some(chunk_len as usize),
            None,
        );
        let _ = request.respond(response);
    }

    fn handle_static(&self, request: Request, _path: &str) {
        let html = r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>TeleDrive Native</title></head>
<body style="background:#0d1016;color:#f3f4f6;font-family:Segoe UI,sans-serif;padding:60px 20px;text-align:center;">
<h2 style="font-size:24px;margin-bottom:8px;">TeleDriveR Native Engine v3.1.7</h2>
<p style="color:#94a3b8;font-size:14px;">100% Pure Native Rust GUI running on desktop.</p>
</body>
</html>"#;
        self.send_bytes(request, 200, "text/html; charset=utf-8", html.as_bytes().to_vec(), None, Some("no-cache"));
    }

    fn handle_api(&self, mut request: Request, path: &str, url: &Url) {
        let method = request.method().clone();
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();

        match (method, path) {
            (Method::Get, "/api/auth/me") => {
                self.send_json(request, 200, &serde_json::json!({
                    "authenticated": true,
                    "user": {
                        "id": "admin",
                        "username": "admin",
                        "role": "admin",
                        "createdAt": 1700000000000i64
                    }
                }));
            }

            (Method::Post, "/api/auth/login") => {
                self.send_json(request, 200, &serde_json::json!({
                    "success": true,
                    "user": { "id": "admin", "username": "admin", "role": "admin" }
                }));
            }

            (Method::Post, "/api/auth/logout") => {
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Get, "/api/auth/sessions") => {
                let now = Utc::now().timestamp_millis();
                self.send_json(request, 200, &serde_json::json!({
                    "sessions": [{
                        "id": "desktop-current",
                        "createdAt": now - 3600000,
                        "lastSeenAt": now,
                        "expiresAt": now + 864000000,
                        "ip": "127.0.0.1",
                        "userAgent": "TeleDrive Desktop App (Windows Native)",
                        "current": true
                    }]
                }));
            }

            (Method::Delete, p) if p.starts_with("/api/auth/sessions/") => {
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Post, "/api/auth/password") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    if let Some(np) = json.get("newPassword").and_then(|v| v.as_str()) {
                        let mut state = self.db.state.write_safe();
                        state.admin_password = Some(np.to_string());
                        drop(state);
                        self.db.save();
                    }
                }
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Get, "/api/drive") => {
                let folder_id = params.get("folderId").map(|s| s.as_str());
                let response = self.db.get_drive_contents(folder_id);
                self.send_json(request, 200, &response);
            }

            (Method::Get, "/api/starred") => {
                let (files, folders) = self.db.get_starred();
                self.send_json(request, 200, &serde_json::json!({ "files": files, "folders": folders }));
            }

            (Method::Get, "/api/recent") => {
                let limit = params.get("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(200);
                let files = self.db.get_recent(limit);
                self.send_json(request, 200, &serde_json::json!({ "files": files }));
            }

            (Method::Get, "/api/trash") => {
                let (files, folders, total_size) = self.db.get_trash();
                self.send_json(request, 200, &serde_json::json!({
                    "files": files,
                    "folders": folders,
                    "totalSize": total_size
                }));
            }

            (Method::Delete, "/api/trash") => {
                let (all_files, all_folders, part_targets) = self.db.get_deletion_targets_for_trash();
                let deleted_count = part_targets.len();
                self.delete_telegram_parts(&part_targets);
                for fid in &all_files {
                    self.remove_stream_cache(fid);
                }
                self.db.purge_deleted_records(&all_files, &all_folders);
                self.trigger_mirror_sync();
                self.send_json(request, 200, &serde_json::json!({
                    "success": true,
                    "affected": all_files.len() + all_folders.len(),
                    "deletedMessages": deleted_count
                }));
            }

            (Method::Get, "/api/search") => {
                let filter = SearchFilter {
                    q: params.get("q").cloned().unwrap_or_default(),
                    category: params.get("category").cloned(),
                    min_size: params.get("minSize").and_then(|s| s.parse().ok()),
                    max_size: params.get("maxSize").and_then(|s| s.parse().ok()),
                    from: params.get("from").and_then(|s| s.parse().ok()),
                    to: params.get("to").and_then(|s| s.parse().ok()),
                    folder_id: params.get("folderId").cloned(),
                    starred: params.get("starred").map(|s| s == "true" || s == "1"),
                };
                let (files, folders, total) = self.db.search(&filter);
                self.send_json(request, 200, &serde_json::json!({
                    "files": files,
                    "folders": folders,
                    "total": total
                }));
            }

            (Method::Get, p) if p == "/api/search/suggest" || p == "/api/search/suggestions" => {
                let q = params.get("q").cloned().unwrap_or_default();
                let suggestions = self.db.suggest(&q);
                self.send_json(request, 200, &serde_json::json!({ "suggestions": suggestions }));
            }

            (Method::Get, "/api/stats") => {
                let stats = self.db.get_stats();
                self.send_json(request, 200, &stats);
            }

            (Method::Get, "/api/system") => {
                let mut sys = self.db.get_system_info();
                {
                    let uploads = self.active_uploads.read_safe();
                    let received = uploads.values()
                        .flat_map(|s| s.parts.iter())
                        .filter(|p| p.received_slices.len() >= p.slice_count.max(1))
                        .count();
                    let uploading = uploads.values()
                        .flat_map(|s| s.parts.iter())
                        .filter(|p| p.status == "uploading")
                        .count();
                    let failed = uploads.values()
                        .flat_map(|s| s.parts.iter())
                        .filter(|p| p.status == "failed")
                        .count();
                    sys.queue = serde_json::json!({
                        "receivedParts": received,
                        "uploadingParts": uploading,
                        "failedParts": failed,
                        "pendingDeletions": 0
                    });
                }
                let status = self.telegram.bot_api.check_available();
                sys.bot_api = serde_json::json!({
                    "url": self.telegram.bot_api_url,
                    "reachable": status.is_ok(),
                    "error": status.err(),
                    "latencyMs": 0
                });
                sys.channel = serde_json::json!({
                    "id": self.telegram.channel_id,
                    "title": "Private Telegram channel"
                });
                let limit_bytes = {
                    let state = self.db.state.read_safe();
                    state.cache_limit_gb.clamp(1, 500) * 1024 * 1024 * 1024
                };
                let files = self.stream_cache_files();
                sys.cache = serde_json::json!({
                    "usedBytes": files.iter().map(|f| f.1).sum::<u64>(),
                    "maxBytes": limit_bytes,
                    "files": files.len()
                });
                self.send_json(request, 200, &sys);
            }

            (Method::Post, "/api/system/retry-failed") => {
                let mut retried_uploads = 0usize;
                let mut retried_parts = 0usize;
                let mut touched_ids: Vec<String> = Vec::new();
                {
                    let mut uploads = self.active_uploads.write_safe();
                    for session in uploads.values_mut() {
                        let mut touched = false;
                        for part in &mut session.parts {
                            if part.status == "failed" {
                                part.status = "pending".to_string();
                                part.last_error = None;
                                part.started_at = None;
                                part.attempts = 0;
                                retried_parts += 1;
                                touched = true;
                            }
                        }
                        if touched {
                            session.status = "active".to_string();
                            touched_ids.push(session.id.clone());
                            retried_uploads += 1;
                        }
                    }
                }
                for id in &touched_ids {
                    self.persist_session_by_id(id);
                    if self.active_uploads.read_safe().get(id)
                        .map(|s| s.source_path.is_some()).unwrap_or(false) {
                        self.spawn_native_feeder(id.clone());
                    }
                }
                self.send_json(request, 200, &serde_json::json!({
                    "ok": true,
                    "retried": retried_uploads,
                    "parts": retried_parts
                }));
            }

            (Method::Post, "/api/system/verify-vault") => {
                let result = self.db.verify_vault();
                self.send_json(request, 200, &result);
            }

            (Method::Post, "/api/system/clear-cache") => {
                let freed = self.clear_stream_cache();
                self.send_json(request, 200, &serde_json::json!({
                    "success": true,
                    "freedBytes": freed
                }));
            }

            (Method::Post, "/api/system/open-vault") => {
                let _ = std::fs::create_dir_all(&self.db.vault_files_dir);
                let path = self.db.vault_dir.clone();
                match open_in_file_manager(&path) {
                    Ok(()) => self.send_json(request, 200, &serde_json::json!({
                        "success": true,
                        "path": path.to_string_lossy()
                    })),
                    Err(e) => self.send_json(request, 500, &serde_json::json!({
                        "error": { "code": "OPEN_FAILED", "message": e.to_string() }
                    })),
                }
            }

            (Method::Get, "/api/settings") => {
                let max_allowed = self.max_part_size_mb();
                let (effective_mb, configured_mb, slice_mb, client, telegram, per_bot, dl_conc, cache_gb) = {
                    let state = self.db.state.read_safe();
                    (
                        state.part_size_mb.clamp(5, max_allowed),
                        state.part_size_mb,
                        state.slice_size_mb.clamp(1, 256),
                        state.client_upload_concurrency.clamp(1, 32),
                        state.telegram_upload_concurrency.min(64),
                        state.bot_max_concurrent_uploads.clamp(1, 8),
                        state.download_concurrency.clamp(1, 8),
                        state.cache_limit_gb.clamp(1, 500),
                    )
                };
                let (disk_free, disk_total) = self.db.disk_space();
                self.send_json(request, 200, &serde_json::json!({
                    "settings": {
                        "partSizeMb": effective_mb,
                        "rawPartSizeMb": configured_mb,
                        "effectivePartSizeMb": effective_mb,
                        "minAllowedMb": 5,
                        "maxAllowedMb": max_allowed,
                        "downloadConcurrency": dl_conc,
                        "cacheLimitGb": cache_gb,
                        "isLocalBotApi": self.is_local_api(),
                        "isLocalStorage": false,
                        "storageMode": "telegram",
                        "diskFreeBytes": disk_free,
                        "diskTotalBytes": disk_total,
                        "sliceSizeMb": slice_mb,
                        "uploadConcurrency": client,
                        "telegramUploadConcurrency": telegram,
                        "botMaxConcurrentUploads": per_bot,
                        "theme": "dark"
                    }
                }));
            }

            (Method::Patch, "/api/settings") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                let json: serde_json::Value = match serde_json::from_str(&body) {
                    Ok(v) => v,
                    Err(_) => {
                        self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid JSON" } }));
                        return;
                    }
                };

                if let Some(v) = json.get("storageMode").and_then(|v| v.as_str()) {
                    let normalized = v.trim().to_lowercase();
                    if normalized != "telegram" {
                        self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "TeleDrive operates exclusively with Telegram cloud storage." } }));
                        return;
                    }
                }

                let max_allowed = self.max_part_size_mb();
                let mut state = self.db.state.write_safe();
                let mut changed = false;

                if let Some(v) = json.get("partSizeMb") {
                    match json_u64(v) {
                        Some(n) => { state.part_size_mb = n.clamp(5, max_allowed); changed = true; }
                        None => {
                            drop(state);
                            self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "partSizeMb must be a finite number" } }));
                            return;
                        }
                    }
                }
                if let Some(v) = json.get("sliceSizeMb") {
                    if let Some(n) = json_u64(v) {
                        state.slice_size_mb = n.clamp(1, 256);
                        changed = true;
                    }
                }
                if let Some(v) = json.get("uploadConcurrency") {
                    if let Some(n) = json_u64(v) {
                        state.client_upload_concurrency = n.clamp(1, 32);
                        changed = true;
                    }
                }
                if let Some(v) = json.get("telegramUploadConcurrency") {
                    if let Some(n) = json_u64(v) {
                        state.telegram_upload_concurrency = n.min(64);
                        changed = true;
                    }
                }
                if let Some(v) = json.get("botMaxConcurrentUploads") {
                    if let Some(n) = json_u64(v) {
                        state.bot_max_concurrent_uploads = n.clamp(1, 8);
                        changed = true;
                    }
                }
                if let Some(v) = json.get("downloadConcurrency") {
                    if let Some(n) = json_u64(v) {
                        state.download_concurrency = n.clamp(1, 8);
                        changed = true;
                    }
                }
                if let Some(v) = json.get("cacheLimitGb") {
                    if let Some(n) = json_u64(v) {
                        state.cache_limit_gb = n.clamp(1, 500);
                        changed = true;
                    }
                }
                drop(state);
                if changed {
                    self.db.save();
                }
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Get, "/api/config") => {
                let max_allowed = self.max_part_size_mb();
                let state = self.db.state.read_safe();
                let effective_mb = state.part_size_mb.clamp(5, max_allowed);
                let slice_mb = state.slice_size_mb.clamp(1, 256);
                let part_size_bytes = effective_mb * 1024 * 1024;
                let slice_size_bytes = slice_mb.min(effective_mb) * 1024 * 1024;
                let bot_count = state.bots.iter().filter(|b| b.healthy && !b.token.is_empty()).count().max(1);
                let client = state.client_upload_concurrency.clamp(1, 32);
                let telegram = state.telegram_upload_concurrency;
                let per_bot = state.bot_max_concurrent_uploads.clamp(1, 8);
                drop(state);
                let (disk_free, disk_total) = self.db.disk_space();
                self.send_json(request, 200, &serde_json::json!({
                    "version": "3.1.7",
                    "partSize": part_size_bytes,
                    "sliceSize": slice_size_bytes,
                    "effectivePartSizeMb": effective_mb,
                    "partSizeMaxMb": max_allowed,
                    "maxAllowedPartSizeMb": max_allowed,
                    "isLocalBotApi": self.is_local_api(),
                    "isLocalStorage": false,
                    "storageMode": "telegram",
                    "diskFreeBytes": disk_free,
                    "diskTotalBytes": disk_total,
                    "uploadConcurrency": client,
                    "telegramUploadConcurrency": telegram,
                    "botMaxConcurrentUploads": per_bot,
                    "botCount": bot_count,
                    "maxFileSize": 53687091200u64,
                    "trashRetentionDays": crate::db::TRASH_RETENTION_DAYS,
                    "desktopMode": true,
                    "downloadDir": self.native_downloads.get_download_dir().to_string_lossy().to_string(),
                    "features": { "ffmpeg": false, "pdf": false, "localVault": false }
                }));
            }

            (Method::Get, "/api/folders/tree") => {
                let state = self.db.state.read_safe();
                let tree: Vec<serde_json::Value> = state.folders.iter()
                    .filter(|f| f.trashed_at.is_none())
                    .map(|f| serde_json::json!({
                        "id": f.id,
                        "parentId": f.parent_id,
                        "name": f.name,
                        "color": f.color
                    }))
                    .collect();
                self.send_json(request, 200, &serde_json::json!({ "folders": tree }));
            }

            (Method::Get, p) if p.starts_with("/api/folders/dedicated/") => {
                let kind = p.trim_start_matches("/api/folders/dedicated/");
                let folder_name = match kind {
                    "photos" | "pictures" | "images" | "image" => "Photos",
                    "videos" | "video" => "Videos",
                    "documents" | "document" => "Documents",
                    "audio" | "music" => "Audio",
                    other => other,
                };

                let existing = {
                    let state = self.db.state.read_safe();
                    state.folders.iter()
                        .find(|f| f.parent_id.is_none() && f.trashed_at.is_none() && f.name.eq_ignore_ascii_case(folder_name))
                        .map(|f| Database::to_folder_dto(f, 0))
                };

                let folder_dto = match existing {
                    Some(f) => f,
                    None => {
                        let created = self.db.create_folder(folder_name, None);
                        self.trigger_mirror_sync();
                        created
                    }
                };

                self.send_json(request, 200, &serde_json::json!({ "folder": folder_dto }));
            }

            (Method::Post, "/api/folders") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let name = json.get("name").and_then(|v| v.as_str()).unwrap_or("New Folder");
                    let parent_id = json.get("parentId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let created = self.db.create_folder(name, parent_id);
                    self.send_json(request, 201, &serde_json::json!({ "folder": created }));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid payload" } }));
                }
            }

            (Method::Post, "/api/folders/ensure-path") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let path = json.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let mut current_parent_id = json.get("parentId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let segments: Vec<&str> = path.split(&['/', '\\'][..]).filter(|s| !s.trim().is_empty()).collect();
                    if segments.is_empty() {
                        self.send_json(request, 400, &serde_json::json!({ "error": { "message": "path required" } }));
                    } else {
                        let mut last_folder = None;
                        for seg in segments {
                            let seg_clean = seg.trim();
                            let existing = {
                                let state = self.db.state.read_safe();
                                state.folders.iter()
                                    .find(|f| f.trashed_at.is_none() && f.parent_id == current_parent_id && f.name.eq_ignore_ascii_case(seg_clean))
                                    .cloned()
                            };

                            if let Some(folder) = existing {
                                current_parent_id = Some(folder.id.clone());
                                last_folder = Some(Database::to_folder_dto(&folder, 0));
                            } else {
                                let created = self.db.create_folder(seg_clean, current_parent_id.clone());
                                current_parent_id = Some(created.id.clone());
                                last_folder = Some(created);
                            }
                        }

                        if let Some(final_folder) = last_folder {
                            self.send_json(request, 200, &serde_json::json!({ "folder": final_folder }));
                        } else {
                            self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Failed to create folder path" } }));
                        }
                    }
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Patch, p) if p.starts_with("/api/folders/") => {
                let id = p.trim_start_matches("/api/folders/");
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let name = json.get("name").and_then(|v| v.as_str());
                    let color = json.get("color").and_then(|v| v.as_str());
                    self.db.update_folder(id, name, color);
                    self.send_json(request, 200, &serde_json::json!({ "success": true }));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Post, "/api/files/text") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let name = json.get("name").and_then(|v| v.as_str()).unwrap_or("untitled.txt");
                    let content = json.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    let folder_id = json.get("folderId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    match self.write_text_file(None, folder_id, name, content) {
                        Ok(file) => self.send_json(request, 200, &serde_json::json!({ "file": file })),
                        Err((status, message)) => self.send_json(request, status, &serde_json::json!({
                            "error": { "code": "TEXT_FAILED", "message": message }
                        })),
                    }
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Put, p) if p.starts_with("/api/files/") && p.ends_with("/text") => {
                let id = p.trim_start_matches("/api/files/").trim_end_matches("/text");
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                match self.write_text_file(Some(id), None, "", &body) {
                    Ok(file) => self.send_json(request, 200, &serde_json::json!({ "file": file })),
                    Err((status, message)) => self.send_json(request, status, &serde_json::json!({
                        "error": { "code": "TEXT_FAILED", "message": message }
                    })),
                }
            }

            (Method::Post, "/api/items/star") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let file_ids: Vec<String> = json.get("fileIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let folder_ids: Vec<String> = json.get("folderIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let starred = json.get("starred").and_then(|v| v.as_bool()).unwrap_or(true);
                    self.db.set_star_items(&file_ids, &folder_ids, starred);
                    self.send_json(request, 200, &serde_json::json!({ "success": true }));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Post, "/api/items/trash") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let file_ids: Vec<String> = json.get("fileIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let folder_ids: Vec<String> = json.get("folderIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    self.db.trash_items(&file_ids, &folder_ids);
                    self.send_json(request, 200, &serde_json::json!({ "success": true }));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Post, "/api/items/restore") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let file_ids: Vec<String> = json.get("fileIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let folder_ids: Vec<String> = json.get("folderIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    self.db.restore_items(&file_ids, &folder_ids);
                    self.send_json(request, 200, &serde_json::json!({ "success": true }));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Post, "/api/items/delete") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let file_ids: Vec<String> = json.get("fileIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let folder_ids: Vec<String> = json.get("folderIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();

                    let (all_files, all_folders, part_targets) = self.db.get_deletion_targets_for_items(&file_ids, &folder_ids);
                    let deleted_count = part_targets.len();
                    self.delete_telegram_parts(&part_targets);
                    self.db.purge_deleted_records(&all_files, &all_folders);
                    self.trigger_mirror_sync();
                    self.send_json(request, 200, &serde_json::json!({
                        "success": true,
                        "affected": all_files.len() + all_folders.len(),
                        "deletedMessages": deleted_count
                    }));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Delete, p) if p.starts_with("/api/files/") && !p.ends_with("/content") => {
                let file_id = p.trim_start_matches("/api/files/");
                let (all_files, all_folders, part_targets) = self.db.get_deletion_targets_for_items(&[file_id.to_string()], &[]);
                self.delete_telegram_parts(&part_targets);
                for fid in &all_files {
                    self.remove_stream_cache(fid);
                }
                self.db.purge_deleted_records(&all_files, &all_folders);
                self.trigger_mirror_sync();
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Post, p) if p.starts_with("/api/files/") && p.ends_with("/thumbnail") => {
                let id = p.trim_start_matches("/api/files/").trim_end_matches("/thumbnail");
                let mut body = Vec::new();
                let _ = request.as_reader().read_to_end(&mut body);
                if !body.is_empty() {
                    // Client-generated thumbnail upload (video frames etc.):
                    // raw JPEG, ≤2 MB, magic bytes required.
                    const MAX_THUMB: usize = 2 * 1024 * 1024;
                    if body.len() > MAX_THUMB || body.len() < 4 || &body[..3] != b"\xFF\xD8\xFF" {
                        self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_THUMBNAIL", "message": "thumbnail must be a JPEG image up to 2 MB" } }));
                        return;
                    }
                    let valid = {
                        let state = self.db.state.read_safe();
                        state.files.iter().find(|f| f.id == id)
                            .map(|f| f.trashed_at.is_none())
                            .unwrap_or(false)
                    };
                    if !valid {
                        self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "file not found" } }));
                        return;
                    }
                    let target_dir = self.get_thumbnails_dir();
                    let target_path = target_dir.join(format!("{}.jpg", id));
                    if let Err(e) = std::fs::write(&target_path, &body) {
                        self.send_json(request, 500, &serde_json::json!({ "error": { "code": "WRITE_FAILED", "message": e.to_string() } }));
                        return;
                    }
                    let fallback_path = self.db.thumbnails_dir.join(format!("{}.jpg", id));
                    if fallback_path != target_path {
                        let _ = std::fs::write(&fallback_path, &body);
                    }
                    {
                        let mut state = self.db.state.write_safe();
                        if let Some(f) = state.files.iter_mut().find(|f| f.id == id) {
                            f.has_thumbnail = 1;
                        }
                    }
                    self.db.save();
                    self.send_json(request, 200, &serde_json::json!({ "ok": true }));
                    return;
                }
                let thumbs_dir = self.get_thumbnails_dir();
                for ext in ["webp", "jpg", "jpeg", "png"] {
                    let _ = std::fs::remove_file(thumbs_dir.join(format!("{}.{}", id, ext)));
                    let _ = std::fs::remove_file(self.db.thumbnails_dir.join(format!("{}.{}", id, ext)));
                }
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Post, p) if p.starts_with("/api/files/") && p.ends_with("/copy") => {
                let id = p.trim_start_matches("/api/files/").trim_end_matches("/copy");
                match self.db.duplicate_file(id) {
                    Ok(new_id) => self.send_json(request, 200, &serde_json::json!({
                        "success": true,
                        "id": new_id
                    })),
                    Err(e) => self.send_json(request, 404, &serde_json::json!({
                        "error": { "code": "NOT_FOUND", "message": e }
                    })),
                }
            }

            (Method::Post, "/api/items/copy") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let file_ids: Vec<String> = json.get("fileIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let folder_ids: Vec<String> = json.get("folderIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let target = json.get("targetFolderId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    self.db.copy_items(&file_ids, &folder_ids, target);
                    self.send_json(request, 200, &serde_json::json!({ "success": true }));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Post, "/api/zip") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let file_ids: Vec<String> = json.get("fileIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let folder_ids: Vec<String> = json.get("folderIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    match self.create_zip_archive(&file_ids, &folder_ids) {
                        Ok(id) => self.send_json(request, 200, &serde_json::json!({
                            "url": format!("/api/zip/{}", id)
                        })),
                        Err((status, message)) => self.send_json(request, status, &serde_json::json!({
                            "error": { "code": "ZIP_FAILED", "message": message }
                        })),
                    }
                } else {
                    self.send_json(request, 400, &serde_json::json!({
                        "error": { "code": "BAD_REQUEST", "message": "Invalid JSON" }
                    }));
                }
            }

            (Method::Post, "/api/items/move") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let file_ids: Vec<String> = json.get("fileIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let folder_ids: Vec<String> = json.get("folderIds")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let target = json.get("targetFolderId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let is_copy = json.get("copy").and_then(|v| v.as_bool()).unwrap_or(false);
                    if is_copy {
                        self.db.copy_items(&file_ids, &folder_ids, target);
                    } else {
                        self.db.move_items(&file_ids, &folder_ids, target);
                    }
                    self.trigger_mirror_sync();
                    self.send_json(request, 200, &serde_json::json!({ "success": true }));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Get, "/api/mirror") => {
                let (path, enabled) = {
                    let state = self.db.state.read_safe();
                    (state.local_mirror_path.clone().unwrap_or_else(|| "A:\\Teledrive".to_string()), state.local_mirror_enabled)
                };
                let stats = if enabled && !path.is_empty() {
                    self.mirror.sync(&path)
                } else {
                    crate::mirror::MirrorSyncStats {
                        enabled,
                        path,
                        synced_files: 0,
                        synced_folders: 0,
                        total_size_bytes: 0,
                        last_sync_at: Utc::now().timestamp_millis(),
                        error: None,
                    }
                };
                self.send_json(request, 200, &serde_json::to_value(&stats).unwrap_or(serde_json::Value::Null));
            }

            (Method::Post, "/api/mirror") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let new_path = json.get("path").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let enabled = json.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                    let clean_old = json.get("cleanOld").and_then(|v| v.as_bool()).unwrap_or(false);

                    // Refuse a drive root or an existing non-empty directory that
                    // lacks our .teledrive marker — the mirror must live in a
                    // dedicated folder so nothing user-owned is ever at risk.
                    if let Some(ref p) = new_path {
                        let trimmed = p.trim().trim_end_matches('\\').trim_end_matches('/');
                        let is_drive_root = is_drive_root_path(trimmed);
                        let target = std::path::Path::new(p);
                        let non_empty_unmarked = target.exists()
                            && !target.join(".teledrive").exists()
                            && std::fs::read_dir(target).map(|mut d| d.next().is_some()).unwrap_or(false);
                        if is_drive_root || non_empty_unmarked {
                            self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "Choose an empty or new folder for the mirror — not a drive root or an existing folder with contents." } }));
                            return;
                        }
                    }

                    let old_path = {
                        let state = self.db.state.read_safe();
                        state.local_mirror_path.clone().unwrap_or_else(|| "A:\\Teledrive".to_string())
                    };

                    {
                        let mut state = self.db.state.write_safe();
                        if let Some(ref p) = new_path {
                            state.local_mirror_path = Some(p.clone());
                        }
                        state.local_mirror_enabled = enabled;
                    }
                    self.db.save();

                    if clean_old && new_path.as_deref().map_or(false, |p| p != old_path) {
                        let _ = std::fs::remove_dir_all(&old_path);
                    }

                    let target_path = new_path.unwrap_or_else(|| {
                        let state = self.db.state.read_safe();
                        state.local_mirror_path.clone().unwrap_or_else(|| "A:\\Teledrive".to_string())
                    });
                    let stats = if enabled {
                        self.mirror.sync(&target_path)
                    } else {
                        crate::mirror::MirrorSyncStats {
                            enabled: false,
                            path: target_path,
                            synced_files: 0,
                            synced_folders: 0,
                            total_size_bytes: 0,
                            last_sync_at: Utc::now().timestamp_millis(),
                            error: None,
                        }
                    };
                    self.send_json(request, 200, &serde_json::to_value(&stats).unwrap_or(serde_json::Value::Null));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            (Method::Post, "/api/mirror/pick-folder") => {
                let current_path = {
                    let state = self.db.state.read_safe();
                    state.local_mirror_path.clone().unwrap_or_else(|| "A:\\Teledrive".to_string())
                };

                let mut dialog = rfd::FileDialog::new().set_title("Select Folder to Clone CloudDrive Metadata");
                let p = std::path::PathBuf::from(&current_path);
                if p.exists() {
                    dialog = dialog.set_directory(&p);
                }

                if let Some(folder) = dialog.pick_folder() {
                    let path_str = folder.to_string_lossy().to_string();
                    self.send_json(request, 200, &serde_json::json!({
                        "selected": true,
                        "path": path_str
                    }));
                } else {
                    self.send_json(request, 200, &serde_json::json!({
                        "selected": false,
                        "path": null
                    }));
                }
            }

            (Method::Post, "/api/mirror/open-folder") => {
                let path = {
                    let state = self.db.state.read_safe();
                    state.local_mirror_path.clone().unwrap_or_else(|| "A:\\Teledrive".to_string())
                };
                let _ = std::process::Command::new("explorer.exe").arg(&path).spawn();
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Post, "/api/mirror/sync") => {
                let (path, _enabled) = {
                    let state = self.db.state.read_safe();
                    (state.local_mirror_path.clone().unwrap_or_else(|| "A:\\Teledrive".to_string()), state.local_mirror_enabled)
                };
                let stats = self.mirror.sync(&path);
                self.send_json(request, 200, &serde_json::to_value(&stats).unwrap_or(serde_json::Value::Null));
            }

            (Method::Get, "/api/shares") => {
                self.send_json(request, 200, &serde_json::json!({ "shares": [] }));
            }

            (Method::Get, "/api/backups") => {
                let backups = self.db.list_backups();
                self.send_json(request, 200, &serde_json::json!({ "backups": backups }));
            }

            (Method::Post, "/api/backups") => {
                match self.db.create_backup() {
                    Ok((meta, _)) => self.send_json(request, 200, &serde_json::json!({ "backup": meta })),
                    Err(e) => self.send_json(request, 500, &serde_json::json!({
                        "error": { "code": "BACKUP_FAILED", "message": e }
                    })),
                }
            }

            (Method::Get, "/api/backups/download") => {
                match self.db.create_backup() {
                    Ok((meta, path)) => {
                        let file_name = meta.get("fileName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("teledrive-backup.json")
                            .to_string();
                        match std::fs::read(&path) {
                            Ok(bytes) => self.send_bytes(
                                request, 200, "application/json; charset=utf-8", bytes,
                                Some(file_name.as_str()), Some("no-store"),
                            ),
                            Err(e) => self.send_json(request, 500, &serde_json::json!({
                                "error": { "code": "BACKUP_FAILED", "message": e.to_string() }
                            })),
                        }
                    }
                    Err(e) => self.send_json(request, 500, &serde_json::json!({
                        "error": { "code": "BACKUP_FAILED", "message": e }
                    })),
                }
            }

            (Method::Get, "/api/native-downloads") => {
                let (downloads, download_dir) = self.native_downloads.list_downloads();
                self.send_json(request, 200, &serde_json::json!({
                    "downloads": downloads,
                    "downloadDir": download_dir,
                }));
            }

            (Method::Post, "/api/native-downloads/start") => {
                let mut req = request;
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let json: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                let file_id = json.get("fileId").and_then(|v| v.as_str());
                let name = json.get("name").and_then(|v| v.as_str());
                match file_id {
                    Some(fid) => match self.native_downloads.start_download(fid, name) {
                        Ok(task) => self.send_json(req, 200, &serde_json::json!({ "task": task })),
                        Err(e) => self.send_json(req, 400, &serde_json::json!({ "error": { "message": e } })),
                    },
                    None => self.send_json(req, 400, &serde_json::json!({ "error": { "message": "Missing fileId" } })),
                }
            }

            (Method::Post, p) if p.starts_with("/api/native-downloads/") && p.ends_with("/pause") => {
                let id = p.trim_start_matches("/api/native-downloads/").trim_end_matches("/pause");
                let _ = self.native_downloads.pause_download(id);
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Post, p) if p.starts_with("/api/native-downloads/") && p.ends_with("/resume") => {
                let id = p.trim_start_matches("/api/native-downloads/").trim_end_matches("/resume");
                match self.native_downloads.resume_download(id) {
                    Ok(_) => self.send_json(request, 200, &serde_json::json!({ "success": true })),
                    Err(e) => self.send_json(request, 400, &serde_json::json!({ "error": { "message": e } })),
                }
            }

            (Method::Post, p) if p.starts_with("/api/native-downloads/") && p.ends_with("/cancel") => {
                let id = p.trim_start_matches("/api/native-downloads/").trim_end_matches("/cancel");
                let _ = self.native_downloads.cancel_download(id);
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Post, p) if p.starts_with("/api/native-downloads/") && p.ends_with("/open") => {
                let id = p.trim_start_matches("/api/native-downloads/").trim_end_matches("/open");
                match self.native_downloads.open_file(id) {
                    Ok(_) => self.send_json(request, 200, &serde_json::json!({ "success": true })),
                    Err(e) => self.send_json(request, 400, &serde_json::json!({ "error": { "message": e } })),
                }
            }

            (Method::Post, p) if p.starts_with("/api/native-downloads/") && p.ends_with("/reveal") => {
                let id = p.trim_start_matches("/api/native-downloads/").trim_end_matches("/reveal");
                match self.native_downloads.reveal_file(id) {
                    Ok(_) => self.send_json(request, 200, &serde_json::json!({ "success": true })),
                    Err(e) => self.send_json(request, 400, &serde_json::json!({ "error": { "message": e } })),
                }
            }

            (Method::Post, "/api/native-downloads/pick-folder") => {
                match self.native_downloads.pick_download_folder() {
                    Ok(path) => self.send_json(request, 200, &serde_json::json!({ "path": path })),
                    Err(e) => self.send_json(request, 500, &serde_json::json!({ "error": { "message": e } })),
                }
            }

            (Method::Post, "/api/native-downloads/clear-done") => {
                self.native_downloads.clear_done();
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Post, p) if p.starts_with("/api/native-downloads/") && p.ends_with("/remove") => {
                let id = p.trim_start_matches("/api/native-downloads/").trim_end_matches("/remove");
                self.native_downloads.remove_task(id);
                self.send_json(request, 200, &serde_json::json!({ "success": true }));
            }

            (Method::Get, "/api/events") => {
                // Return SSE stream with keep-alive
                let headers = vec![
                    Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..]).unwrap(),
                    Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap(),
                    Header::from_bytes(&b"Connection"[..], &b"keep-alive"[..]).unwrap(),
                ];
                let comment = ": keepalive\n\n";
                let cursor = Cursor::new(comment.as_bytes().to_vec());
                let response = Response::new(StatusCode(200), headers, cursor, Some(comment.len()), None);
                let _ = request.respond(response);
            }

            (Method::Get, p) if p.starts_with("/api/zip/") => {
                let id = p.trim_start_matches("/api/zip/");
                match Uuid::parse_str(id) {
                    Ok(uuid) => {
                        let path = self.db.data_dir.join("cache").join(format!("zip-{}.zip", uuid));
                        match std::fs::metadata(&path) {
                            Ok(meta) if meta.is_file() => {
                                let filename = format!("TeleDrive-{}.zip", Utc::now().format("%Y%m%d-%H%M%S"));
                                // Keep the archive for 24h so the WebView download
                                // manager can retry or resume it.
                                self.send_file(request, "application/zip", &path, Some(&filename), Some("no-store"), meta.len());
                            }
                            _ => self.send_json(request, 404, &serde_json::json!({
                                "error": { "code": "NOT_FOUND", "message": "ZIP archive not found or already cleaned up" }
                            })),
                        }
                    }
                    Err(_) => self.send_json(request, 400, &serde_json::json!({
                        "error": { "code": "BAD_REQUEST", "message": "invalid archive id" }
                    })),
                }
            }

            // Thumbnail endpoint
            (Method::Get, p) if p.starts_with("/api/thumbnails/") => {
                let id = p.trim_start_matches("/api/thumbnails/");
                let prefix = if id.len() >= 2 { &id[0..2] } else { "00" };
                let embedded_rel = format!("{}/{}.webp", prefix, id);

                // 1. Check embedded thumbnail
                if let Some(file) = THUMBNAILS_DIR.get_file(&embedded_rel) {
                    let bytes = file.contents().to_vec();
                    self.send_bytes(request, 200, "image/webp", bytes, None, Some("public, max-age=86400"));
                    return;
                }

                // 2. Check disk thumbnail in all common formats (checking metadata mirror drive first, then fallback)
                let thumbs_dir = self.get_thumbnails_dir();
                for ext in &["webp", "jpg", "jpeg", "png"] {
                    let disk_path = thumbs_dir.join(format!("{}.{}", id, ext));
                    let fallback_path = self.db.thumbnails_dir.join(format!("{}.{}", id, ext));
                    let actual_path = if disk_path.exists() {
                        Some(disk_path)
                    } else if fallback_path.exists() {
                        Some(fallback_path)
                    } else {
                        None
                    };
                    if let Some(path) = actual_path {
                        if let Ok(bytes) = std::fs::read(&path) {
                            let mime = match *ext {
                                "webp" => "image/webp",
                                "jpg" | "jpeg" => "image/jpeg",
                                "png" => "image/png",
                                _ => "application/octet-stream",
                            };
                            self.send_bytes(request, 200, mime, bytes, None, Some("public, max-age=86400"));
                            return;
                        }
                    }
                }

                // 3. Fallback: Dynamic thumbnail generation from Telegram
                let file_rec = {
                    let state = self.db.state.read_safe();
                    state.files.iter().find(|f| f.id == id).cloned()
                };
                if let Some(f) = file_rec {
                    if f.category == "image" || f.category == "video" {
                        let state = self.db.state.read_safe();
                        let part = state.parts.iter().find(|p| p.blob_id == f.blob_id && p.part_index == 0).cloned();
                        drop(state);

                        if let Some(p) = part {
                            let telegram = Arc::clone(&self.telegram);
                            if let Ok(bytes) = self.tokio_runtime.block_on(async move {
                                telegram.fetch_part_prefix(&p, 4 * 1024 * 1024).await
                            }) {
                                if !bytes.is_empty() {
                                    let base = thumbs_dir.join(&id);
                                    let _ = std::fs::write(format!("{}.webp", base.display()), &bytes);
                                    let _ = std::fs::write(format!("{}.jpg", base.display()), &bytes);
                                    let _ = std::fs::write(format!("{}.png", base.display()), &bytes);
                                    let fallback_base = self.db.thumbnails_dir.join(&id);
                                    if fallback_base != base {
                                        let _ = std::fs::write(format!("{}.jpg", fallback_base.display()), &bytes);
                                    }

                                    if f.width.is_none() && f.category == "image" {
                                        let parsed = parse_image_metadata(&f.extension, &bytes, f.size);
                                        let mut state = self.db.state.write_safe();
                                        if let Some(file_ref) = state.files.iter_mut().find(|x| x.id == id) {
                                            file_ref.width = parsed.width;
                                            file_ref.height = parsed.height;
                                            file_ref.metadata = parsed.metadata_json;
                                            file_ref.has_thumbnail = 1;
                                        }
                                        drop(state);
                                        self.db.save();
                                    }

                                    let mime = if f.category == "image" { f.mime_type.as_str() } else { "image/jpeg" };
                                    self.send_bytes(request, 200, mime, bytes, None, Some("public, max-age=86400"));
                                    return;
                                }
                            }
                        }
                    }
                }

                self.send_json(request, 404, &serde_json::json!({ "error": { "message": "Thumbnail not found" } }));
            }

            // File content / download / preview endpoints
            (Method::Get, p) if (p.starts_with("/api/files/") && (p.ends_with("/download") || p.ends_with("/content")))
                || p.starts_with("/api/download/")
                || p.starts_with("/api/preview/") => {
                let is_download = p.ends_with("/download") || p.starts_with("/api/download/") || params.get("download").map(|v| v.as_str()) == Some("1");
                let id = if p.starts_with("/api/download/") {
                    p.trim_start_matches("/api/download/")
                } else if p.starts_with("/api/preview/") {
                    p.trim_start_matches("/api/preview/")
                } else if p.ends_with("/download") {
                    p.trim_start_matches("/api/files/").trim_end_matches("/download")
                } else {
                    p.trim_start_matches("/api/files/").trim_end_matches("/content")
                };

                let state = self.db.state.read_safe();
                let file = state.files.iter().find(|f| f.id == id).cloned();
                let parts: Vec<PartRecord> = if let Some(ref f) = file {
                    state.parts.iter().filter(|p| p.blob_id == f.blob_id).cloned().collect()
                } else {
                    Vec::new()
                };
                drop(state);

                if let Some(f) = file {
                    if parts.is_empty() {
                        self.send_bytes(request, 200, &f.mime_type, Vec::new(), if is_download { Some(&f.name) } else { None }, None);
                        return;
                    }

                    let mut sorted_parts = parts;
                    sorted_parts.sort_by_key(|p| p.part_index);

                    // Built-in vault: stream the parts straight off disk with
                    // full Range support. No temp copy, no memory spike.
                    if sorted_parts.iter().all(|p| p.telegram_file_id.starts_with("local:")) {
                        self.send_local_parts(
                            request,
                            &sorted_parts,
                            &f.mime_type,
                            if is_download { Some(&f.name) } else { None },
                            f.size,
                        );
                        return;
                    }

                    let fname = f.name.clone();
                    let mime = f.mime_type.clone();
                    let expected_size = f.size;

                    // Per-part streaming: the Range only fetches the parts it
                    // touches; PartChainReader walks the part cache in order.
                    let range_header = request.headers().iter()
                        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Range"))
                        .map(|h| h.value.as_str().to_string());
                    let (status, start, end) = parse_byte_range(range_header.as_deref(), expected_size);

                    // The first needed part must exist before we can answer —
                    // a fetch failure here becomes a proper 502, not a cut
                    // connection mid-body.
                    let first_idx = crate::part_stream::part_index_at(&sorted_parts, start);
                    if let Err(e) = self.ensure_stream_part(&f.blob_id, first_idx, sorted_parts.get(first_idx)) {
                        eprintln!("Part fetch failed for {} part {}: {}", fname, first_idx, e);
                        self.send_json(request, 502, &serde_json::json!({ "error": { "code": "DOWNLOAD_FAILED", "message": e } }));
                        return;
                    }

                    let reader = crate::part_stream::PartChainReader::new(
                        self.clone(),
                        f.blob_id.clone(),
                        sorted_parts,
                        start,
                    );
                    self.respond_range(
                        request,
                        &mime,
                        reader,
                        if is_download { Some(&fname) } else { None },
                        Some("public, max-age=3600"),
                        status,
                        start,
                        end,
                        expected_size,
                    );
                } else {
                    self.send_json(request, 404, &serde_json::json!({ "error": { "message": "File not found" } }));
                }
            }

            // File metadata details
            (Method::Get, p) if p.starts_with("/api/files/") => {
                let id = p.trim_start_matches("/api/files/");
                if let Some((file, breadcrumbs)) = self.db.get_file(id) {
                    self.send_json(request, 200, &serde_json::json!({
                        "file": file,
                        "breadcrumbs": breadcrumbs
                    }));
                } else if let Some(session) = self.active_uploads.read_safe().values().find(|s| s.file_id == id || s.id == id).cloned() {
                    let is_failed = session.parts.iter().any(|p| p.status == "failed");
                    self.send_json(request, 200, &serde_json::json!({
                        "file": {
                            "id": session.file_id,
                            "name": session.name,
                            "size": session.size,
                            "status": if is_failed { "failed" } else { "processing" },
                            "folderId": session.folder_id,
                            "createdAt": session.created_at,
                            "updatedAt": session.created_at,
                        },
                        "breadcrumbs": []
                    }));
                } else {
                    self.send_json(request, 404, &serde_json::json!({ "error": { "message": "File not found" } }));
                }
            }

            (Method::Patch, p) if p.starts_with("/api/files/") => {
                let id = p.trim_start_matches("/api/files/");
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    let name = json.get("name").and_then(|v| v.as_str());
                    let starred = json.get("starred").and_then(|v| v.as_bool());
                    let folder_id = json.get("folderId").map(|v| v.as_str().map(|s| s.to_string()));
                    self.db.update_file(id, name, starred, folder_id);
                    self.send_json(request, 200, &serde_json::json!({ "success": true }));
                } else {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "message": "Invalid JSON" } }));
                }
            }

            // Create an upload session. Parts are staged on disk and pushed to
            // Telegram one at a time; HTTP slices are deliberately separate
            // from the much larger Telegram part size.
            (Method::Post, "/api/uploads") => {
                let mut body = String::new();
                if request.as_reader().read_to_string(&mut body).is_err() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "cannot read request body" } }));
                    return;
                }
                let json: serde_json::Value = match serde_json::from_str(&body) {
                    Ok(v) => v,
                    Err(_) => {
                        self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid JSON" } }));
                        return;
                    }
                };
                let name = json.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                if name.is_empty() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "name is required" } }));
                    return;
                }
                let size = match json.get("size").and_then(json_u64) {
                    Some(v) => v,
                    None => {
                        self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "size must be a non-negative integer" } }));
                        return;
                    }
                };
                const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024 * 1024;
                if size > MAX_FILE_SIZE {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "file exceeds the 50 GB upload limit" } }));
                    return;
                }
                let folder_id = json.get("folderId").and_then(|v| v.as_str()).map(|s| s.to_string());
                let mime_type = json.get("mimeType").and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| mime_guess::from_path(&name).first_or_octet_stream().to_string());
                let last_modified = json.get("lastModified").and_then(json_u64).map(|v| v.to_string()).unwrap_or_default();
                let client_key = json.get("clientKey").and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("{}|{}|{}", name, size, last_modified));

                // Serialize the duplicate check and insert; the embedded server
                // handles requests on multiple threads.
                let _create_guard = self.create_lock.lock_safe();

                // Idempotent create: a network retry or page refresh must not
                // start a second file/part set for the same client upload.
                let existing = {
                    let uploads = self.active_uploads.read_safe();
                    uploads.values().find(|s| {
                        s.client_key.as_deref() == Some(client_key.as_str())
                            && s.folder_id == folder_id
                            && s.status != "finalizing"
                            && Self::session_status(s) != "failed"
                    }).cloned()
                };
                if let Some(session) = existing {
                    self.send_json(request, 200, &self.upload_dto_json(&session));
                    return;
                }

                // A previous attempt with the same file failed and the client
                // started over. Drop its staged/vault parts instead of leaking
                // them for the full 48-hour session window.
                let stale_failed: Vec<ActiveUploadSession> = {
                    let uploads = self.active_uploads.read_safe();
                    uploads.values()
                        .filter(|s| {
                            s.client_key.as_deref() == Some(client_key.as_str())
                                && s.folder_id == folder_id
                                && Self::session_status(s) == "failed"
                        })
                        .cloned()
                        .collect()
                };
                for session in stale_failed {
                    self.discard_upload(&session);
                }

                // Fail fast with a clear message instead of accepting an upload
                // that will inevitably run out of disk while slices arrive.
                if size > 0 {
                    let (free, total) = self.db.disk_space();
                    const DISK_RESERVE: u64 = 64 * 1024 * 1024;
                    let needed = size.saturating_add(DISK_RESERVE);
                    if total > 0 && free < needed {
                        self.send_json(request, 507, &serde_json::json!({
                            "error": {
                                "code": "INSUFFICIENT_STORAGE",
                                "message": format!(
                                    "Not enough free disk space: {} needed ({} file + 64 MB reserve), only {} available on this drive.",
                                    human_bytes(needed), human_bytes(size), human_bytes(free)
                                ),
                                "details": { "needed": needed, "free": free, "total": total }
                            }
                        }));
                        return;
                    }
                }

                let part_size = self.part_size_for(&mime_type) * 1024 * 1024;
                let slice_mb = self.db.state.read_safe().slice_size_mb.clamp(1, 256);
                let slice_size = (slice_mb * 1024 * 1024).min(part_size).max(1);
                let part_count = if size == 0 { 0 } else { size.div_ceil(part_size) as usize };
                let mut parts = Vec::with_capacity(part_count);
                let mut offset = 0u64;
                for idx in 0..part_count {
                    let psize = (size - offset).min(part_size);
                    let slice_count = psize.div_ceil(slice_size).max(1) as usize;
                    parts.push(ActiveUploadPart {
                        idx,
                        offset,
                        size: psize,
                        slice_count,
                        status: "pending".to_string(),
                        received_slices: Vec::new(),
                        attempts: 0,
                        telegram_file_id: None,
                        telegram_message_id: None,
                        bot_id: None,
                        sha256: String::new(),
                        started_at: None,
                        last_error: None,
                    });
                    offset += psize;
                }

                let session = ActiveUploadSession {
                    id: Uuid::new_v4().to_string(),
                    file_id: Uuid::new_v4().to_string(),
                    blob_id: Uuid::new_v4().to_string(),
                    name,
                    size,
                    mime_type,
                    folder_id,
                    part_size,
                    slice_size,
                    client_key: Some(client_key),
                    parts,
                    created_at: Utc::now().timestamp_millis(),
                    status: "active".to_string(),
                    preview: None,
                    source_path: None,
                    source_size: None,
                    source_mtime: None,
                };
                let upload_id = session.id.clone();
                self.active_uploads.write_safe().insert(upload_id.clone(), session.clone());
                self.persist_session(&session);

                if size == 0 {
                    // Telegram cannot store an empty document. Like the Node
                    // server, finalize zero-byte files locally and finish now.
                    match self.finalize_upload(&session) {
                        Ok(file) => {
                            self.drop_upload(&upload_id);
                            let mut dto = self.upload_dto_json(&session);
                            if let Some(obj) = dto.as_object_mut() {
                                obj.insert("status".to_string(), serde_json::json!("complete"));
                                obj.insert("file".to_string(), file);
                            }
                            self.send_json(request, 201, &dto);
                        }
                        Err(e) => {
                            self.drop_upload(&upload_id);
                            self.send_json(request, 500, &serde_json::json!({ "error": { "code": "FINALIZE_FAILED", "message": e } }));
                        }
                    }
                    return;
                }

                let _ = std::fs::create_dir_all(self.upload_dir(&upload_id));
                self.send_json(request, 201, &self.upload_dto_json(&session));
            }

            (Method::Get, "/api/uploads") => {
                let wanted = params.get("status").map(|s| s.as_str());
                let uploads = self.active_uploads.read_safe();
                let mut list: Vec<(i64, serde_json::Value)> = uploads.values().filter_map(|u| {
                    let status = Self::session_status(u);
                    let include = match wanted {
                        None | Some("all") => true,
                        Some("active") => status == "active",
                        Some(value) => status == value,
                    };
                    include.then(|| (u.created_at, self.upload_status_json(u)))
                }).collect();
                list.sort_by_key(|(created, _)| -created);
                let items: Vec<serde_json::Value> = list.into_iter().map(|(_, value)| value).collect();
                self.send_json(request, 200, &serde_json::json!({ "uploads": items }));
            }

            (Method::Post, "/api/native-uploads/pick") => {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                let json: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
                let folder_id = json.get("folderId").and_then(|v| v.as_str()).map(|s| s.to_string());
                let conflict = json.get("conflict").and_then(|v| v.as_str()).unwrap_or("rename");
                // OS file picker — runs on this request worker thread, which is
                // fine: rfd only needs a free thread, not the GUI event loop.
                let picked = rfd::FileDialog::new()
                    .set_title("Choose files to upload")
                    .pick_files();
                match picked {
                    None => self.send_json(request, 200, &serde_json::json!({ "cancelled": true })),
                    Some(files) => {
                        let paths: Vec<String> = files.iter().map(|p| p.to_string_lossy().to_string()).collect();
                        let outcome = self.create_native_uploads(paths, folder_id, conflict);
                        self.send_json(request, 201, &serde_json::json!({
                            "uploads": outcome.uploads,
                            "skipped": outcome.skipped
                        }));
                    }
                }
            }

            (Method::Post, "/api/native-uploads") => {
                let mut body = String::new();
                if request.as_reader().read_to_string(&mut body).is_err() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "cannot read request body" } }));
                    return;
                }
                let json: serde_json::Value = match serde_json::from_str(&body) {
                    Ok(v) => v,
                    Err(_) => {
                        self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "Invalid JSON" } }));
                        return;
                    }
                };
                let paths: Vec<String> = json.get("paths").and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                if paths.is_empty() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "paths must be a non-empty array" } }));
                    return;
                }
                let folder_id = json.get("folderId").and_then(|v| v.as_str()).map(|s| s.to_string());
                let conflict = json.get("conflict").and_then(|v| v.as_str()).unwrap_or("rename");
                let outcome = self.create_native_uploads(paths, folder_id, conflict);
                self.send_json(request, 201, &serde_json::json!({
                    "uploads": outcome.uploads,
                    "skipped": outcome.skipped
                }));
            }

            (Method::Get, p) if p.starts_with("/api/uploads/") && p.ends_with("/progress") => {
                let upload_id = p.strip_prefix("/api/uploads/").and_then(|rest| rest.strip_suffix("/progress")).unwrap_or("");
                if Uuid::parse_str(upload_id).is_err() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "invalid upload id" } }));
                    return;
                }
                let session = self.active_uploads.read_safe().get(upload_id).cloned();
                if let Some(session) = session {
                    self.send_json(request, 200, &self.upload_progress_json(&session));
                } else {
                    self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "Upload not found" } }));
                }
            }

            (Method::Get, p) if p.starts_with("/api/uploads/") => {
                let upload_id = p.trim_start_matches("/api/uploads/");
                if Uuid::parse_str(upload_id).is_err() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "invalid upload id" } }));
                    return;
                }
                let session = self.active_uploads.read_safe().get(upload_id).cloned();
                if let Some(session) = session {
                    self.send_json(request, 200, &self.upload_dto_json(&session));
                } else {
                    self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "Upload session not found" } }));
                }
            }

            (Method::Delete, p) if p.starts_with("/api/uploads/") => {
                let upload_id = p.trim_start_matches("/api/uploads/").to_string();
                if Uuid::parse_str(&upload_id).is_err() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "invalid upload id" } }));
                    return;
                }
                let session = {
                    // Serialize with finalization so a completed upload cannot
                    // be resurrected after the user cancels it.
                    let lock = self.upload_lock(&upload_id);
                    let _guard = lock.lock_safe();
                    self.active_uploads.write_safe().remove(&upload_id)
                };
                let Some(session) = session else {
                    self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "Upload session not found" } }));
                    return;
                };

                self.discard_upload(&session);
                self.send_json(request, 200, &serde_json::json!({ "ok": true }));
            }

            (Method::Put, p) if p.starts_with("/api/uploads/") && p.contains("/parts/") && p.contains("/slices/") => {
                let segs: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
                if segs.len() != 7 || segs[0] != "api" || segs[1] != "uploads" || segs[3] != "parts" || segs[5] != "slices" {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "invalid slice path" } }));
                    return;
                }
                let upload_id = segs[2];
                if Uuid::parse_str(upload_id).is_err() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "invalid upload id" } }));
                    return;
                }
                let part_idx: usize = match segs[4].parse() {
                    Ok(v) => v,
                    Err(_) => {
                        self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "invalid part index" } }));
                        return;
                    }
                };
                let slice_idx: usize = match segs[6].parse() {
                    Ok(v) => v,
                    Err(_) => {
                        self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "invalid slice index" } }));
                        return;
                    }
                };

                let session = self.active_uploads.read_safe().get(upload_id).cloned();
                let Some(session) = session else {
                    self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "Upload session not found" } }));
                    return;
                };
                if session.status == "finalizing" {
                    self.send_json(request, 409, &serde_json::json!({ "error": { "code": "UPLOAD_PROCESSING", "message": "upload is being finalized" } }));
                    return;
                }
                let Some(part) = session.parts.iter().find(|p| p.idx == part_idx).cloned() else {
                    self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "part not found" } }));
                    return;
                };
                if part.status == "stored" {
                    // Idempotent retry of an already stored slice. Drain the
                    // body so tiny_http can keep the connection reusable.
                    let _ = std::io::copy(&mut request.as_reader(), &mut std::io::sink());
                    self.send_json(request, 200, &serde_json::json!({ "partReceived": true }));
                    return;
                }
                let slice_start = slice_idx as u64 * session.slice_size;
                if slice_idx >= part.slice_count.max(1) || slice_start >= part.size {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "slice index out of range" } }));
                    return;
                }
                let expected = (part.size - slice_start).min(session.slice_size);
                let content_length = request.body_length().map(|v| v as u64);
                if content_length != Some(expected) {
                    self.send_json(request, 400, &serde_json::json!({
                        "error": { "code": "BAD_REQUEST", "message": format!("Content-Length must be {} bytes", expected) }
                    }));
                    return;
                }

                // Guard against another application filling the disk after the
                // upload was created. Already-received slices are skipped.
                if !part.received_slices.contains(&slice_idx) {
                    let (free, total) = self.db.disk_space();
                    const SLICE_RESERVE: u64 = 16 * 1024 * 1024;
                    if total > 0 && free < expected.saturating_add(SLICE_RESERVE) {
                        self.send_json(request, 507, &serde_json::json!({
                            "error": {
                                "code": "INSUFFICIENT_STORAGE",
                                "message": format!(
                                    "Disk is full: this slice needs {} but only {} is free. Free some space and retry the upload.",
                                    human_bytes(expected), human_bytes(free)
                                )
                            }
                        }));
                        return;
                    }
                }

                if let Err(e) = write_body_at(&mut request, &self.part_file(upload_id, part_idx), slice_start, expected) {
                    eprintln!("[TeleDrive] Failed to stage slice {}/{} for {}: {}", part_idx, slice_idx, upload_id, e);
                    self.send_json(request, 500, &serde_json::json!({ "error": { "code": "STAGE_FAILED", "message": e } }));
                    return;
                }

                let should_send = {
                    let mut uploads = self.active_uploads.write_safe();
                    match uploads.get_mut(upload_id).and_then(|s| s.parts.get_mut(part_idx)) {
                        None => {
                            drop(uploads);
                            self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "Upload session not found" } }));
                            return;
                        }
                        Some(p) => {
                            if p.status != "stored" {
                                if p.status == "failed" {
                                    p.status = "pending".to_string();
                                    p.last_error = None;
                                }
                                if !p.received_slices.contains(&slice_idx) {
                                    p.received_slices.push(slice_idx);
                                    p.received_slices.sort_unstable();
                                }
                            }
                            p.status != "stored"
                                && p.status != "uploading"
                                && p.received_slices.len() >= p.slice_count.max(1)
                        }
                    }
                };
                self.persist_session_by_id(upload_id);

                // Always acknowledge the slice upload immediately so the client HTTP connection
                // is never blocked waiting for the WAN Telegram upload.
                self.send_json(request, 200, &serde_json::json!({ "partReceived": true }));

                if should_send {
                    let server = self.clone();
                    let uid = upload_id.to_string();
                    std::thread::spawn(move || {
                        let body = std::panic::AssertUnwindSafe(|| match server.claim_part_wait(&uid, part_idx) {
                            Ok(Some(claimed)) => {
                                if let Err(e) = server.send_part(&claimed, part_idx) {
                                    eprintln!("[TeleDrive] Background Telegram part upload failed for {} part {}: {}", uid, part_idx, e);
                                } else {
                                    // Check if all parts are stored and finalize automatically
                                    let all_stored = {
                                        let map = server.active_uploads.read_safe();
                                        map.get(&uid).map(|s| s.parts.iter().all(|p| p.status == "stored")).unwrap_or(false)
                                    };
                                    if all_stored && server.try_begin_finalize(&uid) {
                                        let _ = server.finalize_and_drop(&uid);
                                    }
                                }
                            }
                            Ok(None) => {}
                            Err(e) => {
                                eprintln!("[TeleDrive] Background Telegram claim failed for {} part {}: {}", uid, part_idx, e);
                            }
                        });
                        if std::panic::catch_unwind(body).is_err() {
                            eprintln!("[TeleDrive] Background part-upload worker panicked for {} part {}", uid, part_idx);
                        }
                    });
                }
            }

            (Method::Post, p) if p.starts_with("/api/uploads/") && (p.ends_with("/complete") || p.ends_with("/finalize")) => {
                let upload_id = p.strip_prefix("/api/uploads/")
                    .and_then(|rest| rest.strip_suffix("/complete").or_else(|| rest.strip_suffix("/finalize")))
                    .unwrap_or("");
                if Uuid::parse_str(upload_id).is_err() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "invalid upload id" } }));
                    return;
                }
                let session = self.active_uploads.read_safe().get(upload_id).cloned();
                let Some(session) = session else {
                    let state = self.db.state.read_safe();
                    if let Some(file) = state.files.iter().find(|f| f.trashed_at.is_none() && f.id == upload_id) {
                        self.send_json(request, 200, &serde_json::json!({
                            "ok": true,
                            "file": file,
                            "ready": true
                        }));
                        return;
                    }
                    self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "Upload session not found" } }));
                    return;
                };

                let missing: Vec<serde_json::Value> = session.parts.iter().filter_map(|p| {
                    if p.status == "stored" { return None; }
                    let missing_slices: Vec<usize> = (0..p.slice_count.max(1))
                        .filter(|idx| !p.received_slices.contains(idx))
                        .collect();
                    if missing_slices.is_empty() {
                        None
                    } else {
                        Some(serde_json::json!({ "partIdx": p.idx, "missing": missing_slices }))
                    }
                }).collect();
                if !missing.is_empty() {
                    self.send_json(request, 409, &serde_json::json!({
                        "error": {
                            "code": "MISSING_SLICES",
                            "message": "upload has missing slices",
                            "details": { "missing": missing }
                        }
                    }));
                    return;
                }

                // If any parts are pending, trigger background upload
                for part in session.parts.iter().filter(|p| p.status == "pending") {
                    let server = self.clone();
                    let uid = upload_id.to_string();
                    let pidx = part.idx;
                    std::thread::spawn(move || {
                        let body = std::panic::AssertUnwindSafe(|| {
                            if let Ok(Some(claimed)) = server.claim_part_wait(&uid, pidx) {
                                if let Err(e) = server.send_part(&claimed, pidx) {
                                    eprintln!("[TeleDrive] Complete-triggered part upload failed for {} part {}: {}", uid, pidx, e);
                                } else {
                                    let all_stored = {
                                        let map = server.active_uploads.read_safe();
                                        map.get(&uid).map(|s| s.parts.iter().all(|p| p.status == "stored")).unwrap_or(false)
                                    };
                                    if all_stored && server.try_begin_finalize(&uid) {
                                        let _ = server.finalize_and_drop(&uid);
                                    }
                                }
                            }
                        });
                        if std::panic::catch_unwind(body).is_err() {
                            eprintln!("[TeleDrive] Complete-triggered part-upload worker panicked for {} part {}", uid, pidx);
                        }
                    });
                }

                // Wait briefly (up to 1.5s) in case parts are finishing right now
                let wait_deadline = Instant::now() + std::time::Duration::from_millis(1500);
                let mut all_stored = false;
                while Instant::now() < wait_deadline {
                    let current = self.active_uploads.read_safe().get(upload_id).cloned();
                    if let Some(cur) = current {
                        if cur.parts.iter().all(|p| p.status == "stored") {
                            all_stored = true;
                            break;
                        }
                    } else {
                        all_stored = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }

                if all_stored {
                    if self.try_begin_finalize(upload_id) {
                        match self.finalize_and_drop(upload_id) {
                            Ok(file) => {
                                self.send_json(request, 200, &serde_json::json!({
                                    "ok": true,
                                    "file": file,
                                    "ready": true
                                }));
                                return;
                            }
                            Err(e) => {
                                self.send_json(request, 500, &serde_json::json!({ "error": { "code": "FINALIZE_FAILED", "message": e } }));
                                return;
                            }
                        }
                    } else {
                        let state = self.db.state.read_safe();
                        if let Some(file) = state.files.iter().find(|f| f.trashed_at.is_none() && f.blob_id == session.blob_id) {
                            self.send_json(request, 200, &serde_json::json!({
                                "ok": true,
                                "file": file,
                                "ready": true
                            }));
                            return;
                        }
                        self.send_json(request, 200, &serde_json::json!({ "ok": true, "ready": true }));
                        return;
                    }
                }

                // Parts are streaming to Telegram in background; return ready: false cleanly
                self.send_json(request, 200, &serde_json::json!({
                    "ok": true,
                    "ready": false,
                    "message": "storing parts in Telegram"
                }));
            }

            (Method::Post, p) if p.starts_with("/api/uploads/") && p.ends_with("/retry") => {
                let upload_id = p.strip_prefix("/api/uploads/").and_then(|rest| rest.strip_suffix("/retry")).unwrap_or("");
                if Uuid::parse_str(upload_id).is_err() {
                    self.send_json(request, 400, &serde_json::json!({ "error": { "code": "BAD_REQUEST", "message": "invalid upload id" } }));
                    return;
                }
                let Some(session) = self.active_uploads.read_safe().get(upload_id).cloned() else {
                    self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "Upload session not found" } }));
                    return;
                };
                if session.status == "finalizing" {
                    self.send_json(request, 409, &serde_json::json!({ "error": { "code": "UPLOAD_PROCESSING", "message": "upload is being finalized" } }));
                    return;
                }
                let retry_parts: Vec<usize> = session.parts.iter()
                    .filter(|p| p.status != "stored")
                    .map(|p| p.idx)
                    .collect();
                let is_native = session.source_path.is_some();
                let missing_slices: Vec<serde_json::Value> = session.parts.iter().filter_map(|p| {
                    if p.status == "stored" { return None; }
                    let missing: Vec<usize> = (0..p.slice_count.max(1))
                        .filter(|idx| !p.received_slices.contains(idx))
                        .collect();
                    (!missing.is_empty()).then(|| serde_json::json!({ "partIdx": p.idx, "missing": missing }))
                }).collect();
                if !missing_slices.is_empty() && !is_native {
                    self.send_json(request, 409, &serde_json::json!({
                        "error": {
                            "code": "MISSING_SLICES",
                            "message": "upload has missing slices; re-select the file to resume",
                            "details": { "missing": missing_slices }
                        }
                    }));
                    return;
                }
                // Native sessions skip the staged-file check — their feeder
                // restages any missing part from the source on retry.
                let missing_parts: Vec<usize> = if is_native {
                    Vec::new()
                } else {
                    retry_parts.iter()
                        .filter(|idx| !self.part_file(upload_id, **idx).exists())
                        .copied()
                        .collect()
                };
                if !missing_parts.is_empty() {
                    self.send_json(request, 409, &serde_json::json!({
                        "error": {
                            "code": "MISSING_PARTS",
                            "message": "staged part files are gone; re-upload required",
                            "details": { "missingParts": missing_parts }
                        }
                    }));
                    return;
                }
                if !self.try_begin_finalize(upload_id) {
                    self.send_json(request, 409, &serde_json::json!({ "error": { "code": "UPLOAD_PROCESSING", "message": "upload is already being finalized" } }));
                    return;
                }

                // Reset failed parts explicitly, but never a part that is
                // already 'uploading': another request may be sending it right
                // now and resetting it would create a duplicate document.
                {
                    let mut uploads = self.active_uploads.write_safe();
                    if let Some(current) = uploads.get_mut(upload_id) {
                        for part in current.parts.iter_mut() {
                            if part.status != "stored" && part.status != "uploading" {
                                part.status = "pending".to_string();
                                part.attempts = 0;
                                part.last_error = None;
                                part.started_at = None;
                            }
                        }
                    }
                }
                self.persist_session_by_id(upload_id);

                if is_native {
                    // The feeder re-dispatches everything pending — including
                    // parts whose staged file vanished (it restages them).
                    self.spawn_native_feeder(upload_id.to_string());
                    self.send_json(request, 200, &serde_json::json!({
                        "ok": true,
                        "native": true,
                        "retriedParts": retry_parts.len()
                    }));
                    return;
                }

                let mut retried = 0usize;
                for idx in retry_parts {
                    match self.claim_part_wait(upload_id, idx) {
                        Ok(Some(claimed)) => {
                            retried += 1;
                            if let Err(e) = self.send_part(&claimed, idx) {
                                self.set_upload_status(upload_id, "active");
                                self.send_json(request, 502, &serde_json::json!({
                                    "error": { "code": "TELEGRAM_UPLOAD_FAILED", "message": format!("Telegram upload failed: {}", e) }
                                }));
                                return;
                            }
                        }
                        Ok(None) => {}
                        Err(e) => {
                            self.set_upload_status(upload_id, "active");
                            self.send_json(request, 503, &serde_json::json!({ "error": { "code": "UPLOAD_BUSY", "message": e } }));
                            return;
                        }
                    }
                }

                // Keep waiting while a request that started before retry is
                // still sending its part; if it fails, surface that instead of
                // reporting success with a truncated file.
                let wait_deadline = Instant::now() + std::time::Duration::from_secs(3600);
                loop {
                    let current = self.active_uploads.read_safe().get(upload_id).cloned();
                    let Some(current) = current else {
                        self.send_json(request, 404, &serde_json::json!({ "error": { "code": "NOT_FOUND", "message": "Upload session not found" } }));
                        return;
                    };
                    if current.parts.iter().all(|p| p.status == "stored") {
                        break;
                    }
                    if !current.parts.iter().any(|p| p.status == "uploading") {
                        self.set_upload_status(upload_id, "active");
                        let pending: Vec<usize> = current.parts.iter()
                            .filter(|p| p.status != "stored")
                            .map(|p| p.idx)
                            .collect();
                        let detail = current.parts.iter()
                            .filter(|p| p.status != "stored")
                            .find_map(|p| p.last_error.clone())
                            .unwrap_or_else(|| "part upload failed".to_string());
                        self.send_json(request, 409, &serde_json::json!({
                            "error": {
                                "code": "RETRY_INCOMPLETE",
                                "message": format!("not all parts were stored in Telegram: {}", detail),
                                "details": { "missingParts": pending }
                            }
                        }));
                        return;
                    }
                    if Instant::now() >= wait_deadline {
                        self.set_upload_status(upload_id, "active");
                        let pending: Vec<usize> = current.parts.iter()
                            .filter(|p| p.status != "stored")
                            .map(|p| p.idx)
                            .collect();
                        self.send_json(request, 409, &serde_json::json!({
                            "error": {
                                "code": "UPLOAD_PROCESSING",
                                "message": "upload is still being stored in Telegram",
                                "details": { "missingParts": pending }
                            }
                        }));
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }

                match self.finalize_and_drop(upload_id) {
                    Ok(file) => {
                        self.send_json(request, 200, &serde_json::json!({
                            "retried": retried,
                            "ready": true,
                            "file": file
                        }));
                    }
                    Err(e) => {
                        self.send_json(request, 500, &serde_json::json!({ "error": { "code": "FINALIZE_FAILED", "message": e } }));
                    }
                }
            }

            _ => {
                self.send_json(request, 404, &serde_json::json!({
                    "error": { "code": "NOT_FOUND", "message": format!("Endpoint not found: {}", path) }
                }));
            }
        }
    }
}


/// RAII guard: dropping it releases the cache file's in-use refcount so it
/// becomes evictable again.
pub struct CacheUseGuard {
    map: Arc<Mutex<std::collections::HashMap<PathBuf, usize>>>,
    path: PathBuf,
}

impl Drop for CacheUseGuard {
    fn drop(&mut self) {
        let mut map = self.map.lock_safe();
        if let Some(n) = map.get_mut(&self.path) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                map.remove(&self.path);
            }
        }
    }
}


/// `D:\`, `C:/` style drive roots are never acceptable mirror targets.
fn is_drive_root_path(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() == 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

#[cfg(test)]
mod mirror_path_tests {
    use super::is_drive_root_path;

    #[test]
    fn drive_roots_detected() {
        assert!(is_drive_root_path("D:"));
        assert!(is_drive_root_path("c:"));
        assert!(!is_drive_root_path(r"D:\Teledrive"));
        assert!(!is_drive_root_path("AB:"));
        assert!(!is_drive_root_path("D:sub"));
    }
}
