use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use eframe::egui::{self, Color32, RichText};

use crate::bot_api::BotApiProcess;
use crate::db::Database;
use crate::models::{Breadcrumb, FileDTO, FolderDTO, SearchFilter};
use crate::server::AppServer;
use crate::ui::details::{render_details_panel, DetailsActions};
use crate::ui::dialogs::{render_dialogs, DialogResult};
use crate::ui::explorer::{render_explorer, ExplorerActions};
use crate::ui::header::render_header;
use crate::ui::preview::{render_preview_modal, PreviewActions};
use crate::ui::recent::render_recent_view;
use crate::ui::settings::render_settings_view;
use crate::ui::sidebar::render_sidebar;
use crate::ui::theme::*;
use crate::ui::transfers::{render_floating_dock, render_transfers_view, TransferTab};
use crate::ui::types::*;

pub struct TeleDriveApp {
    pub db: Arc<Database>,
    pub server: Arc<AppServer>,
    pub bot_api: Arc<BotApiProcess>,
    #[allow(dead_code)]
    pub tokio_runtime: Arc<tokio::runtime::Runtime>,

    pub current_page: NavPage,
    pub current_folder_id: Option<String>,
    pub current_folder_name: String,
    pub breadcrumbs: Vec<Breadcrumb>,
    pub folders: Vec<FolderDTO>,
    pub files: Vec<FileDTO>,

    pub search_query: String,
    pub view_mode: ViewMode,
    pub sort_by: SortBy,
    pub sort_dir: SortDir,

    pub selected_files: HashSet<String>,
    pub selected_folders: HashSet<String>,
    pub details_file: Option<FileDTO>,
    pub transfer_tab: TransferTab,
    pub recent_tab: RecentTab,
    pub mini_dock_collapsed: bool,
    pub mini_dock_dismissed: bool,

    pub dialog_state: DialogState,
    pub toasts: Vec<Toast>,
    pub preview_text: Option<String>,
    pub preview_loading: bool,
    pub last_refresh: Instant,
}

impl TeleDriveApp {
    pub fn new(
        db: Arc<Database>,
        server: Arc<AppServer>,
        bot_api: Arc<BotApiProcess>,
        tokio_runtime: Arc<tokio::runtime::Runtime>,
    ) -> Self {
        let mut app = Self {
            db,
            server,
            bot_api,
            tokio_runtime,
            current_page: NavPage::Drive,
            current_folder_id: None,
            current_folder_name: "My Drive".to_string(),
            breadcrumbs: Vec::new(),
            folders: Vec::new(),
            files: Vec::new(),
            search_query: String::new(),
            view_mode: ViewMode::Grid,
            sort_by: SortBy::Name,
            sort_dir: SortDir::Asc,
            selected_files: HashSet::new(),
            selected_folders: HashSet::new(),
            details_file: None,
            transfer_tab: TransferTab::All,
            recent_tab: RecentTab::All,
            mini_dock_collapsed: false,
            mini_dock_dismissed: false,
            dialog_state: DialogState::None,
            toasts: Vec::new(),
            preview_text: None,
            preview_loading: false,
            last_refresh: Instant::now(),
        };
        app.refresh_contents();
        app
    }

    pub fn toast(&mut self, message: &str, kind: ToastKind) {
        self.toasts.push(Toast {
            message: message.to_string(),
            kind,
            expires_at: Instant::now() + Duration::from_secs(4),
        });
    }

