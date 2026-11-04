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
}
