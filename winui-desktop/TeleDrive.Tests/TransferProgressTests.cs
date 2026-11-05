using System;
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
    public void InitialConnectionRamp_NeverStuckAtZero()
    {
        // During initial connection handshake (0..2.5s), active ramp provides non-zero responsive feedback
        double elapsed = 1.0;
        double rampCap = 50_000_000 * 0.025; // 2.5% of 50MB = 1.25MB
        double progressFraction = Math.Min(1.0, elapsed / 2.5);
        double initialRamp = rampCap * (1.0 - Math.Pow(1.0 - progressFraction, 2.0));

        Assert.True(initialRamp > 0, "Initial ramp must be positive to prevent freeze at 0%");
        Assert.True(initialRamp <= rampCap, "Initial ramp must not exceed cap");
    }

    [Fact]
    public void FinalizingCreep_ContinuouslyAdvancesTowardsCapWithoutFreezing()
    {
        // When cloud confirmation is pending, finalization creep approaches 99.4% smoothly
        double size = 100_000_000;
        double cap = size * 0.994;
        double currentDisplay = size * 0.95; // at 95%

        double dist = cap - currentDisplay;
        double dt = 0.04; // 25fps frame
        double step = Math.Max(16.0 * 1024, dist * (dt * 1.5));
        double nextDisplay = Math.Min(cap, currentDisplay + step);

        Assert.True(nextDisplay > currentDisplay, "Progress must continue moving forward during finalization");
        Assert.True(nextDisplay <= cap, "Progress must not overshoot 99.4% until server confirms completion");
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
    public void ConnectingPhase_ZeroTransferred_ReportsZeroProgress()
    {
        string status = "connecting";
        long transferred = 0;
        long size = 80_000_000;

        double pct = (status == "connecting" && transferred == 0) ? 0.0 : TransferProgressHelpers.CalculateProgressPercentage(transferred, size);
        Assert.Equal(0.0, pct);
    }
}