    pub fn refresh_contents(&mut self) {
        self.last_refresh = Instant::now();

        if !self.search_query.trim().is_empty() {
            let filter = SearchFilter {
                q: self.search_query.trim().to_string(),
                category: match self.current_page {
                    NavPage::Category(cat) => Some(cat.to_string()),
                    _ => None,
                },
                ..Default::default()
            };
            let (f_res, d_res, _) = self.db.search(&filter);
            self.files = f_res;
            self.folders = d_res;
            self.breadcrumbs.clear();
            return;
        }

        match self.current_page {
            NavPage::Drive => {
                let drive_resp = self.db.get_drive_contents(self.current_folder_id.as_deref());
                self.folders = drive_resp.folders;
                self.files = drive_resp.files;
                self.breadcrumbs = drive_resp.breadcrumbs;
                self.current_folder_name = self.breadcrumbs.last().map(|b| b.name.clone()).unwrap_or_else(|| "My Drive".to_string());
            }
            NavPage::Starred => {
                let (starred_files, starred_folders) = self.db.get_starred();
                self.files = starred_files;
                self.folders = starred_folders;
                self.breadcrumbs.clear();
                self.current_folder_name = "Starred".to_string();
            }
            NavPage::Recent => {
                self.files = self.db.get_recent(200);
                self.folders.clear();
                self.breadcrumbs.clear();
                self.current_folder_name = "Recent Files".to_string();
            }
            NavPage::Category(cat) => {
                let filter = SearchFilter {
                    q: "".to_string(),
                    category: Some(cat.to_string()),
                    ..Default::default()
                };
                let (cat_files, _, _) = self.db.search(&filter);
                self.files = cat_files;
                self.folders.clear();
                self.breadcrumbs.clear();
                self.current_folder_name = match cat {
                    "image" => "Photos & Images".to_string(),
                    "video" => "Videos".to_string(),
                    "audio" => "Audio Tracks".to_string(),
                    "document" => "Documents".to_string(),
                    "archive" => "Archives".to_string(),
                    "code" => "Code & Scripts".to_string(),
                    _ => cat.to_string(),
                };
            }
            NavPage::Trash => {
                let (trash_files, trash_folders, _) = self.db.get_trash();
                self.files = trash_files;
                self.folders = trash_folders;
                self.breadcrumbs.clear();
                self.current_folder_name = "Trash".to_string();
            }
            NavPage::Transfers => {
                self.current_folder_name = "Transfers".to_string();
            }
            NavPage::Settings => {
                self.current_folder_name = "Settings".to_string();
            }
        }

        self.apply_sorting();
    }

    fn apply_sorting(&mut self) {
        match self.sort_by {
            SortBy::Name => {
                self.folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                self.files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            }
            SortBy::Size => {
                self.files.sort_by_key(|f| f.size);
            }
            SortBy::Date => {
                self.folders.sort_by_key(|f| f.updated_at);
                self.files.sort_by_key(|f| f.updated_at);
            }
        }
        if self.sort_dir == SortDir::Desc {
            self.folders.reverse();
            self.files.reverse();
        }
    }
}

