use std::collections::HashSet;
use std::sync::Arc;
use eframe::egui::{self, Color32, ProgressBar, RichText, Ui, Vec2};
use crate::models::{FileDTO, FolderDTO};
use crate::server::AppServer;
use crate::sync_ext::RwLockExt;
use crate::ui::explorer::{render_explorer, ExplorerActions};
use crate::ui::theme::*;
use crate::ui::types::{RecentTab, ViewMode};

pub fn render_recent_view(
    ui: &mut Ui,
    tab: &mut RecentTab,
    files: &[FileDTO],
    folders: &[FolderDTO],
    view_mode: ViewMode,
    selected_files: &mut HashSet<String>,
    selected_folders: &mut HashSet<String>,
    actions: &mut ExplorerActions,
    thumb_fn: &impl Fn(&str) -> Option<String>,
    server: &Arc<AppServer>,
) {
    ui.add_space(4.0);

    let (downloads, download_dir) = server.native_downloads.list_downloads();
    let uploads: Vec<_> = {
        let map = server.active_uploads.read_safe();
        map.values().cloned().collect()
    };

    let active_dl_count = downloads.iter().filter(|t| matches!(t.status.as_str(), "downloading" | "finalizing" | "queued")).count();
    let active_up_count = uploads.iter().filter(|u| matches!(u.status.as_str(), "active" | "finalizing" | "staging")).count();

    // ── Header & Tabs ──
    ui.horizontal(|ui| {
        ui.label(RichText::new("🕒 Recent Activity").size(18.0).strong().color(TEXT_PRIMARY));
        ui.add_space(16.0);

        let tabs = [
            (RecentTab::All, "⚡ All Activity"),
            (RecentTab::Files, "📁 Cloud Files"),
            (RecentTab::Downloads, "⬇ Recent Downloads"),
            (RecentTab::Uploads, "⬆ Recent Uploads"),
        ];

        for (t, label) in tabs {
            let mut label_text = label.to_string();
            if t == RecentTab::Downloads && active_dl_count > 0 {
                label_text = format!("⬇ Downloads ({})", active_dl_count);
            } else if t == RecentTab::Uploads && active_up_count > 0 {
                label_text = format!("⬆ Uploads ({})", active_up_count);
            }

            if ui.selectable_label(*tab == t, label_text).clicked() {
                *tab = t;
            }
        }

        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if *tab == RecentTab::Downloads {
                if ui.button("Clear Finished").clicked() {
                    server.native_downloads.clear_done();
                }
                if ui.button("📁 Open Downloads Folder").clicked() {
                    open_dir_in_explorer(&download_dir);
                }
            }
        });
    });

    ui.add_space(8.0);
    ui.separator();
    ui.add_space(8.0);

    match *tab {
        RecentTab::All => {
            render_all_summary(ui, files, &downloads, &uploads, tab);
            ui.add_space(16.0);

            if !downloads.is_empty() {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("RECENT DOWNLOADS DIRECTLY TO DISK").size(11.0).strong().color(TEXT_MUTED));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.small_button("View all downloads →").clicked() {
                            *tab = RecentTab::Downloads;
                        }
                    });
                });
                ui.add_space(4.0);
                for task in downloads.iter().take(3) {
                    render_recent_download_item(ui, task, server);
                    ui.add_space(4.0);
                }
                ui.add_space(12.0);
            }

            ui.label(RichText::new("RECENT CLOUD FILES").size(11.0).strong().color(TEXT_MUTED));
            ui.add_space(4.0);
            render_explorer(ui, folders, files, view_mode, selected_files, selected_folders, actions, thumb_fn);
        }
        RecentTab::Files => {
            render_explorer(ui, folders, files, view_mode, selected_files, selected_folders, actions, thumb_fn);
        }
        RecentTab::Downloads => {
            if downloads.is_empty() {
                ui.vertical_centered(|ui| {
                    ui.add_space(80.0);
                    ui.label(RichText::new("⬇").size(48.0).color(TEXT_MUTED));
                    ui.add_space(8.0);
                    ui.label(RichText::new("No downloads yet").size(16.0).strong().color(TEXT_PRIMARY));
                    ui.label(RichText::new("Downloaded files stream directly to your local drive without browser popups or Edge warnings.").size(12.0).color(TEXT_MUTED));
                });
            } else {
                egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                    for task in &downloads {
                        render_recent_download_item(ui, task, server);
                        ui.add_space(6.0);
                    }
                });
            }
        }
        RecentTab::Uploads => {
            if uploads.is_empty() {
                ui.vertical_centered(|ui| {
                    ui.add_space(80.0);
                    ui.label(RichText::new("⬆").size(48.0).color(TEXT_MUTED));
                    ui.add_space(8.0);
                    ui.label(RichText::new("No active or recent uploads").size(16.0).strong().color(TEXT_PRIMARY));
                    ui.label(RichText::new("Drag and drop files or folders anywhere in the app to upload directly to Telegram cloud storage.").size(12.0).color(TEXT_MUTED));
                });
            } else {
                egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                    for up in &uploads {
                        render_recent_upload_item(ui, up, server);
                        ui.add_space(6.0);
                    }
                });
            }
        }
    }
}

