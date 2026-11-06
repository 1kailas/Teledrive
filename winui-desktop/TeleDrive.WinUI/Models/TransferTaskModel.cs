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
    private static readonly SolidColorBrush SlateBrush = new(ColorHelper.FromArgb(255, 148, 163, 184));

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
    [NotifyPropertyChangedFor(nameof(DisplayStatus))]
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
    [NotifyPropertyChangedFor(nameof(CanRetryVisibility))]
    [NotifyPropertyChangedFor(nameof(TypeBadge))]
    [NotifyPropertyChangedFor(nameof(TypeBadgeColor))]
    [NotifyPropertyChangedFor(nameof(TypeBadgeBrush))]
    [NotifyPropertyChangedFor(nameof(ProgressRatio))]
    [NotifyPropertyChangedFor(nameof(ProgressPercentage))]
    [NotifyPropertyChangedFor(nameof(ProgressSummary))]
    [NotifyPropertyChangedFor(nameof(SpeedSummary))]
    [NotifyPropertyChangedFor(nameof(IsProgressIndeterminate))]
    private string _status = "queued"; // "downloading" | "finalizing" | "uploading" | "pending" | "paused" | "done" | "failed" | "cancelled"

    public string DisplayStatus => Status switch
    {
        "queued" => "Queued",
        "connecting" or "preparing" => "Connecting",
        "finalizing" => "Finalizing",
        "downloading" => "Downloading",
        "uploading" => "Uploading",
        "done" or "stored" or "complete" => "Completed",
        "paused" => "Paused",
        "failed" or "error" => "Failed",
        "cancelled" => "Cancelled",
        _ => string.IsNullOrEmpty(Status) ? "Active" : char.ToUpper(Status[0]) + Status.Substring(1)
    };

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

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SpeedSummary))]
    [NotifyPropertyChangedFor(nameof(IsProgressIndeterminate))]
    private string _phase = "";

    public string? Error { get; set; }
    public long CreatedAt { get; set; }

    public bool IsUpload => string.Equals(Type, "upload", StringComparison.OrdinalIgnoreCase);
    public bool IsDownload => !IsUpload;

    public bool IsDone => Status == "done" || Status == "stored" || Status == "complete";
    public bool IsActive => Status == "downloading" || Status == "finalizing" || Status == "uploading" || Status == "pending" || Status == "active" || Status == "queued" || Status == "connecting" || Status == "preparing";
    public bool IsPaused => Status == "paused";
    public bool IsFailed => Status == "failed" || Status == "error";
    public bool IsProgressIndeterminate => IsUpload && IsActive && !IsDone
        && Status != "queued" && Phase != "waiting-bot" && Status != "finalizing" && Phase != "finalizing";

    public double ProgressRatio
    {
        get
        {
            if (Status == "connecting" && Transferred == 0) return 0.0;
            if (IsDone) return 1.0;
            if (Size == 0) return 0.0;
            return Math.Clamp((double)Transferred / Size, 0.0, 1.0);
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
                    ? $"{FileModel.FormatBytes(Size)} (Uploaded to Telegram)"
                    : $"{FileModel.FormatBytes(Size)} (Saved to disk)";
            }

            if (Status == "queued" || (IsUpload && Phase == "waiting-bot"))
                return $"{FileModel.FormatBytes(Transferred)} of {FileModel.FormatBytes(Size)} (Waiting in queue)";

            if (Status == "connecting" || Phase == "connecting")
                return $"{FileModel.FormatBytes(Transferred)} of {FileModel.FormatBytes(Size)} (Connecting to Telegram...)";

            if (Status == "finalizing" || Phase == "finalizing")
                return IsUpload
                    ? $"{FileModel.FormatBytes(Transferred)} confirmed (Saving metadata...)"
                    : $"{FileModel.FormatBytes(Transferred)} of {FileModel.FormatBytes(Size)} (Verifying & saving to disk...)";

            if (IsUpload)
                return $"{FileModel.FormatBytes(Transferred)} of {FileModel.FormatBytes(Size)} confirmed in Telegram";
            return $"{FileModel.FormatBytes(Transferred)} of {FileModel.FormatBytes(Size)} ({ProgressPercentage:F1}%)";
        }
    }

    private static string FormatEta(ulong seconds)
    {
        if (seconds < 60) return $"{seconds}s";
        if (seconds < 3600) return $"{seconds / 60}m {seconds % 60}s";
        if (seconds < 86400) return $"{seconds / 3600}h {seconds % 3600 / 60}m";
        return $"{seconds / 86400}d {seconds % 86400 / 3600}h";
    }

    public string SpeedSummary
    {
        get
        {
            if (IsDone)
                return IsUpload ? "✓ Stored in Telegram" : "✓ Saved to disk";
            if (IsPaused)
                return "⏸ Paused";
            if (IsFailed)
                return $"⚠ {Error ?? "Transfer failed"}";

            if (Status == "queued" || (IsUpload && Phase == "waiting-bot"))
                return "⏳ Waiting in queue...";
            if (IsUpload && Status == "preparing")
                return "Preparing file for Telegram...";
            if (IsUpload && Phase == "sending")
                return "Sending to Telegram; awaiting confirmation...";
            if (Status == "connecting" || Phase == "connecting" || Status == "preparing")
                return "⚡ Connecting to Telegram...";
            if (Status == "finalizing" || Phase == "finalizing")
                return IsUpload ? "⚡ Finalizing in Telegram..." : "⚡ Verifying on disk...";

            if (Speed > 0)
            {
                return Eta > 0
                    ? $"⚡ {FileModel.FormatBytes(Speed)}/s · {FormatEta(Eta)} left"
                    : $"⚡ {FileModel.FormatBytes(Speed)}/s";
            }

            return IsUpload ? "Sending to Telegram..." : "⬇ Downloading...";
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
            if (Status == "queued") return "\uE823";
            if (Status == "connecting" || Phase == "connecting" || Status == "finalizing" || Phase == "finalizing")
                return "\uE768";
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
            if (Status == "queued") return "#94A3B8";
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
            if (Status == "queued") return SlateBrush;
            return IsUpload ? PurpleBrush : TealBrush;
        }
    }

    public Visibility DoneVisibility => IsDone ? Visibility.Visible : Visibility.Collapsed;
    public Visibility ActiveVisibility => IsActive ? Visibility.Visible : Visibility.Collapsed;
    public Visibility PausedVisibility => IsPaused ? Visibility.Visible : Visibility.Collapsed;
    public Visibility NotDoneVisibility => IsDone ? Visibility.Collapsed : Visibility.Visible;
    public Visibility CanPauseVisibility => (IsActive && IsDownload) ? Visibility.Visible : Visibility.Collapsed;
    public Visibility CanOpenVisibility => (IsDone && IsDownload) ? Visibility.Visible : Visibility.Collapsed;
    public Visibility CanRetryVisibility => (IsFailed && IsUpload) ? Visibility.Visible : Visibility.Collapsed;
}
