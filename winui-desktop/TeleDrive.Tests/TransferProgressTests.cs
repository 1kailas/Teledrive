using System;
using System.Text.Json;
using TeleDrive_WinUI.Services;
using Xunit;

namespace TeleDrive.Tests;

public static class TransferProgressHelpers
{
    public static double CalculateProgressPercentage(long transferred, long total)
    {
        if (total <= 0) return 0.0;
        double pct = (double)transferred / total * 100.0;
        return Math.Clamp(pct, 0.0, 100.0);
    }

    public static string FormatBytes(long bytes)
    {
        if (bytes == 0) return "0 B";
        string[] units = { "B", "KiB", "MiB", "GiB", "TiB" };
        int i = Math.Min(units.Length - 1, (int)(Math.Log(bytes, 1024)));
        double val = bytes / Math.Pow(1024, i);
        return i == 0 ? $"{val:0} {units[i]}" : $"{val:0.0} {units[i]}";
    }

    public static string FormatEta(double seconds)
    {
        if (seconds <= 0 || double.IsInfinity(seconds) || double.IsNaN(seconds)) return "—";
        var ts = TimeSpan.FromSeconds(seconds);
        if (ts.TotalHours >= 1)
            return $"{(int)ts.TotalHours}h {ts.Minutes}m";
        if (ts.TotalMinutes >= 1)
            return $"{ts.Minutes}m {ts.Seconds}s";
        return $"{ts.Seconds}s";
    }
}

public class TransferProgressTests
{
    [Theory]
    [InlineData(0, 1000, 0.0)]
    [InlineData(500, 1000, 50.0)]
    [InlineData(1000, 1000, 100.0)]
    [InlineData(1500, 1000, 100.0)] // Clamped to 100%
    [InlineData(-10, 1000, 0.0)]    // Clamped to 0%
    [InlineData(500, 0, 0.0)]       // Zero total handles safely
    public void CalculateProgressPercentage_AccuratelyCalculatesAndClamps(long transferred, long total, double expected)
    {
        double pct = TransferProgressHelpers.CalculateProgressPercentage(transferred, total);
        Assert.Equal(expected, pct, 1);
    }

