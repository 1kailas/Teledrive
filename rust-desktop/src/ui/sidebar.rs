use eframe::egui::{self, Color32, RichText, Sense, Ui};
use crate::ui::theme::*;
use crate::ui::types::NavPage;

pub fn render_sidebar(
    ui: &mut Ui,
    current_page: &mut NavPage,
    used_bytes: u64,
    file_count: usize,
    active_transfers: usize,
    healthy_bots: usize,
) {
    ui.add_space(8.0);

    // App Brand Header
    ui.horizontal(|ui| {
        ui.add_space(4.0);
        ui.label(RichText::new("⚡").color(ACCENT).size(20.0).strong());
        ui.vertical(|ui| {
            ui.label(RichText::new("TeleDriveR").color(TEXT_PRIMARY).size(15.0).strong());
            ui.label(RichText::new("Native Pure Rust").color(TEXT_MUTED).size(10.5));
        });
    });

    ui.add_space(16.0);
    ui.separator();
    ui.add_space(8.0);

    // Navigation Items
    let pages = [
        (NavPage::Drive, "📁", "My Drive"),
        (NavPage::Starred, "⭐", "Starred"),
        (NavPage::Recent, "🕒", "Recent"),
        (NavPage::Category("image"), "🖼", "Photos & Images"),
        (NavPage::Category("video"), "🎬", "Videos"),
        (NavPage::Category("audio"), "🎵", "Audio"),
        (NavPage::Category("document"), "📄", "Documents"),
        (NavPage::Transfers, "⬇", "Transfers"),
        (NavPage::Trash, "🗑", "Trash"),
        (NavPage::Settings, "⚙", "Settings"),
    ];

    for (page, icon, label) in pages {
        let is_selected = *current_page == page;
        let mut text = RichText::new(format!("{}  {}", icon, label)).size(13.0);
        if is_selected {
            text = text.color(ACCENT).strong();
        } else {
            text = text.color(TEXT_PRIMARY);
        }

        let bg_color = if is_selected {
            BG_SURFACE_SELECTED
        } else {
            Color32::TRANSPARENT
        };

        let response = egui::Frame::new()
            .fill(bg_color)
            .corner_radius(6.0)
            .inner_margin(egui::Margin::symmetric(8, 6))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(text);
                    if page == NavPage::Transfers && active_transfers > 0 {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let badge = egui::Frame::new()
                                .fill(ACCENT)
                                .corner_radius(8.0)
                                .inner_margin(egui::Margin::symmetric(6, 1))
                                .show(ui, |ui| {
                                    ui.label(
                                        RichText::new(format!("{}", active_transfers))
                                            .color(Color32::BLACK)
                                            .size(10.0)
                                            .strong(),
                                    );
                                });
                            let _ = badge;
                        });
                    }
                });
            });

        if response.response.interact(Sense::click()).clicked() {
            *current_page = page;
        }
    }

    ui.add_space(16.0);
    ui.separator();
    ui.add_space(8.0);

    // Storage Usage Card
    egui::Frame::new()
        .fill(BG_SURFACE)
        .corner_radius(6.0)
        .stroke(egui::Stroke::new(1.0_f32, BORDER))
        .inner_margin(egui::Margin::same(10))
        .show(ui, |ui| {
            ui.label(RichText::new("Storage Used").color(TEXT_MUTED).size(11.0));
            ui.add_space(2.0);
            ui.label(
                RichText::new(fmt_bytes(used_bytes))
                    .color(TEXT_PRIMARY)
                    .size(14.0)
                    .strong(),
            );
            ui.label(
                RichText::new(format!("{} cloud files", file_count))
                    .color(TEXT_MUTED)
                    .size(11.0),
            );
        });

    ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            let dot_color = if healthy_bots > 0 {
                Color32::from_rgb(34, 197, 94)
            } else {
                Color32::from_rgb(239, 68, 68)
            };
            ui.label(RichText::new("●").color(dot_color).size(12.0));
            ui.label(
                RichText::new(format!("{} bots online (2GB API)", healthy_bots))
                    .color(TEXT_MUTED)
                    .size(10.5),
            );
        });
    });
}
