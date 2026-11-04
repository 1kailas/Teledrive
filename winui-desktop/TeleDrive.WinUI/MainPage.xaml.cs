using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.UI;
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
    private string _currentPageTag = "drive";
    private string _transfersFilter = "all"; // "all" | "active" | "uploads" | "downloads" | "completed"
    private int _viewMode = 0; // 0 = Grid, 1 = List

    private FileModel? _selectedFileForDetails;

    public MainPage()
    {
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

        if (NavBackBtn != null)
        {
            NavBackBtn.Visibility = !string.IsNullOrEmpty(_currentFolderId) ? Visibility.Visible : Visibility.Collapsed;
        }

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
        bool isCtrlDown = IsCtrlPressed();
        if (isCtrlDown)
        {
            if (e.Key == Windows.System.VirtualKey.A)
            {
                SelectAllItems();
                e.Handled = true;
                return;
            }
            if (e.Key == Windows.System.VirtualKey.Add || (int)e.Key == 187)
            {
                StepCardSize(+1);
                e.Handled = true;
                return;
            }
            if (e.Key == Windows.System.VirtualKey.Subtract || (int)e.Key == 189)
            {
                StepCardSize(-1);
                e.Handled = true;
                return;
            }
            if (e.Key == Windows.System.VirtualKey.Number0 || e.Key == Windows.System.VirtualKey.NumberPad0)
            {
                SetCardSizeTier(3);
                e.Handled = true;
                return;
            }
        }
        else if (e.Key == Windows.System.VirtualKey.Escape)
        {
            ClearSelection();
            e.Handled = true;
        }
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
                _currentFolderId = selectedFolder.Id;
                CurrentFolderTitle.Text = selectedFolder.Name;
                _ = LoadContentsAsync();
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
            foldersWrap.ItemWidth = tileWidth <= 110 ? 150 : (tileWidth <= 140 ? 165 : (tileWidth <= 175 ? 190 : (tileWidth <= 220 ? 230 : 280)));
            foldersWrap.ItemHeight = tileWidth <= 110 ? 42 : 46;
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
                    var filePaths = new List<string>();
                    var folderPaths = new List<string>();

                    foreach (var item in items)
                    {
                        if (item is StorageFolder || Directory.Exists(item.Path))
                        {
                            folderPaths.Add(item.Path);
                        }
                        else if (item is StorageFile || File.Exists(item.Path))
                        {
                            filePaths.Add(item.Path);
                        }
                    }

                    if (filePaths.Count > 0)
                    {
                        await _service.UploadFilesAsync(filePaths, _currentFolderId);
                    }

                    foreach (var folderPath in folderPaths)
                    {
                        await _service.UploadDirectoryAsync(folderPath, _currentFolderId);
                    }

                    await RefreshTransfersAsync();
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

    private async void NavBackBtn_Click(object sender, RoutedEventArgs e)
    {
        _currentFolderId = null;
        _currentPageTag = "drive";
        CurrentFolderTitle.Text = "My Drive";
        if (DriveNavItem != null)
        {
            NavView.SelectedItem = DriveNavItem;
        }
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

            await LoadContentsAsync();
            if (DriveScrollViewer != null && DriveScrollViewer.ActualWidth > 0)
            {
                UpdateResponsiveGrid(DriveScrollViewer.ActualWidth);
            }
        }
    }

    private async void FoldersGridView_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        var folder = (e.OriginalSource as FrameworkElement)?.DataContext as FolderModel
                     ?? FoldersGridView.SelectedItem as FolderModel;
        if (folder != null)
        {
            _currentFolderId = folder.Id;
            CurrentFolderTitle.Text = folder.Name;
            await LoadContentsAsync();
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

    private async void FoldersGridView_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is FolderModel folder)
        {
            _currentFolderId = folder.Id;
            CurrentFolderTitle.Text = folder.Name;
            await LoadContentsAsync();
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
                await _service.UploadFilesAsync(paths, _currentFolderId);
                await RefreshTransfersAsync();
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
                await _service.UploadDirectoryAsync(folder.Path, _currentFolderId);
                await RefreshTransfersAsync();
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Folder picker failed: {ex.Message}");
        }
    }

    private async void NewFolderBtn_Click(object sender, RoutedEventArgs e)
    {
        var inputTextBox = new TextBox { Text = "New Folder", HorizontalAlignment = HorizontalAlignment.Stretch };
        var dialog = new ContentDialog
        {
            Title = "Create New Folder",
            Content = inputTextBox,
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

    private async void ContextMenu_OpenFolder_Click(object sender, RoutedEventArgs e)
    {
        var folder = (sender as FrameworkElement)?.DataContext as FolderModel;
        if (folder != null)
        {
            _currentFolderId = folder.Id;
            CurrentFolderTitle.Text = folder.Name;
            await LoadContentsAsync();
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
}
