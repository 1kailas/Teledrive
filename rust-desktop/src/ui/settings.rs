use std::sync::Arc;
use eframe::egui::{self, Color32, RichText, Ui};
use crate::bot_api::BotApiProcess;
use crate::db::Database;
use crate::native_downloads::NativeDownloadManager;
use crate::ui::theme::*;

pub fn render_settings_view(
    ui: &mut Ui,
    db: &Arc<Database>,
    download_mgr: &NativeDownloadManager,
    bot_api: &Arc<BotApiProcess>,
    on_toast: &mut Option<(String, bool)>,
) {
    ui.label(RichText::new("Settings & System Status").size(18.0).strong().color(TEXT_PRIMARY));
    ui.add_space(8.0);
    ui.separator();
    ui.add_space(8.0);

    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        // Section: Download Directory
        ui.label(RichText::new("DOWNLOAD DIRECTORY").size(11.0).strong().color(TEXT_MUTED));
        ui.add_space(4.0);

        egui::Frame::new()
            .fill(BG_SURFACE)
            .corner_radius(8.0)
            .stroke(egui::Stroke::new(1.0_f32, BORDER))
            .inner_margin(egui::Margin::same(12))
            .show(ui, |ui| {
                let current_dir = download_mgr.get_download_dir();
                ui.label(RichText::new("Files downloaded from your drive will be saved here:").size(11.5).color(TEXT_MUTED));
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new(current_dir.to_string_lossy()).size(13.0).strong().color(TEXT_PRIMARY));
                    if ui.button("Browse...").clicked() {
                        if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                            let path_str = folder.to_string_lossy().to_string();
                            {
                                let mut state = match db.state.write() {
                                    Ok(s) => s,
                                    Err(p) => p.into_inner(),
                                };
                                state.download_dir = Some(path_str.clone());
                            }
                            db.save();
                            *on_toast = Some((format!("Download path updated to {}", path_str), true));
                        }
                    }
                });
            });

        ui.add_space(16.0);

        // Section: Telegram Local Bot API
        ui.label(RichText::new("TELEGRAM BOT API ENGINE").size(11.0).strong().color(TEXT_MUTED));
        ui.add_space(4.0);

        egui::Frame::new()
            .fill(BG_SURFACE)
            .corner_radius(8.0)
            .stroke(egui::Stroke::new(1.0_f32, BORDER))
            .inner_margin(egui::Margin::same(12))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    let is_running = bot_api.ready();
                    let dot = if is_running { "● Running" } else { "● Stopped" };
                    let dot_color = if is_running { Color32::from_rgb(34, 197, 94) } else { Color32::from_rgb(239, 68, 68) };
                    ui.label(RichText::new(dot).size(13.0).strong().color(dot_color));
                    ui.label(RichText::new(format!("URL: {}  ·  2 GB Maximum Upload Envelope", bot_api.url)).size(11.5).color(TEXT_MUTED));
                });

                ui.add_space(6.0);
                ui.label(RichText::new("The local Telegram Bot API server runs natively as an isolated child process, enabling direct up to 2,000 MiB multi-part transfers directly to Telegram storage channels.").size(11.0).color(TEXT_MUTED));
            });

        ui.add_space(16.0);

        // Section: Telegram Bots Fleet
        let state = match db.state.read() {
            Ok(s) => s,
            Err(p) => p.into_inner(),
        };

        ui.label(RichText::new(format!("TELEGRAM BOTS FLEET ({} BOTS CONFIGURED)", state.bots.len())).size(11.0).strong().color(TEXT_MUTED));
        ui.add_space(4.0);

        for bot in &state.bots {
            egui::Frame::new()
                .fill(BG_SURFACE)
                .corner_radius(6.0)
                .stroke(egui::Stroke::new(1.0_f32, BORDER))
                .inner_margin(egui::Margin::same(10))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let dot_color = if bot.healthy { Color32::from_rgb(34, 197, 94) } else { Color32::from_rgb(239, 68, 68) };
                        ui.label(RichText::new("●").size(12.0).color(dot_color));

                        let masked = if bot.token.len() > 10 {
                            format!("{}:***", &bot.token[..bot.token.find(':').unwrap_or(6)])
                        } else {
                            "***".to_string()
                        };

                        ui.label(RichText::new(&bot.username).size(12.5).strong().color(TEXT_PRIMARY));
                        ui.label(RichText::new(masked).size(11.0).color(TEXT_MUTED));

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.label(RichText::new(format!("Uploaded: {}", fmt_bytes(bot.bytes_uploaded))).size(11.0).color(TEXT_MUTED));
                            if bot.healthy {
                                ui.label(RichText::new("Healthy").size(11.0).color(Color32::from_rgb(34, 197, 94)));
                            } else {
                                ui.label(RichText::new("Error / Cooling down").size(11.0).color(Color32::from_rgb(239, 68, 68)));
                            }
                        });
                    });
                });
            ui.add_space(4.0);
        }

        ui.add_space(16.0);

        // Section: System Information
        ui.label(RichText::new("SYSTEM INFORMATION").size(11.0).strong().color(TEXT_MUTED));
        ui.add_space(4.0);

        egui::Frame::new()
            .fill(BG_SURFACE)
            .corner_radius(8.0)
            .stroke(egui::Stroke::new(1.0_f32, BORDER))
            .inner_margin(egui::Margin::same(12))
            .show(ui, |ui| {
                render_setting_row(ui, "Architecture", "Pure Native Rust (x86_64)");
                render_setting_row(ui, "GUI Engine", "egui 0.31 / eframe (Zero JavaScript, Zero WebView2)");
                render_setting_row(ui, "Application Version", "3.1.7");
                render_setting_row(ui, "Total Cloud Files", &format!("{}", state.files.len()));
                render_setting_row(ui, "Total Cloud Folders", &format!("{}", state.folders.len()));
                render_setting_row(ui, "Total Vault Size", &fmt_bytes(state.files.iter().map(|f| f.size).sum()));
            });
    });
}

fn render_setting_row(ui: &mut Ui, label: &str, val: &str) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(label).size(11.5).color(TEXT_MUTED));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(RichText::new(val).size(12.0).strong().color(TEXT_PRIMARY));
        });
    });
    ui.add_space(2.0);
}
