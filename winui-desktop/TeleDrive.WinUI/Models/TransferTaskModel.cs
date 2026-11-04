using System;
using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;

namespace TeleDrive_WinUI.Models;

public partial class TransferTaskModel : ObservableObject
{
    private static readonly SolidColorBrush TealBrush = new(ColorHelper.FromArgb(255, 45, 212, 191));
    private static readonly SolidColorBrush PurpleBrush = new(ColorHelper.FromArgb(255, 168, 85, 247));
    private static readonly SolidColorBrush GreenBrush = new(ColorHelper.FromArgb(255, 16, 185, 129));
    private static readonly SolidColorBrush RedBrush = new(ColorHelper.FromArgb(255, 244, 63, 94));
    private static readonly SolidColorBrush AmberBrush = new(ColorHelper.FromArgb(255, 245, 158, 11));

    public string Id { get; set; } = string.Empty;
    public string FileId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public ulong Size { get; set; }
    public string Type { get; set; } = "download"; // "download" | "upload"

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ProgressRatio))]
    [NotifyPropertyChangedFor(nameof(ProgressPercentage))]
    [NotifyPropertyChangedFor(nameof(ProgressSummary))]
    private ulong _transferred;

    public ulong Downloaded
    {
        get => Transferred;
        set => Transferred = value;
    }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsDone))]
    [NotifyPropertyChangedFor(nameof(IsActive))]
    [NotifyPropertyChangedFor(nameof(IsPaused))]
    [NotifyPropertyChangedFor(nameof(IsFailed))]
    [NotifyPropertyChangedFor(nameof(StatusGlyph))]
    [NotifyPropertyChangedFor(nameof(StatusColor))]
    [NotifyPropertyChangedFor(nameof(StatusBrush))]
    [NotifyPropertyChangedFor(nameof(DoneVisibility))]
    [NotifyPropertyChangedFor(nameof(ActiveVisibility))]
    [NotifyPropertyChangedFor(nameof(PausedVisibility))]
    [NotifyPropertyChangedFor(nameof(NotDoneVisibility))]
    [NotifyPropertyChangedFor(nameof(CanPauseVisibility))]
    [NotifyPropertyChangedFor(nameof(CanOpenVisibility))]
    [NotifyPropertyChangedFor(nameof(TypeBadge))]
    [NotifyPropertyChangedFor(nameof(TypeBadgeColor))]
    [NotifyPropertyChangedFor(nameof(TypeBadgeBrush))]
    [NotifyPropertyChangedFor(nameof(ProgressRatio))]
    [NotifyPropertyChangedFor(nameof(ProgressPercentage))]
    [NotifyPropertyChangedFor(nameof(ProgressSummary))]
    [NotifyPropertyChangedFor(nameof(SpeedSummary))]
    private string _status = "queued"; // "downloading" | "finalizing" | "uploading" | "pending" | "paused" | "done" | "failed" | "cancelled"

    partial void OnStatusChanged(string value)
    {
        if (value == "done" || value == "stored" || value == "complete")
        {
            if (Size > 0 && Transferred != Size)
            {
                Transferred = Size;
            }
        }
    }

    public string DestPath { get; set; } = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SpeedSummary))]
    private ulong _speed;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SpeedSummary))]
    private ulong _eta;

    public string? Error { get; set; }
    public long CreatedAt { get; set; }

    public bool IsUpload => string.Equals(Type, "upload", StringComparison.OrdinalIgnoreCase);
    public bool IsDownload => !IsUpload;

    public bool IsDone => Status == "done" || Status == "stored" || Status == "complete";
    public bool IsActive => Status == "downloading" || Status == "finalizing" || Status == "uploading" || Status == "pending" || Status == "active" || Status == "queued";
    public bool IsPaused => Status == "paused";
    public bool IsFailed => Status == "failed" || Status == "error";

    public double ProgressRatio
    {
        get
        {
            if (IsDone || Status == "finalizing") return 1.0;
            if (Size == 0) return 0.0;
            double ratio = Math.Clamp((double)Transferred / Size, 0.0, 1.0);
            // An active transfer should never claim 100% until it is finalized and done
            if (IsActive && ratio >= 0.999) return 0.99;
            return ratio;
        }
    }

    public double ProgressPercentage => ProgressRatio * 100.0;

    public string ProgressSummary
    {
        get
        {
            if (IsDone)
            {
                return IsUpload
                    ? $"{FileModel.FormatBytes(Size)} (Uploaded to cloud)"
                    : $"{FileModel.FormatBytes(Size)} (Saved to disk)";
            }
            if (Status == "finalizing")
                return "100% · Finalizing & verifying on disk...";

            ulong displayTransferred = Transferred;
            if (IsActive && displayTransferred >= Size && Size > 0)
            {
                displayTransferred = (ulong)(Size * 0.99);
            }
            return $"{FileModel.FormatBytes(displayTransferred)} of {FileModel.FormatBytes(Size)} ({ProgressPercentage:F1}%)";
        }
    }

    public string SpeedSummary
    {
        get
        {
            if (IsActive)
            {
                if (Speed > 0)
                    return $"⚡ {FileModel.FormatBytes(Speed)}/s · ETA {Eta}s";
                return IsUpload ? "⬆ Uploading to Telegram..." : "⬇ Downloading from Telegram...";
            }
            if (IsDone)
                return IsUpload ? "✓ Stored in Telegram Cloud" : "✓ Saved to disk";
            if (IsPaused)
                return "⏸ Paused";
            if (IsFailed)
                return $"⚠ {Error ?? "Transfer failed"}";
            return "⏳ Queued...";
        }
    }

    public string TypeBadge => IsUpload ? "UPLOAD" : "DOWNLOAD";
    public string TypeBadgeColor => IsUpload ? "#A855F7" : "#2DD4BF";
    public SolidColorBrush TypeBadgeBrush => IsUpload ? PurpleBrush : TealBrush;

    public string StatusGlyph
    {
        get
        {
            if (IsDone) return "\uE73E";
            if (IsFailed) return "\uEA39";
            if (IsPaused) return "\uE769";
            return IsUpload ? "\uE898" : "\uE896";
        }
    }

    public string StatusColor
    {
        get
        {
            if (IsDone) return "#10B981";
            if (IsFailed) return "#F43F5E";
            if (IsPaused) return "#F59E0B";
            return IsUpload ? "#A855F7" : "#2DD4BF";
        }
    }

    public SolidColorBrush StatusBrush
    {
        get
        {
            if (IsDone) return GreenBrush;
            if (IsFailed) return RedBrush;
            if (IsPaused) return AmberBrush;
            return IsUpload ? PurpleBrush : TealBrush;
        }
    }

    public Visibility DoneVisibility => IsDone ? Visibility.Visible : Visibility.Collapsed;
    public Visibility ActiveVisibility => IsActive ? Visibility.Visible : Visibility.Collapsed;
    public Visibility PausedVisibility => IsPaused ? Visibility.Visible : Visibility.Collapsed;
    public Visibility NotDoneVisibility => IsDone ? Visibility.Collapsed : Visibility.Visible;
    public Visibility CanPauseVisibility => (IsActive && IsDownload) ? Visibility.Visible : Visibility.Collapsed;
    public Visibility CanOpenVisibility => (IsDone && IsDownload) ? Visibility.Visible : Visibility.Collapsed;
}
