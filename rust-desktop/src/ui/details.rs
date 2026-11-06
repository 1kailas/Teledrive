use std::path::Path;
use eframe::egui::{self, Color32, RichText, Ui, Vec2};
use crate::models::FileDTO;
use crate::ui::theme::*;

pub struct DetailsActions {
    pub download: Option<FileDTO>,
    pub toggle_star: Option<(String, bool)>,
    pub trash: Option<FileDTO>,
    pub close: bool,
}

impl Default for DetailsActions {
    fn default() -> Self {
        Self {
            download: None,
            toggle_star: None,
            trash: None,
            close: false,
        }
    }
}

pub fn render_details_panel(
    ui: &mut Ui,
    file: &FileDTO,
    thumb_path: Option<&Path>,
    actions: &mut DetailsActions,
) {
    ui.horizontal(|ui| {
        ui.label(RichText::new("File Details").size(14.0).strong().color(TEXT_PRIMARY));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.small_button("✕").clicked() {
                actions.close = true;
            }
        });
    });

    ui.add_space(8.0);
    ui.separator();
    ui.add_space(8.0);

    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        // Top Icon / Thumbnail Card
        egui::Frame::new()
            .fill(BG_INPUT)
            .corner_radius(8.0)
            .inner_margin(egui::Margin::same(12))
            .show(ui, |ui| {
                ui.vertical_centered(|ui| {
                    if let Some(path) = thumb_path {
                        let uri = format!("file:///{}", path.to_string_lossy().replace('\\', "/"));
                        ui.add(
                            egui::Image::new(uri)
                                .max_size(Vec2::new(280.0, 160.0))
                                .corner_radius(6.0)
                        );
                    } else {
                        let glyph = category_glyph(&file.category);
                        let color = category_color(&file.category);
                        ui.label(RichText::new(glyph).size(48.0).color(color));
                    }
                    ui.add_space(6.0);
                    ui.label(RichText::new(&file.name).size(13.0).strong().color(TEXT_PRIMARY));
                    ui.label(RichText::new(fmt_bytes(file.size)).size(11.0).color(TEXT_MUTED));
                });
            });

        ui.add_space(12.0);

        // Actions Bar
        ui.horizontal(|ui| {
            if ui.button(RichText::new("⬇ Download").color(Color32::BLACK).strong()).clicked() {
                actions.download = Some(file.clone());
            }
            if ui.button(if file.starred { "★ Unstar" } else { "☆ Star" }).clicked() {
                actions.toggle_star = Some((file.id.clone(), !file.starred));
            }
            if ui.button(RichText::new("🗑 Trash").color(Color32::from_rgb(239, 68, 68))).clicked() {
                actions.trash = Some(file.clone());
            }
        });

        ui.add_space(12.0);
        ui.separator();
        ui.add_space(8.0);

        // Attributes Table
        ui.label(RichText::new("PROPERTIES").size(11.0).strong().color(TEXT_MUTED));
        ui.add_space(4.0);

        render_row(ui, "Category", &file.category);
        render_row(ui, "MIME Type", &file.mime_type);
        render_row(ui, "Extension", &file.extension);
        render_row(ui, "Size", &format!("{} ({} bytes)", fmt_bytes(file.size), file.size));
        render_row(ui, "Telegram Parts", &format!("{}", file.part_count));
        render_row(ui, "Modified", &fmt_date(file.updated_at));
        render_row(ui, "Created", &fmt_date(file.created_at));

        // Rich Metadata parsing
        if let Some(ref meta) = file.metadata {
            ui.add_space(12.0);
            ui.separator();
            ui.add_space(8.0);
            ui.label(RichText::new("RICH METADATA").size(11.0).strong().color(ACCENT));
            ui.add_space(4.0);

            if let Some(obj) = meta.as_object() {
                // Dimensions / Aspect Ratio / Codec
                if let (Some(w), Some(h)) = (file.width, file.height) {
                    render_row(ui, "Dimensions", &format!("{} × {} px", w, h));
                }
                if let Some(aspect) = obj.get("aspectRatio").and_then(|v| v.as_str()) {
                    if !aspect.is_empty() {
                        render_row(ui, "Aspect Ratio", aspect);
                    }
                }
                if let Some(codec) = obj.get("codec").and_then(|v| v.as_str()) {
                    render_row(ui, "Video Codec", codec);
                }
                if let Some(duration) = file.duration {
                    render_row(ui, "Duration", &format!("{:.1}s", duration));
                }

                // Audio ID3
                if let Some(title) = obj.get("title").and_then(|v| v.as_str()) {
                    render_row(ui, "Track Title", title);
                }
                if let Some(artist) = obj.get("artist").and_then(|v| v.as_str()) {
                    render_row(ui, "Artist", artist);
                }
                if let Some(album) = obj.get("album").and_then(|v| v.as_str()) {
                    render_row(ui, "Album", album);
                }
                if let Some(year) = obj.get("year").and_then(|v| v.as_str()) {
                    render_row(ui, "Year", year);
                }
                if let Some(genre) = obj.get("genre").and_then(|v| v.as_str()) {
                    render_row(ui, "Genre", genre);
                }

                // PDF Page count
                if let Some(pages) = obj.get("pageCount").and_then(|v| v.as_u64()) {
                    render_row(ui, "Pages", &format!("{} pages", pages));
                }

                // Code / Text
                if let Some(lines) = obj.get("lines").and_then(|v| v.as_u64()) {
                    render_row(ui, "Lines", &format!("{} lines", lines));
                }
                if let Some(words) = obj.get("words").and_then(|v| v.as_u64()) {
                    render_row(ui, "Words", &format!("{} words", words));
                }
                if let Some(chars) = obj.get("characters").and_then(|v| v.as_u64()) {
                    render_row(ui, "Characters", &format!("{} chars", chars));
                }

                // Camera EXIF
                if let Some(make) = obj.get("make").and_then(|v| v.as_str()) {
                    let model = obj.get("model").and_then(|v| v.as_str()).unwrap_or("");
                    render_row(ui, "Camera", &format!("{} {}", make, model).trim());
                }
                if let Some(lens) = obj.get("lens").and_then(|v| v.as_str()) {
                    render_row(ui, "Lens", lens);
                }
                if let Some(iso) = obj.get("iso").and_then(|v| v.as_u64()) {
                    render_row(ui, "ISO", &format!("{}", iso));
                }
                if let Some(shutter) = obj.get("shutterSpeed").and_then(|v| v.as_str()) {
                    render_row(ui, "Shutter", shutter);
                }
                if let Some(fnum) = obj.get("fNumber").and_then(|v| v.as_str()) {
                    render_row(ui, "Aperture", &format!("ƒ/{}", fnum));
                }
                if let Some(focal) = obj.get("focalLength").and_then(|v| v.as_str()) {
                    render_row(ui, "Focal Length", &format!("{} mm", focal));
                }
                if let Some(taken) = file.taken_at {
                    render_row(ui, "Captured", &fmt_date(taken));
                }
            }
        }
    });
}

fn render_row(ui: &mut Ui, label: &str, val: &str) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(label).size(11.0).color(TEXT_MUTED));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(RichText::new(val).size(11.5).color(TEXT_PRIMARY));
        });
    });
    ui.add_space(2.0);
}
