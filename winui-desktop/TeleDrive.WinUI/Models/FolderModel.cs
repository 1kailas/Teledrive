using System;
using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;

namespace TeleDrive_WinUI.Models;

public partial class FolderModel : ObservableObject
{
    public string Id { get; set; } = string.Empty;
    public string? ParentId { get; set; }
    public string Name { get; set; } = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(StarGlyph))]
    private bool _starred;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SelectionBorderBrush))]
    [NotifyPropertyChangedFor(nameof(SelectionBackground))]
    [NotifyPropertyChangedFor(nameof(SelectionBorderThickness))]
    [NotifyPropertyChangedFor(nameof(SelectionCheckmarkVisibility))]
    private bool _isSelected;

    private static readonly Brush _selectedBgBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(45, 56, 189, 248));
    private static readonly Brush _selectedBorderBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 56, 189, 248));

    public Brush SelectionBorderBrush => IsSelected
        ? _selectedBorderBrush
        : (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"];

    public Brush SelectionBackground => IsSelected
        ? _selectedBgBrush
        : (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"];

    public Thickness SelectionBorderThickness => new Thickness(1);

    public Visibility SelectionCheckmarkVisibility => IsSelected ? Visibility.Visible : Visibility.Collapsed;

    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
    public long? TrashedAt { get; set; }

    [ObservableProperty]
    private int _itemCount;

    public bool IsSeasonFolder =>
        !string.IsNullOrEmpty(Name) &&
        Name.Contains("Season", StringComparison.OrdinalIgnoreCase);

    public bool IsSeriesFolder =>
        !string.IsNullOrEmpty(Name) &&
        (IsSeasonFolder ||
         Name.Equals("Lost", StringComparison.OrdinalIgnoreCase) ||
         Name.Contains("Cosmos", StringComparison.OrdinalIgnoreCase) ||
         Name.Contains("Series", StringComparison.OrdinalIgnoreCase) ||
         Name.Equals("stream", StringComparison.OrdinalIgnoreCase));

    public string FolderGlyph =>
        IsSeasonFolder ? "\uE8B9" :
        IsSeriesFolder ? "\uE714" : "\uE8B7";

    public Brush FolderBrush =>
        IsSeriesFolder
            ? new SolidColorBrush(Windows.UI.Color.FromArgb(255, 129, 140, 248))
            : new SolidColorBrush(Windows.UI.Color.FromArgb(255, 245, 158, 11));

    public Visibility SeriesBadgeVisibility => IsSeriesFolder ? Visibility.Visible : Visibility.Collapsed;
    public string SeriesBadgeText => IsSeasonFolder ? "SEASON" : (Name.Equals("stream", StringComparison.OrdinalIgnoreCase) ? "STREAM" : "SERIES");

    public string FormattedItemCount
    {
        get
        {
            if (IsSeriesFolder && !IsSeasonFolder)
            {
                return ItemCount == 1 ? "1 season" : (ItemCount > 0 ? $"{ItemCount} seasons" : "Series");
            }
            if (IsSeasonFolder)
            {
                return ItemCount == 1 ? "1 episode" : (ItemCount > 0 ? $"{ItemCount} episodes" : "Season");
            }
            return ItemCount == 1 ? "1 item" : $"{ItemCount} items";
        }
    }

    public string StarGlyph => Starred ? "\uE735" : "\uE734";

    public string FormattedDate
    {
        get
        {
            if (UpdatedAt <= 0) return "";
            try
            {
                var dt = DateTimeOffset.FromUnixTimeMilliseconds(UpdatedAt).ToLocalTime();
                return dt.ToString("g");
            }
            catch
            {
                return "";
            }
        }
    }
}
