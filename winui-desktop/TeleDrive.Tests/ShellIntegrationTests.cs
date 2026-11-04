using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace TeleDrive.Tests;

public static class ShellArgsHelper
{
    public static List<string> ExtractPaths(string[]? args, Func<string, bool>? pathExistsOverride = null)
    {
        var result = new List<string>();
        if (args == null || args.Length <= 1) return result;

        var pathExists = pathExistsOverride ?? ((p) => File.Exists(p) || Directory.Exists(p));

        for (int i = 1; i < args.Length; i++)
        {
            var a = args[i]?.Trim();
            if (string.IsNullOrWhiteSpace(a)) continue;

            if (a.Equals("--upload", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("-u", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--register-shell", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--unregister-shell", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--minimized", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (a.StartsWith("teledrive://", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    var uri = new Uri(a);
                    var query = uri.Query.TrimStart('?');
                    var parts = query.Split('&');
                    foreach (var part in parts)
                    {
                        var kv = part.Split('=');
                        if (kv.Length == 2 && kv[0].Equals("path", StringComparison.OrdinalIgnoreCase))
                        {
                            var decoded = Uri.UnescapeDataString(kv[1]);
                            if (!string.IsNullOrWhiteSpace(decoded) && pathExists(decoded))
                            {
                                result.Add(decoded);
                            }
                        }
                    }
                }
                catch { }
                continue;
            }

            var clean = a.Trim('"', '\'');
            if (pathExists(clean))
            {
                result.Add(clean);
            }
        }

        return result;
    }
}

public class ShellIntegrationTests
{
    [Fact]
    public void ExtractPaths_WithNoExtraArgs_ReturnsEmpty()
    {
        var args = new[] { "TeleDrive.WinUI.exe" };
        var paths = ShellArgsHelper.ExtractPaths(args, _ => true);
        Assert.Empty(paths);
    }

    [Fact]
    public void ExtractPaths_WithUploadFlag_ExtractsTargetFile()
    {
        var args = new[] { "TeleDrive.WinUI.exe", "--upload", @"C:\Users\User\Documents\contract.pdf" };
        var paths = ShellArgsHelper.ExtractPaths(args, _ => true);
        Assert.Single(paths);
        Assert.Equal(@"C:\Users\User\Documents\contract.pdf", paths[0]);
    }

    [Fact]
    public void ExtractPaths_WithQuotedPath_StripsQuotesProperly()
    {
        var args = new[] { "TeleDrive.WinUI.exe", "--upload", "\"C:\\My Media\\video presentation.mp4\"" };
        var paths = ShellArgsHelper.ExtractPaths(args, _ => true);
        Assert.Single(paths);
        Assert.Equal(@"C:\My Media\video presentation.mp4", paths[0]);
    }

    [Fact]
    public void ExtractPaths_FromSendTo_ExtractsMultipleFiles()
    {
        var args = new[]
        {
            "TeleDrive.WinUI.exe",
            @"C:\Files\photo1.jpg",
            @"C:\Files\photo2.jpg",
            @"C:\Files\photo3.png"
        };
        var paths = ShellArgsHelper.ExtractPaths(args, _ => true);
        Assert.Equal(3, paths.Count);
        Assert.Contains(@"C:\Files\photo1.jpg", paths);
        Assert.Contains(@"C:\Files\photo2.jpg", paths);
        Assert.Contains(@"C:\Files\photo3.png", paths);
    }

    [Fact]
    public void ExtractPaths_IgnoresCommandFlags()
    {
        var args = new[]
        {
            "TeleDrive.WinUI.exe",
            "--register-shell",
            "--minimized",
            @"C:\Folder\doc.docx"
        };
        var paths = ShellArgsHelper.ExtractPaths(args, _ => true);
        Assert.Single(paths);
        Assert.Equal(@"C:\Folder\doc.docx", paths[0]);
    }

    [Fact]
    public void ExtractPaths_WithUriScheme_ExtractsQueryParameter()
    {
        var args = new[]
        {
            "TeleDrive.WinUI.exe",
            "teledrive://upload?path=C%3A%5CData%5Cbackup.zip"
        };
        var paths = ShellArgsHelper.ExtractPaths(args, _ => true);
        Assert.Single(paths);
        Assert.Equal(@"C:\Data\backup.zip", paths[0]);
    }
}
