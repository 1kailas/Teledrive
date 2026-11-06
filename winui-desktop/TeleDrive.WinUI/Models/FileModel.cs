using System;
using System.Collections.Generic;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using TeleDrive_WinUI.Services;

namespace TeleDrive_WinUI.Models;

public class MetadataEntry
{
    public string Key { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
}

public partial class FileModel : ObservableObject
{
    public string Id { get; set; } = string.Empty;
    public string? FolderId { get; set; }
    public string? BlobId { get; set; }
    public string Name { get; set; } = string.Empty;
    private string _extension = string.Empty;
    public string Extension
    {
        get
        {
            if (!string.IsNullOrEmpty(_extension)) return _extension;
            if (!string.IsNullOrEmpty(Name))
            {
                var ext = System.IO.Path.GetExtension(Name).TrimStart('.');
                if (!string.IsNullOrEmpty(ext)) return ext;
            }
            return "";
        }
        set => _extension = value;
    }
    public string MimeType { get; set; } = "application/octet-stream";
    public string Category { get; set; } = "document";
    public ulong Size { get; set; }
    public string Status { get; set; } = "ready";

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

    public bool HasThumbnail { get; set; }
    public string? ThumbnailUrl { get; set; }
    public long CreatedAt { get; set; }
    public long UpdatedAt { get; set; }
    public long? TrashedAt { get; set; }

    public int? Width { get; set; }
    public int? Height { get; set; }
    public double? Duration { get; set; }
    public int? PartCount { get; set; }
    public long? TakenAt { get; set; }
    public string? MetadataJson { get; set; }
    public string? Description { get; set; }
    public string? Tags { get; set; }

    public string StarGlyph => Starred ? "\uE735" : "\uE734";
    public Visibility ThumbnailVisibility => Visibility.Visible;
    public Visibility IconVisibility => Visibility.Collapsed;

    public bool IsVideo => Category == "video" || Extension.Equals("mp4", StringComparison.OrdinalIgnoreCase)
        || Extension.Equals("mkv", StringComparison.OrdinalIgnoreCase)
        || Extension.Equals("webm", StringComparison.OrdinalIgnoreCase)
        || Extension.Equals("mov", StringComparison.OrdinalIgnoreCase)
        || Extension.Equals("avi", StringComparison.OrdinalIgnoreCase)
        || Extension.Equals("ts", StringComparison.OrdinalIgnoreCase);

    public Visibility VideoBadgeVisibility => IsVideo ? Visibility.Visible : Visibility.Collapsed;
    public string VideoFormatBadge => !string.IsNullOrEmpty(Extension) ? Extension.ToUpperInvariant() : "VIDEO";

    public string FormattedDuration
    {
        get
        {
            if (Duration.HasValue && Duration.Value > 0)
            {
                var ts = TimeSpan.FromSeconds(Duration.Value);
                if (ts.TotalHours >= 1) return $"{(int)ts.TotalHours}h {ts.Minutes}m";
                return $"{ts.Minutes}m {ts.Seconds}s";
            }
            return "";
        }
    }

    public string FormattedSize => FormatBytes(Size);

    public string EffectiveThumbnailUrl
    {
        get
        {
            string? fallback = (HasThumbnail || Category is "image" or "video")
                ? (ThumbnailUrl ?? $"{TeleDriveService.Instance.BaseUrl}/api/thumbnails/{Id}")
                : null;
            return ThumbnailCacheService.Instance.ResolveThumbnailUrl(Id, Extension, Name, fallback);
        }
    }

    public void NotifyThumbnailChanged()
    {
        OnPropertyChanged(nameof(EffectiveThumbnailUrl));
    }

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

    public string FormattedCreatedDate
    {
        get
        {
            if (CreatedAt <= 0) return "";
            try
            {
                var dt = DateTimeOffset.FromUnixTimeMilliseconds(CreatedAt).ToLocalTime();
                return dt.ToString("g");
            }
            catch
            {
                return "";
            }
        }
    }

    public bool HasDimensions => Width.HasValue && Height.HasValue && Width > 0 && Height > 0;
    public string DimensionsSummary => HasDimensions ? $"{Width} × {Height} px" : "";
    public Visibility DimensionsVisibility => HasDimensions ? Visibility.Visible : Visibility.Collapsed;

