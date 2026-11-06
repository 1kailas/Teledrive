#![allow(dead_code)]

use eframe::egui::{self, Color32, CornerRadius, Margin, Stroke, Visuals};

pub const BG_MAIN: Color32 = Color32::from_rgb(13, 16, 22);
pub const BG_SURFACE: Color32 = Color32::from_rgb(20, 25, 34);
pub const BG_SURFACE_HOVER: Color32 = Color32::from_rgb(28, 35, 48);
pub const BG_SURFACE_SELECTED: Color32 = Color32::from_rgb(30, 48, 75);
pub const BG_INPUT: Color32 = Color32::from_rgb(16, 20, 28);
pub const BORDER: Color32 = Color32::from_rgb(35, 44, 60);
pub const ACCENT: Color32 = Color32::from_rgb(56, 189, 248);
pub const ACCENT_HOVER: Color32 = Color32::from_rgb(14, 165, 233);
pub const TEXT_PRIMARY: Color32 = Color32::from_rgb(243, 244, 246);
pub const TEXT_MUTED: Color32 = Color32::from_rgb(148, 163, 184);

pub const COLOR_IMAGE: Color32 = Color32::from_rgb(244, 114, 182);   // Pink
pub const COLOR_VIDEO: Color32 = Color32::from_rgb(192, 132, 252);   // Purple
pub const COLOR_AUDIO: Color32 = Color32::from_rgb(250, 204, 21);    // Amber
pub const COLOR_DOCUMENT: Color32 = Color32::from_rgb(96, 165, 250); // Sky
pub const COLOR_ARCHIVE: Color32 = Color32::from_rgb(248, 113, 113); // Coral
pub const COLOR_CODE: Color32 = Color32::from_rgb(74, 222, 128);     // Emerald
pub const COLOR_FOLDER: Color32 = Color32::from_rgb(56, 189, 248);   // Folder Blue

pub fn apply_theme(ctx: &egui::Context) {
    let mut visuals = Visuals::dark();
    visuals.override_text_color = Some(TEXT_PRIMARY);
    visuals.panel_fill = BG_MAIN;
    visuals.window_fill = BG_SURFACE;
    visuals.window_stroke = Stroke::new(1.0_f32, BORDER);
    visuals.window_corner_radius = CornerRadius::same(10);

    visuals.widgets.noninteractive.bg_fill = BG_MAIN;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER);
    visuals.widgets.noninteractive.corner_radius = CornerRadius::same(6);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY);

    visuals.widgets.inactive.bg_fill = BG_SURFACE;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, BORDER);
    visuals.widgets.inactive.corner_radius = CornerRadius::same(6);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY);

    visuals.widgets.hovered.bg_fill = BG_SURFACE_HOVER;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.widgets.hovered.corner_radius = CornerRadius::same(6);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY);

    visuals.widgets.active.bg_fill = BG_SURFACE_SELECTED;
    visuals.widgets.active.bg_stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.widgets.active.corner_radius = CornerRadius::same(6);
    visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY);

    visuals.widgets.open.bg_fill = BG_SURFACE_HOVER;
    visuals.widgets.open.bg_stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.widgets.open.corner_radius = CornerRadius::same(6);

    ctx.set_visuals(visuals);

    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = egui::vec2(8.0, 8.0);
    style.spacing.button_padding = egui::vec2(10.0, 6.0);
    style.spacing.window_margin = Margin::same(12);
    ctx.set_style(style);
}

pub fn fmt_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    const TB: f64 = GB * 1024.0;

    let b = bytes as f64;
    if b >= TB {
        format!("{:.2} TB", b / TB)
    } else if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{} B", bytes)
    }
}

pub fn fmt_date(timestamp_ms: i64) -> String {
    use chrono::{Local, TimeZone};
    if timestamp_ms <= 0 {
        return "—".to_string();
    }
    match Local.timestamp_millis_opt(timestamp_ms) {
        chrono::LocalResult::Single(dt) => dt.format("%b %d, %Y %H:%M").to_string(),
        _ => "—".to_string(),
    }
}

pub fn category_color(cat: &str) -> Color32 {
    match cat {
        "image" => COLOR_IMAGE,
        "video" => COLOR_VIDEO,
        "audio" => COLOR_AUDIO,
        "document" => COLOR_DOCUMENT,
        "archive" => COLOR_ARCHIVE,
        "code" => COLOR_CODE,
        _ => TEXT_MUTED,
    }
}

pub fn category_glyph(cat: &str) -> &'static str {
    match cat {
        "image" => "🖼",
        "video" => "🎬",
        "audio" => "🎵",
        "document" => "📄",
        "archive" => "📦",
        "code" => "💻",
        _ => "📁",
    }
}