impl eframe::App for TeleDriveApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        apply_theme(ctx);

        // Auto-repaint if transfers are active
        let active_downloads = self.server.native_downloads.list_downloads().0.iter().any(|t| matches!(t.status.as_str(), "downloading" | "finalizing"));
        let active_uploads = self.server.active_uploads.read().map(|m| !m.is_empty()).unwrap_or(false);
        if active_downloads || active_uploads {
            ctx.request_repaint_after(Duration::from_millis(50));
        }

        // Expire toasts
        let now = Instant::now();
        self.toasts.retain(|t| t.expires_at > now);

        // ── Keyboard shortcuts ──
        if ctx.input(|i| i.key_pressed(egui::Key::F5)) {
            self.refresh_contents();
            self.toast("Refreshed drive", ToastKind::Info);
        }
        if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            if !self.selected_files.is_empty() || !self.selected_folders.is_empty() {
                self.selected_files.clear();
                self.selected_folders.clear();
            } else if self.dialog_state != DialogState::None {
                self.dialog_state = DialogState::None;
            } else if self.details_file.is_some() {
                self.details_file = None;
            }
        }
        // Ctrl + A: Select all
        if ctx.input(|i| (i.modifiers.command || i.modifiers.ctrl) && i.key_pressed(egui::Key::A)) {
            self.selected_files = self.files.iter().map(|f| f.id.clone()).collect();
            self.selected_folders = self.folders.iter().map(|f| f.id.clone()).collect();
        }
        // Delete: Move selected items to trash
        if ctx.input(|i| i.key_pressed(egui::Key::Delete)) {
            if !self.selected_files.is_empty() || !self.selected_folders.is_empty() {
                self.dialog_state = DialogState::DeleteConfirm {
                    file_ids: self.selected_files.iter().cloned().collect(),
                    folder_ids: self.selected_folders.iter().cloned().collect(),
                    permanent: false,
                };
            }
        }
        // Ctrl + N: New folder
        if ctx.input(|i| (i.modifiers.command || i.modifiers.ctrl) && i.key_pressed(egui::Key::N)) {
            self.dialog_state = DialogState::NewFolder {
                parent_id: self.current_folder_id.clone(),
                name_input: "New Folder".to_string(),
            };
        }

        // ── Native Drag-and-Drop file/folder upload from Windows Explorer ──
        let dropped_files = ctx.input(|i| i.raw.dropped_files.clone());
        let is_hovering = ctx.input(|i| !i.raw.hovered_files.is_empty());

        if is_hovering {
            egui::Area::new(egui::Id::new("dnd_hover_overlay"))
                .interactable(false)
                .order(egui::Order::Foreground)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    egui::Frame::new()
                        .fill(Color32::from_rgba_premultiplied(13, 16, 22, 230))
                        .stroke(egui::Stroke::new(2.0_f32, ACCENT))
                        .corner_radius(12.0)
                        .inner_margin(egui::Margin::symmetric(36, 24))
                        .show(ui, |ui| {
                            ui.vertical_centered(|ui| {
                                ui.label(RichText::new("📁").size(48.0).color(ACCENT));
                                ui.add_space(8.0);
                                ui.label(RichText::new("Drop files or folders here").size(18.0).strong().color(TEXT_PRIMARY));
                                ui.add_space(4.0);
                                ui.label(RichText::new(format!("Uploading directly to '{}'", self.current_folder_name)).size(13.0).color(TEXT_MUTED));
                            });
                        });
                });
        }

        if !dropped_files.is_empty() {
            let mut files_to_upload = Vec::new();
            for dropped in dropped_files {
                if let Some(path) = dropped.path {
                    if path.is_dir() {
                        let mut dirs = vec![path];
                        while let Some(d) = dirs.pop() {
                            if let Ok(entries) = std::fs::read_dir(&d) {
                                for e in entries.flatten() {
                                    let p = e.path();
                                    if p.is_dir() {
                                        dirs.push(p);
                                    } else if p.is_file() {
                                        files_to_upload.push(p.to_string_lossy().to_string());
                                    }
                                }
                            }
                        }
                    } else if path.is_file() {
                        files_to_upload.push(path.to_string_lossy().to_string());
                    }
                }
            }
            if !files_to_upload.is_empty() {
                let count = files_to_upload.len();
                self.server.create_native_uploads(files_to_upload, self.current_folder_id.clone(), "rename");
                self.toast(&format!("Queued {} dropped file(s) for upload", count), ToastKind::Success);
                self.current_page = NavPage::Transfers;
            }
        }

        // ── 0. Transfer Stats & Metrics ──
        let stats = self.db.get_stats();
        let (dl_list, _) = self.server.native_downloads.list_downloads();
        let active_dl_count = dl_list.iter().filter(|t| matches!(t.status.as_str(), "downloading" | "finalizing" | "queued")).count();
        let active_up_count = self.server.active_uploads.read().map(|m| m.len()).unwrap_or(0);
        let total_active_transfers = active_dl_count + active_up_count;
        let healthy_bots = self.db.state.read().map(|s| s.bots.iter().filter(|b| b.healthy).count()).unwrap_or(0);

        // ── 1. Top Panel: Header Bar ──
        let mut on_navigate: Option<Option<String>> = None;
        let mut on_upload_files = false;
        let mut on_upload_folder = false;
        let mut on_new_folder = false;
        let mut on_refresh = false;
        let mut on_open_transfers = false;

        egui::TopBottomPanel::top("top_header")
            .frame(egui::Frame::new().fill(BG_SURFACE).inner_margin(egui::Margin::symmetric(14, 10)).stroke(egui::Stroke::new(1.0_f32, BORDER)))
            .show(ctx, |ui| {
                render_header(
                    ui,
                    &self.breadcrumbs,
                    &self.current_folder_name,
                    &mut on_navigate,
                    &mut self.search_query,
                    &mut self.view_mode,
                    &mut self.sort_by,
                    &mut self.sort_dir,
                    &mut on_upload_files,
                    &mut on_upload_folder,
                    &mut on_new_folder,
                    &mut on_refresh,
                    total_active_transfers,
                    &mut on_open_transfers,
                );
            });

        if on_open_transfers {
            self.current_page = NavPage::Transfers;
        }

        // ── 2. Left Panel: Sidebar ──
        let prev_page = self.current_page.clone();
        egui::SidePanel::left("left_sidebar")
            .resizable(false)
            .exact_width(220.0)
            .frame(egui::Frame::new().fill(BG_SURFACE).inner_margin(egui::Margin::symmetric(12, 10)).stroke(egui::Stroke::new(1.0_f32, BORDER)))
            .show(ctx, |ui| {
                render_sidebar(
                    ui,
                    &mut self.current_page,
                    stats.total_size,
                    stats.file_count,
                    total_active_transfers,
                    healthy_bots,
                );
            });

        if prev_page != self.current_page {
            self.current_folder_id = None;
            self.search_query.clear();
            self.refresh_contents();
        }

        // ── 3. Right Panel: File Details (if opened) ──
        let mut details_actions = DetailsActions::default();
        if let Some(ref file) = self.details_file.clone() {
            let thumb_path = self.db.find_thumbnail_path(&file.id);
            egui::SidePanel::right("right_details")
                .resizable(true)
                .default_width(320.0)
                .min_width(260.0)
                .max_width(420.0)
                .frame(egui::Frame::new().fill(BG_SURFACE).inner_margin(egui::Margin::same(12)).stroke(egui::Stroke::new(1.0_f32, BORDER)))
                .show(ctx, |ui| {
                    render_details_panel(ui, file, thumb_path.as_deref(), &mut details_actions);
                });
        }

        if details_actions.close {
            self.details_file = None;
        }
        if let Some(f) = details_actions.download {
            let _ = self.server.native_downloads.start_download(&f.id, None);
            self.toast(&format!("Downloading {}", f.name), ToastKind::Success);
        }
        if let Some((fid, star)) = details_actions.toggle_star {
            self.db.set_star_items(&[fid], &[], star);
            self.refresh_contents();
        }
        if let Some(f) = details_actions.trash {
            self.db.trash_items(&[f.id], &[]);
            self.details_file = None;
            self.refresh_contents();
            self.toast(&format!("Moved {} to Trash", f.name), ToastKind::Info);
        }

        // ── 4. Central Panel: Content Area ──
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(BG_MAIN).inner_margin(egui::Margin::same(16)))
            .show(ctx, |ui| {
                match self.current_page {
                    NavPage::Recent => {
                        let mut explorer_actions = ExplorerActions::default();
                        let db_ref = &self.db;
                        let thumb_fn = |fid: &str| {
                            db_ref.find_thumbnail_path(fid).map(|p| format!("file:///{}", p.to_string_lossy().replace('\\', "/")))
                        };
                        render_recent_view(
                            ui,
                            &mut self.recent_tab,
                            &self.files,
                            &self.folders,
                            self.view_mode,
                            &mut self.selected_files,
                            &mut self.selected_folders,
                            &mut explorer_actions,
                            &thumb_fn,
                            &self.server,
                        );

                        if let Some(folder_id) = explorer_actions.open_folder {
                            self.current_folder_id = Some(folder_id);
                            self.current_page = NavPage::Drive;
                            self.refresh_contents();
                        }
                        if let Some(f) = explorer_actions.start_download {
                            let _ = self.server.native_downloads.start_download(&f.id, None);
                            self.mini_dock_dismissed = false;
                            self.toast(&format!("Started native download for {}", f.name), ToastKind::Success);
                        }
                        if let Some(f) = explorer_actions.open_details {
                            self.details_file = Some(f);
                        }
                        if let Some(f) = explorer_actions.open_preview {
                            self.dialog_state = DialogState::Preview {
                                file_id: f.id.clone(),
                                name: f.name.clone(),
                                category: f.category.clone(),
                                size: f.size,
                                text_content: None,
                                loading: false,
                            };
                        }
                        if let Some((fid, star)) = explorer_actions.toggle_star_file {
                            self.db.set_star_items(&[fid], &[], star);
                            self.refresh_contents();
                        }
                        if let Some((fid, star)) = explorer_actions.toggle_star_folder {
                            self.db.set_star_items(&[], &[fid], star);
                            self.refresh_contents();
                        }
                        if let Some(f) = explorer_actions.rename_file {
                            self.dialog_state = DialogState::RenameItem {
                                id: f.id,
                                is_folder: false,
                                name_input: f.name,
                            };
                        }
                        if let Some(f) = explorer_actions.rename_folder {
                            self.dialog_state = DialogState::RenameItem {
                                id: f.id,
                                is_folder: true,
                                name_input: f.name,
                            };
                        }
                        if let Some(f) = explorer_actions.trash_file {
                            self.db.trash_items(&[f.id], &[]);
                            self.refresh_contents();
                            self.toast(&format!("Moved {} to Trash", f.name), ToastKind::Info);
                        }
                        if let Some(f) = explorer_actions.trash_folder {
                            self.db.trash_items(&[], &[f.id]);
                            self.refresh_contents();
                            self.toast(&format!("Moved folder {} to Trash", f.name), ToastKind::Info);
                        }
                    }
                    NavPage::Drive | NavPage::Starred | NavPage::Category(_) => {
                        let mut explorer_actions = ExplorerActions::default();
                        let db_ref = &self.db;
                        let thumb_fn = |fid: &str| {
                            db_ref.find_thumbnail_path(fid).map(|p| format!("file:///{}", p.to_string_lossy().replace('\\', "/")))
                        };
                        render_explorer(
                            ui,
                            &self.folders,
                            &self.files,
                            self.view_mode,
                            &mut self.selected_files,
                            &mut self.selected_folders,
                            &mut explorer_actions,
                            &thumb_fn,
                        );

                        if let Some(folder_id) = explorer_actions.open_folder {
                            self.current_folder_id = Some(folder_id);
                            self.current_page = NavPage::Drive;
                            self.refresh_contents();
                        }
                        if let Some(f) = explorer_actions.start_download {
                            let _ = self.server.native_downloads.start_download(&f.id, None);
                            self.mini_dock_dismissed = false;
                            self.toast(&format!("Started native download for {}", f.name), ToastKind::Success);
                        }
                        if let Some(f) = explorer_actions.open_details {
                            self.details_file = Some(f);
                        }
                        if let Some(f) = explorer_actions.open_preview {
                            self.dialog_state = DialogState::Preview {
                                file_id: f.id.clone(),
                                name: f.name.clone(),
                                category: f.category.clone(),
                                size: f.size,
                                text_content: None,
                                loading: false,
                            };
                        }
                        if let Some((fid, star)) = explorer_actions.toggle_star_file {
                            self.db.set_star_items(&[fid], &[], star);
                            self.refresh_contents();
                        }
                        if let Some((fid, star)) = explorer_actions.toggle_star_folder {
                            self.db.set_star_items(&[], &[fid], star);
                            self.refresh_contents();
                        }
                        if let Some(f) = explorer_actions.rename_file {
                            self.dialog_state = DialogState::RenameItem {
                                id: f.id,
                                is_folder: false,
                                name_input: f.name,
                            };
                        }
                        if let Some(f) = explorer_actions.rename_folder {
                            self.dialog_state = DialogState::RenameItem {
                                id: f.id,
                                is_folder: true,
                                name_input: f.name,
                            };
                        }
                        if let Some(f) = explorer_actions.trash_file {
                            self.db.trash_items(&[f.id], &[]);
                            self.refresh_contents();
                            self.toast(&format!("Moved {} to Trash", f.name), ToastKind::Info);
                        }
                        if let Some(f) = explorer_actions.trash_folder {
                            self.db.trash_items(&[], &[f.id]);
                            self.refresh_contents();
                            self.toast(&format!("Moved folder {} to Trash", f.name), ToastKind::Info);
                        }
                    }
                    NavPage::Transfers => {
                        render_transfers_view(ui, &mut self.transfer_tab, &self.server);
                    }
                    NavPage::Trash => {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new("Trash").size(18.0).strong().color(TEXT_PRIMARY));
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if ui.button(RichText::new("Empty Trash").color(Color32::from_rgb(239, 68, 68))).clicked() {
                                    self.db.empty_trash();
                                    self.refresh_contents();
                                    self.toast("Trash emptied", ToastKind::Info);
                                }
                            });
                        });
                        ui.add_space(8.0);
                        ui.separator();
                        ui.add_space(8.0);

                        let mut explorer_actions = ExplorerActions::default();
                        let db_ref = &self.db;
                        let thumb_fn = |fid: &str| {
                            db_ref.find_thumbnail_path(fid).map(|p| format!("file:///{}", p.to_string_lossy().replace('\\', "/")))
                        };
                        render_explorer(
                            ui,
                            &self.folders,
                            &self.files,
                            self.view_mode,
                            &mut self.selected_files,
                            &mut self.selected_folders,
                            &mut explorer_actions,
                            &thumb_fn,
                        );
                    }
                    NavPage::Settings => {
                        let mut on_toast = None;
                        render_settings_view(ui, &self.db, &self.server.native_downloads, &self.bot_api, &mut on_toast);
                        if let Some((msg, ok)) = on_toast {
                            self.toast(&msg, if ok { ToastKind::Success } else { ToastKind::Error });
                        }
                    }
                }
            });

        // ── Floating Multi-Selection Action Bar ──
        let sel_count = self.selected_files.len() + self.selected_folders.len();
        if sel_count > 0 && matches!(self.current_page, NavPage::Drive | NavPage::Starred | NavPage::Recent | NavPage::Category(_)) {
            let total_sel_bytes: u64 = self.files.iter()
                .filter(|f| self.selected_files.contains(&f.id))
                .map(|f| f.size)
                .sum();

            egui::TopBottomPanel::bottom("bottom_selection_bar")
                .frame(egui::Frame::new().fill(BG_SURFACE_SELECTED).stroke(egui::Stroke::new(1.0_f32, ACCENT)).inner_margin(egui::Margin::symmetric(16, 8)))
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(format!("{} selected", sel_count)).strong().color(TEXT_PRIMARY));
                        if total_sel_bytes > 0 {
                            ui.label(RichText::new(format!("({})", fmt_bytes(total_sel_bytes))).color(TEXT_MUTED).size(11.5));
                        }
                        ui.add_space(16.0);

                        if !self.selected_files.is_empty() {
                            if ui.button(RichText::new("⬇ Download All").color(Color32::BLACK).strong()).clicked() {
                                for fid in &self.selected_files {
                                    let _ = self.server.native_downloads.start_download(fid, None);
                                }
                                self.toast(&format!("Queued {} downloads directly to disk", self.selected_files.len()), ToastKind::Success);
                                self.current_page = NavPage::Transfers;
                            }
                        }

                        if ui.button("★ Star").clicked() {
                            let fids: Vec<_> = self.selected_files.iter().cloned().collect();
                            let dids: Vec<_> = self.selected_folders.iter().cloned().collect();
                            self.db.set_star_items(&fids, &dids, true);
                            self.refresh_contents();
                            self.toast("Starred selected items", ToastKind::Success);
                        }

                        if ui.button("☆ Unstar").clicked() {
                            let fids: Vec<_> = self.selected_files.iter().cloned().collect();
                            let dids: Vec<_> = self.selected_folders.iter().cloned().collect();
                            self.db.set_star_items(&fids, &dids, false);
                            self.refresh_contents();
                            self.toast("Unstarred selected items", ToastKind::Info);
                        }

                        if ui.button("📁 Move to...").clicked() {
                            self.dialog_state = DialogState::MoveItems {
                                file_ids: self.selected_files.iter().cloned().collect(),
                                folder_ids: self.selected_folders.iter().cloned().collect(),
                                target_folder_id: None,
                            };
                        }

                        if ui.button(RichText::new("🗑 Trash").color(Color32::from_rgb(239, 68, 68))).clicked() {
                            self.dialog_state = DialogState::DeleteConfirm {
                                file_ids: self.selected_files.iter().cloned().collect(),
                                folder_ids: self.selected_folders.iter().cloned().collect(),
                                permanent: false,
                            };
                        }

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("✕ Deselect").clicked() {
                                self.selected_files.clear();
                                self.selected_folders.clear();
                            }
                        });
                    });
                });
        }

        // ── Navigation & Header Action Handlers ──
        if let Some(nav_target) = on_navigate {
            self.current_folder_id = nav_target;
            self.refresh_contents();
        }
        if on_refresh {
            self.refresh_contents();
            self.toast("Refreshed cloud drive", ToastKind::Info);
        }
        if on_new_folder {
            self.dialog_state = DialogState::NewFolder {
                parent_id: self.current_folder_id.clone(),
                name_input: "New Folder".to_string(),
            };
        }
        if on_upload_files {
            if let Some(paths) = rfd::FileDialog::new().pick_files() {
                let str_paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
                self.server.create_native_uploads(str_paths, self.current_folder_id.clone(), "rename");
                self.toast("Uploads queued directly from disk", ToastKind::Success);
                self.current_page = NavPage::Transfers;
            }
        }
        if on_upload_folder {
            if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                let mut files_to_upload = Vec::new();
                let mut dirs_to_visit = vec![folder.clone()];
                while let Some(current_dir) = dirs_to_visit.pop() {
                    if let Ok(entries) = std::fs::read_dir(&current_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.is_dir() {
                                dirs_to_visit.push(path);
                            } else if path.is_file() {
                                files_to_upload.push(path.to_string_lossy().to_string());
                            }
                        }
                    }
                }
                if !files_to_upload.is_empty() {
                    self.server.create_native_uploads(files_to_upload, self.current_folder_id.clone(), "rename");
                    self.toast("Folder files queued natively", ToastKind::Success);
                    self.current_page = NavPage::Transfers;
                }
            }
        }

        // ── 5. Dialogs & Modals ──
        let available_folders = self.folders.clone();
        let dlg_res = render_dialogs(ctx, &mut self.dialog_state, &available_folders);
        match dlg_res {
            DialogResult::None => {}
            DialogResult::Close => {
                self.dialog_state = DialogState::None;
            }
            DialogResult::CreateFolder { parent_id, name } => {
                self.db.create_folder(&name, parent_id);
                self.dialog_state = DialogState::None;
                self.refresh_contents();
                self.toast(&format!("Created folder '{}'", name), ToastKind::Success);
            }
            DialogResult::RenameItem { id, is_folder, new_name } => {
                if is_folder {
                    self.db.update_folder(&id, Some(&new_name), None);
                } else {
                    self.db.update_file(&id, Some(&new_name), None, None);
                }
                self.dialog_state = DialogState::None;
                self.refresh_contents();
                self.toast(&format!("Renamed to '{}'", new_name), ToastKind::Success);
            }
            DialogResult::ConfirmDelete { file_ids, folder_ids, permanent } => {
                if permanent {
                    self.db.delete_items(&file_ids, &folder_ids);
                    self.toast("Permanently deleted items", ToastKind::Info);
                } else {
                    self.db.trash_items(&file_ids, &folder_ids);
                    self.toast("Moved items to Trash", ToastKind::Info);
                }
                self.dialog_state = DialogState::None;
                self.refresh_contents();
            }
            DialogResult::MoveItems { file_ids, folder_ids, target_folder_id } => {
                self.db.move_items(&file_ids, &folder_ids, target_folder_id);
                self.dialog_state = DialogState::None;
                self.refresh_contents();
                self.toast("Moved items successfully", ToastKind::Success);
            }
        }

        // Preview Modal
        if let DialogState::Preview { ref file_id, ref name, ref category, size, .. } = self.dialog_state.clone() {
            let mut preview_act = PreviewActions::default();
            let real_dto = self.files.iter().find(|f| f.id == *file_id).cloned();
            let fake_dto = FileDTO {
                id: file_id.clone(),
                folder_id: None,
                name: name.clone(),
                extension: name.split('.').next_back().unwrap_or("").to_string(),
                mime_type: "application/octet-stream".to_string(),
                category: category.clone(),
                size,
                status: "ready".to_string(),
                width: None,
                height: None,
                duration: None,
                has_thumbnail: false,
                thumbnail_url: None,
                starred: false,
                description: "".to_string(),
                tags: Vec::new(),
                metadata: None,
                taken_at: None,
                part_count: 1,
                last_accessed_at: Some(0),
                created_at: 0,
                updated_at: 0,
                trashed_at: None,
            };
            let target_dto = real_dto.unwrap_or(fake_dto);
            let thumb_path = self.db.find_thumbnail_path(file_id);

            render_preview_modal(
                ctx,
                &target_dto,
                thumb_path.as_deref(),
                self.preview_text.as_deref(),
                self.preview_loading,
                &mut preview_act,
            );
            if preview_act.close {
                self.dialog_state = DialogState::None;
                self.preview_text = None;
            }
            if let Some(f) = preview_act.download {
                let _ = self.server.native_downloads.start_download(&f.id, None);
                self.mini_dock_dismissed = false;
                self.toast(&format!("Downloading {}", f.name), ToastKind::Success);
            }
        }

        // ── 6. Floating Transfer Mini-Dock ──
        let mut dock_visible = false;
        if self.current_page != NavPage::Transfers {
            let mut open_hub = false;
            render_floating_dock(
                ctx,
                &self.server,
                &mut open_hub,
                &mut self.mini_dock_collapsed,
                &mut self.mini_dock_dismissed,
            );
            if open_hub {
                self.current_page = NavPage::Transfers;
            }
            dock_visible = !self.mini_dock_dismissed;
        }

        // ── 7. Toast Overlay ──
        if !self.toasts.is_empty() {
            let toast_offset_y = if dock_visible { -150.0 } else { -16.0 };
            egui::Area::new(egui::Id::new("toast_overlay"))
                .anchor(egui::Align2::RIGHT_BOTTOM, egui::vec2(-16.0, toast_offset_y))
                .show(ctx, |ui| {
                    for t in &self.toasts {
                        let fill_color = match t.kind {
                            ToastKind::Success => Color32::from_rgb(22, 101, 52),
                            ToastKind::Info => Color32::from_rgb(30, 58, 138),
                            ToastKind::Error => Color32::from_rgb(153, 27, 27),
                        };
                        egui::Frame::new()
                            .fill(fill_color)
                            .corner_radius(6.0)
                            .inner_margin(egui::Margin::symmetric(14, 8))
                            .show(ui, |ui| {
                                ui.label(RichText::new(&t.message).color(Color32::WHITE).size(12.0).strong());
                            });
                        ui.add_space(4.0);
                    }
                });
        }
    }
}
