using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace TeleDrive.Tests;

public class NavigationHistoryTracker
{
    private readonly Stack<(string? FolderId, string Title)> _history = new();
    public string? CurrentFolderId { get; private set; }
    public string CurrentTitle { get; private set; } = "My Drive";

    public bool CanNavigateBack => _history.Count > 0 || !string.IsNullOrEmpty(CurrentFolderId);

    public string BackButtonToolTip
    {
        get
        {
            if (_history.Count > 0)
            {
                return $"Back to {_history.Peek().Title}";
            }
            return "Back to My Drive";
        }
    }

    public void NavigateTo(string folderId, string title)
    {
        _history.Push((CurrentFolderId, CurrentTitle));
        CurrentFolderId = folderId;
        CurrentTitle = title;
    }

    public void NavigateBack()
    {
        if (_history.Count > 0)
        {
            var (prevId, prevTitle) = _history.Pop();
            CurrentFolderId = prevId;
            CurrentTitle = string.IsNullOrEmpty(prevTitle) ? "My Drive" : prevTitle;
        }
        else
        {
            CurrentFolderId = null;
            CurrentTitle = "My Drive";
        }
    }

    public void Reset()
    {
        _history.Clear();
        CurrentFolderId = null;
        CurrentTitle = "My Drive";
    }
}

public class ClipboardTracker
{
    public List<string> FileIds { get; } = new();
    public List<string> FolderIds { get; } = new();
    public bool IsCut { get; private set; }

    public bool HasItems => FileIds.Count > 0 || FolderIds.Count > 0;

    public void StageCut(IEnumerable<string> fileIds, IEnumerable<string> folderIds)
    {
        FileIds.Clear();
        FolderIds.Clear();
        FileIds.AddRange(fileIds);
        FolderIds.AddRange(folderIds);
        IsCut = true;
    }

    public void StageCopy(IEnumerable<string> fileIds, IEnumerable<string> folderIds)
    {
        FileIds.Clear();
        FolderIds.Clear();
        FileIds.AddRange(fileIds);
        FolderIds.AddRange(folderIds);
        IsCut = false;
    }

    public void OnPasted()
    {
        if (IsCut)
        {
            FileIds.Clear();
            FolderIds.Clear();
        }
    }
}

public class NavigationAndClipboardTests
{
    [Fact]
    public void NavigationTracker_StartsAtRoot()
    {
        var nav = new NavigationHistoryTracker();
        Assert.Null(nav.CurrentFolderId);
        Assert.Equal("My Drive", nav.CurrentTitle);
        Assert.False(nav.CanNavigateBack);
        Assert.Equal("Back to My Drive", nav.BackButtonToolTip);
    }

    [Fact]
    public void NavigationTracker_NestedFoldersStepBackHierarchically()
    {
        var nav = new NavigationHistoryTracker();

        // Root -> Documents
        nav.NavigateTo("doc-1", "Documents");
        Assert.Equal("doc-1", nav.CurrentFolderId);
        Assert.Equal("Documents", nav.CurrentTitle);
        Assert.True(nav.CanNavigateBack);
        Assert.Equal("Back to My Drive", nav.BackButtonToolTip);

        // Documents -> Invoices
        nav.NavigateTo("inv-2", "Invoices");
        Assert.Equal("inv-2", nav.CurrentFolderId);
        Assert.Equal("Invoices", nav.CurrentTitle);
        Assert.True(nav.CanNavigateBack);
        Assert.Equal("Back to Documents", nav.BackButtonToolTip);

        // Invoices -> 2026
        nav.NavigateTo("yr-3", "2026");
        Assert.Equal("yr-3", nav.CurrentFolderId);
        Assert.Equal("2026", nav.CurrentTitle);
        Assert.Equal("Back to Invoices", nav.BackButtonToolTip);

        // Step back 1: Back to Invoices
        nav.NavigateBack();
        Assert.Equal("inv-2", nav.CurrentFolderId);
        Assert.Equal("Invoices", nav.CurrentTitle);
        Assert.Equal("Back to Documents", nav.BackButtonToolTip);

        // Step back 2: Back to Documents
        nav.NavigateBack();
        Assert.Equal("doc-1", nav.CurrentFolderId);
        Assert.Equal("Documents", nav.CurrentTitle);
        Assert.Equal("Back to My Drive", nav.BackButtonToolTip);

        // Step back 3: Back to My Drive
        nav.NavigateBack();
        Assert.Null(nav.CurrentFolderId);
        Assert.Equal("My Drive", nav.CurrentTitle);
        Assert.False(nav.CanNavigateBack);
    }

    [Fact]
    public void NavigationTracker_ResetClearsHistory()
    {
        var nav = new NavigationHistoryTracker();
        nav.NavigateTo("sub-1", "Folder A");
        nav.NavigateTo("sub-2", "Folder B");
        Assert.True(nav.CanNavigateBack);

        nav.Reset();
        Assert.Null(nav.CurrentFolderId);
        Assert.Equal("My Drive", nav.CurrentTitle);
        Assert.False(nav.CanNavigateBack);
    }

    [Fact]
    public void ClipboardTracker_CutClearsAfterPaste()
    {
        var clip = new ClipboardTracker();
        clip.StageCut(new[] { "f1", "f2" }, new[] { "fold1" });

        Assert.True(clip.HasItems);
        Assert.True(clip.IsCut);
        Assert.Equal(2, clip.FileIds.Count);
        Assert.Single(clip.FolderIds);

        clip.OnPasted();
        Assert.False(clip.HasItems);
        Assert.Empty(clip.FileIds);
        Assert.Empty(clip.FolderIds);
    }

    [Fact]
    public void ClipboardTracker_CopyRetainsItemsAfterPaste()
    {
        var clip = new ClipboardTracker();
        clip.StageCopy(new[] { "f1", "f2" }, new[] { "fold1" });

        Assert.True(clip.HasItems);
        Assert.False(clip.IsCut);

        clip.OnPasted();
        Assert.True(clip.HasItems);
        Assert.Equal(2, clip.FileIds.Count);
        Assert.Single(clip.FolderIds);
    }
}
