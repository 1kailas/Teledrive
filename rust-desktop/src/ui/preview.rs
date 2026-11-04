use std::path::Path;
use eframe::egui::{self, Color32, RichText, Vec2};
use crate::models::FileDTO;
use crate::ui::theme::*;

pub struct PreviewActions {
    pub download: Option<FileDTO>,
    pub close: bool,
}

impl Default for PreviewActions {
    fn default() -> Self {
        Self {
            download: None,
            close: false,
        }
    }
}

pub fn render_preview_modal(
    ctx: &egui::Context,
    file: &FileDTO,
    thumb_path: Option<&Path>,
    text_content: Option<&str>,
    loading: bool,
    actions: &mut PreviewActions,
) {
    egui::Window::new(format!("Preview: {}", file.name))
        .collapsible(false)
        .resizable(true)
        .default_size([750.0, 520.0])
        .min_size([400.0, 300.0])
        .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
        .show(ctx, |ui| {
            // Top Bar
            ui.horizontal(|ui| {
                ui.label(RichText::new(&file.name).size(14.0).strong().color(TEXT_PRIMARY));
                ui.label(RichText::new(fmt_bytes(file.size)).size(11.0).color(TEXT_MUTED));

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("✕ Close").clicked() {
                        actions.close = true;
                    }
                    if ui.button(RichText::new("⬇ Download").color(Color32::BLACK).strong()).clicked() {
                        actions.download = Some(file.clone());
                    }
                });
            });

            ui.separator();
            ui.add_space(4.0);

            if loading {
                ui.vertical_centered(|ui| {
                    ui.add_space(80.0);
                    ui.label(RichText::new("Loading preview from Telegram...").size(14.0).color(TEXT_MUTED));
                });
                return;
            }

            match file.category.as_str() {
                "code" | "document" => {
                    if let Some(text) = text_content {
                        egui::ScrollArea::both().auto_shrink([false, false]).show(ui, |ui| {
                            ui.add(
                                egui::TextEdit::multiline(&mut text.to_string())
                                    .font(egui::TextStyle::Monospace)
                                    .desired_width(f32::INFINITY)
                                    .interactive(false)
                            );
                        });
                    } else {
                        ui.vertical_centered(|ui| {
                            ui.add_space(80.0);
                            ui.label(RichText::new("📄").size(48.0).color(COLOR_DOCUMENT));
                            ui.add_space(8.0);
                            ui.label(RichText::new("Document ready to download").size(14.0).color(TEXT_PRIMARY));
                            ui.add_space(8.0);
                            if ui.button("Download and Open").clicked() {
                                actions.download = Some(file.clone());
                            }
                        });
                    }
                }
                "image" => {
                    ui.vertical_centered(|ui| {
                        ui.add_space(10.0);
                        if let Some(path) = thumb_path {
                            let uri = format!("file:///{}", path.to_string_lossy().replace('\\', "/"));
                            ui.add(
                                egui::Image::new(uri)
                                    .max_size(Vec2::new(680.0, 380.0))
                                    .corner_radius(8.0)
                            );
                        } else {
                            ui.add_space(30.0);
                            ui.label(RichText::new("🖼").size(64.0).color(COLOR_IMAGE));
                        }
                        ui.add_space(8.0);
                        if let (Some(w), Some(h)) = (file.width, file.height) {
                            ui.label(RichText::new(format!("{} × {} pixels", w, h)).size(13.0).color(TEXT_PRIMARY));
                        }
                        ui.add_space(8.0);
                        if ui.button(RichText::new("⬇ Download Full Quality Original").color(Color32::BLACK).strong()).clicked() {
                            actions.download = Some(file.clone());
                        }
                    });
                }
                "video" | "audio" => {
                    ui.vertical_centered(|ui| {
                        ui.add_space(10.0);
                        if file.category == "video" {
                            if let Some(path) = thumb_path {
                                let uri = format!("file:///{}", path.to_string_lossy().replace('\\', "/"));
                                ui.add(
                                    egui::Image::new(uri)
                                        .max_size(Vec2::new(480.0, 270.0))
                                        .corner_radius(8.0)
                                );
                                ui.add_space(6.0);
                            }
                        }
                        let glyph = if file.category == "video" { "🎬" } else { "🎵" };
                        let color = if file.category == "video" { COLOR_VIDEO } else { COLOR_AUDIO };
                        if thumb_path.is_none() || file.category == "audio" {
                            ui.label(RichText::new(glyph).size(48.0).color(color));
                        }
                        ui.add_space(4.0);
                        ui.label(RichText::new(&file.name).size(14.0).strong().color(TEXT_PRIMARY));
                        if let Some(duration) = file.duration {
                            ui.label(RichText::new(format!("Duration: {:.1} seconds", duration)).size(12.0).color(TEXT_MUTED));
                        }
                        ui.add_space(12.0);
                        if ui.button(RichText::new("⬇ Download & Play Natively").color(Color32::BLACK).strong()).clicked() {
                            actions.download = Some(file.clone());
                        }
                    });
                }
                _ => {
                    ui.vertical_centered(|ui| {
                        ui.add_space(60.0);
                        ui.label(RichText::new("📦").size(48.0).color(TEXT_MUTED));
                        ui.add_space(8.0);
                        ui.label(RichText::new(&file.name).size(14.0).color(TEXT_PRIMARY));
                        ui.label(RichText::new(fmt_bytes(file.size)).size(12.0).color(TEXT_MUTED));
                        ui.add_space(12.0);
                        if ui.button("Download File").clicked() {
                            actions.download = Some(file.clone());
                        }
                    });
                }
            }
        });
}
