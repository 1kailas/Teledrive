use std::collections::HashSet;
use eframe::egui::{self, Color32, RichText, Sense, Ui, Vec2};
use crate::models::{FileDTO, FolderDTO};
use crate::ui::theme::*;
use crate::ui::types::ViewMode;

#[allow(dead_code)]
pub struct ExplorerActions {
    pub open_folder: Option<String>,
    pub start_download: Option<FileDTO>,
    pub open_preview: Option<FileDTO>,
    pub open_details: Option<FileDTO>,
    pub toggle_star_file: Option<(String, bool)>,
    pub toggle_star_folder: Option<(String, bool)>,
    pub rename_file: Option<FileDTO>,
    pub rename_folder: Option<FolderDTO>,
    pub trash_file: Option<FileDTO>,
    pub trash_folder: Option<FolderDTO>,
    pub move_selection: bool,
}

impl Default for ExplorerActions {
    fn default() -> Self {
        Self {
            open_folder: None,
            start_download: None,
            open_preview: None,
            open_details: None,
            toggle_star_file: None,
            toggle_star_folder: None,
            rename_file: None,
            rename_folder: None,
            trash_file: None,
            trash_folder: None,
            move_selection: false,
        }
    }
}

pub fn render_explorer(
    ui: &mut Ui,
    folders: &[FolderDTO],
    files: &[FileDTO],
    view_mode: ViewMode,
    selected_files: &mut HashSet<String>,
    selected_folders: &mut HashSet<String>,
    actions: &mut ExplorerActions,
    thumb_fn: &impl Fn(&str) -> Option<String>,
) {
    if folders.is_empty() && files.is_empty() {
        ui.vertical_centered(|ui| {
            ui.add_space(80.0);
            ui.label(RichText::new("📁").size(48.0).color(TEXT_MUTED));
            ui.add_space(8.0);
            ui.label(RichText::new("This folder is empty").size(16.0).strong().color(TEXT_PRIMARY));
            ui.label(RichText::new("Click '+ Upload Files' or drag and drop files here to upload").size(12.0).color(TEXT_MUTED));
        });
        return;
    }

    match view_mode {
        ViewMode::Grid => render_grid(ui, folders, files, selected_files, selected_folders, actions, thumb_fn),
        ViewMode::List => render_list(ui, folders, files, selected_files, selected_folders, actions, thumb_fn),
    }
}

