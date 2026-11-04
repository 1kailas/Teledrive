use eframe::egui::{self, Color32, RichText};
use crate::models::FolderDTO;
use crate::ui::theme::*;
use crate::ui::types::DialogState;

pub enum DialogResult {
    None,
    CreateFolder { parent_id: Option<String>, name: String },
    RenameItem { id: String, is_folder: bool, new_name: String },
    ConfirmDelete { file_ids: Vec<String>, folder_ids: Vec<String>, permanent: bool },
    MoveItems { file_ids: Vec<String>, folder_ids: Vec<String>, target_folder_id: Option<String> },
    Close,
}

pub fn render_dialogs(
    ctx: &egui::Context,
    dialog_state: &mut DialogState,
    available_folders: &[FolderDTO],
) -> DialogResult {
    let mut result = DialogResult::None;

    match dialog_state {
        DialogState::None => {}

        DialogState::NewFolder { parent_id, name_input } => {
            egui::Window::new("New Folder")
                .collapsible(false)
                .resizable(false)
                .default_size([340.0, 140.0])
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    ui.label("Folder Name:");
                    ui.add_space(4.0);
                    let edit = ui.text_edit_singleline(name_input);
                    if edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                        if !name_input.trim().is_empty() {
                            result = DialogResult::CreateFolder {
                                parent_id: parent_id.clone(),
                                name: name_input.trim().to_string(),
                            };
                        }
                    }

                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        if ui.button(RichText::new("Create Folder").color(Color32::BLACK).strong()).clicked() {
                            if !name_input.trim().is_empty() {
                                result = DialogResult::CreateFolder {
                                    parent_id: parent_id.clone(),
                                    name: name_input.trim().to_string(),
                                };
                            }
                        }
                        if ui.button("Cancel").clicked() {
                            result = DialogResult::Close;
                        }
                    });
                });
        }

        DialogState::RenameItem { id, is_folder, name_input } => {
            let title = if *is_folder { "Rename Folder" } else { "Rename File" };
            egui::Window::new(title)
                .collapsible(false)
                .resizable(false)
                .default_size([360.0, 140.0])
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    ui.label("New Name:");
                    ui.add_space(4.0);
                    ui.text_edit_singleline(name_input);

                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        if ui.button(RichText::new("Rename").color(Color32::BLACK).strong()).clicked() {
                            if !name_input.trim().is_empty() {
                                result = DialogResult::RenameItem {
                                    id: id.clone(),
                                    is_folder: *is_folder,
                                    new_name: name_input.trim().to_string(),
                                };
                            }
                        }
                        if ui.button("Cancel").clicked() {
                            result = DialogResult::Close;
                        }
                    });
                });
        }

        DialogState::DeleteConfirm { file_ids, folder_ids, permanent } => {
            let count = file_ids.len() + folder_ids.len();
            let title = if *permanent { "Permanently Delete?" } else { "Move to Trash?" };
            egui::Window::new(title)
                .collapsible(false)
                .resizable(false)
                .default_size([380.0, 140.0])
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    let msg = if *permanent {
                        format!("Permanently delete {} item(s)? This action cannot be undone.", count)
                    } else {
                        format!("Move {} item(s) to Trash?", count)
                    };
                    ui.label(RichText::new(msg).color(TEXT_PRIMARY));

                    ui.add_space(16.0);
                    ui.horizontal(|ui| {
                        let btn_text = if *permanent { "Delete Permanently" } else { "Move to Trash" };
                        let btn_color = Color32::from_rgb(239, 68, 68);
                        if ui.button(RichText::new(btn_text).color(btn_color).strong()).clicked() {
                            result = DialogResult::ConfirmDelete {
                                file_ids: file_ids.clone(),
                                folder_ids: folder_ids.clone(),
                                permanent: *permanent,
                            };
                        }
                        if ui.button("Cancel").clicked() {
                            result = DialogResult::Close;
                        }
                    });
                });
        }

        DialogState::MoveItems { file_ids, folder_ids, target_folder_id } => {
            egui::Window::new("Move to Folder")
                .collapsible(false)
                .resizable(false)
                .default_size([400.0, 320.0])
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    ui.label(RichText::new("Select Destination Folder:").color(TEXT_MUTED));
                    ui.add_space(8.0);

                    let root_selected = target_folder_id.is_none();
                    if ui.selectable_label(root_selected, "📁 My Drive (Root)").clicked() {
                        *target_folder_id = None;
                    }

                    egui::ScrollArea::vertical().max_height(200.0).show(ui, |ui| {
                        for folder in available_folders {
                            let is_sel = *target_folder_id == Some(folder.id.clone());
                            if ui.selectable_label(is_sel, format!("📁 {}", folder.name)).clicked() {
                                *target_folder_id = Some(folder.id.clone());
                            }
                        }
                    });

                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        if ui.button(RichText::new("Move Here").color(Color32::BLACK).strong()).clicked() {
                            result = DialogResult::MoveItems {
                                file_ids: file_ids.clone(),
                                folder_ids: folder_ids.clone(),
                                target_folder_id: target_folder_id.clone(),
                            };
                        }
                        if ui.button("Cancel").clicked() {
                            result = DialogResult::Close;
                        }
                    });
                });
        }

        DialogState::Preview { .. } => {}
    }

    result
}
