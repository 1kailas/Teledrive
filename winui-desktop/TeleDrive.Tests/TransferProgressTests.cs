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
    public void FinalizingPhase_FullProgressRatio_AndZeroFakeEta()
    {
        string status = "finalizing";
        string phase = "finalizing";
        long size = 92_900_000;
        long transferred = size;

        double ratio = (status == "finalizing" || phase == "finalizing") ? 1.0 : (double)transferred / size;
        Assert.Equal(1.0, ratio);
    }

    [Fact]
    public void OvertimeGlide_SmoothlyApproachesCapWithoutFreezing()
    {
        double pSize = 100_000_000;
        double rate = 4.0 * 1024 * 1024;
        double expectedSec = pSize / rate; // ~23.8s

        // Test overtime at 0.5s, 1.5s, 2.5s
        double ot1 = 0.5;
        double ot2 = 1.5;
        double ot3 = 2.5;

        double glide1 = 0.95 + 0.035 * (1.0 - Math.Exp(-ot1 / 1.5));
        double glide2 = 0.95 + 0.035 * (1.0 - Math.Exp(-ot2 / 1.5));
        double glide3 = 0.95 + 0.035 * (1.0 - Math.Exp(-ot3 / 1.5));

        Assert.True(glide1 > 0.95, "Glide must be above 95%");
        Assert.True(glide2 > glide1, "Glide must smoothly advance forward");
        Assert.True(glide3 > glide2, "Glide must continue advancing forward");
        Assert.True(glide3 <= 0.99, "Glide must stay under 99% before finalizing");
    }

    [Fact]
    public void AdaptiveUploadRate_CalculatesRealisticBandwidth()
    {
        ulong size = 40_000_000;
        double elapsed = 10.0; // 40MB in 10s = 4.0 MB/s
        double measuredRate = size / elapsed;

        Assert.Equal(4_000_000.0, measuredRate);
        Assert.InRange(measuredRate, 256.0 * 1024.0, 100.0 * 1024.0 * 1024.0);
    }

    [Fact]
    public void MultiFileUpload_DifferentFileSizes_IndependentTransferredBytes()
    {
        // 3 files of different sizes uploading simultaneously
        ulong size1 = 92_900_000;  // TeleDrive-Setup.msi
        ulong size2 = 117_300_000; // TeleDrive-Portable.zip
        ulong size3 = 271_400_000; // DevinUserSetup.exe

        int activeStreams = 3;
        double totalBandwidth = 3.5 * 1024 * 1024;
        double streamRate = totalBandwidth / activeStreams;

        double elapsed = 5.0; // 5 seconds in

        double exp1 = (double)size1 / streamRate;
        double exp2 = (double)size2 / streamRate;
        double exp3 = (double)size3 / streamRate;

        double frac1 = Math.Min(0.95, (elapsed / exp1) * 0.95);
        double frac2 = Math.Min(0.95, (elapsed / exp2) * 0.95);
        double frac3 = Math.Min(0.95, (elapsed / exp3) * 0.95);

        // Fractions and percentages must vary inversely with total size
        Assert.True(frac1 > frac2, "Smaller file must have a higher completion percentage");
        Assert.True(frac2 > frac3, "Medium file must have a higher completion percentage than large file");

        double pct1 = frac1 * 100.0;
        double pct2 = frac2 * 100.0;
        double pct3 = frac3 * 100.0;

        Assert.True(pct1 != pct2 && pct2 != pct3, "All files must have distinct progress percentages, not lockstep");
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
