use std::sync::Arc;
use chrono::Utc;
use eframe::egui::{self, Color32, ProgressBar, RichText, Ui};
use crate::native_downloads::NativeDownloadTask;
use crate::server::AppServer;
use crate::sync_ext::RwLockExt;
use crate::ui::theme::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferTab {
    All,
    Active,
    Downloads,
    Uploads,
    Completed,
}

pub fn render_transfers_view(
    ui: &mut Ui,
    tab: &mut TransferTab,
    server: &Arc<AppServer>,
) {
    ui.add_space(4.0);

    // Top action bar & tabs
    ui.horizontal(|ui| {
        ui.label(RichText::new("Transfers Hub").size(18.0).strong().color(TEXT_PRIMARY));
        ui.add_space(16.0);

        let tabs = [
            (TransferTab::All, "All"),
            (TransferTab::Active, "Active"),
            (TransferTab::Downloads, "Downloads"),
            (TransferTab::Uploads, "Uploads"),
            (TransferTab::Completed, "Completed"),
        ];

        for (t, label) in tabs {
            if ui.selectable_label(*tab == t, label).clicked() {
                *tab = t;
            }
        }

        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button("Clear Completed").clicked() {
                server.native_downloads.clear_done();
            }
        });
    });

    ui.add_space(8.0);
    ui.separator();
    ui.add_space(8.0);

    let (downloads, _) = server.native_downloads.list_downloads();
    let uploads: Vec<_> = {
        let map = server.active_uploads.read_safe();
        map.values().cloned().collect()
    };

    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        let show_downloads = matches!(*tab, TransferTab::All | TransferTab::Active | TransferTab::Downloads | TransferTab::Completed);
        let show_uploads = matches!(*tab, TransferTab::All | TransferTab::Active | TransferTab::Uploads | TransferTab::Completed);

        let mut has_items = false;

        // Render Downloads
        if show_downloads {
            for task in &downloads {
                let is_active = matches!(task.status.as_str(), "downloading" | "finalizing" | "queued");
                let is_done = task.status == "done";

                if *tab == TransferTab::Active && !is_active { continue; }
                if *tab == TransferTab::Completed && !is_done { continue; }

                has_items = true;
                render_download_card(ui, task, server);
                ui.add_space(6.0);
            }
        }

        // Render Uploads
        if show_uploads {
            for up in &uploads {
                let is_active = matches!(up.status.as_str(), "active" | "finalizing" | "staging");
                let is_done = up.status == "done";

                if *tab == TransferTab::Active && !is_active { continue; }
                if *tab == TransferTab::Completed && !is_done { continue; }

                has_items = true;
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

                egui::Frame::new()
                    .fill(BG_SURFACE)
                    .corner_radius(8.0)
                    .stroke(egui::Stroke::new(1.0_f32, BORDER))
                    .inner_margin(egui::Margin::same(12))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new("⬆").size(20.0).color(COLOR_VIDEO).strong());

                            ui.vertical(|ui| {
                                ui.horizontal(|ui| {
                                    ui.label(RichText::new(&up.name).size(13.0).strong().color(TEXT_PRIMARY));
                                    ui.label(RichText::new(format!("({})", up.status)).size(11.0).color(status_color(&up.status)));
                                });

                                ui.add_space(2.0);

                                let ratio = if up.size > 0 {
                                    (uploaded_bytes as f32 / up.size as f32).clamp(0.0, 1.0)
                                } else {
                                    0.0
                                };

                                let progress_text = format!(
                                    "{} / {}  ({:.1}%)",
                                    fmt_bytes(uploaded_bytes),
                                    fmt_bytes(up.size),
                                    ratio * 100.0
                                );

                                ui.add(
                                    ProgressBar::new(ratio)
                                        .show_percentage()
                                        .text(progress_text)
                                        .corner_radius(4.0),
                                );

                                ui.add_space(2.0);

                                ui.horizontal(|ui| {
                                    ui.label(RichText::new(format!("Parts: {} / {}", parts_done, parts_total)).size(10.5).color(TEXT_MUTED));
                                    if let Some(ref p) = up.source_path {
                                        ui.add_space(10.0);
                                        ui.label(RichText::new(p).size(10.5).color(TEXT_MUTED));
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
                ui.add_space(6.0);
            }
        }

        if !has_items {
            ui.vertical_centered(|ui| {
                ui.add_space(60.0);
                ui.label(RichText::new("No transfers in this view").size(14.0).color(TEXT_MUTED));
            });
        }
    });
}

fn render_download_card(ui: &mut Ui, task: &NativeDownloadTask, server: &Arc<AppServer>) {
    let bg = BG_SURFACE;
    egui::Frame::new()
        .fill(bg)
        .corner_radius(8.0)
        .stroke(egui::Stroke::new(1.0_f32, BORDER))
        .inner_margin(egui::Margin::same(12))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("⬇").size(20.0).color(ACCENT).strong());

                ui.vertical(|ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(&task.name).size(13.0).strong().color(TEXT_PRIMARY));
                        ui.label(RichText::new(format!("({})", task.status)).size(11.0).color(status_color(&task.status)));
                    });

                    ui.add_space(2.0);

                    // Progress bar
                    let is_finishing = task.status == "finalizing" || task.status == "done";
                    let ratio = if is_finishing {
                        1.0
                    } else if task.size > 0 {
                        (task.downloaded as f32 / task.size as f32).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };

                    let progress_text = if task.status == "finalizing" {
                        "100% · Finalizing & verifying on disk...".to_string()
                    } else if task.status == "done" {
                        format!("{} / {} (100%)", fmt_bytes(task.size), fmt_bytes(task.size))
                    } else {
                        format!(
                            "{} / {}  ({:.1}%)",
                            fmt_bytes(task.downloaded),
                            fmt_bytes(task.size),
                            ratio * 100.0
                        )
                    };

                    ui.add(
                        ProgressBar::new(ratio)
                            .show_percentage()
                            .text(progress_text)
                            .corner_radius(4.0)
                    );

                    ui.add_space(2.0);

                    // Speed & destination path
                    ui.horizontal(|ui| {
                        if task.status == "downloading" && task.speed > 0 {
                            ui.label(
                                RichText::new(format!("⚡ {}/s", fmt_bytes(task.speed)))
                                    .size(11.0)
                                    .color(ACCENT),
                            );
                            if task.eta > 0 {
                                ui.label(RichText::new(format!("· ETA {}s", task.eta)).size(11.0).color(TEXT_MUTED));
                            }
                        } else if task.status == "finalizing" {
                            ui.label(RichText::new("⚙ Finalizing & verifying file...").size(11.0).color(ACCENT));
                        } else if task.status == "queued" {
                            ui.label(RichText::new("⏳ Queued in download scheduler...").size(11.0).color(TEXT_MUTED));
                        } else if task.status == "done" {
                            ui.label(RichText::new("✓ Completed directly to disk").size(11.0).color(Color32::from_rgb(34, 197, 94)));
                        } else if let Some(ref err) = task.error {
                            ui.label(RichText::new(format!("Error: {}", err)).size(11.0).color(Color32::from_rgb(239, 68, 68)));
                        }

                        ui.add_space(10.0);
                        ui.label(RichText::new(&task.dest_path).size(10.5).color(TEXT_MUTED));
                    });
                });

                // Action buttons on right
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    match task.status.as_str() {
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
                        "done" => {
                            if ui.button("Open File").clicked() {
                                let _ = server.native_downloads.open_file(&task.id);
                            }
                            if ui.button("Reveal in Explorer").clicked() {
                                let _ = server.native_downloads.reveal_file(&task.id);
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

fn status_color(status: &str) -> Color32 {
    match status {
        "downloading" | "uploading" | "active" => ACCENT,
        "done" => Color32::from_rgb(34, 197, 94),
        "paused" => Color32::from_rgb(234, 179, 8),
        "failed" => Color32::from_rgb(239, 68, 68),
        _ => TEXT_MUTED,
    }
}

pub fn render_floating_dock(
    ctx: &egui::Context,
    server: &Arc<AppServer>,
    on_open_transfers: &mut bool,
    collapsed: &mut bool,
    dismissed: &mut bool,
) {
    if *dismissed {
        return;
    }

    let (downloads, _) = server.native_downloads.list_downloads();
    let uploads: Vec<_> = {
        let map = server.active_uploads.read_safe();
        map.values().cloned().collect()
    };

    let active_downloads: Vec<_> = downloads.iter()
        .filter(|t| matches!(t.status.as_str(), "downloading" | "finalizing" | "queued"))
        .collect();
    let active_uploads: Vec<_> = uploads.iter()
        .filter(|u| matches!(u.status.as_str(), "active" | "finalizing" | "staging"))
        .collect();

    let recent_done = downloads.iter().find(|t| t.status == "done" && Utc::now().timestamp_millis() - t.created_at < 30_000);

    if active_downloads.is_empty() && active_uploads.is_empty() && recent_done.is_none() {
        return;
    }

    let total_active = active_downloads.len() + active_uploads.len();

    egui::Area::new(egui::Id::new("floating_transfer_dock_area"))
        .anchor(egui::Align2::RIGHT_BOTTOM, egui::vec2(-20.0, -20.0))
        .show(ctx, |ui| {
            egui::Frame::new()
                .fill(BG_SURFACE)
                .stroke(egui::Stroke::new(1.5_f32, ACCENT))
                .corner_radius(10.0)
                .inner_margin(egui::Margin::symmetric(14, 10))
                .show(ui, |ui| {
                    ui.set_width(330.0);

                    // Header
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("⚡").size(16.0).color(ACCENT).strong());
                        let header_title = if total_active > 0 {
                            format!("Transfers ({} active)", total_active)
                        } else {
                            "Download Complete".to_string()
                        };
                        ui.label(RichText::new(header_title).size(12.5).strong().color(TEXT_PRIMARY));

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.small_button("✕").on_hover_text("Dismiss floating dock").clicked() {
                                *dismissed = true;
                            }
                            let collapse_icon = if *collapsed { "▲" } else { "▼" };
                            if ui.small_button(collapse_icon).on_hover_text("Collapse / Expand").clicked() {
                                *collapsed = !*collapsed;
                            }
                            if ui.small_button("Hub ↗").on_hover_text("Open Transfers Hub").clicked() {
                                *on_open_transfers = true;
                            }
                        });
                    });

                    if !*collapsed {
                        ui.add_space(6.0);
                        ui.separator();
                        ui.add_space(6.0);

                        if let Some(task) = active_downloads.first().copied().or(recent_done) {
                            ui.horizontal(|ui| {
                                let icon = if task.status == "done" { "✓" } else { "⬇" };
                                let col = if task.status == "done" { Color32::from_rgb(34, 197, 94) } else { ACCENT };
                                ui.label(RichText::new(icon).size(15.0).color(col).strong());
                                ui.label(RichText::new(&task.name).size(12.0).strong().color(TEXT_PRIMARY));
                            });

                            let is_done = task.status == "done";
                            let is_finishing = task.status == "finalizing" || is_done;
                            let ratio = if is_finishing {
                                1.0
                            } else if task.size > 0 {
                                (task.downloaded as f32 / task.size as f32).clamp(0.0, 1.0)
                            } else {
                                0.0
                            };

                            let progress_text = if task.status == "finalizing" {
                                "100% · Finalizing on disk...".to_string()
                            } else if is_done {
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
                                    ui.label(RichText::new(format!("⚡ {}/s · ETA {}s", fmt_bytes(task.speed), task.eta)).size(10.0).color(ACCENT));
                                } else if is_done {
                                    ui.label(RichText::new("Saved directly to Downloads").size(10.0).color(Color32::from_rgb(34, 197, 94)));
                                }

                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    if is_done {
                                        if ui.small_button("Open").clicked() {
                                            let _ = server.native_downloads.open_file(&task.id);
                                        }
                                        if ui.small_button("Reveal").clicked() {
                                            let _ = server.native_downloads.reveal_file(&task.id);
                                        }
                                    } else if task.status == "downloading" {
                                        if ui.small_button("Pause").clicked() {
                                            let _ = server.native_downloads.pause_download(&task.id);
                                        }
                                        if ui.small_button("Cancel").clicked() {
                                            let _ = server.native_downloads.cancel_download(&task.id);
                                        }
                                    }
                                });
                            });
                        }

                        if let Some(up) = active_uploads.first() {
                            ui.add_space(4.0);
                            ui.separator();
                            ui.add_space(4.0);

                            ui.horizontal(|ui| {
                                ui.label(RichText::new("⬆").size(15.0).color(COLOR_VIDEO).strong());
                                ui.label(RichText::new(&up.name).size(12.0).strong().color(TEXT_PRIMARY));
                            });

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

                            ui.add(
                                ProgressBar::new(ratio)
                                    .show_percentage()
                                    .text(format!("{} / {} ({:.1}%)", fmt_bytes(uploaded_bytes), fmt_bytes(up.size), ratio * 100.0))
                                    .corner_radius(4.0)
                            );
                        }
                    }
                });
        });
}