fn render_grid(
    ui: &mut Ui,
    folders: &[FolderDTO],
    files: &[FileDTO],
    selected_files: &mut HashSet<String>,
    selected_folders: &mut HashSet<String>,
    actions: &mut ExplorerActions,
    thumb_fn: &impl Fn(&str) -> Option<String>,
) {
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        // Folders Section
        if !folders.is_empty() {
            ui.label(RichText::new("FOLDERS").size(11.0).strong().color(TEXT_MUTED));
            ui.add_space(4.0);

            let card_width = 190.0;
            let card_height = 56.0;

            ui.horizontal_wrapped(|ui| {
                for folder in folders {
                    let is_sel = selected_folders.contains(&folder.id);
                    let bg = if is_sel { BG_SURFACE_SELECTED } else { BG_SURFACE };

                    let resp = egui::Frame::new()
                        .fill(bg)
                        .stroke(egui::Stroke::new(1.0_f32, if is_sel { ACCENT } else { BORDER }))
                        .corner_radius(8.0)
                        .inner_margin(egui::Margin::symmetric(10, 8))
                        .show(ui, |ui| {
                            ui.set_min_size(Vec2::new(card_width, card_height));
                            ui.set_max_size(Vec2::new(card_width, card_height));
                            ui.horizontal(|ui| {
                                ui.label(RichText::new("📁").size(24.0).color(COLOR_FOLDER));
                                ui.vertical(|ui| {
                                    ui.label(
                                        RichText::new(&folder.name)
                                            .size(12.5)
                                            .strong()
                                            .color(TEXT_PRIMARY),
                                    );
                                    let subtext = if folder.child_count > 0 {
                                        format!("{} items", folder.child_count)
                                    } else {
                                        "Empty".to_string()
                                    };
                                    ui.label(RichText::new(subtext).size(10.5).color(TEXT_MUTED));
                                });
                            });
                        });

                    let r = resp.response.interact(Sense::click());
                    if r.double_clicked() {
                        actions.open_folder = Some(folder.id.clone());
                    } else if r.clicked() {
                        if ui.input(|i| i.modifiers.ctrl || i.modifiers.command) {
                            if is_sel {
                                selected_folders.remove(&folder.id);
                            } else {
                                selected_folders.insert(folder.id.clone());
                            }
                        } else {
                            selected_folders.clear();
                            selected_files.clear();
                            selected_folders.insert(folder.id.clone());
                        }
                    }

                    r.context_menu(|ui| {
                        if ui.button("Open").clicked() {
                            actions.open_folder = Some(folder.id.clone());
                            ui.close_menu();
                        }
                        if ui.button(if folder.starred { "★ Unstar" } else { "☆ Star" }).clicked() {
                            actions.toggle_star_folder = Some((folder.id.clone(), !folder.starred));
                            ui.close_menu();
                        }
                        if ui.button("Rename").clicked() {
                            actions.rename_folder = Some(folder.clone());
                            ui.close_menu();
                        }
                        ui.separator();
                        if ui.button(RichText::new("Move to Trash").color(Color32::from_rgb(239, 68, 68))).clicked() {
                            actions.trash_folder = Some(folder.clone());
                            ui.close_menu();
                        }
                    });
                }
            });
            ui.add_space(16.0);
        }

        // Files Section
        if !files.is_empty() {
            ui.label(RichText::new("FILES").size(11.0).strong().color(TEXT_MUTED));
            ui.add_space(4.0);

            let card_width = 175.0;
            let card_height = 160.0;

            ui.horizontal_wrapped(|ui| {
                for file in files {
                    let is_sel = selected_files.contains(&file.id);
                    let bg = if is_sel { BG_SURFACE_SELECTED } else { BG_SURFACE };

                    let resp = egui::Frame::new()
                        .fill(bg)
                        .stroke(egui::Stroke::new(1.0_f32, if is_sel { ACCENT } else { BORDER }))
                        .corner_radius(8.0)
                        .inner_margin(egui::Margin::same(8))
                        .show(ui, |ui| {
                            ui.set_min_size(Vec2::new(card_width, card_height));
                            ui.set_max_size(Vec2::new(card_width, card_height));
                            ui.vertical(|ui| {
                                egui::Frame::new()
                                    .fill(BG_INPUT)
                                    .corner_radius(6.0)
                                    .inner_margin(egui::Margin::same(4))
                                    .show(ui, |ui| {
                                        ui.set_min_size(Vec2::new(card_width - 16.0, 80.0));
                                        ui.set_max_size(Vec2::new(card_width - 16.0, 80.0));
                                        if let Some(uri) = thumb_fn(&file.id) {
                                            ui.centered_and_justified(|ui| {
                                                ui.add(
                                                    egui::Image::new(uri)
                                                        .max_size(Vec2::new(card_width - 16.0, 80.0))
                                                        .corner_radius(4.0)
                                                );
                                            });
                                        } else {
                                            ui.centered_and_justified(|ui| {
                                                let glyph = category_glyph(&file.category);
                                                let color = category_color(&file.category);
                                                ui.label(RichText::new(glyph).size(36.0).color(color));
                                            });
                                        }
                                    });

                                ui.add_space(4.0);

                                ui.label(
                                    RichText::new(&file.name)
                                        .size(12.0)
                                        .strong()
                                        .color(TEXT_PRIMARY),
                                );

                                ui.horizontal(|ui| {
                                    ui.label(RichText::new(fmt_bytes(file.size)).size(10.5).color(TEXT_MUTED));
                                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                        if file.starred {
                                            ui.label(RichText::new("★").size(12.0).color(Color32::from_rgb(250, 204, 21)));
                                        }
                                    });
                                });
                            });
                        });

                    let r = resp.response.interact(Sense::click());
                    if r.double_clicked() {
                        if matches!(file.category.as_str(), "image" | "code" | "document") {
                            actions.open_preview = Some(file.clone());
                        } else {
                            actions.start_download = Some(file.clone());
                        }
                    } else if r.clicked() {
                        if ui.input(|i| i.modifiers.ctrl || i.modifiers.command) {
                            if is_sel {
                                selected_files.remove(&file.id);
                            } else {
                                selected_files.insert(file.id.clone());
                            }
                        } else {
                            selected_files.clear();
                            selected_folders.clear();
                            selected_files.insert(file.id.clone());
                            actions.open_details = Some(file.clone());
                        }
                    }

                    r.context_menu(|ui| {
                        if ui.button("⬇ Download to Disk").clicked() {
                            actions.start_download = Some(file.clone());
                            ui.close_menu();
                        }
                        if ui.button("👁 Preview").clicked() {
                            actions.open_preview = Some(file.clone());
                            ui.close_menu();
                        }
                        if ui.button("ℹ Details").clicked() {
                            actions.open_details = Some(file.clone());
                            ui.close_menu();
                        }
                        if ui.button(if file.starred { "★ Unstar" } else { "☆ Star" }).clicked() {
                            actions.toggle_star_file = Some((file.id.clone(), !file.starred));
                            ui.close_menu();
                        }
                        if ui.button("Rename").clicked() {
                            actions.rename_file = Some(file.clone());
                            ui.close_menu();
                        }
                        ui.separator();
                        if ui.button(RichText::new("Move to Trash").color(Color32::from_rgb(239, 68, 68))).clicked() {
                            actions.trash_file = Some(file.clone());
                            ui.close_menu();
                        }
                    });
                }
            });
        }
    });
}

