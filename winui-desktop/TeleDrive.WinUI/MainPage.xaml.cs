using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Navigation;
using TeleDrive_WinUI.Models;
using TeleDrive_WinUI.Services;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace TeleDrive_WinUI;

public sealed partial class MainPage : Page
{
    private readonly TeleDriveService _service = TeleDriveService.Instance;
    private DispatcherTimer? _pollTimer;

    public ObservableCollection<FolderModel> Folders { get; } = new();
    public ObservableCollection<FileModel> Files { get; } = new();
    public ObservableCollection<TransferTaskModel> Transfers { get; } = new();
    public ObservableCollection<TransferTaskModel> FilteredTransfers { get; } = new();

    private List<FolderModel> _allFolders = new();
    private List<FileModel> _allFiles = new();

    private string? _currentFolderId = null;
    private readonly Stack<(string? FolderId, string Title)> _navHistory = new();
    private readonly List<string> _clipboardFileIds = new();
    private readonly List<string> _clipboardFolderIds = new();
    private bool _isClipboardCut = false;
    private string _currentPageTag = "drive";
    private string _transfersFilter = "all"; // "all" | "active" | "uploads" | "downloads" | "completed"
    private int _viewMode = 0; // 0 = Grid, 1 = List

    private FileModel? _selectedFileForDetails;

    public static MainPage? Current { get; private set; }

    public MainPage()
    {
        Current = this;
        InitializeComponent();
        FoldersGridView.ItemsSource = Folders;
        FilesGridView.ItemsSource = Files;
        FilesListView.ItemsSource = Files;
        TransfersListView.ItemsSource = FilteredTransfers;
        RecentDownloadsListView.ItemsSource = FilteredTransfers;

        Loaded += MainPage_Loaded;
    }

    private async void MainPage_Loaded(object sender, RoutedEventArgs e)
    {
        _service.OnUploadCompleted += Service_OnUploadCompleted;

        var cfg = AppConfigService.Current;

        // Restore navigation sidebar pane state (expanded vs compact icon rail)
        if (NavView != null)
        {
            NavView.IsPaneOpen = cfg.IsPaneOpen;
        }

        // Restore view mode (0 = Grid, 1 = List)
        _viewMode = cfg.ViewMode;
        if (SettingsViewModeCombo != null)
        {
            SettingsViewModeCombo.SelectedIndex = _viewMode;
        }
        if (_viewMode == 1)
        {
            ListViewBtn_Click(this, new RoutedEventArgs());
        }
        else
        {
            GridViewBtn_Click(this, new RoutedEventArgs());
        }

        // Restore theme
        if (SettingsThemeCombo != null)
        {
            int themeIdx = cfg.Theme switch
            {
                "Dark" => 1,
                "Light" => 2,
                _ => 0
            };
            SettingsThemeCombo.SelectedIndex = themeIdx;
            ApplyTheme(cfg.Theme);
        }

        // Restore card size tier (0=Tiny, 1=Mini, 2=Compact, 3=Standard, 4=Large)
        int tier = Math.Clamp(cfg.CardSizeTier, 0, CardSizeTiers.Length - 1);
        SetCardSizeTier(tier);

        // Restore details pane state
        if (FileDetailsPane != null && !cfg.IsDetailsPaneVisible)
        {
            FileDetailsPane.Visibility = Visibility.Collapsed;
            if (ToggleDetailsPaneBtn != null)
            {
                ToggleDetailsPaneBtn.Background = new SolidColorBrush(Colors.Transparent);
            }
        }

        _currentPageTag = "drive";
        _currentFolderId = null;
        if (NavView != null && DriveNavItem != null)
        {
            NavView.SelectedItem = DriveNavItem;
        }

        DriveScrollViewer?.AddHandler(UIElement.PointerWheelChangedEvent, new PointerEventHandler(DriveScrollViewer_PointerWheelChanged), true);

        await _service.EnsureDaemonRunningAsync();
        await LoadContentsAsync();

        if (App.InitialLaunchPaths.Count > 0)
        {
            var initial = App.InitialLaunchPaths.ToList();
            App.InitialLaunchPaths.Clear();
            _ = HandleIncomingPathsAsync(initial);
        }

        _pollTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
        _pollTimer.Tick += PollTimer_Tick;
        _pollTimer.Start();
    }

    private void Service_OnUploadCompleted()
    {
        DispatcherQueue.TryEnqueue(async () =>
        {
            if (_currentPageTag == "drive" || _currentPageTag == "recent" || _currentPageTag == "starred" || _currentPageTag == "trash" || _currentPageTag.StartsWith("folder_"))
            {
                await LoadContentsAsync();
            }
        });
    }

    private async void PollTimer_Tick(object? sender, object e)
    {
        await RefreshTransfersAsync();
    }

    private async Task LoadContentsAsync()
    {
        if (_currentPageTag == "transfers")
        {
            DriveScrollViewer.Visibility = Visibility.Collapsed;
            RecentView.Visibility = Visibility.Collapsed;
            TransfersView.Visibility = Visibility.Visible;
            FileDetailsPane.Visibility = Visibility.Collapsed;
            CurrentFolderTitle.Text = "Transfers Hub";
            ItemCountSubtitle.Text = $"· {Transfers.Count} total";
            ViewModeToggleBorder.Visibility = Visibility.Collapsed;
            UploadFilesBtn.Visibility = Visibility.Visible;
            UploadFolderBtn.Visibility = Visibility.Visible;
            NewFolderBtn.Visibility = Visibility.Collapsed;
            if (EmptyTrashBtn != null) EmptyTrashBtn.Visibility = Visibility.Collapsed;
            await RefreshTransfersAsync();
            return;
        }

        if (_currentPageTag == "recent")
        {
            DriveScrollViewer.Visibility = Visibility.Collapsed;
            RecentView.Visibility = Visibility.Visible;
            TransfersView.Visibility = Visibility.Collapsed;
            FileDetailsPane.Visibility = Visibility.Collapsed;
            CurrentFolderTitle.Text = "Recent Activity";
            ViewModeToggleBorder.Visibility = Visibility.Collapsed;
            UploadFilesBtn.Visibility = Visibility.Visible;
            UploadFolderBtn.Visibility = Visibility.Visible;
            NewFolderBtn.Visibility = Visibility.Collapsed;
            if (EmptyTrashBtn != null) EmptyTrashBtn.Visibility = Visibility.Collapsed;

            var recentFiles = await _service.GetRecentAsync();
            Files.Clear();
            foreach (var f in recentFiles) Files.Add(f);
            ItemCountSubtitle.Text = $"· {Files.Count} items";
            await RefreshTransfersAsync();
            return;
        }

        if (_currentPageTag == "trash")
        {
            DriveScrollViewer.Visibility = Visibility.Visible;
            RecentView.Visibility = Visibility.Collapsed;
            TransfersView.Visibility = Visibility.Collapsed;
            ViewModeToggleBorder.Visibility = Visibility.Visible;
            FileDetailsPane.Visibility = Visibility.Visible;
            if (ToggleDetailsPaneBtn != null)
            {
                ToggleDetailsPaneBtn.Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"];
            }
            UploadFilesBtn.Visibility = Visibility.Collapsed;
            UploadFolderBtn.Visibility = Visibility.Collapsed;
            NewFolderBtn.Visibility = Visibility.Collapsed;
            if (EmptyTrashBtn != null) EmptyTrashBtn.Visibility = Visibility.Visible;
            if (NavBackBtn != null) NavBackBtn.Visibility = Visibility.Collapsed;

            var (folders, files, totalSize) = await _service.GetTrashAsync();
            _allFolders = folders;
            _allFiles = files;

            ApplyCurrentFilterAndDisplay();
            ItemCountSubtitle.Text = $"· {_allFiles.Count + _allFolders.Count} items in Trash ({FileModel.FormatBytes(totalSize)})";
            return;
        }

        DriveScrollViewer.Visibility = Visibility.Visible;
        RecentView.Visibility = Visibility.Collapsed;
        TransfersView.Visibility = Visibility.Collapsed;
        ViewModeToggleBorder.Visibility = Visibility.Visible;
        FileDetailsPane.Visibility = Visibility.Visible;
        if (ToggleDetailsPaneBtn != null)
        {
            ToggleDetailsPaneBtn.Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"];
        }
        UploadFilesBtn.Visibility = Visibility.Visible;
        UploadFolderBtn.Visibility = Visibility.Visible;
        NewFolderBtn.Visibility = Visibility.Visible;
        if (EmptyTrashBtn != null) EmptyTrashBtn.Visibility = Visibility.Collapsed;

        UpdateNavBackButton();

        var (folders2, files2) = await _service.GetDriveAsync(_currentFolderId);
        _allFolders = folders2;
        _allFiles = files2;

        ApplyCurrentFilterAndDisplay();
    }