    public bool HasDuration => (Duration.HasValue && Duration > 0) || !string.IsNullOrEmpty(FormattedDuration);
    public string DurationSummary
    {
        get
        {
            if (!string.IsNullOrEmpty(FormattedDuration)) return FormattedDuration;
            if (!HasDuration) return "";
            var ts = TimeSpan.FromSeconds(Duration!.Value);
            return ts.TotalHours >= 1 ? ts.ToString(@"hh\:mm\:ss") : ts.ToString(@"mm\:ss");
        }
    }
    public Visibility DurationVisibility => HasDuration ? Visibility.Visible : Visibility.Collapsed;

    public bool HasTakenAt => TakenAt.HasValue && TakenAt > 0;
    public string TakenAtSummary
    {
        get
        {
            if (!HasTakenAt) return "";
            try
            {
                return DateTimeOffset.FromUnixTimeMilliseconds(TakenAt!.Value).ToLocalTime().ToString("g");
            }
            catch { return ""; }
        }
    }
    public Visibility TakenAtVisibility => HasTakenAt ? Visibility.Visible : Visibility.Collapsed;

    public bool HasParts => PartCount.HasValue && PartCount > 0;
    public string PartCountSummary => HasParts ? $"{PartCount} Telegram parts" : "1 Telegram part";

    private List<MetadataEntry>? _parsedMetadata;
    public List<MetadataEntry> MetadataEntries
    {
        get
        {
            if (_parsedMetadata != null) return _parsedMetadata;
            _parsedMetadata = new List<MetadataEntry>();

            if (!string.IsNullOrWhiteSpace(MetadataJson))
            {
                try
                {
                    using var doc = JsonDocument.Parse(MetadataJson);
                    foreach (var prop in doc.RootElement.EnumerateObject())
                    {
                        var key = FormatMetadataKey(prop.Name);
                        var val = prop.Value.ToString();
                        if (!string.IsNullOrWhiteSpace(val))
                        {
                            _parsedMetadata.Add(new MetadataEntry { Key = key, Value = val });
                        }
                    }
                }
                catch { }
            }

            return _parsedMetadata;
        }
    }

    private static string FormatMetadataKey(string key) => key switch
    {
        "make" => "Camera Make",
        "model" => "Camera Model",
        "lens" => "Lens",
        "iso" => "ISO Speed",
        "fnumber" => "Aperture",
        "shutter" => "Shutter Speed",
        "focal" => "Focal Length",
        "pages" => "Page Count",
        "lines" => "Lines of Code",
        "words" => "Word Count",
        "characters" => "Characters",
        "codec" => "Video Codec",
        "bitrate" => "Bitrate",
        _ => char.ToUpper(key[0]) + key[1..]
    };

    public string IconGlyph => Category switch
    {
        "image" => "\uEB9F",    // Photo
        "video" => "\uE714",    // Video
        "audio" => "\uEC4F",    // Audio
        "document" => "\uE8A5", // Document
        "archive" => "\uF012",  // ZipFolder
        "code" => "\uE943",     // Code
        _ => "\uE7C3"           // Page
    };

    public string CategoryGlyph => IconGlyph;

    public string IconColor => Category switch
    {
        "image" => "#38BDF8",   // Light Blue
        "video" => "#A855F7",   // Purple
        "audio" => "#EC4899",   // Pink
        "document" => "#10B981",// Emerald
        "archive" => "#F59E0B", // Amber
        "code" => "#06B6D4",    // Cyan
        _ => "#94A3B8"          // Slate
    };

    public string CategoryColor => IconColor;

    public SolidColorBrush CategoryBrush => Category switch
    {
        "image" => new SolidColorBrush(ColorHelper.FromArgb(255, 56, 189, 248)),
        "video" => new SolidColorBrush(ColorHelper.FromArgb(255, 168, 85, 247)),
        "audio" => new SolidColorBrush(ColorHelper.FromArgb(255, 236, 72, 153)),
        "document" => new SolidColorBrush(ColorHelper.FromArgb(255, 16, 185, 129)),
        "archive" => new SolidColorBrush(ColorHelper.FromArgb(255, 245, 158, 11)),
        "code" => new SolidColorBrush(ColorHelper.FromArgb(255, 6, 182, 212)),
        _ => new SolidColorBrush(ColorHelper.FromArgb(255, 148, 163, 184))
    };

    public static string FormatBytes(ulong bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        string[] suffixes = { "KiB", "MiB", "GiB", "TiB" };
        decimal number = bytes;
        int counter = -1;
        while (number >= 1024 && counter < suffixes.Length - 1)
        {
            number /= 1024;
            counter++;
        }
        return $"{number:n1} {suffixes[counter]}";
    }
}
