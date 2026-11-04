use eframe::egui::{self, Color32, RichText, Ui};
use crate::models::Breadcrumb;
use crate::ui::theme::*;
use crate::ui::types::{SortBy, SortDir, ViewMode};

pub fn render_header(
    ui: &mut Ui,
    breadcrumbs: &[Breadcrumb],
    current_folder_name: &str,
    on_navigate: &mut Option<Option<String>>,
    search_query: &mut String,
    view_mode: &mut ViewMode,
    sort_by: &mut SortBy,
    sort_dir: &mut SortDir,
    on_upload_files: &mut bool,
    on_upload_folder: &mut bool,
    on_new_folder: &mut bool,
    on_refresh: &mut bool,
    active_transfers: usize,
    on_open_transfers: &mut bool,
) {
    ui.horizontal(|ui| {
        // Left: Breadcrumbs
        ui.horizontal(|ui| {
            let home_btn = ui.selectable_label(breadcrumbs.is_empty(), "Home");
            if home_btn.clicked() && !breadcrumbs.is_empty() {
                *on_navigate = Some(None);
            }

            for (idx, b) in breadcrumbs.iter().enumerate() {
                ui.label(RichText::new("/").color(TEXT_MUTED));
                let is_last = idx == breadcrumbs.len() - 1;
                let btn = ui.selectable_label(is_last, &b.name);
                if btn.clicked() && !is_last {
                    *on_navigate = Some(Some(b.id.clone()));
                }
            }

            if breadcrumbs.is_empty() && !current_folder_name.is_empty() && current_folder_name != "My Drive" {
                ui.label(RichText::new("/").color(TEXT_MUTED));
                ui.label(RichText::new(current_folder_name).color(ACCENT).strong());
            }
        });

        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            // Action Buttons
            if ui.button(RichText::new("+ Upload Files").color(Color32::BLACK).strong()).clicked() {
                *on_upload_files = true;
            }
            if ui.button("+ Upload Folder").clicked() {
                *on_upload_folder = true;
            }
            if ui.button("+ New Folder").clicked() {
                *on_new_folder = true;
            }
            if ui.button("↻").on_hover_text("Refresh").clicked() {
                *on_refresh = true;
            }

            if active_transfers > 0 {
                let badge_btn = egui::Button::new(
                    RichText::new(format!("⚡ {} Active", active_transfers))
                        .color(Color32::BLACK)
                        .strong()
                        .size(11.5)
                ).fill(ACCENT).corner_radius(6.0);
                if ui.add(badge_btn).on_hover_text("Open Transfers Hub").clicked() {
                    *on_open_transfers = true;
                }
            }

            ui.separator();

            // View Mode Switcher
            let grid_active = *view_mode == ViewMode::Grid;
            if ui.selectable_label(grid_active, "⊞").on_hover_text("Grid View").clicked() {
                *view_mode = ViewMode::Grid;
            }
            let list_active = *view_mode == ViewMode::List;
            if ui.selectable_label(list_active, "☰").on_hover_text("List View").clicked() {
                *view_mode = ViewMode::List;
            }

            ui.separator();

            // Sort Selector
            egui::ComboBox::from_id_salt("sort_by_combo")
                .selected_text(match sort_by {
                    SortBy::Name => "Sort: Name",
                    SortBy::Size => "Sort: Size",
                    SortBy::Date => "Sort: Date",
                })
                .show_ui(ui, |ui| {
                    ui.selectable_value(sort_by, SortBy::Name, "Name");
                    ui.selectable_value(sort_by, SortBy::Size, "Size");
                    ui.selectable_value(sort_by, SortBy::Date, "Date Modified");
                });

            let dir_icon = if *sort_dir == SortDir::Asc { "↑" } else { "↓" };
            if ui.small_button(dir_icon).on_hover_text("Toggle Sort Order").clicked() {
                *sort_dir = match sort_dir {
                    SortDir::Asc => SortDir::Desc,
                    SortDir::Desc => SortDir::Asc,
                };
            }

            ui.separator();

            // Search Bar
            ui.add(
                egui::TextEdit::singleline(search_query)
                    .hint_text("🔍 Search...")
                    .desired_width(180.0),
            );
        });
    });
}