    private static readonly HashSet<string> SpecialSidebarFolderNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Documents",
        "Pictures",
        "Videos",
        "Music"
    };

    private void ApplyCurrentFilterAndDisplay()
    {
        IEnumerable<FolderModel> filteredFolders = _allFolders;
        IEnumerable<FileModel> filteredFiles = _allFiles;

        switch (_currentPageTag)
        {
            case "starred":
                CurrentFolderTitle.Text = "Starred";
                filteredFolders = _allFolders.Where(f => f.Starred);
                filteredFiles = _allFiles.Where(f => f.Starred);
                break;
            case "trash":
                CurrentFolderTitle.Text = "Trash";
                break;
            default:
                CurrentFolderTitle.Text = string.IsNullOrEmpty(_currentFolderId) ? "My Drive" : CurrentFolderTitle.Text;
                // Special library folders (Documents, Pictures, Videos, Music) are accessible directly in the left sidebar,
                // so hide them in root "My Drive" to keep the view clean and uncluttered.
                if (string.IsNullOrEmpty(_currentFolderId))
                {
                    filteredFolders = filteredFolders.Where(f => !SpecialSidebarFolderNames.Contains(f.Name));
                }
                break;
        }

        var q = SearchBox.Text.Trim();
        if (!string.IsNullOrEmpty(q))
        {
            filteredFolders = filteredFolders.Where(f => f.Name.Contains(q, StringComparison.OrdinalIgnoreCase));
            filteredFiles = filteredFiles.Where(f => f.Name.Contains(q, StringComparison.OrdinalIgnoreCase));
        }

        Folders.Clear();
        foreach (var f in filteredFolders) Folders.Add(f);

        Files.Clear();
        foreach (var f in filteredFiles) Files.Add(f);

        FoldersSection.Visibility = Folders.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        var hasFiles = Files.Count > 0;
        FilesGridSection.Visibility = hasFiles && _viewMode == 0 ? Visibility.Visible : Visibility.Collapsed;
        FilesListSection.Visibility = hasFiles && _viewMode == 1 ? Visibility.Visible : Visibility.Collapsed;

        if (Folders.Count == 0 && Files.Count == 0)
        {
            EmptyState.Visibility = Visibility.Visible;
            if (_currentPageTag == "trash")
            {
                if (EmptyStateIcon != null) EmptyStateIcon.Glyph = "\uE74D";
                if (EmptyStateTitle != null) EmptyStateTitle.Text = "Trash is empty";
                if (EmptyStateSubtitle != null) EmptyStateSubtitle.Text = "Items moved to trash will appear here.";
            }
            else if (_currentPageTag == "starred")
            {
                if (EmptyStateIcon != null) EmptyStateIcon.Glyph = "\uE734";
                if (EmptyStateTitle != null) EmptyStateTitle.Text = "No starred items";
                if (EmptyStateSubtitle != null) EmptyStateSubtitle.Text = "Star files or folders to quickly find them later.";
            }
            else
            {
                if (EmptyStateIcon != null) EmptyStateIcon.Glyph = "\uE8B7";
                if (EmptyStateTitle != null) EmptyStateTitle.Text = "This folder is empty";
                if (EmptyStateSubtitle != null) EmptyStateSubtitle.Text = "Upload files or drag and drop items here to get started.";
            }
        }
        else
        {
            EmptyState.Visibility = Visibility.Collapsed;
        }

        int totalItems = Folders.Count + Files.Count;
        if (_currentPageTag != "trash")
        {
            ItemCountSubtitle.Text = $"· {totalItems} items";
        }
        if (StatusBarItemCountText != null)
        {
            StatusBarItemCountText.Text = $"{totalItems} items";
        }
        if (StatusBarSelectionText != null)
        {
            StatusBarSelectionText.Text = _selectedFileForDetails != null ? $"| 1 item selected ({_selectedFileForDetails.FormattedSize})" : "";
        }
        if (_selectedFileForDetails == null && DetailsEmptyPlaceholder != null && DetailsContentStack != null)
        {
            DetailsEmptyPlaceholder.Visibility = Visibility.Visible;
            DetailsContentStack.Visibility = Visibility.Collapsed;
        }
        UpdateResponsiveGrid(DriveScrollViewer.ActualWidth);
    }

    private async Task RefreshTransfersAsync()
    {
        var fetched = await _service.GetAllTransfersAsync();

        // 1. In-place high-performance diffing to avoid UI flickering and lag
        var existingMap = Transfers.ToDictionary(t => t.Id);
        var fetchedIds = new HashSet<string>();

        foreach (var task in fetched)
        {
            fetchedIds.Add(task.Id);
            if (existingMap.TryGetValue(task.Id, out var existing))
            {
                existing.Status = task.Status;
                existing.Transferred = task.Transferred;
                existing.Speed = task.Speed;
                existing.Eta = task.Eta;
                existing.Error = task.Error;
            }
            else
            {
                Transfers.Insert(0, task);
            }
        }

        for (int i = Transfers.Count - 1; i >= 0; i--)
        {
            if (!fetchedIds.Contains(Transfers[i].Id) && !Transfers[i].IsDone)
            {
                Transfers.RemoveAt(i);
            }
        }

        // 2. Filter transfers for the UI
        var filteredList = ApplyTransferFilter(Transfers);
        UpdateFilteredTransfers(filteredList);

        // 3. Update Badge
        var activeTasks = Transfers.Where(t => t.IsActive).ToList();
        var activeCount = activeTasks.Count;

        if (activeCount > 0)
        {
            TransfersBadge.Value = activeCount;
            TransfersBadge.Visibility = Visibility.Visible;
        }
        else
        {
            TransfersBadge.Visibility = Visibility.Collapsed;
        }

        // 4. Update Integrated Status Bar Transfer Widget
        if (activeCount > 0)
        {
            StatusBarTransferBtn.Visibility = Visibility.Visible;
            StatusBarTransferText.Text = $"{activeCount} transfer{(activeCount == 1 ? "" : "s")}";
            var first = activeTasks[0];
            StatusBarTransferProgress.Value = first.ProgressPercentage;
            StatusBarTransferIcon.Glyph = first.IsUpload ? "\uE898" : "\uE896";
            StatusBarTransferIcon.Foreground = new SolidColorBrush(first.IsUpload
                ? ColorHelper.FromArgb(255, 168, 85, 247)
                : ColorHelper.FromArgb(255, 45, 212, 191));
        }
        else
        {
            StatusBarTransferBtn.Visibility = Visibility.Collapsed;
        }

        // 5. Native Windows Taskbar Progress Bar
        if (activeCount > 0)
        {
            ulong totalTransferred = 0;
            ulong totalSize = 0;
            foreach (var t in activeTasks)
            {
                totalTransferred += t.Transferred;
                totalSize += t.Size;
            }
            TaskbarProgressService.SetProgress(MainWindow.WindowHandle, totalTransferred, Math.Max(totalTransferred, totalSize));
        }
        else
        {
            TaskbarProgressService.Clear(MainWindow.WindowHandle);
        }
    }

    private List<TransferTaskModel> ApplyTransferFilter(IEnumerable<TransferTaskModel> source)
    {
        return _transfersFilter switch
        {
            "active" => source.Where(t => t.IsActive).ToList(),
            "uploads" => source.Where(t => t.IsUpload).ToList(),
            "downloads" => source.Where(t => t.IsDownload).ToList(),
            "completed" => source.Where(t => t.IsDone).ToList(),
            _ => source.ToList(),
        };
    }

    private void UpdateFilteredTransfers(List<TransferTaskModel> newFiltered)
    {
        var existingIds = FilteredTransfers.Select(t => t.Id).ToList();
        var newIds = newFiltered.Select(t => t.Id).ToList();

        if (!existingIds.SequenceEqual(newIds))
        {
            FilteredTransfers.Clear();
            foreach (var t in newFiltered) FilteredTransfers.Add(t);
        }

        TransfersEmptyState.Visibility = FilteredTransfers.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    // --- Responsive Grid Layout, Card Scaling & Ctrl+Scroll / Ctrl+Key Zoom ---

    private static readonly double[] CardSizeTiers = [96, 130, 165, 205, 265];
    private double _targetTileWidth = 205;

    private int GetCurrentSizeTierIndex()
    {
        if (_targetTileWidth <= 110) return 0; // Tiny / Micro (96px)
        if (_targetTileWidth <= 145) return 1; // Mini / Ultra Compact (130px)
        if (_targetTileWidth <= 185) return 2; // Compact (165px)
        if (_targetTileWidth <= 235) return 3; // Medium / Standard (205px)
        return 4;                              // Large (265px)
    }

    private void NavView_PaneOpened(NavigationView sender, object args)
    {
        if (!AppConfigService.Current.IsPaneOpen)
        {
            AppConfigService.Current.IsPaneOpen = true;
            AppConfigService.Save();
        }
    }

    private void NavView_PaneClosed(NavigationView sender, object args)
    {
        if (AppConfigService.Current.IsPaneOpen)
        {
            AppConfigService.Current.IsPaneOpen = false;
            AppConfigService.Save();
        }
    }

    private void FoldersGridView_Loaded(object sender, RoutedEventArgs e)
    {
        UpdateResponsiveGrid(DriveScrollViewer?.ActualWidth ?? 0);
    }

    private void FilesGridView_Loaded(object sender, RoutedEventArgs e)
    {
        UpdateResponsiveGrid(DriveScrollViewer?.ActualWidth ?? 0);
    }

    private void SetCardSizeTier(int tierIndex)
    {
        tierIndex = Math.Clamp(tierIndex, 0, CardSizeTiers.Length - 1);
        _targetTileWidth = CardSizeTiers[tierIndex];

        if (SettingsCardSizeCombo != null && SettingsCardSizeCombo.SelectedIndex != tierIndex)
        {
            SettingsCardSizeCombo.SelectedIndex = tierIndex;
        }

        UpdateResponsiveGrid(DriveScrollViewer?.ActualWidth ?? 0);

        if (AppConfigService.Current.CardSizeTier != tierIndex || Math.Abs(AppConfigService.Current.TargetTileWidth - _targetTileWidth) > 0.1)
        {
            AppConfigService.Current.CardSizeTier = tierIndex;
            AppConfigService.Current.TargetTileWidth = _targetTileWidth;
            AppConfigService.Save();
        }
    }

    private void StepCardSize(int delta)
    {
        int currentTier = GetCurrentSizeTierIndex();
        int newTier = Math.Clamp(currentTier + delta, 0, CardSizeTiers.Length - 1);
        if (newTier != currentTier)
        {
            SetCardSizeTier(newTier);
        }
    }

    private void DriveScrollViewer_PointerWheelChanged(object sender, PointerRoutedEventArgs e)
    {
        bool isCtrlDown = (e.KeyModifiers & Windows.System.VirtualKeyModifiers.Control) == Windows.System.VirtualKeyModifiers.Control
            || IsCtrlPressed();

        if (isCtrlDown)
        {
            var ptrPt = e.GetCurrentPoint(DriveScrollViewer);
            int wheelDelta = ptrPt.Properties.MouseWheelDelta;
            if (wheelDelta > 0)
            {
                StepCardSize(+1);
                e.Handled = true;
            }
            else if (wheelDelta < 0)
            {
                StepCardSize(-1);
                e.Handled = true;
            }
        }
    }

    [DllImport("user32.dll")]
    private static extern short GetKeyState(int nVirtKey);

    private static bool IsCtrlPressed()
    {
        try
        {
            return (GetKeyState(0x11) & 0x8000) != 0;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsShiftPressed()
    {
        try
        {
            return (GetKeyState(0x10) & 0x8000) != 0;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsAltPressed()
    {
        try
        {
            return (GetKeyState(0x12) & 0x8000) != 0;
        }
        catch
        {
            return false;
        }
    }

    private void SelectAllAccelerator_Invoked(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        var focused = FocusManager.GetFocusedElement(this.XamlRoot);
        if (focused is TextBox || focused is AutoSuggestBox)
        {
            return;
        }

        SelectAllItems();
        args.Handled = true;
    }

    private void FilesOrFolders_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        MainPage_KeyDown(sender, e);
    }

    private void EscapeAccelerator_Invoked(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        ClearSelection();
        args.Handled = true;
    }

    public void SelectAllItems()
    {
        if (_viewMode == 0)
        {
            if (FoldersSection.Visibility == Visibility.Visible && Folders.Count > 0)
            {
                FoldersGridView?.SelectAll();
            }
            if (Files.Count > 0)
            {
                FilesGridView?.SelectAll();
            }
        }
        else
        {
            if (Files.Count > 0)
            {
                FilesListView?.SelectAll();
            }
        }
        SyncSelectionState();
        UpdateSelectionSummary();
    }

    public void ClearSelection()
    {
        FoldersGridView?.SelectedItems.Clear();
        FilesGridView?.SelectedItems.Clear();
        FilesListView?.SelectedItems.Clear();
        SyncSelectionState();
        UpdateSelectionSummary();
    }

    private void SyncSelectionState()
    {
        var selectedFiles = new HashSet<object>(
            _viewMode == 0
                ? (FilesGridView?.SelectedItems ?? (IList<object>)Array.Empty<object>())
                : (FilesListView?.SelectedItems ?? (IList<object>)Array.Empty<object>()));

        foreach (var f in Files)
        {
            f.IsSelected = selectedFiles.Contains(f);
        }

        var selectedFolders = new HashSet<object>(FoldersGridView?.SelectedItems ?? (IList<object>)Array.Empty<object>());
        foreach (var folder in Folders)
        {
            folder.IsSelected = selectedFolders.Contains(folder);
        }
    }

    private void MainPage_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.OriginalSource is TextBox || e.OriginalSource is AutoSuggestBox)
        {
            return;
        }

        bool isCtrlDown = IsCtrlPressed();

        if (isCtrlDown)
        {
            // Ctrl + A: Select All (Files and Folders in the current view)
            if (e.Key == Windows.System.VirtualKey.A)
            {
                SelectAllItems();
                e.Handled = true;
                return;
            }

            // Ctrl + R: Refresh
            if (e.Key == Windows.System.VirtualKey.R)
            {
                _ = LoadContentsAsync();
                e.Handled = true;
                return;
            }

            // Ctrl + X: Cut
            if (e.Key == Windows.System.VirtualKey.X)
            {
                ExecuteClipboardCut();
                e.Handled = true;
                return;
            }

            // Ctrl + C: Copy
            if (e.Key == Windows.System.VirtualKey.C)
            {
                ExecuteClipboardCopy();
                e.Handled = true;
                return;
            }

            // Ctrl + V: Paste
            if (e.Key == Windows.System.VirtualKey.V)
            {
                _ = ExecuteClipboardPasteAsync();
                e.Handled = true;
                return;
            }

            // Zoom in: Numpad Add (+), VirtualKey 187 (=/+ on standard keyboard)
            if (e.Key == Windows.System.VirtualKey.Add || (int)e.Key == 187)
            {
                StepCardSize(+1);
                e.Handled = true;
                return;
            }
            // Zoom out: Numpad Subtract (-), VirtualKey 189 (-/_ on standard keyboard)
            else if (e.Key == Windows.System.VirtualKey.Subtract || (int)e.Key == 189)
            {
                StepCardSize(-1);
                e.Handled = true;
                return;
            }
            // Reset to default Medium: Ctrl + 0 or Ctrl + Numpad0
            else if (e.Key == Windows.System.VirtualKey.Number0 || e.Key == Windows.System.VirtualKey.NumberPad0)
            {
                SetCardSizeTier(3);
                e.Handled = true;
                return;
            }
        }
        else if (e.Key == Windows.System.VirtualKey.F5)
        {
            _ = LoadContentsAsync();
            e.Handled = true;
        }
        else if (e.Key == Windows.System.VirtualKey.F2)
        {
            var selectedFile = _viewMode == 0 ? FilesGridView?.SelectedItem as FileModel : FilesListView?.SelectedItem as FileModel;
            if (selectedFile != null)
            {
                PromptRename(selectedFile.Id, false, selectedFile.Name);
                e.Handled = true;
                return;
            }
            var selectedFolder = FoldersGridView?.SelectedItem as FolderModel;
            if (selectedFolder != null)
            {
                PromptRename(selectedFolder.Id, true, selectedFolder.Name);
                e.Handled = true;
                return;
            }
        }
        else if (e.Key == Windows.System.VirtualKey.Enter)
        {
            var selectedFolder = FoldersGridView?.SelectedItem as FolderModel;
            if (selectedFolder != null)
            {
                NavigateToFolder(selectedFolder.Id, selectedFolder.Name);
                e.Handled = true;
                return;
            }
            var selectedFile = _viewMode == 0 ? FilesGridView?.SelectedItem as FileModel : FilesListView?.SelectedItem as FileModel;
            if (selectedFile != null)
            {
                ShowFileDetails(selectedFile);
                e.Handled = true;
                return;
            }
        }
        else if (e.Key == Windows.System.VirtualKey.Back || (e.Key == Windows.System.VirtualKey.Left && IsAltPressed()))
        {
            if (NavBackBtn != null && NavBackBtn.Visibility == Visibility.Visible)
            {
                NavBackBtn_Click(this, new RoutedEventArgs());
                e.Handled = true;
                return;
            }
        }
        else if (e.Key == Windows.System.VirtualKey.Escape)
        {
            ClearSelection();
            e.Handled = true;
        }
        else if (e.Key == Windows.System.VirtualKey.Delete)
        {
            bool isShift = IsShiftPressed();
            if (_currentPageTag == "trash" || isShift)
            {
                DetailsDeletePermanentlyBtn_Click(this, new RoutedEventArgs());
            }
            else
            {
                DetailsTrashBtn_Click(this, new RoutedEventArgs());
            }
            e.Handled = true;
        }
    }

    private void DriveScrollViewer_Tapped(object sender, TappedRoutedEventArgs e)
    {
        if (e.OriginalSource is ScrollViewer || e.OriginalSource is StackPanel)
        {
            ClearSelection();
        }
    }

    private void FoldersGridView_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        SyncSelectionState();
        UpdateSelectionSummary();
    }

    private void FilesGridView_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        SyncSelectionState();
        UpdateSelectionSummary();
    }

    private void FilesListView_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        SyncSelectionState();
        UpdateSelectionSummary();
    }

    private void UpdateSelectionSummary()
    {
        var selectedFiles = _viewMode == 0
            ? (FilesGridView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>())
            : (FilesListView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>());

        var selectedFolders = FoldersGridView?.SelectedItems.OfType<FolderModel>().ToList() ?? new List<FolderModel>();
        int totalSelected = selectedFiles.Count + selectedFolders.Count;

        if (totalSelected == 0)
        {
            if (StatusBarSelectionText != null) StatusBarSelectionText.Text = "";
            _selectedFileForDetails = null;
            if (FileDetailsPane != null && FileDetailsPane.Visibility == Visibility.Visible)
            {
                if (DetailsEmptyPlaceholder != null) DetailsEmptyPlaceholder.Visibility = Visibility.Visible;
                if (DetailsContentStack != null) DetailsContentStack.Visibility = Visibility.Collapsed;
            }
        }
        else if (totalSelected == 1)
        {
            if (selectedFiles.Count == 1)
            {
                ShowFileDetails(selectedFiles[0]);
            }
            else
            {
                var folder = selectedFolders[0];
                if (StatusBarSelectionText != null) StatusBarSelectionText.Text = $"| 1 folder selected ({folder.Name})";
                _selectedFileForDetails = null;
                if (DetailsFileName != null) DetailsFileName.Text = folder.Name;
                if (DetailsCategoryPill != null) DetailsCategoryPill.Text = "FOLDER";
                if (DetailsFileSize != null) DetailsFileSize.Text = folder.FormattedItemCount;
                if (DetailsMimeType != null) DetailsMimeType.Text = "Directory";
                if (DetailsModifiedDate != null) DetailsModifiedDate.Text = folder.FormattedDate;
                if (DetailsCreatedDate != null) DetailsCreatedDate.Text = folder.FormattedDate;
                if (DetailsCloudIdText != null) DetailsCloudIdText.Text = folder.Id;
                if (DetailsPartsText != null) DetailsPartsText.Text = "-";
                if (DetailsThumbImage != null) DetailsThumbImage.Visibility = Visibility.Collapsed;
                if (DetailsFallbackIcon != null)
                {
                    DetailsFallbackIcon.Visibility = Visibility.Visible;
                    DetailsFallbackIcon.Glyph = "\uE8B7";
                    DetailsFallbackIcon.Foreground = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"];
                }
                if (DetailsMediaSection != null) DetailsMediaSection.Visibility = Visibility.Collapsed;
                if (DetailsEmptyPlaceholder != null) DetailsEmptyPlaceholder.Visibility = Visibility.Collapsed;
                if (DetailsContentStack != null) DetailsContentStack.Visibility = Visibility.Visible;
            }
        }
        else
        {
            ulong totalBytes = 0;
            foreach (var f in selectedFiles) totalBytes += f.Size;
            string formattedTotal = FileModel.FormatBytes(totalBytes);
            if (StatusBarSelectionText != null)
            {
                StatusBarSelectionText.Text = $"| {totalSelected} items selected ({formattedTotal})";
            }
            ShowMultiSelectionDetails(selectedFiles, selectedFolders, formattedTotal);
        }

        if (NormalDetailsActions != null && TrashDetailsActions != null)
        {
            if (_currentPageTag == "trash")
            {
                NormalDetailsActions.Visibility = Visibility.Collapsed;
                TrashDetailsActions.Visibility = Visibility.Visible;
            }
            else
            {
                NormalDetailsActions.Visibility = Visibility.Visible;
                TrashDetailsActions.Visibility = Visibility.Collapsed;
            }
        }
    }

    private void ShowMultiSelectionDetails(List<FileModel> files, List<FolderModel> folders, string formattedTotal)
    {
        _selectedFileForDetails = files.FirstOrDefault();
        int totalCount = files.Count + folders.Count;

        if (DetailsFileName != null) DetailsFileName.Text = $"{totalCount} items selected";
        if (DetailsCategoryPill != null) DetailsCategoryPill.Text = "MULTIPLE SELECTION";
        if (DetailsFileSize != null) DetailsFileSize.Text = formattedTotal;
        if (DetailsMimeType != null) DetailsMimeType.Text = $"{files.Count} files, {folders.Count} folders";
        if (DetailsModifiedDate != null) DetailsModifiedDate.Text = "Various dates";
        if (DetailsCreatedDate != null) DetailsCreatedDate.Text = "Various dates";
        if (DetailsCloudIdText != null) DetailsCloudIdText.Text = "Batch selection";
        if (DetailsPartsText != null)
        {
            int totalParts = files.Sum(f => f.PartCount ?? 1);
            DetailsPartsText.Text = $"{totalParts} cloud chunks";
        }

        if (DetailsThumbImage != null) DetailsThumbImage.Visibility = Visibility.Collapsed;
        if (DetailsFallbackIcon != null)
        {
            DetailsFallbackIcon.Visibility = Visibility.Visible;
            DetailsFallbackIcon.Glyph = "\uE8B7";
            DetailsFallbackIcon.Foreground = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"];
        }

        if (DetailsMediaSection != null) DetailsMediaSection.Visibility = Visibility.Collapsed;
        if (DetailsEmptyPlaceholder != null) DetailsEmptyPlaceholder.Visibility = Visibility.Collapsed;
        if (DetailsContentStack != null) DetailsContentStack.Visibility = Visibility.Visible;
    }

    private void DriveScrollViewer_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        UpdateResponsiveGrid(e.NewSize.Width);
    }

    private void UpdateResponsiveGrid(double availableWidth)
    {
        // Strictly fixed tile width & height per scale tier (identical to Windows File Explorer).
        // Zero stretching or dynamic width division: cards and icons NEVER resize or distort
        // regardless of whether the details pane is opened/closed or the window resized.
        double tileWidth;
        double tileHeight;
        if (_targetTileWidth <= 110)
        {
            tileWidth = 96;
            tileHeight = 118; // Tiny / Micro (96px)
        }
        else if (_targetTileWidth <= 140)
        {
            tileWidth = 130;
            tileHeight = 144; // Mini / Ultra Compact (130px)
        }
        else if (_targetTileWidth <= 175)
        {
            tileWidth = 165;
            tileHeight = 168; // Compact (165px)
        }
        else if (_targetTileWidth <= 220)
        {
            tileWidth = 205;
            tileHeight = 192; // Medium / Standard (205px)
        }
        else
        {
            tileWidth = 265;
            tileHeight = 228; // Large (265px)
        }

        if (FilesGridView?.ItemsPanelRoot is ItemsWrapGrid filesWrap)
        {
            filesWrap.ItemWidth = tileWidth;
            filesWrap.ItemHeight = tileHeight;
        }

        if (FoldersGridView?.ItemsPanelRoot is ItemsWrapGrid foldersWrap)
        {
            foldersWrap.ItemWidth = tileWidth <= 110 ? 180 : (tileWidth <= 140 ? 200 : (tileWidth <= 175 ? 220 : (tileWidth <= 220 ? 250 : 290)));
            foldersWrap.ItemHeight = tileWidth <= 110 ? 46 : 50;
        }
    }

    private void SettingsCardSizeCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (SettingsCardSizeCombo?.SelectedItem is ComboBoxItem item && double.TryParse(item.Tag?.ToString(), out var width))
        {
            _targetTileWidth = width;
            int tier = GetCurrentSizeTierIndex();
            if (AppConfigService.Current.CardSizeTier != tier || Math.Abs(AppConfigService.Current.TargetTileWidth - width) > 0.1)
            {
                AppConfigService.Current.CardSizeTier = tier;
                AppConfigService.Current.TargetTileWidth = width;
                AppConfigService.Save();
            }
            UpdateResponsiveGrid(DriveScrollViewer?.ActualWidth ?? 0);
        }
    }

    private void SettingsViewModeCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (SettingsViewModeCombo?.SelectedItem is ComboBoxItem item && int.TryParse(item.Tag?.ToString(), out var mode))
        {
            _viewMode = mode;
            if (AppConfigService.Current.ViewMode != mode)
            {
                AppConfigService.Current.ViewMode = mode;
                AppConfigService.Save();
            }
            if (mode == 0)
            {
                GridViewBtn_Click(this, new RoutedEventArgs());
            }
            else
            {
                ListViewBtn_Click(this, new RoutedEventArgs());
            }
        }
    }

    private void ApplyTheme(string theme)
    {
        if (this.XamlRoot?.Content is FrameworkElement root)
        {
            root.RequestedTheme = theme switch
            {
                "Dark" => ElementTheme.Dark,
                "Light" => ElementTheme.Light,
                _ => ElementTheme.Default
            };
        }
    }

    private void SettingsThemeCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (SettingsThemeCombo?.SelectedItem is ComboBoxItem item && item.Tag is string tag)
        {
            ApplyTheme(tag);
            if (AppConfigService.Current.Theme != tag)
            {
                AppConfigService.Current.Theme = tag;
                AppConfigService.Save();
            }
        }
    }

    private async void SettingsClearCacheBtn_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var localCache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TeleDrive", "cache");
            if (Directory.Exists(localCache))
            {
                foreach (var file in Directory.GetFiles(localCache, "*.*", SearchOption.AllDirectories))
                {
                    try { File.Delete(file); } catch { }
                }
            }
            await LoadContentsAsync();
        }
        catch { }
    }

    // --- File Details & Metadata Drawer ---

    public async void ShowFileDetails(FileModel file)
    {
        _selectedFileForDetails = file;

        // Try getting full detailed record
        var fullDetails = await _service.GetFileDetailsAsync(file.Id);
        var target = fullDetails ?? file;

        DetailsFileName.Text = target.Name;
        DetailsCategoryPill.Text = $"{target.Category.ToUpperInvariant()} · {target.Extension.ToUpperInvariant()}";
        DetailsFileSize.Text = target.FormattedSize;
        DetailsMimeType.Text = target.MimeType;
        DetailsModifiedDate.Text = target.FormattedDate;
        DetailsCreatedDate.Text = target.FormattedCreatedDate;
        DetailsCloudIdText.Text = target.Id;
        DetailsPartsText.Text = target.PartCountSummary;

        // Thumbnail / Visual Preview (supports images, videos, and authentic Windows Shell icons for all types)
        var thumbUrl = target.EffectiveThumbnailUrl;
        if (!string.IsNullOrEmpty(thumbUrl))
        {
            try
            {
                DetailsThumbImage.Source = new BitmapImage(new Uri(thumbUrl));
                DetailsThumbImage.Visibility = Visibility.Visible;
                DetailsFallbackIcon.Visibility = Visibility.Collapsed;
            }
            catch
            {
                DetailsThumbImage.Visibility = Visibility.Collapsed;
                DetailsFallbackIcon.Visibility = Visibility.Visible;
                DetailsFallbackIcon.Glyph = target.CategoryGlyph;
                DetailsFallbackIcon.Foreground = target.CategoryBrush;
            }
        }
        else
        {
            DetailsThumbImage.Visibility = Visibility.Collapsed;
            DetailsFallbackIcon.Visibility = Visibility.Visible;
            DetailsFallbackIcon.Glyph = target.CategoryGlyph;
            DetailsFallbackIcon.Foreground = target.CategoryBrush;
        }

        // Star button state
        DetailsStarIcon.Glyph = target.StarGlyph;
        DetailsStarText.Text = target.Starred ? "Starred" : "Star";

        // Technical / Media Metadata
        var hasMedia = target.HasDimensions || target.HasDuration || target.HasTakenAt || target.MetadataEntries.Count > 0;
        DetailsMediaSection.Visibility = hasMedia ? Visibility.Visible : Visibility.Collapsed;

        DetailsDimensionsRow.Visibility = target.HasDimensions ? Visibility.Visible : Visibility.Collapsed;
        DetailsDimensionsText.Text = target.DimensionsSummary;

        DetailsDurationRow.Visibility = target.HasDuration ? Visibility.Visible : Visibility.Collapsed;
        DetailsDurationText.Text = target.DurationSummary;

        DetailsTakenAtRow.Visibility = target.HasTakenAt ? Visibility.Visible : Visibility.Collapsed;
        DetailsTakenAtText.Text = target.TakenAtSummary;

        DetailsMetadataItemsControl.ItemsSource = target.MetadataEntries;

        DetailsEmptyPlaceholder.Visibility = Visibility.Collapsed;
        DetailsContentStack.Visibility = Visibility.Visible;
        FileDetailsPane.Visibility = Visibility.Visible;
        if (ToggleDetailsPaneBtn != null)
        {
            ToggleDetailsPaneBtn.Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"];
        }
        if (StatusBarSelectionText != null)
        {
            StatusBarSelectionText.Text = $"| 1 item selected ({target.FormattedSize})";
        }
    }

    private void CloseDetailsPane_Click(object sender, RoutedEventArgs e)
    {
        FileDetailsPane.Visibility = Visibility.Collapsed;
        _selectedFileForDetails = null;
        if (ToggleDetailsPaneBtn != null)
        {
            ToggleDetailsPaneBtn.Background = new SolidColorBrush(Colors.Transparent);
        }
        if (StatusBarSelectionText != null)
        {
            StatusBarSelectionText.Text = "";
        }
        AppConfigService.Current.IsDetailsPaneVisible = false;
        AppConfigService.Save();
    }

    private void ToggleDetailsPaneBtn_Click(object sender, RoutedEventArgs e)
    {
        if (FileDetailsPane.Visibility == Visibility.Visible)
        {
            FileDetailsPane.Visibility = Visibility.Collapsed;
            if (ToggleDetailsPaneBtn != null)
            {
                ToggleDetailsPaneBtn.Background = new SolidColorBrush(Colors.Transparent);
            }
            AppConfigService.Current.IsDetailsPaneVisible = false;
            AppConfigService.Save();
        }
        else
        {
            FileDetailsPane.Visibility = Visibility.Visible;
            if (ToggleDetailsPaneBtn != null)
            {
                ToggleDetailsPaneBtn.Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"];
            }
            AppConfigService.Current.IsDetailsPaneVisible = true;
            AppConfigService.Save();
            if (_selectedFileForDetails == null)
            {
                DetailsEmptyPlaceholder.Visibility = Visibility.Visible;
                DetailsContentStack.Visibility = Visibility.Collapsed;
            }
            else
            {
                DetailsEmptyPlaceholder.Visibility = Visibility.Collapsed;
                DetailsContentStack.Visibility = Visibility.Visible;
            }
        }
    }

    private void FileInfoBtn_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.DataContext is FileModel file)
        {
            ShowFileDetails(file);
        }
    }

    private async void DetailsDownloadBtn_Click(object sender, RoutedEventArgs e)
    {
        var selectedFiles = _viewMode == 0
            ? (FilesGridView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>())
            : (FilesListView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>());

        if (selectedFiles.Count > 0)
        {
            foreach (var file in selectedFiles)
            {
                await _service.StartDownloadAsync(file.Id);
            }
            await RefreshTransfersAsync();
        }
        else if (_selectedFileForDetails != null)
        {
            await _service.StartDownloadAsync(_selectedFileForDetails.Id);
            await RefreshTransfersAsync();
        }
    }

    private async void DetailsStarBtn_Click(object sender, RoutedEventArgs e)
    {
        if (_selectedFileForDetails != null)
        {
            _selectedFileForDetails.Starred = !_selectedFileForDetails.Starred;
            await _service.SetStarredAsync(_selectedFileForDetails.Id, false, _selectedFileForDetails.Starred);
            DetailsStarIcon.Glyph = _selectedFileForDetails.StarGlyph;
            DetailsStarText.Text = _selectedFileForDetails.Starred ? "Starred" : "Star";
        }
    }

    private void DetailsCopyIdBtn_Click(object sender, RoutedEventArgs e)
    {
        if (_selectedFileForDetails != null)
        {
            var dataPackage = new DataPackage();
            dataPackage.SetText(_selectedFileForDetails.Id);
            Clipboard.SetContent(dataPackage);
        }
    }

    private async void DetailsTrashBtn_Click(object sender, RoutedEventArgs e)
    {
        var selectedFiles = _viewMode == 0
            ? (FilesGridView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>())
            : (FilesListView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>());
        var selectedFolders = FoldersGridView?.SelectedItems.OfType<FolderModel>().ToList() ?? new List<FolderModel>();

        var fileIds = selectedFiles.Select(f => f.Id).ToList();
        var folderIds = selectedFolders.Select(f => f.Id).ToList();

        if (fileIds.Count == 0 && folderIds.Count == 0 && _selectedFileForDetails != null)
        {
            fileIds.Add(_selectedFileForDetails.Id);
        }

        if (fileIds.Count > 0 || folderIds.Count > 0)
        {
            await _service.TrashItemsAsync(fileIds, folderIds);
            _selectedFileForDetails = null;
            await LoadContentsAsync();
        }
    }

    private async void DetailsDeletePermanentlyBtn_Click(object sender, RoutedEventArgs e)
    {
        var selectedFiles = _viewMode == 0
            ? (FilesGridView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>())
            : (FilesListView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>());
        var selectedFolders = FoldersGridView?.SelectedItems.OfType<FolderModel>().ToList() ?? new List<FolderModel>();

        var fileIds = selectedFiles.Select(f => f.Id).ToList();
        var folderIds = selectedFolders.Select(f => f.Id).ToList();

        if (fileIds.Count == 0 && folderIds.Count == 0 && _selectedFileForDetails != null)
        {
            fileIds.Add(_selectedFileForDetails.Id);
        }

        if (fileIds.Count > 0 || folderIds.Count > 0)
        {
            int total = fileIds.Count + folderIds.Count;
            var dialog = new ContentDialog
            {
                Title = "Permanently Delete?",
                Content = $"Are you sure you want to permanently delete {total} item{(total > 1 ? "s" : "")}? This cannot be undone and will permanently remove all storage messages from the Telegram cloud channel.",
                PrimaryButtonText = "Delete Permanently",
                CloseButtonText = "Cancel",
                DefaultButton = ContentDialogButton.Close,
                XamlRoot = this.XamlRoot
            };

            if (await dialog.ShowAsync() == ContentDialogResult.Primary)
            {
                await _service.DeletePermanentlyAsync(fileIds, folderIds);
                _selectedFileForDetails = null;
                await LoadContentsAsync();
            }
        }
    }

    private async void DetailsRestoreBtn_Click(object sender, RoutedEventArgs e)
    {
        var selectedFiles = _viewMode == 0
            ? (FilesGridView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>())
            : (FilesListView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>());
        var selectedFolders = FoldersGridView?.SelectedItems.OfType<FolderModel>().ToList() ?? new List<FolderModel>();

        var fileIds = selectedFiles.Select(f => f.Id).ToList();
        var folderIds = selectedFolders.Select(f => f.Id).ToList();

        if (fileIds.Count == 0 && folderIds.Count == 0 && _selectedFileForDetails != null)
        {
            fileIds.Add(_selectedFileForDetails.Id);
        }

        if (fileIds.Count > 0 || folderIds.Count > 0)
        {
            await _service.RestoreAsync(fileIds, folderIds);
            _selectedFileForDetails = null;
            await LoadContentsAsync();
        }
    }

    private async void EmptyTrashBtn_Click(object sender, RoutedEventArgs e)
    {
        int total = _allFiles.Count + _allFolders.Count;
        if (total == 0) return;

        var dialog = new ContentDialog
        {
            Title = "Empty Trash?",
            Content = $"Permanently delete all {total} item{(total > 1 ? "s" : "")} in Trash? This will delete all files from Telegram cloud messages and free storage space.",
            PrimaryButtonText = "Empty Trash",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = this.XamlRoot
        };

        if (await dialog.ShowAsync() == ContentDialogResult.Primary)
        {
            await _service.EmptyTrashAsync();
            _selectedFileForDetails = null;
            await LoadContentsAsync();
        }
    }

    // --- Drag and Drop Handlers ---

    private void Common_DragOver(object sender, DragEventArgs e)
    {
        if (e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            e.AcceptedOperation = DataPackageOperation.Copy;
            e.DragUIOverride.Caption = "Drop files or folders to upload to TeleDrive";
            e.DragUIOverride.IsCaptionVisible = true;
            e.DragUIOverride.IsContentVisible = true;
            e.DragUIOverride.IsGlyphVisible = true;
            DragDropOverlay.Visibility = Visibility.Visible;
            e.Handled = true;
        }
        else
        {
            e.AcceptedOperation = DataPackageOperation.None;
        }
    }

    private void Common_DragLeave(object sender, DragEventArgs e)
    {
        DragDropOverlay.Visibility = Visibility.Collapsed;
    }

    private async void Common_Drop(object sender, DragEventArgs e)
    {
        DragDropOverlay.Visibility = Visibility.Collapsed;
        e.Handled = true;

        if (e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            var def = e.GetDeferral();
            try
            {
                var items = await e.DataView.GetStorageItemsAsync();
                if (items != null && items.Count > 0)
                {
                    var paths = items.Select(it => it.Path).Where(p => !string.IsNullOrEmpty(p)).ToList();
                    await HandleIncomingPathsAsync(paths);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Drag and drop error: {ex.Message}");
            }
            finally
            {
                def.Complete();
            }
        }
    }

    private async Task UploadFilesWithConflictCheckAsync(IEnumerable<string> filePaths, string? targetFolderId)
    {
        try
        {
            var validPaths = filePaths.Where(p => !string.IsNullOrWhiteSpace(p) && File.Exists(p)).ToList();
            if (validPaths.Count == 0) return;

            // 1. Fetch current files in destination folder to accurately detect duplicates
            var (_, existingFiles) = await _service.GetDriveAsync(targetFolderId);
            var existingMap = existingFiles
                .GroupBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

            var nonConflicting = new List<string>();
            var conflicting = new List<(string SourcePath, FileModel ExistingFile)>();

            foreach (var path in validPaths)
            {
                var name = Path.GetFileName(path);
                if (existingMap.TryGetValue(name, out var existingFile))
                {
                    conflicting.Add((path, existingFile));
                }
                else
                {
                    nonConflicting.Add(path);
                }
            }

            // 2. Fast path: no conflicts exist
            if (conflicting.Count == 0)
            {
                await _service.UploadFilesAsync(validPaths, targetFolderId, "rename");
                await RefreshTransfersAsync();
                return;
            }

            // 3. Conflicts found: resolve interactively like Windows File Explorer
            var filesToReplace = new List<string>();
            var filesToRename = new List<string>(nonConflicting);
            bool applyToAll = false;
            string? rememberedAction = null;

            for (int i = 0; i < conflicting.Count; i++)
            {
                var (sourcePath, existingFile) = conflicting[i];

                if (applyToAll && rememberedAction != null)
                {
                    if (rememberedAction == "replace") filesToReplace.Add(sourcePath);
                    else if (rememberedAction == "rename") filesToRename.Add(sourcePath);
                    // if "skip", do nothing
                    continue;
                }

                var sourceInfo = new FileInfo(sourcePath);
                var (action, doAll) = await ShowConflictDialogAsync(sourcePath, sourceInfo, existingFile, i + 1, conflicting.Count);

                if (action == "cancel")
                {
                    // User aborted upload flow
                    break;
                }

                if (doAll)
                {
                    applyToAll = true;
                    rememberedAction = action;
                }

                if (action == "replace") filesToReplace.Add(sourcePath);
                else if (action == "rename") filesToRename.Add(sourcePath);
                // if "skip", do nothing
            }

            // 4. Fire the uploads according to resolution
            if (filesToReplace.Count > 0)
            {
                await _service.UploadFilesAsync(filesToReplace, targetFolderId, "replace");
            }
            if (filesToRename.Count > 0)
            {
                await _service.UploadFilesAsync(filesToRename, targetFolderId, "rename");
            }

            await RefreshTransfersAsync();
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"UploadFilesWithConflictCheckAsync error: {ex.Message}");
        }
    }

    private async Task UploadDirectoryWithConflictCheckAsync(string dirPath, string? parentFolderId)
    {
        try
        {
            if (!Directory.Exists(dirPath)) return;
            var dirInfo = new DirectoryInfo(dirPath);
            var folderName = dirInfo.Name;

            var createdFolderId = await _service.CreateFolderAsync(folderName, parentFolderId);
            var targetFolderId = !string.IsNullOrEmpty(createdFolderId) ? createdFolderId : parentFolderId;

            var files = Directory.GetFiles(dirPath);
            if (files.Length > 0)
            {
                await UploadFilesWithConflictCheckAsync(files, targetFolderId);
            }

            var subDirs = Directory.GetDirectories(dirPath);
            foreach (var sub in subDirs)
            {
                await UploadDirectoryWithConflictCheckAsync(sub, targetFolderId);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"UploadDirectoryWithConflictCheckAsync error: {ex.Message}");
        }
    }

    private async Task<(string Action, bool ApplyToAll)> ShowConflictDialogAsync(
        string sourcePath,
        FileInfo sourceInfo,
        FileModel existingFile,
        int conflictIndex,
        int totalConflicts)
    {
        var fileName = Path.GetFileName(sourcePath);
        var rootPanel = new StackPanel { Spacing = 14, Width = 460 };

        // Subtitle / Question
        var questionText = new TextBlock
        {
            Text = totalConflicts > 1
                ? $"Conflict ({conflictIndex} of {totalConflicts}): The destination already has a file named \"{fileName}\""
                : $"The destination already has a file named \"{fileName}\"",
            FontWeight = FontWeights.SemiBold,
            FontSize = 14,
            TextWrapping = TextWrapping.Wrap
        };
        rootPanel.Children.Add(questionText);

        // Comparison card grid
        var cardGrid = new Grid
        {
            ColumnSpacing = 12,
            Padding = new Thickness(12),
            Background = Application.Current.Resources.TryGetValue("CardBackgroundFillColorDefaultBrush", out var cardBg)
                ? (Brush)cardBg
                : new SolidColorBrush(Windows.UI.Color.FromArgb(24, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            BorderBrush = Application.Current.Resources.TryGetValue("CardStrokeColorDefaultBrush", out var cardStroke)
                ? (Brush)cardStroke
                : new SolidColorBrush(Windows.UI.Color.FromArgb(40, 255, 255, 255)),
            CornerRadius = new CornerRadius(8)
        };
        cardGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        cardGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        // Existing file in cloud (Left)
        var existingPanel = new StackPanel { Spacing = 4 };
        existingPanel.Children.Add(new TextBlock
        {
            Text = "EXISTING IN CLOUD",
            FontSize = 10,
            FontWeight = FontWeights.Bold,
            Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 168, 85, 247))
        });
        existingPanel.Children.Add(new TextBlock
        {
            Text = FileModel.FormatBytes((ulong)Math.Max(0, existingFile.Size)),
            FontSize = 13,
            FontWeight = FontWeights.Medium
        });
        var existingDate = DateTimeOffset.FromUnixTimeMilliseconds(existingFile.CreatedAt).LocalDateTime;
        existingPanel.Children.Add(new TextBlock
        {
            Text = existingDate.ToString("g"),
            FontSize = 11,
            Opacity = 0.75
        });
        Grid.SetColumn(existingPanel, 0);
        cardGrid.Children.Add(existingPanel);

        // Incoming file from PC (Right)
        var sourcePanel = new StackPanel { Spacing = 4 };
        sourcePanel.Children.Add(new TextBlock
        {
            Text = "INCOMING FILE (PC)",
            FontSize = 10,
            FontWeight = FontWeights.Bold,
            Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 56, 189, 248))
        });
        sourcePanel.Children.Add(new TextBlock
        {
            Text = FileModel.FormatBytes((ulong)Math.Max(0, sourceInfo.Length)),
            FontSize = 13,
            FontWeight = FontWeights.Medium
        });
        sourcePanel.Children.Add(new TextBlock
        {
            Text = sourceInfo.LastWriteTime.ToString("g"),
            FontSize = 11,
            Opacity = 0.75
        });
        Grid.SetColumn(sourcePanel, 1);
        cardGrid.Children.Add(sourcePanel);

        rootPanel.Children.Add(cardGrid);

        // Choices
        var radioPanel = new StackPanel { Spacing = 8, Margin = new Thickness(0, 4, 0, 0) };

        var rbReplace = new RadioButton
        {
            GroupName = "ConflictActionGroup",
            IsChecked = true,
            Content = new StackPanel
            {
                Spacing = 2,
                Children =
                {
                    new TextBlock { Text = "Replace the file in the destination", FontWeight = FontWeights.Medium, FontSize = 13 },
                    new TextBlock { Text = "Replaces the existing cloud file with the newly uploaded version", FontSize = 11.5, Opacity = 0.7 }
                }
            }
        };

        var rbRename = new RadioButton
        {
            GroupName = "ConflictActionGroup",
            Content = new StackPanel
            {
                Spacing = 2,
                Children =
                {
                    new TextBlock { Text = "Keep both files (Rename incoming file)", FontWeight = FontWeights.Medium, FontSize = 13 },
                    new TextBlock { Text = "The new file will be saved with a number suffix (e.g. \"(1)\")", FontSize = 11.5, Opacity = 0.7 }
                }
            }
        };

        var rbSkip = new RadioButton
        {
            GroupName = "ConflictActionGroup",
            Content = new StackPanel
            {
                Spacing = 2,
                Children =
                {
                    new TextBlock { Text = "Skip this file", FontWeight = FontWeights.Medium, FontSize = 13 },
                    new TextBlock { Text = "Do not upload this file and keep the existing file unchanged", FontSize = 11.5, Opacity = 0.7 }
                }
            }
        };

        radioPanel.Children.Add(rbReplace);
        radioPanel.Children.Add(rbRename);
        radioPanel.Children.Add(rbSkip);
        rootPanel.Children.Add(radioPanel);

        // Checkbox for bulk conflicts
        CheckBox? applyAllCheck = null;
        if (totalConflicts > 1)
        {
            int remaining = totalConflicts - conflictIndex + 1;
            applyAllCheck = new CheckBox
            {
                Content = $"Do this for all remaining conflicts ({remaining} item{(remaining > 1 ? "s" : "")})",
                FontSize = 12,
                Margin = new Thickness(0, 4, 0, 0)
            };
            rootPanel.Children.Add(applyAllCheck);
        }

        var dialog = new ContentDialog
        {
            Title = "Replace or Skip Files",
            Content = rootPanel,
            PrimaryButtonText = "Continue",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = this.XamlRoot
        };

        var result = await dialog.ShowAsync();
        if (result == ContentDialogResult.Primary)
        {
            string action = "replace";
            if (rbRename.IsChecked == true) action = "rename";
            else if (rbSkip.IsChecked == true) action = "skip";

            bool doAll = applyAllCheck?.IsChecked == true;
            return (action, doAll);
        }

        return ("cancel", false);
    }

    private async Task<string?> GetOrCreateSpecialFolderIdAsync(string folderName)
    {
        try
        {
            var (rootFolders, _) = await _service.GetDriveAsync(null);
            var existing = rootFolders.FirstOrDefault(f => string.Equals(f.Name, folderName, StringComparison.OrdinalIgnoreCase));
            if (existing != null)
            {
                return existing.Id;
            }

            var createdId = await _service.CreateFolderAsync(folderName, null);
            return createdId;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"GetOrCreateSpecialFolderIdAsync error: {ex.Message}");
            return null;
        }
    }

    private async void NavigateToFolder(string folderId, string folderName)
    {
        _navHistory.Push((_currentFolderId, CurrentFolderTitle.Text));
        _currentFolderId = folderId;
        _currentPageTag = "drive";
        CurrentFolderTitle.Text = folderName;
        UpdateNavBackButton();
        await LoadContentsAsync();
    }

    private void UpdateNavBackButton()
    {
        if (NavBackBtn != null)
        {
            bool canGoBack = _navHistory.Count > 0 || !string.IsNullOrEmpty(_currentFolderId);
            NavBackBtn.Visibility = canGoBack ? Visibility.Visible : Visibility.Collapsed;
            if (_navHistory.Count > 0)
            {
                var prev = _navHistory.Peek();
                ToolTipService.SetToolTip(NavBackBtn, $"Back to {prev.Title}");
            }
            else
            {
                ToolTipService.SetToolTip(NavBackBtn, "Back to My Drive");
            }
        }
        UpdateHeaderBreadcrumbs();
    }

    private void UpdateHeaderBreadcrumbs()
    {
        if (BreadcrumbsBarStack == null) return;
        BreadcrumbsBarStack.Children.Clear();

        if (_currentPageTag != "drive" || (string.IsNullOrEmpty(_currentFolderId) && _navHistory.Count == 0))
        {
            BreadcrumbsBarStack.Children.Add(new TextBlock
            {
                Text = CurrentFolderTitle?.Text ?? "My Drive",
                FontSize = 20,
                FontWeight = FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center
            });
            return;
        }

        var crumbs = new List<(string? Id, string Name)>();
        crumbs.Add((null, "My Drive"));

        var historyList = _navHistory.Reverse().ToList();
        foreach (var h in historyList)
        {
            if (!string.IsNullOrEmpty(h.FolderId) && !crumbs.Any(c => c.Id == h.FolderId))
            {
                crumbs.Add((h.FolderId, h.Title));
            }
        }

        if (!string.IsNullOrEmpty(_currentFolderId) && !crumbs.Any(c => c.Id == _currentFolderId))
        {
            crumbs.Add((_currentFolderId, CurrentFolderTitle?.Text ?? "Folder"));
        }

        for (int i = 0; i < crumbs.Count; i++)
        {
            var crumb = crumbs[i];
            bool isLast = (i == crumbs.Count - 1);

            if (isLast)
            {
                BreadcrumbsBarStack.Children.Add(new TextBlock
                {
                    Text = crumb.Name,
                    FontSize = 20,
                    FontWeight = FontWeights.SemiBold,
                    VerticalAlignment = VerticalAlignment.Center
                });
            }
            else
            {
                var btn = new Button
                {
                    Content = crumb.Name,
                    Background = new SolidColorBrush(Colors.Transparent),
                    BorderThickness = new Thickness(0),
                    Padding = new Thickness(4, 2, 4, 2),
                    FontSize = 18,
                    Foreground = (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"],
                    VerticalAlignment = VerticalAlignment.Center
                };
                var targetId = crumb.Id;
                var targetTitle = crumb.Name;
                int targetIndex = i;
                btn.Click += async (s, e) =>
                {
                    while (_navHistory.Count > targetIndex)
                    {
                        _navHistory.Pop();
                    }
                    _currentFolderId = targetId;
                    if (CurrentFolderTitle != null)
                    {
                        CurrentFolderTitle.Text = targetTitle;
                    }
                    UpdateNavBackButton();
                    await LoadContentsAsync();
                };
                BreadcrumbsBarStack.Children.Add(btn);

                BreadcrumbsBarStack.Children.Add(new FontIcon
                {
                    Glyph = "\uE76C",
                    FontSize = 9,
                    Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
                    VerticalAlignment = VerticalAlignment.Center,
                    Margin = new Thickness(2, 0, 2, 0)
                });
            }
        }
    }

    private async void NavBackBtn_Click(object sender, RoutedEventArgs e)
    {
        if (_navHistory.Count > 0)
        {
            var (prevFolderId, prevTitle) = _navHistory.Pop();
            _currentFolderId = prevFolderId;
            _currentPageTag = "drive";
            CurrentFolderTitle.Text = string.IsNullOrEmpty(prevTitle) ? "My Drive" : prevTitle;
        }
        else
        {
            _currentFolderId = null;
            _currentPageTag = "drive";
            CurrentFolderTitle.Text = "My Drive";
        }

        if (DriveNavItem != null)
        {
            NavView.SelectedItem = DriveNavItem;
        }
        UpdateNavBackButton();
        await LoadContentsAsync();
    }

    private void NavView_ItemInvoked(NavigationView sender, NavigationViewItemInvokedEventArgs args)
    {
        if (args.InvokedItemContainer is NavigationViewItem item)
        {
            if ((NavView.SelectedItem as NavigationViewItem) != item)
            {
                NavView.SelectedItem = item;
            }
            else
            {
                // Re-trigger if already selected
                NavView_SelectionChanged(sender, null!);
            }
        }
    }

    // --- Navigation & Pickers ---

    private async void NavView_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs? args)
    {
        if (args?.IsSettingsSelected == true)
        {
            _currentPageTag = "settings";
            CurrentFolderTitle.Text = "Settings";
            ItemCountSubtitle.Text = "Preferences & Diagnostics";
            DriveScrollViewer.Visibility = Visibility.Collapsed;
            RecentView.Visibility = Visibility.Collapsed;
            TransfersView.Visibility = Visibility.Collapsed;
            FileDetailsPane.Visibility = Visibility.Collapsed;
            ViewModeToggleBorder.Visibility = Visibility.Collapsed;
            UploadFilesBtn.Visibility = Visibility.Collapsed;
            UploadFolderBtn.Visibility = Visibility.Collapsed;
            NewFolderBtn.Visibility = Visibility.Collapsed;
            if (NavBackBtn != null) NavBackBtn.Visibility = Visibility.Collapsed;
            if (ShellContextMenuToggle != null)
            {
                ShellContextMenuToggle.IsOn = ShellIntegrationService.IsShellIntegrationRegistered();
            }
            SettingsView.Visibility = Visibility.Visible;
            return;
        }

        SettingsView.Visibility = Visibility.Collapsed;

        var item = (args?.SelectedItem as NavigationViewItem) ?? (sender.SelectedItem as NavigationViewItem);
        if (item != null && item.Tag is string tag)
        {
            _currentPageTag = tag;
            if (tag == "drive")
            {
                _currentFolderId = null;
                CurrentFolderTitle.Text = "My Drive";
            }
            else if (tag == "folder_documents")
            {
                _currentFolderId = await GetOrCreateSpecialFolderIdAsync("Documents");
                CurrentFolderTitle.Text = "Documents";
            }
            else if (tag == "folder_pictures")
            {
                _currentFolderId = await GetOrCreateSpecialFolderIdAsync("Pictures");
                CurrentFolderTitle.Text = "Pictures";
            }
            else if (tag == "folder_videos")
            {
                _currentFolderId = await GetOrCreateSpecialFolderIdAsync("Videos");
                CurrentFolderTitle.Text = "Videos";
            }
            else if (tag == "folder_music")
            {
                _currentFolderId = await GetOrCreateSpecialFolderIdAsync("Music");
                CurrentFolderTitle.Text = "Music";
            }
            else if (tag == "starred")
            {
                _currentFolderId = null;
                CurrentFolderTitle.Text = "Starred";
            }
            else if (tag == "trash")
            {
                _currentFolderId = null;
                CurrentFolderTitle.Text = "Trash";
            }

            _navHistory.Clear();
            UpdateNavBackButton();

            await LoadContentsAsync();
            if (DriveScrollViewer != null && DriveScrollViewer.ActualWidth > 0)
            {
                UpdateResponsiveGrid(DriveScrollViewer.ActualWidth);
            }
        }
    }

    private void FoldersGridView_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        var folder = (e.OriginalSource as FrameworkElement)?.DataContext as FolderModel
                     ?? FoldersGridView.SelectedItem as FolderModel;
        if (folder != null)
        {
            NavigateToFolder(folder.Id, folder.Name);
        }
    }

    private async void FilesGridView_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        var file = (e.OriginalSource as FrameworkElement)?.DataContext as FileModel
                   ?? FilesGridView.SelectedItem as FileModel;
        if (file != null)
        {
            await _service.StartDownloadAsync(file.Id);
            await RefreshTransfersAsync();
        }
    }

    private async void FilesListView_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        var file = (e.OriginalSource as FrameworkElement)?.DataContext as FileModel
                   ?? FilesListView.SelectedItem as FileModel;
        if (file != null)
        {
            await _service.StartDownloadAsync(file.Id);
            await RefreshTransfersAsync();
        }
    }

    private void FoldersGridView_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is FolderModel folder)
        {
            NavigateToFolder(folder.Id, folder.Name);
        }
    }

    private void FilesGridView_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is FileModel file)
        {
            ShowFileDetails(file);
        }
    }

    private void FilesListView_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is FileModel file)
        {
            ShowFileDetails(file);
        }
    }

    private async void FileDownloadBtn_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.DataContext is FileModel file)
        {
            await _service.StartDownloadAsync(file.Id);
            await RefreshTransfersAsync();
        }
    }

    private async void FileStarBtn_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.DataContext is FileModel file)
        {
            file.Starred = !file.Starred;
            await _service.SetStarredAsync(file.Id, false, file.Starred);
        }
    }

    private async void FolderStarBtn_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.DataContext is FolderModel folder)
        {
            folder.Starred = !folder.Starred;
            await _service.SetStarredAsync(folder.Id, true, folder.Starred);
        }
    }

    private async void UploadFilesBtn_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var picker = new FileOpenPicker
            {
                ViewMode = PickerViewMode.List,
                SuggestedStartLocation = PickerLocationId.Downloads
            };
            picker.FileTypeFilter.Add("*");

            var hwnd = WindowNative.GetWindowHandle(App.CurrentWindow);
            InitializeWithWindow.Initialize(picker, hwnd);

            var files = await picker.PickMultipleFilesAsync();
            if (files != null && files.Count > 0)
            {
                var paths = files.Select(f => f.Path).ToList();
                await HandleIncomingPathsAsync(paths);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Upload picker failed: {ex.Message}");
        }
    }

    private async void UploadFolderBtn_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var picker = new FolderPicker
            {
                SuggestedStartLocation = PickerLocationId.Downloads
            };
            picker.FileTypeFilter.Add("*");

            var hwnd = WindowNative.GetWindowHandle(App.CurrentWindow);
            InitializeWithWindow.Initialize(picker, hwnd);

            var folder = await picker.PickSingleFolderAsync();
            if (folder != null && Directory.Exists(folder.Path))
            {
                await HandleIncomingPathsAsync(new[] { folder.Path });
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Folder picker failed: {ex.Message}");
        }
    }

    private async void NewFolderBtn_Click(object sender, RoutedEventArgs e)
    {
        var panel = new StackPanel { Spacing = 6 };
        var inputTextBox = new TextBox { Text = "New Folder", HorizontalAlignment = HorizontalAlignment.Stretch };
        var hint = new TextBlock
        {
            Text = "Tip: You can create nested folders by typing paths like 'Work/2026/Q4'",
            FontSize = 11,
            Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"]
        };
        panel.Children.Add(inputTextBox);
        panel.Children.Add(hint);

        var dialog = new ContentDialog
        {
            Title = "Create New Folder",
            Content = panel,
            PrimaryButtonText = "Create",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = XamlRoot
        };

        if (await dialog.ShowAsync() == ContentDialogResult.Primary && !string.IsNullOrWhiteSpace(inputTextBox.Text))
        {
            await _service.CreateFolderAsync(inputTextBox.Text.Trim(), _currentFolderId);
            await LoadContentsAsync();
        }
    }

    private async void RefreshBtn_Click(object sender, RoutedEventArgs e)
    {
        await LoadContentsAsync();
    }

    private void GridViewBtn_Click(object sender, RoutedEventArgs e)
    {
        _viewMode = 0;
        GridViewBtn.Background = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"];
        ListViewBtn.Background = new SolidColorBrush(Colors.Transparent);
        FilesGridSection.Visibility = Files.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        FilesListSection.Visibility = Visibility.Collapsed;

        if (AppConfigService.Current.ViewMode != 0)
        {
            AppConfigService.Current.ViewMode = 0;
            AppConfigService.Save();
        }
    }

    private void ListViewBtn_Click(object sender, RoutedEventArgs e)
    {
        _viewMode = 1;
        ListViewBtn.Background = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"];
        GridViewBtn.Background = new SolidColorBrush(Colors.Transparent);
        FilesGridSection.Visibility = Visibility.Collapsed;
        FilesListSection.Visibility = Files.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

        if (AppConfigService.Current.ViewMode != 1)
        {
            AppConfigService.Current.ViewMode = 1;
            AppConfigService.Save();
        }
    }

    private void SearchBox_TextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
    {
        ApplyCurrentFilterAndDisplay();
    }

    // --- Transfer Filter Buttons ---

    private void SetTransfersFilterBtnActive(Button activeBtn)
    {
        TransfersAllBtn.Background = new SolidColorBrush(Colors.Transparent);
        TransfersAllBtn.Foreground = (Brush)Application.Current.Resources["TextFillColorPrimaryBrush"];
        TransfersActiveBtn.Background = new SolidColorBrush(Colors.Transparent);
        TransfersUploadsBtn.Background = new SolidColorBrush(Colors.Transparent);
        TransfersDownloadsBtn.Background = new SolidColorBrush(Colors.Transparent);
        TransfersCompletedBtn.Background = new SolidColorBrush(Colors.Transparent);

        activeBtn.Background = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"];
        activeBtn.Foreground = new SolidColorBrush(Colors.Black);
    }

    private void TransfersAllBtn_Click(object sender, RoutedEventArgs e)
    {
        _transfersFilter = "all";
        SetTransfersFilterBtnActive(TransfersAllBtn);
        UpdateFilteredTransfers(ApplyTransferFilter(Transfers));
    }

    private void TransfersActiveBtn_Click(object sender, RoutedEventArgs e)
    {
        _transfersFilter = "active";
        SetTransfersFilterBtnActive(TransfersActiveBtn);
        UpdateFilteredTransfers(ApplyTransferFilter(Transfers));
    }

    private void TransfersUploadsBtn_Click(object sender, RoutedEventArgs e)
    {
        _transfersFilter = "uploads";
        SetTransfersFilterBtnActive(TransfersUploadsBtn);
        UpdateFilteredTransfers(ApplyTransferFilter(Transfers));
    }

    private void TransfersDownloadsBtn_Click(object sender, RoutedEventArgs e)
    {
        _transfersFilter = "downloads";
        SetTransfersFilterBtnActive(TransfersDownloadsBtn);
        UpdateFilteredTransfers(ApplyTransferFilter(Transfers));
    }

    private void TransfersCompletedBtn_Click(object sender, RoutedEventArgs e)
    {
        _transfersFilter = "completed";
        SetTransfersFilterBtnActive(TransfersCompletedBtn);
        UpdateFilteredTransfers(ApplyTransferFilter(Transfers));
    }

    private void RecentAllBtn_Click(object sender, RoutedEventArgs e)
    {
        RecentAllBtn.Background = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"];
        RecentFilesBtn.Background = new SolidColorBrush(Colors.Transparent);
        RecentDownloadsBtn.Background = new SolidColorBrush(Colors.Transparent);
        RecentDownloadsListView.Visibility = Visibility.Visible;
    }

    private void RecentFilesBtn_Click(object sender, RoutedEventArgs e)
    {
        RecentFilesBtn.Background = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"];
        RecentAllBtn.Background = new SolidColorBrush(Colors.Transparent);
        RecentDownloadsBtn.Background = new SolidColorBrush(Colors.Transparent);
        RecentDownloadsListView.Visibility = Visibility.Collapsed;
    }

    private void RecentDownloadsBtn_Click(object sender, RoutedEventArgs e)
    {
        RecentDownloadsBtn.Background = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"];
        RecentAllBtn.Background = new SolidColorBrush(Colors.Transparent);
        RecentFilesBtn.Background = new SolidColorBrush(Colors.Transparent);
        RecentDownloadsListView.Visibility = Visibility.Visible;
    }

    // --- Transfer Actions ---

    private async void ClearFinishedDownloads_Click(object sender, RoutedEventArgs e)
    {
        await _service.ClearFinishedDownloadsAsync();
        await RefreshTransfersAsync();
    }

    private void OpenDownloadsFolder_Click(object sender, RoutedEventArgs e)
    {
        var downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        if (Directory.Exists(downloads))
        {
            Process.Start("explorer.exe", downloads);
        }
    }

    private async void OpenDownloadedFile_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.DataContext is TransferTaskModel task)
        {
            await _service.OpenFileAsync(task.Id);
        }
    }

    private async void RevealDownloadedFile_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.DataContext is TransferTaskModel task)
        {
            await _service.RevealFileAsync(task.Id);
        }
    }

    private async void PauseDownload_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.DataContext is TransferTaskModel task)
        {
            await _service.PauseDownloadAsync(task.Id);
            await RefreshTransfersAsync();
        }
    }

    private async void ResumeDownload_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.DataContext is TransferTaskModel task)
        {
            await _service.ResumeDownloadAsync(task.Id);
            await RefreshTransfersAsync();
        }
    }

    private async void CancelTransfer_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn && btn.DataContext is TransferTaskModel task)
        {
            await _service.CancelTransferAsync(task);
            await RefreshTransfersAsync();
        }
    }

    private void StatusBarTransferBtn_Click(object sender, RoutedEventArgs e)
    {
        NavView.SelectedItem = TransfersNavItem;
    }

    // --- Native Context Menu Handlers ---

    private async void PromptRename(string id, bool isFolder, string currentName)
    {
        var input = new TextBox { Text = currentName, HorizontalAlignment = HorizontalAlignment.Stretch };
        var dialog = new ContentDialog
        {
            Title = isFolder ? "Rename Folder" : "Rename File",
            Content = input,
            PrimaryButtonText = "Rename",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = XamlRoot
        };

        if (await dialog.ShowAsync() == ContentDialogResult.Primary && !string.IsNullOrWhiteSpace(input.Text))
        {
            await _service.RenameAsync(id, isFolder, input.Text.Trim());
            await LoadContentsAsync();
        }
    }

    private async void ContextMenu_Download_Click(object sender, RoutedEventArgs e)
    {
        var file = (sender as FrameworkElement)?.DataContext as FileModel;
        if (file != null)
        {
            await _service.StartDownloadAsync(file.Id);
            await RefreshTransfersAsync();
        }
    }

    private void ContextMenu_CopyId_Click(object sender, RoutedEventArgs e)
    {
        var file = (sender as FrameworkElement)?.DataContext as FileModel;
        if (file != null)
        {
            var dp = new Windows.ApplicationModel.DataTransfer.DataPackage();
            dp.SetText(file.Id);
            Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(dp);
        }
    }

    private async void ContextMenu_Star_Click(object sender, RoutedEventArgs e)
    {
        var file = (sender as FrameworkElement)?.DataContext as FileModel;
        if (file != null)
        {
            file.Starred = !file.Starred;
            await _service.SetStarredAsync(file.Id, false, file.Starred);
            if (_currentPageTag == "starred") await LoadContentsAsync();
        }
    }

    private void ContextMenu_Rename_Click(object sender, RoutedEventArgs e)
    {
        var file = (sender as FrameworkElement)?.DataContext as FileModel;
        if (file != null)
        {
            PromptRename(file.Id, false, file.Name);
        }
    }

    private async void ContextMenu_Trash_Click(object sender, RoutedEventArgs e)
    {
        var file = (sender as FrameworkElement)?.DataContext as FileModel;
        if (file != null)
        {
            await _service.TrashAsync(file.Id, false);
            await LoadContentsAsync();
        }
    }

    private void ContextMenu_Properties_Click(object sender, RoutedEventArgs e)
    {
        var file = (sender as FrameworkElement)?.DataContext as FileModel;
        if (file != null)
        {
            ShowFileDetails(file);
        }
    }

    private void ContextMenu_OpenFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = (sender as FrameworkElement)?.DataContext as FolderModel;
        if (folder != null)
        {
            NavigateToFolder(folder.Id, folder.Name);
        }
    }

    private void ContextMenu_RenameFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = (sender as FrameworkElement)?.DataContext as FolderModel;
        if (folder != null)
        {
            PromptRename(folder.Id, true, folder.Name);
        }
    }

    private async void ContextMenu_TrashFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = (sender as FrameworkElement)?.DataContext as FolderModel;
        if (folder != null)
        {
            await _service.TrashAsync(folder.Id, true);
            await LoadContentsAsync();
        }
    }

    private (List<string> FileIds, List<string> FolderIds) GetSelectedOrTargetItemIds(object? senderContext = null)
    {
        var selectedFiles = _viewMode == 0
            ? (FilesGridView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>())
            : (FilesListView?.SelectedItems.OfType<FileModel>().ToList() ?? new List<FileModel>());
        var selectedFolders = FoldersGridView?.SelectedItems.OfType<FolderModel>().ToList() ?? new List<FolderModel>();

        var fileIds = selectedFiles.Select(f => f.Id).ToList();
        var folderIds = selectedFolders.Select(f => f.Id).ToList();

        if (fileIds.Count == 0 && folderIds.Count == 0)
        {
            if (senderContext is FileModel fm)
            {
                fileIds.Add(fm.Id);
            }
            else if (senderContext is FolderModel fdm)
            {
                folderIds.Add(fdm.Id);
            }
            else if (_selectedFileForDetails != null)
            {
                fileIds.Add(_selectedFileForDetails.Id);
            }
        }

        return (fileIds, folderIds);
    }

    private void ExecuteClipboardCut(object? senderContext = null)
    {
        var (fileIds, folderIds) = GetSelectedOrTargetItemIds(senderContext);
        if (fileIds.Count == 0 && folderIds.Count == 0) return;

        _clipboardFileIds.Clear();
        _clipboardFileIds.AddRange(fileIds);
        _clipboardFolderIds.Clear();
        _clipboardFolderIds.AddRange(folderIds);
        _isClipboardCut = true;

        var count = fileIds.Count + folderIds.Count;
        if (StatusBarSelectionText != null)
        {
            StatusBarSelectionText.Text = $"• {count} item{(count == 1 ? "" : "s")} cut (press Ctrl+V to paste)";
        }
    }

    private void ExecuteClipboardCopy(object? senderContext = null)
    {
        var (fileIds, folderIds) = GetSelectedOrTargetItemIds(senderContext);
        if (fileIds.Count == 0 && folderIds.Count == 0) return;

        _clipboardFileIds.Clear();
        _clipboardFileIds.AddRange(fileIds);
        _clipboardFolderIds.Clear();
        _clipboardFolderIds.AddRange(folderIds);
        _isClipboardCut = false;

        var count = fileIds.Count + folderIds.Count;
        if (StatusBarSelectionText != null)
        {
            StatusBarSelectionText.Text = $"• {count} item{(count == 1 ? "" : "s")} copied (press Ctrl+V to paste)";
        }
    }

    private async Task ExecuteClipboardPasteAsync(string? targetFolderId = null)
    {
        if (_clipboardFileIds.Count == 0 && _clipboardFolderIds.Count == 0)
        {
            return;
        }

        var destinationFolderId = targetFolderId ?? _currentFolderId;
        var count = _clipboardFileIds.Count + _clipboardFolderIds.Count;
        bool success;
        if (_isClipboardCut)
        {
            success = await _service.MoveItemsAsync(_clipboardFileIds, _clipboardFolderIds, destinationFolderId);
            if (success)
            {
                if (StatusBarSelectionText != null)
                {
                    StatusBarSelectionText.Text = $"• Moved {count} item{(count == 1 ? "" : "s")}";
                }
                _clipboardFileIds.Clear();
                _clipboardFolderIds.Clear();
            }
        }
        else
        {
            success = await _service.CopyItemsAsync(_clipboardFileIds, _clipboardFolderIds, destinationFolderId);
            if (success)
            {
                if (StatusBarSelectionText != null)
                {
                    StatusBarSelectionText.Text = $"• Copied {count} item{(count == 1 ? "" : "s")}";
                }
            }
        }

        if (success)
        {
            await LoadContentsAsync();
        }
    }

    private async void ContextMenu_PasteIntoFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = (sender as FrameworkElement)?.DataContext as FolderModel;
        if (folder != null && !string.IsNullOrEmpty(folder.Id))
        {
            await ExecuteClipboardPasteAsync(folder.Id);
        }
    }

    private async void ContextMenu_MoveItem_Click(object sender, RoutedEventArgs e)
    {
        var (fileIds, folderIds) = GetSelectedOrTargetItemIds((sender as FrameworkElement)?.DataContext);
        if (fileIds.Count == 0 && folderIds.Count == 0) return;

        var folderTree = await _service.GetFolderTreeAsync();
        var blockedIds = new HashSet<string>(folderIds, StringComparer.OrdinalIgnoreCase);
        var childrenMap = folderTree.Where(f => !string.IsNullOrEmpty(f.ParentId))
                                    .GroupBy(f => f.ParentId!)
                                    .ToDictionary(g => g.Key, g => g.Select(x => x.Id).ToList(), StringComparer.OrdinalIgnoreCase);
        void BlockSubtree(string fid)
        {
            if (childrenMap.TryGetValue(fid, out var children))
            {
                foreach (var child in children)
                {
                    if (blockedIds.Add(child)) BlockSubtree(child);
                }
            }
        }
        foreach (var fid in folderIds) BlockSubtree(fid);

        var validFolders = folderTree.Where(f => !blockedIds.Contains(f.Id)).ToList();
        var options = FolderPickerOption.BuildFlattenedFolderList(validFolders);

        var combo = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch, ItemsSource = options, SelectedIndex = 0 };
        var pathText = new TextBlock
        {
            Text = $"📍 Move to: {options[0].FullPath}",
            FontSize = 12,
            Foreground = (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"],
            Margin = new Thickness(0, 6, 0, 0)
        };
        combo.SelectionChanged += (s, ev) =>
        {
            if (combo.SelectedItem is FolderPickerOption opt)
            {
                pathText.Text = $"📍 Move to: {opt.FullPath}";
            }
        };

        var filter = new TextBox { PlaceholderText = "Search/filter folders...", Margin = new Thickness(0, 0, 0, 6), FontSize = 12 };
        filter.TextChanged += (s, ev) =>
        {
            var q = filter.Text.Trim();
            if (string.IsNullOrEmpty(q))
            {
                combo.ItemsSource = options;
                combo.SelectedIndex = 0;
            }
            else
            {
                var flt = options.Where(o => o.Id == null || o.RawName.Contains(q, StringComparison.OrdinalIgnoreCase) || o.FullPath.Contains(q, StringComparison.OrdinalIgnoreCase)).ToList();
                combo.ItemsSource = flt;
                if (flt.Count > 1) combo.SelectedIndex = 1;
                else if (flt.Count == 1) combo.SelectedIndex = 0;
            }
        };

        var stack = new StackPanel { Spacing = 8, MinWidth = 380 };
        stack.Children.Add(new TextBlock { Text = $"Choose destination folder for {fileIds.Count + folderIds.Count} item(s):", FontWeight = FontWeights.SemiBold, FontSize = 13 });
        stack.Children.Add(filter);
        stack.Children.Add(combo);
        stack.Children.Add(pathText);

        var dialog = new ContentDialog
        {
            Title = "Move to Nested Folder",
            Content = stack,
            PrimaryButtonText = "Move Here",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = this.XamlRoot ?? App.CurrentWindow?.Content?.XamlRoot
        };

        if (await dialog.ShowAsync() == ContentDialogResult.Primary)
        {
            var chosen = combo.SelectedItem as FolderPickerOption ?? options[0];
            bool ok = await _service.MoveItemsAsync(fileIds, folderIds, chosen.Id);
            if (ok)
            {
                if (StatusBarSelectionText != null)
                {
                    StatusBarSelectionText.Text = $"• Moved {fileIds.Count + folderIds.Count} item(s) to {chosen.RawName}";
                }
                await LoadContentsAsync();
            }
        }
    }

    private void ContextMenu_CutFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = (sender as FrameworkElement)?.DataContext as FolderModel;
        ExecuteClipboardCut(folder);
    }

    private void ContextMenu_CopyFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = (sender as FrameworkElement)?.DataContext as FolderModel;
        ExecuteClipboardCopy(folder);
    }

    private void ContextMenu_CutFile_Click(object sender, RoutedEventArgs e)
    {
        var file = (sender as FrameworkElement)?.DataContext as FileModel;
        ExecuteClipboardCut(file);
    }

    private void ContextMenu_CopyFile_Click(object sender, RoutedEventArgs e)
    {
        var file = (sender as FrameworkElement)?.DataContext as FileModel;
        ExecuteClipboardCopy(file);
    }

    private async void ContextMenu_Paste_Click(object sender, RoutedEventArgs e)
    {
        await ExecuteClipboardPasteAsync();
    }

    private async Task<(bool Confirmed, string? TargetFolderId, string TargetFolderName, bool NavigateToDestination)> ShowUploadDestinationDialogAsync(
        IReadOnlyList<string> filePaths, IReadOnlyList<string> folderPaths, long totalBytes)
    {
        var xamlRoot = this.XamlRoot ?? App.CurrentWindow?.Content?.XamlRoot;
        if (xamlRoot == null)
        {
            int retries = 0;
            while (xamlRoot == null && retries < 10)
            {
                await Task.Delay(100);
                xamlRoot = this.XamlRoot ?? App.CurrentWindow?.Content?.XamlRoot;
                retries++;
            }
        }
        if (xamlRoot == null)
        {
            return (true, _currentFolderId, CurrentFolderTitle?.Text ?? "My Drive", false);
        }

        var folderTree = await _service.GetFolderTreeAsync();
        var options = FolderPickerOption.BuildFlattenedFolderList(folderTree);

        // State tracking
        string? currentNavId = _currentFolderId;
        string? selectedTargetId = _currentFolderId;

        // Verify initial folder exists in options; if not fallback to root
        var initialMatch = options.FirstOrDefault(o => o.Id == currentNavId) ?? options[0];
        currentNavId = initialMatch.Id;
        selectedTargetId = initialMatch.Id;

        // Fixed-size Root Grid so the dialog NEVER changes height or width
        var rootGrid = new Grid
        {
            Width = 520,
            Height = 560,
            MinHeight = 560,
            MaxHeight = 560,
            RowSpacing = 8
        };
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 0: Summary
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 1: Address Bar / Breadcrumbs
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 2: Search Filter
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // 3: Explorer List
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 4: Inline New Folder
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 5: Destination Card
        rootGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 6: CheckBox

        // 0. Summary Header Card
        var summaryBorder = new Border
        {
            Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"],
            BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12, 10, 12, 10)
        };
        var summaryStack = new StackPanel { Spacing = 2 };

        int totalCount = filePaths.Count + folderPaths.Count;
        string itemsDescription;
        if (filePaths.Count > 0 && folderPaths.Count > 0)
        {
            itemsDescription = $"{filePaths.Count} file{(filePaths.Count > 1 ? "s" : "")} and {folderPaths.Count} folder{(folderPaths.Count > 1 ? "s" : "")}";
        }
        else if (folderPaths.Count > 0)
        {
            itemsDescription = $"{folderPaths.Count} folder{(folderPaths.Count > 1 ? "s" : "")}";
        }
        else
        {
            itemsDescription = $"{filePaths.Count} file{(filePaths.Count > 1 ? "s" : "")}";
        }

        var titleRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        titleRow.Children.Add(new FontIcon { Glyph = "\uE898", FontSize = 15, Foreground = (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"] });
        titleRow.Children.Add(new TextBlock
        {
            Text = $"Ready to upload {itemsDescription}",
            FontWeight = FontWeights.SemiBold,
            FontSize = 13
        });
        summaryStack.Children.Add(titleRow);

        summaryStack.Children.Add(new TextBlock
        {
            Text = $"Total size: {FileModel.FormatBytes((ulong)Math.Max(0, totalBytes))}",
            FontSize = 11,
            Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
            Margin = new Thickness(23, 0, 0, 0)
        });

        summaryBorder.Child = summaryStack;
        Grid.SetRow(summaryBorder, 0);
        rootGrid.Children.Add(summaryBorder);

        // 1. File Explorer Address Bar (Breadcrumbs + Up Button + New Folder)
        var addressBarBorder = new Border
        {
            Background = (Brush)Application.Current.Resources["ControlFillColorDefaultBrush"],
            BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(6, 4, 6, 4)
        };

        var addressBarGrid = new Grid();
        addressBarGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); // Up button
        addressBarGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); // Breadcrumbs
        addressBarGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); // + New Folder

        var upButton = new Button
        {
            Content = new FontIcon { Glyph = "\uE74A", FontSize = 13 },
            Padding = new Thickness(6, 4, 6, 4),
            Margin = new Thickness(0, 0, 6, 0)
        };
        ToolTipService.SetToolTip(upButton, "Up to parent folder");
        Grid.SetColumn(upButton, 0);
        addressBarGrid.Children.Add(upButton);

        var breadcrumbsStack = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
        var breadcrumbsScroll = new ScrollViewer
        {
            HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollMode = ScrollMode.Enabled,
            VerticalScrollMode = ScrollMode.Disabled,
            Content = breadcrumbsStack,
            VerticalAlignment = VerticalAlignment.Center
        };
        Grid.SetColumn(breadcrumbsScroll, 1);
        addressBarGrid.Children.Add(breadcrumbsScroll);

        var newFolderToggleBtn = new Button
        {
            Content = "+ New Folder",
            FontSize = 11,
            Padding = new Thickness(8, 4, 8, 4),
            Margin = new Thickness(6, 0, 0, 0)
        };
        Grid.SetColumn(newFolderToggleBtn, 2);
        addressBarGrid.Children.Add(newFolderToggleBtn);

        addressBarBorder.Child = addressBarGrid;
        Grid.SetRow(addressBarBorder, 1);
        rootGrid.Children.Add(addressBarBorder);

        // 2. Search / Quick Filter
        var filterBox = new TextBox
        {
            PlaceholderText = "Filter subfolders or search all (e.g. Work, Q4)...",
            FontSize = 12,
            Height = 32
        };
        Grid.SetRow(filterBox, 2);
        rootGrid.Children.Add(filterBox);

        // 3. Folder Explorer List (Fixed Height Scrollable Area)
        var explorerItemsStack = new StackPanel { Spacing = 4 };
        var explorerScroll = new ScrollViewer
        {
            Background = (Brush)Application.Current.Resources["ControlFillColorDefaultBrush"],
            BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(8),
            Content = explorerItemsStack
        };
        Grid.SetRow(explorerScroll, 3);
        rootGrid.Children.Add(explorerScroll);

        // 4. Inline New Folder Input
        var inlineNewFolderPanel = new Border
        {
            Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"],
            BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(8, 6, 8, 6),
            Visibility = Visibility.Collapsed
        };
        var inlineStack = new StackPanel { Spacing = 4 };
        var targetParentLabel = new TextBlock
        {
            FontSize = 11,
            Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"]
        };
        inlineStack.Children.Add(targetParentLabel);

        var inlineInputGrid = new Grid();
        inlineInputGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        inlineInputGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        inlineInputGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var newFolderNameInput = new TextBox
        {
            PlaceholderText = "Folder name or nested path (e.g. Work/2026/Q4)...",
            FontSize = 12,
            Margin = new Thickness(0, 0, 6, 0)
        };
        Grid.SetColumn(newFolderNameInput, 0);
        inlineInputGrid.Children.Add(newFolderNameInput);

        var createFolderBtn = new Button
        {
            Content = "Create",
            FontSize = 12,
            Style = (Style)Application.Current.Resources["AccentButtonStyle"],
            Margin = new Thickness(0, 0, 4, 0)
        };
        Grid.SetColumn(createFolderBtn, 1);
        inlineInputGrid.Children.Add(createFolderBtn);

        var cancelNewFolderBtn = new Button
        {
            Content = "Cancel",
            FontSize = 12
        };
        Grid.SetColumn(cancelNewFolderBtn, 2);
        inlineInputGrid.Children.Add(cancelNewFolderBtn);

        inlineStack.Children.Add(inlineInputGrid);
        inlineNewFolderPanel.Child = inlineStack;
        Grid.SetRow(inlineNewFolderPanel, 4);
        rootGrid.Children.Add(inlineNewFolderPanel);

        // 5. Selected Destination Confirmation Card
        var destCardBorder = new Border
        {
            Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"],
            BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(10, 8, 10, 8)
        };
        var destCardGrid = new Grid();
        destCardGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        destCardGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var destInfoStack = new StackPanel { Spacing = 2 };
        var destTitleRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        destTitleRow.Children.Add(new FontIcon { Glyph = "\uE8B7", FontSize = 12, Foreground = (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"] });
        destTitleRow.Children.Add(new TextBlock { Text = "Upload Target:", FontSize = 11, FontWeight = FontWeights.SemiBold });
        destInfoStack.Children.Add(destTitleRow);

        var destPathText = new TextBlock
        {
            FontSize = 12,
            Foreground = (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"],
            FontWeight = FontWeights.Medium,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(18, 0, 0, 0)
        };
        destInfoStack.Children.Add(destPathText);
        Grid.SetColumn(destInfoStack, 0);
        destCardGrid.Children.Add(destInfoStack);

        var uploadHereBtn = new Button
        {
            Content = "Select Current",
            FontSize = 11,
            Padding = new Thickness(8, 4, 8, 4),
            VerticalAlignment = VerticalAlignment.Center
        };
        Grid.SetColumn(uploadHereBtn, 1);
        destCardGrid.Children.Add(uploadHereBtn);

        destCardBorder.Child = destCardGrid;
        Grid.SetRow(destCardBorder, 5);
        rootGrid.Children.Add(destCardBorder);

        // 6. Navigate CheckBox
        var navigateCheck = new CheckBox
        {
            Content = "Open destination folder when upload starts",
            IsChecked = true,
            FontSize = 12
        };
        Grid.SetRow(navigateCheck, 6);
        rootGrid.Children.Add(navigateCheck);

        // Helper Functions
        List<FolderPickerOption> GetBreadcrumbs(string? folderId)
        {
            var list = new List<FolderPickerOption>();
            var cur = options.FirstOrDefault(o => o.Id == folderId);
            while (cur != null && cur.Id != null)
            {
                list.Insert(0, cur);
                cur = options.FirstOrDefault(o => o.Id == cur.ParentId);
            }
            // Add root (options[0]) at the beginning
            list.Insert(0, options[0]);
            return list;
        }

        List<FolderPickerOption> GetSubfolders(string? parentId)
        {
            if (parentId == null)
            {
                // Top-level subfolders of My Drive root
                return options.Where(o => o.Id != null && string.IsNullOrEmpty(o.ParentId)).ToList();
            }
            return options.Where(o => o.ParentId == parentId).ToList();
        }

        void UpdateDestinationCard()
        {
            var targetOpt = options.FirstOrDefault(o => o.Id == selectedTargetId) ?? options[0];
            destPathText.Text = targetOpt.FullPath;
            var currentNavOpt = options.FirstOrDefault(o => o.Id == currentNavId) ?? options[0];
            targetParentLabel.Text = $"Creating inside: {currentNavOpt.RawName}";

            // If currentNavId matches selectedTargetId, indicate it's already selected
            if (selectedTargetId == currentNavId)
            {
                uploadHereBtn.IsEnabled = false;
                uploadHereBtn.Content = "Selected \u2713";
            }
            else
            {
                uploadHereBtn.IsEnabled = true;
                uploadHereBtn.Content = $"Select {currentNavOpt.RawName}";
            }
        }

        void RefreshAddressBar()
        {
            breadcrumbsStack.Children.Clear();
            var crumbs = GetBreadcrumbs(currentNavId);

            // Up button state
            upButton.IsEnabled = (currentNavId != null);

            for (int i = 0; i < crumbs.Count; i++)
            {
                var crumb = crumbs[i];
                bool isLast = (i == crumbs.Count - 1);

                var crumbBtn = new Button
                {
                    Background = new SolidColorBrush(Colors.Transparent),
                    BorderThickness = new Thickness(0),
                    Padding = new Thickness(4, 2, 4, 2),
                    FontSize = 12,
                    VerticalAlignment = VerticalAlignment.Center
                };

                var crumbStack = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
                if (i == 0)
                {
                    crumbStack.Children.Add(new FontIcon { Glyph = "\uE8B7", FontSize = 12, Foreground = (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"] });
                }
                crumbStack.Children.Add(new TextBlock
                {
                    Text = crumb.RawName,
                    FontWeight = isLast ? FontWeights.SemiBold : FontWeights.Normal,
                    Foreground = isLast
                        ? (Brush)Application.Current.Resources["TextFillColorPrimaryBrush"]
                        : (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"]
                });
                crumbBtn.Content = crumbStack;

                var crumbId = crumb.Id;
                crumbBtn.Click += (s, e) =>
                {
                    currentNavId = crumbId;
                    selectedTargetId = crumbId;
                    filterBox.Text = "";
                    RenderExplorerView();
                };

                breadcrumbsStack.Children.Add(crumbBtn);

                if (!isLast)
                {
                    breadcrumbsStack.Children.Add(new FontIcon
                    {
                        Glyph = "\uE76C",
                        FontSize = 8,
                        Foreground = (Brush)Application.Current.Resources["TextFillColorTertiaryBrush"],
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(2, 0, 2, 0)
                    });
                }
            }

            // Scroll to end of breadcrumbs so deepest folder is visible
            breadcrumbsScroll.ChangeView(breadcrumbsScroll.ScrollableWidth, null, null, false);
        }

        void RenderExplorerView()
        {
            RefreshAddressBar();
            UpdateDestinationCard();
            explorerItemsStack.Children.Clear();

            var query = filterBox.Text.Trim();
            List<FolderPickerOption> itemsToDisplay;

            if (!string.IsNullOrEmpty(query))
            {
                // Global search mode across all folders
                itemsToDisplay = options
                    .Where(o => o.Id != null && (
                        o.RawName.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                        o.FullPath.Contains(query, StringComparison.OrdinalIgnoreCase)))
                    .ToList();
            }
            else
            {
                // Browsing subfolders of currentNavId
                itemsToDisplay = GetSubfolders(currentNavId);
            }

            if (itemsToDisplay.Count == 0)
            {
                var emptyPanel = new StackPanel
                {
                    Spacing = 8,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center,
                    Margin = new Thickness(0, 40, 0, 40)
                };

                emptyPanel.Children.Add(new FontIcon
                {
                    Glyph = "\uED43",
                    FontSize = 32,
                    Foreground = (Brush)Application.Current.Resources["TextFillColorTertiaryBrush"],
                    HorizontalAlignment = HorizontalAlignment.Center
                });

                var currentNavOpt = options.FirstOrDefault(o => o.Id == currentNavId) ?? options[0];
                string emptyMsg = string.IsNullOrEmpty(query)
                    ? $"No subfolders in \"{currentNavOpt.RawName}\""
                    : $"No folders match \"{query}\"";

                emptyPanel.Children.Add(new TextBlock
                {
                    Text = emptyMsg,
                    FontSize = 13,
                    Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
                    HorizontalAlignment = HorizontalAlignment.Center
                });

                if (string.IsNullOrEmpty(query))
                {
                    emptyPanel.Children.Add(new TextBlock
                    {
                        Text = $"Files will be uploaded directly into this folder.",
                        FontSize = 11,
                        Foreground = (Brush)Application.Current.Resources["TextFillColorTertiaryBrush"],
                        HorizontalAlignment = HorizontalAlignment.Center
                    });
                }

                explorerItemsStack.Children.Add(emptyPanel);
                return;
            }

            foreach (var opt in itemsToDisplay)
            {
                var isSelected = (opt.Id == selectedTargetId);
                var rowBorder = new Border
                {
                    Background = isSelected
                        ? (Brush)Application.Current.Resources["SubtleFillColorSecondaryBrush"]
                        : new SolidColorBrush(Colors.Transparent),
                    BorderBrush = isSelected
                        ? (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"]
                        : new SolidColorBrush(Colors.Transparent),
                    BorderThickness = new Thickness(isSelected ? 1 : 0),
                    CornerRadius = new CornerRadius(6),
                    Padding = new Thickness(8, 6, 8, 6),
                    Margin = new Thickness(0, 1, 0, 1)
                };

                var rowGrid = new Grid();
                rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); // Folder Icon
                rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); // Name + Path
                rowGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); // Open ❯ Button

                var icon = new FontIcon
                {
                    Glyph = "\uED43",
                    FontSize = 16,
                    Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 234, 179, 8)),
                    Margin = new Thickness(0, 0, 10, 0),
                    VerticalAlignment = VerticalAlignment.Center
                };
                Grid.SetColumn(icon, 0);
                rowGrid.Children.Add(icon);

                var textStack = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
                var nameBlock = new TextBlock
                {
                    Text = opt.RawName,
                    FontSize = 13,
                    FontWeight = isSelected ? FontWeights.SemiBold : FontWeights.Normal,
                    TextTrimming = TextTrimming.CharacterEllipsis
                };
                textStack.Children.Add(nameBlock);

                if (!string.IsNullOrEmpty(query))
                {
                    var pathSub = new TextBlock
                    {
                        Text = opt.FullPath,
                        FontSize = 10,
                        Foreground = (Brush)Application.Current.Resources["TextFillColorTertiaryBrush"],
                        TextTrimming = TextTrimming.CharacterEllipsis
                    };
                    textStack.Children.Add(pathSub);
                }
                Grid.SetColumn(textStack, 1);
                rowGrid.Children.Add(textStack);

                // Open ❯ Button
                var openBtnContent = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
                openBtnContent.Children.Add(new TextBlock { Text = "Open", FontSize = 11, VerticalAlignment = VerticalAlignment.Center });
                openBtnContent.Children.Add(new FontIcon { Glyph = "\uE76C", FontSize = 9, VerticalAlignment = VerticalAlignment.Center });

                var openBtn = new Button
                {
                    Content = openBtnContent,
                    Padding = new Thickness(8, 3, 8, 3),
                    VerticalAlignment = VerticalAlignment.Center
                };
                var targetOptId = opt.Id;
                openBtn.Click += (s, e) =>
                {
                    currentNavId = targetOptId;
                    selectedTargetId = targetOptId;
                    filterBox.Text = "";
                    RenderExplorerView();
                };
                Grid.SetColumn(openBtn, 2);
                rowGrid.Children.Add(openBtn);

                rowBorder.Child = rowGrid;

                // Single click on row selects it as upload destination
                rowBorder.PointerPressed += (s, e) =>
                {
                    selectedTargetId = targetOptId;
                    RenderExplorerView();
                };

                explorerItemsStack.Children.Add(rowBorder);
            }
        }

        // Event Handlers
        upButton.Click += (s, e) =>
        {
            if (currentNavId != null)
            {
                var cur = options.FirstOrDefault(o => o.Id == currentNavId);
                currentNavId = cur?.ParentId; // Can be null (My Drive Root)
                selectedTargetId = currentNavId;
                filterBox.Text = "";
                RenderExplorerView();
            }
        };

        uploadHereBtn.Click += (s, e) =>
        {
            selectedTargetId = currentNavId;
            RenderExplorerView();
        };

        filterBox.TextChanged += (s, e) =>
        {
            RenderExplorerView();
        };

        newFolderToggleBtn.Click += (s, e) =>
        {
            inlineNewFolderPanel.Visibility = Visibility.Visible;
            newFolderToggleBtn.Visibility = Visibility.Collapsed;
            newFolderNameInput.Text = "";
            newFolderNameInput.Focus(FocusState.Programmatic);
        };

        cancelNewFolderBtn.Click += (s, e) =>
        {
            inlineNewFolderPanel.Visibility = Visibility.Collapsed;
            newFolderToggleBtn.Visibility = Visibility.Visible;
            newFolderNameInput.Text = "";
        };

        createFolderBtn.Click += async (s, e) =>
        {
            var name = newFolderNameInput.Text.Trim();
            if (string.IsNullOrEmpty(name)) return;

            createFolderBtn.IsEnabled = false;
            // Create folder inside currentNavId (supports nested paths like Work/2026/Q4)
            var createdId = await _service.CreateFolderAsync(name, currentNavId);
            createFolderBtn.IsEnabled = true;

            if (!string.IsNullOrEmpty(createdId))
            {
                var refreshedTree = await _service.GetFolderTreeAsync();
                options = FolderPickerOption.BuildFlattenedFolderList(refreshedTree);
                currentNavId = createdId;
                selectedTargetId = createdId;

                inlineNewFolderPanel.Visibility = Visibility.Collapsed;
                newFolderToggleBtn.Visibility = Visibility.Visible;
                newFolderNameInput.Text = "";
                RenderExplorerView();
            }
        };

        // Initial render
        RenderExplorerView();

        // Create ContentDialog
        var dialog = new ContentDialog
        {
            Title = "Upload to TeleDrive",
            Content = rootGrid,
            PrimaryButtonText = "Upload",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = xamlRoot
        };

        var dialogResult = await dialog.ShowAsync();
        if (dialogResult == ContentDialogResult.Primary)
        {
            var chosen = options.FirstOrDefault(o => o.Id == selectedTargetId) ?? options[0];
            return (true, chosen.Id, chosen.RawName, navigateCheck.IsChecked == true);
        }

        return (false, null, "", false);
    }

    public async Task HandleIncomingPathsAsync(IEnumerable<string> paths)
    {
        try
        {
            var filePaths = new List<string>();
            var folderPaths = new List<string>();

            foreach (var p in paths)
            {
                if (string.IsNullOrWhiteSpace(p)) continue;
                var clean = p.Trim('"', '\'', ' ');
                if (File.Exists(clean))
                {
                    filePaths.Add(clean);
                }
                else if (Directory.Exists(clean))
                {
                    folderPaths.Add(clean);
                }
            }

            if (filePaths.Count == 0 && folderPaths.Count == 0) return;

            long totalBytes = 0;
            foreach (var f in filePaths)
            {
                try { totalBytes += new FileInfo(f).Length; } catch { }
            }
            foreach (var d in folderPaths)
            {
                try
                {
                    var di = new DirectoryInfo(d);
                    foreach (var fi in di.EnumerateFiles("*", SearchOption.AllDirectories))
                    {
                        totalBytes += fi.Length;
                    }
                }
                catch { }
            }

            var (confirmed, targetFolderId, targetFolderName, navigateToDest) =
                await ShowUploadDestinationDialogAsync(filePaths, folderPaths, totalBytes);

            if (!confirmed)
            {
                Debug.WriteLine("Upload cancelled by user at destination picker.");
                return;
            }

            if (navigateToDest)
            {
                if (string.IsNullOrEmpty(targetFolderId))
                {
                    if (_currentFolderId != null || _currentPageTag != "drive")
                    {
                        _navHistory.Clear();
                        _currentFolderId = null;
                        _currentPageTag = "drive";
                        CurrentFolderTitle.Text = "My Drive";
                        if (NavView != null && DriveNavItem != null)
                        {
                            NavView.SelectedItem = DriveNavItem;
                        }
                        UpdateNavBackButton();
                        await LoadContentsAsync();
                    }
                }
                else
                {
                    NavigateToFolder(targetFolderId, targetFolderName);
                }
            }

            if (filePaths.Count > 0)
            {
                await UploadFilesWithConflictCheckAsync(filePaths, targetFolderId);
            }

            foreach (var folderPath in folderPaths)
            {
                await UploadDirectoryWithConflictCheckAsync(folderPath, targetFolderId);
            }

            await RefreshTransfersAsync();
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"HandleIncomingPathsAsync error: {ex.Message}");
        }
    }

    private void ShellContextMenuToggle_Toggled(object sender, RoutedEventArgs e)
    {
        if (sender is ToggleSwitch toggle)
        {
            if (toggle.IsOn)
            {
                ShellIntegrationService.RegisterShellIntegration();
            }
            else
            {
                ShellIntegrationService.UnregisterShellIntegration();
            }
        }
    }

    private void RegisterShellBtn_Click(object sender, RoutedEventArgs e)
    {
        ShellIntegrationService.RegisterShellIntegration();
        if (ShellContextMenuToggle != null)
        {
            ShellContextMenuToggle.IsOn = true;
        }
    }
}