fn render_all_summary(
    ui: &mut Ui,
    files: &[FileDTO],
    downloads: &[crate::native_downloads::NativeDownloadTask],
    uploads: &[crate::server::ActiveUploadSession],
    _tab: &mut RecentTab,
) {
    let completed_dl = downloads.iter().filter(|t| t.status == "done").count();
    let active_dl = downloads.iter().filter(|t| matches!(t.status.as_str(), "downloading" | "finalizing")).count();
    let total_dl_bytes: u64 = downloads.iter().filter(|t| t.status == "done").map(|t| t.size).sum();

    let completed_up = uploads.iter().filter(|u| u.status == "done").count();
    let active_up = uploads.iter().filter(|u| matches!(u.status.as_str(), "active" | "finalizing")).count();

    ui.horizontal(|ui| {
        // Card 1: Cloud Files
        render_stat_card(ui, "📁 Cloud Files", &format!("{}", files.len()), "In recent vault view", ACCENT);
        ui.add_space(8.0);

        // Card 2: Downloads
        let dl_sub = if active_dl > 0 {
            format!("{} active now · {}", active_dl, fmt_bytes(total_dl_bytes))
        } else {
            format!("{} saved to disk", fmt_bytes(total_dl_bytes))
        };
        render_stat_card(ui, "⬇ Downloads", &format!("{} finished", completed_dl), &dl_sub, Color32::from_rgb(34, 197, 94));
        ui.add_space(8.0);

        // Card 3: Uploads
        let up_sub = if active_up > 0 {
            format!("{} uploading now", active_up)
        } else {
            format!("{} completed", completed_up)
        };
        render_stat_card(ui, "⬆ Uploads", &format!("{} tracked", uploads.len()), &up_sub, COLOR_VIDEO);
    });
}

fn render_stat_card(ui: &mut Ui, title: &str, value: &str, subtitle: &str, accent_color: Color32) {
    egui::Frame::new()
        .fill(BG_SURFACE)
        .corner_radius(8.0)
        .stroke(egui::Stroke::new(1.0_f32, BORDER))
        .inner_margin(egui::Margin::symmetric(14, 10))
        .show(ui, |ui| {
            ui.set_min_size(Vec2::new(180.0, 56.0));
            ui.vertical(|ui| {
                ui.label(RichText::new(title).size(11.0).color(accent_color).strong());
                ui.label(RichText::new(value).size(16.0).color(TEXT_PRIMARY).strong());
                ui.label(RichText::new(subtitle).size(10.5).color(TEXT_MUTED));
            });
        });
}