fn render_list(
    ui: &mut Ui,
    folders: &[FolderDTO],
    files: &[FileDTO],
    selected_files: &mut HashSet<String>,
    selected_folders: &mut HashSet<String>,
    actions: &mut ExplorerActions,
    thumb_fn: &impl Fn(&str) -> Option<String>,
) {
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        // Table Header
        ui.horizontal(|ui| {
            ui.add_space(8.0);
            ui.label(RichText::new("Name").size(11.0).strong().color(TEXT_MUTED));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(20.0);
                ui.label(RichText::new("Actions").size(11.0).strong().color(TEXT_MUTED));
                ui.add_space(40.0);
                ui.label(RichText::new("Modified").size(11.0).strong().color(TEXT_MUTED));
                ui.add_space(40.0);
                ui.label(RichText::new("Size").size(11.0).strong().color(TEXT_MUTED));
                ui.add_space(40.0);
                ui.label(RichText::new("Type").size(11.0).strong().color(TEXT_MUTED));
            });
        });
        ui.separator();

        // Folders list rows
        for folder in folders {
            let is_sel = selected_folders.contains(&folder.id);
            let bg = if is_sel { BG_SURFACE_SELECTED } else { Color32::TRANSPARENT };

            let row = egui::Frame::new()
                .fill(bg)
                .corner_radius(4.0)
                .inner_margin(egui::Margin::symmetric(8, 6))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("📁").size(16.0).color(COLOR_FOLDER));
                        ui.label(RichText::new(&folder.name).size(12.5).strong().color(TEXT_PRIMARY));

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.small_button("Open").clicked() {
                                actions.open_folder = Some(folder.id.clone());
                            }
                            if ui.small_button(if folder.starred { "★" } else { "☆" }).clicked() {
                                actions.toggle_star_folder = Some((folder.id.clone(), !folder.starred));
                            }
                            ui.add_space(30.0);
                            ui.label(RichText::new(fmt_date(folder.updated_at)).size(11.0).color(TEXT_MUTED));
                            ui.add_space(30.0);
                            ui.label(RichText::new(format!("{} items", folder.child_count)).size(11.0).color(TEXT_MUTED));
                            ui.add_space(30.0);
                            ui.label(RichText::new("Folder").size(11.0).color(TEXT_MUTED));
                        });
                    });
                });

            let r = row.response.interact(Sense::click());
            if r.double_clicked() {
                actions.open_folder = Some(folder.id.clone());
            } else if r.clicked() {
                selected_folders.clear();
                selected_files.clear();
                selected_folders.insert(folder.id.clone());
            }
        }

        // Files list rows
        for file in files {
            let is_sel = selected_files.contains(&file.id);
            let bg = if is_sel { BG_SURFACE_SELECTED } else { Color32::TRANSPARENT };

            let row = egui::Frame::new()
                .fill(bg)
                .corner_radius(4.0)
                .inner_margin(egui::Margin::symmetric(8, 6))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        if let Some(uri) = thumb_fn(&file.id) {
                            ui.add(
                                egui::Image::new(uri)
                                    .max_size(Vec2::new(20.0, 20.0))
                                    .corner_radius(3.0)
                            );
                        } else {
                            let glyph = category_glyph(&file.category);
                            let color = category_color(&file.category);
                            ui.label(RichText::new(glyph).size(16.0).color(color));
                        }
                        ui.label(RichText::new(&file.name).size(12.5).strong().color(TEXT_PRIMARY));

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.small_button("⬇").on_hover_text("Download").clicked() {
                                actions.start_download = Some(file.clone());
                            }
                            if ui.small_button("ℹ").on_hover_text("Details").clicked() {
                                actions.open_details = Some(file.clone());
                            }
                            if ui.small_button(if file.starred { "★" } else { "☆" }).clicked() {
                                actions.toggle_star_file = Some((file.id.clone(), !file.starred));
                            }
                            ui.add_space(30.0);
                            ui.label(RichText::new(fmt_date(file.updated_at)).size(11.0).color(TEXT_MUTED));
                            ui.add_space(30.0);
                            ui.label(RichText::new(fmt_bytes(file.size)).size(11.0).color(TEXT_MUTED));
                            ui.add_space(30.0);
                            ui.label(RichText::new(&file.category).size(11.0).color(category_color(&file.category)));
                        });
                    });
                });

            let r = row.response.interact(Sense::click());
            if r.double_clicked() {
                if matches!(file.category.as_str(), "image" | "code" | "document") {
                    actions.open_preview = Some(file.clone());
                } else {
                    actions.start_download = Some(file.clone());
                }
            } else if r.clicked() {
                selected_files.clear();
                selected_folders.clear();
                selected_files.insert(file.id.clone());
                actions.open_details = Some(file.clone());
            }

            r.context_menu(|ui| {
                if ui.button("⬇ Download to Disk").clicked() {
                    actions.start_download = Some(file.clone());
                    ui.close_menu();
                }
                if ui.button("👁 Preview").clicked() {
                    actions.open_preview = Some(file.clone());
                    ui.close_menu();
                }
                if ui.button("ℹ Details").clicked() {
                    actions.open_details = Some(file.clone());
                    ui.close_menu();
                }
                if ui.button(if file.starred { "★ Unstar" } else { "☆ Star" }).clicked() {
                    actions.toggle_star_file = Some((file.id.clone(), !file.starred));
                    ui.close_menu();
                }
                if ui.button("Rename").clicked() {
                    actions.rename_file = Some(file.clone());
                    ui.close_menu();
                }
                ui.separator();
                if ui.button(RichText::new("Move to Trash").color(Color32::from_rgb(239, 68, 68))).clicked() {
                    actions.trash_file = Some(file.clone());
                    ui.close_menu();
                }
            });
        }
    });
}
