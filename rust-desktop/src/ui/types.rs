use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavPage {
    Drive,
    Starred,
    Recent,
    Category(&'static str),
    Transfers,
    Trash,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewMode {
    Grid,
    List,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecentTab {
    All,
    Files,
    Downloads,
    Uploads,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortBy {
    Name,
    Size,
    Date,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToastKind {
    Success,
    Info,
    Error,
}

#[derive(Debug, Clone)]
pub struct Toast {
    pub message: String,
    pub kind: ToastKind,
    pub expires_at: Instant,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DialogState {
    None,
    NewFolder {
        parent_id: Option<String>,
        name_input: String,
    },
    RenameItem {
        id: String,
        is_folder: bool,
        name_input: String,
    },
    #[allow(dead_code)]
    DeleteConfirm {
        file_ids: Vec<String>,
        folder_ids: Vec<String>,
        permanent: bool,
    },
    #[allow(dead_code)]
    MoveItems {
        file_ids: Vec<String>,
        folder_ids: Vec<String>,
        target_folder_id: Option<String>,
    },
    Preview {
        file_id: String,
        name: String,
        category: String,
        size: u64,
        #[allow(dead_code)]
        text_content: Option<String>,
        #[allow(dead_code)]
        loading: bool,
    },
}