fn render_recent_download_item(ui: &mut Ui, task: &crate::native_downloads::NativeDownloadTask, server: &Arc<AppServer>) {
    egui::Frame::new()
        .fill(BG_SURFACE)
        .corner_radius(8.0)
        .stroke(egui::Stroke::new(1.0_f32, BORDER))
        .inner_margin(egui::Margin::same(10))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                let icon = match task.status.as_str() {
                    "done" => "✓",
                    "finalizing" => "⚙",
                    "downloading" => "⬇",
                    "paused" => "⏸",
                    "failed" => "⚠",
                    _ => "⬇",
                };
                let icon_color = match task.status.as_str() {
                    "done" => Color32::from_rgb(34, 197, 94),
                    "failed" => Color32::from_rgb(239, 68, 68),
                    _ => ACCENT,
                };
                ui.label(RichText::new(icon).size(18.0).color(icon_color).strong());

                ui.vertical(|ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(&task.name).size(12.5).strong().color(TEXT_PRIMARY));
                        ui.label(RichText::new(format!("({})", task.status)).size(10.5).color(icon_color));
                    });

                    let ratio = if task.status == "done" || task.status == "finalizing" {
                        1.0
                    } else if task.size > 0 {
                        (task.downloaded as f32 / task.size as f32).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };

                    let progress_text = if task.status == "finalizing" {
                        "100% · Finalizing & verifying on disk...".to_string()
                    } else if task.status == "done" {
                        format!("{} (100% on disk)", fmt_bytes(task.size))
                    } else {
                        format!("{} / {} ({:.1}%)", fmt_bytes(task.downloaded), fmt_bytes(task.size), ratio * 100.0)
                    };

                    ui.add(
                        ProgressBar::new(ratio)
                            .show_percentage()
                            .text(progress_text)
                            .corner_radius(4.0)
                    );

                    ui.horizontal(|ui| {
                        if task.status == "downloading" && task.speed > 0 {
                            ui.label(RichText::new(format!("⚡ {}/s · ETA {}s", fmt_bytes(task.speed), task.eta)).size(10.5).color(ACCENT));
                        } else if task.status == "done" {
                            ui.label(RichText::new("Direct native disk storage").size(10.5).color(TEXT_MUTED));
                        }
                        ui.add_space(8.0);
                        ui.label(RichText::new(&task.dest_path).size(10.0).color(TEXT_MUTED));
                    });
                });

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    match task.status.as_str() {
                        "done" => {
                            if ui.button("Open File").clicked() {
                                let _ = server.native_downloads.open_file(&task.id);
                            }
                            if ui.button("Reveal").on_hover_text("Reveal file in Windows Explorer").clicked() {
                                let _ = server.native_downloads.reveal_file(&task.id);
                            }
                        }
                        "downloading" => {
                            if ui.button("Pause").clicked() {
                                let _ = server.native_downloads.pause_download(&task.id);
                            }
                            if ui.button("Cancel").clicked() {
                                let _ = server.native_downloads.cancel_download(&task.id);
                            }
                        }
                        "paused" => {
                            if ui.button("Resume").clicked() {
                                let _ = server.native_downloads.resume_download(&task.id);
                            }
                            if ui.button("Cancel").clicked() {
                                let _ = server.native_downloads.cancel_download(&task.id);
                            }
                        }
                        "failed" => {
                            if ui.button("Retry").clicked() {
                                let _ = server.native_downloads.resume_download(&task.id);
                            }
                        }
                        _ => {}
                    }
                });
            });
        });
}

fn render_recent_upload_item(ui: &mut Ui, up: &crate::server::ActiveUploadSession, server: &Arc<AppServer>) {
    egui::Frame::new()
        .fill(BG_SURFACE)
        .corner_radius(8.0)
        .stroke(egui::Stroke::new(1.0_f32, BORDER))
        .inner_margin(egui::Margin::same(10))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("⬆").size(18.0).color(COLOR_VIDEO).strong());

                ui.vertical(|ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(&up.name).size(12.5).strong().color(TEXT_PRIMARY));
                        ui.label(RichText::new(format!("({})", up.status)).size(10.5).color(COLOR_VIDEO));
                    });

                    let parts_done = up.parts.iter().filter(|p| matches!(p.status.as_str(), "completed" | "stored")).count();
                    let parts_total = up.parts.len().max(1);
                    let uploaded_bytes: u64 = up.parts.iter().map(|p| {
                        if matches!(p.status.as_str(), "completed" | "stored") {
                            p.size
                        } else if p.slice_count > 0 {
                            (p.received_slices.len() as u64 * p.size) / p.slice_count as u64
                        } else {
                            0
                        }
                    }).sum();

                    let ratio = if up.size > 0 {
                        (uploaded_bytes as f32 / up.size as f32).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };

                    let progress_text = format!("{} / {} ({:.1}%)", fmt_bytes(uploaded_bytes), fmt_bytes(up.size), ratio * 100.0);

                    ui.add(
                        ProgressBar::new(ratio)
                            .show_percentage()
                            .text(progress_text)
                            .corner_radius(4.0)
                    );

                    ui.horizontal(|ui| {
                        ui.label(RichText::new(format!("Parts: {} / {}", parts_done, parts_total)).size(10.5).color(TEXT_MUTED));
                        if let Some(ref p) = up.source_path {
                            ui.add_space(8.0);
                            ui.label(RichText::new(p).size(10.0).color(TEXT_MUTED));
                        }
                    });
                });

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Cancel").clicked() {
                        server.drop_upload(&up.id);
                    }
                });
            });
        });
}

fn open_dir_in_explorer(dir_path: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("explorer.exe")
            .arg(dir_path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(dir_path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(dir_path).spawn();
    }
}