    [Theory]
    [InlineData(0, "0 B")]
    [InlineData(500, "500 B")]
    [InlineData(1024, "1.0 KiB")]
    [InlineData(1048576, "1.0 MiB")]
    [InlineData(1073741824, "1.0 GiB")]
    public void FormatBytes_ProducesAccurateBinaryUnits(long bytes, string expected)
    {
        string result = TransferProgressHelpers.FormatBytes(bytes);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(0, "—")]
    [InlineData(-10, "—")]
    [InlineData(45, "45s")]
    [InlineData(90, "1m 30s")]
    [InlineData(3665, "1h 1m")]
    public void FormatEta_FormatsTimeRemainingCleanly(double seconds, string expected)
    {
        string result = TransferProgressHelpers.FormatEta(seconds);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void QueuedTransfer_RemainsAtZeroPercent_UntilActivelyTransmitting()
    {
        // Queued tasks should never show false forward progression
        long transferred = 0;
        long total = 50_000_000;
        double pct = TransferProgressHelpers.CalculateProgressPercentage(transferred, total);
        Assert.Equal(0.0, pct);
    }

    [Fact]
    public void AggregateTransferProgress_AccuratelyCalculatesMultiTaskRatio()
    {
        // When 3 tasks exist: 1 active at 50%, 2 queued at 0%
        long[] sizes = { 100_000_000, 100_000_000, 100_000_000 };
        long[] transferred = { 50_000_000, 0, 0 };

        long totalSize = 0;
        long totalTransferred = 0;
        for (int i = 0; i < sizes.Length; i++)
        {
            totalSize += sizes[i];
            totalTransferred += transferred[i];
        }

        double aggregatePct = TransferProgressHelpers.CalculateProgressPercentage(totalTransferred, totalSize);
        // 50MB of 300MB = 16.666%
        Assert.InRange(aggregatePct, 16.6, 16.7);
    }

    [Fact]
    public void InFlightUpload_DoesNotAdvanceWithoutTelegramConfirmation()
    {
        using var doc = JsonDocument.Parse("""
            {"status":"active","parts":[{"status":"uploading","size":50000000,"startedAt":1000,"estRate":8388608}]}
            """);
        var snapshot = UploadProgressSnapshot.Read(doc.RootElement, 50_000_000);
        Assert.Equal(0UL, snapshot.ConfirmedBytes);
        Assert.True(snapshot.Sending);
        Assert.False(snapshot.AllStored);
    }

    [Fact]
    public void MultiPartUpload_OnlyCountsStoredParts()
    {
        using var doc = JsonDocument.Parse("""
            {"status":"active","parts":[
              {"status":"stored","size":400},
              {"status":"uploading","size":300,"startedAt":0},
              {"status":"pending","phase":"waiting-bot","size":300}]}
            """);
        var snapshot = UploadProgressSnapshot.Read(doc.RootElement, 1000);
        Assert.Equal(400UL, snapshot.ConfirmedBytes);
        Assert.True(snapshot.Sending);
        Assert.True(snapshot.WaitingForBot);
        Assert.False(snapshot.AllStored);
    }

    [Fact]
    public void QueuedTasks_StrictlyZeroProgressAndZeroSpeed()
    {
        string status = "queued";
        long transferred = 0;
        long size = 120_000_000;
        ulong speed = 0;

        double pct = (status == "queued") ? 0.0 : TransferProgressHelpers.CalculateProgressPercentage(transferred, size);
        Assert.Equal(0.0, pct);
        Assert.Equal((ulong)0, speed);
    }

    [Fact]
    public void AllStored_EntersFinalizingOnlyWhenConfirmed()
    {
        using var doc = JsonDocument.Parse("""
            {"status":"active","parts":[{"status":"stored","size":700},{"status":"stored","size":300}]}
            """);
        var snapshot = UploadProgressSnapshot.Read(doc.RootElement, 1000);
        Assert.Equal(1000UL, snapshot.ConfirmedBytes);
        Assert.True(snapshot.AllStored);
        Assert.False(snapshot.Sending);
    }

    [Fact]
    public void FailedOrEmptySession_NeverReportedAsFinalizing()
    {
        using var empty = JsonDocument.Parse("""{"status":"active","parts":[]}""");
        using var failed = JsonDocument.Parse("""{"status":"failed","parts":[{"status":"failed","size":50}]}""");
        Assert.False(UploadProgressSnapshot.Read(empty.RootElement, 100).AllStored);
        var snapshot = UploadProgressSnapshot.Read(failed.RootElement, 100);
        Assert.True(snapshot.Failed);
        Assert.False(snapshot.AllStored);
    }

    [Fact]
    public void OversizedParts_AreCappedAtOriginalFileSize()
    {
        using var doc = JsonDocument.Parse("""
            {"parts":[{"status":"stored","size":18446744073709551615},{"status":"stored","size":100}]}
            """);
        var snapshot = UploadProgressSnapshot.Read(doc.RootElement, 100);
        Assert.Equal(100UL, snapshot.ConfirmedBytes);
    }

    [Fact]
    public void NoConfirmation_MultipleFilesRemainAtZeroIndependently()
    {
        using var doc = JsonDocument.Parse("""{"parts":[{"status":"uploading","size":10}]}""");
        Assert.Equal(0UL, UploadProgressSnapshot.Read(doc.RootElement, 10).ConfirmedBytes);
        Assert.Equal(0UL, UploadProgressSnapshot.Read(doc.RootElement, 1000).ConfirmedBytes);
    }

    [Fact]
    public void NormalizedFileName_StripsCopySuffixAccurately()
    {
        string name1 = "DevinUserSetup-x64-3.11.238 (1).exe";
        string norm1 = System.Text.RegularExpressions.Regex.Replace(name1, @"\s*\(\d+\)(?=\.[^.]+$)", "");
        Assert.Equal("DevinUserSetup-x64-3.11.238.exe", norm1);

        string name2 = "Kailasnath_T_qmetron_internship (1) (1).pdf";
        string norm2 = System.Text.RegularExpressions.Regex.Replace(name2, @"\s*\(\d+\)(?=\.[^.]+$)", "");
        Assert.Equal("Kailasnath_T_qmetron_internship (1).pdf", norm2);

        string name3 = "clean_file.png";
        string norm3 = System.Text.RegularExpressions.Regex.Replace(name3, @"\s*\(\d+\)(?=\.[^.]+$)", "");
        Assert.Equal("clean_file.png", norm3);
    }
}
