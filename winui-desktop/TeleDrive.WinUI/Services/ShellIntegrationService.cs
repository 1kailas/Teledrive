using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Dispatching;
using Microsoft.Win32;

namespace TeleDrive_WinUI.Services;

public static class ShellIntegrationService
{
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    private const int SW_RESTORE = 9;

    public static string MutexName => $"Global\\TeleDrive_WinUI_Mutex_{Environment.UserName}";
    public static string PipeName => $"TeleDrive_Upload_Pipe_{Environment.UserName}";

    private static CancellationTokenSource? _pipeCts;

    public static List<string> ExtractPathsFromArgs(string[]? args)
    {
        var result = new List<string>();
        if (args == null || args.Length <= 1) return result;

        // Skip args[0] (which is the executable path)
        for (int i = 1; i < args.Length; i++)
        {
            var a = args[i]?.Trim();
            if (string.IsNullOrWhiteSpace(a)) continue;

            // Flags
            if (a.Equals("--upload", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("-u", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--register-shell", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--unregister-shell", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--minimized", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            // URI Scheme format: teledrive://upload?path=...
            if (a.StartsWith("teledrive://", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    var uri = new Uri(a);
                    var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
                    var path = query.Get("path");
                    if (!string.IsNullOrWhiteSpace(path) && (File.Exists(path) || Directory.Exists(path)))
                    {
                        result.Add(path);
                    }
                }
                catch { }
                continue;
            }

            // Normal file or directory path
            var clean = a.Trim('"', '\'');
            if (File.Exists(clean) || Directory.Exists(clean))
            {
                result.Add(clean);
            }
        }

        return result;
    }

    public static bool TrySendToExistingInstance(IEnumerable<string> paths)
    {
        var pathList = paths.ToList();
        if (pathList.Count == 0) return false;

        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(1500); // 1.5s timeout
            using var writer = new StreamWriter(client, Encoding.UTF8);
            foreach (var p in pathList)
            {
                writer.WriteLine(p);
            }
            writer.Flush();
            return true;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"TrySendToExistingInstance failed: {ex.Message}");
            return false;
        }
    }

    public static void StartPipeServer(DispatcherQueue dispatcher, Action<List<string>> onPathsReceived)
    {
        _pipeCts?.Cancel();
        _pipeCts = new CancellationTokenSource();
        var token = _pipeCts.Token;

        Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(
                        PipeName,
                        PipeDirection.In,
                        NamedPipeServerStream.MaxAllowedServerInstances,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous);

                    await server.WaitForConnectionAsync(token);

                    using var reader = new StreamReader(server, Encoding.UTF8);
                    var content = await reader.ReadToEndAsync();
                    if (!string.IsNullOrWhiteSpace(content))
                    {
                        var lines = content.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                                           .Select(l => l.Trim())
                                           .Where(l => !string.IsNullOrEmpty(l) && (File.Exists(l) || Directory.Exists(l)))
                                           .ToList();

                        if (lines.Count > 0)
                        {
                            dispatcher.TryEnqueue(() =>
                            {
                                try
                                {
                                    MainWindow.BringToForeground();
                                    onPathsReceived(lines);
                                }
                                catch (Exception ex)
                                {
                                    Debug.WriteLine($"Failed to handle incoming pipe paths: {ex.Message}");
                                }
                            });
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"Pipe server error: {ex.Message}");
                    await Task.Delay(500, token);
                }
            }
        }, token);
    }

    public static void StopPipeServer()
    {
        try
        {
            _pipeCts?.Cancel();
            _pipeCts?.Dispose();
            _pipeCts = null;
        }
        catch { }
    }

    public static void BringExistingWindowToFront()
    {
        try
        {
            var currentPid = Environment.ProcessId;
            var processes = Process.GetProcessesByName("TeleDrive.WinUI");
            foreach (var proc in processes)
            {
                if (proc.Id != currentPid && proc.MainWindowHandle != IntPtr.Zero)
                {
                    ShowWindow(proc.MainWindowHandle, SW_RESTORE);
                    SetForegroundWindow(proc.MainWindowHandle);
                    break;
                }
            }
        }
        catch { }
    }

    public static bool IsShellIntegrationRegistered()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Classes\*\shell\TeleDriveUpload");
            return key != null;
        }
        catch
        {
            return false;
        }
    }

    public static bool RegisterShellIntegration(string? customExePath = null)
    {
        try
        {
            var exePath = customExePath
                ?? Process.GetCurrentProcess().MainModule?.FileName
                ?? Path.Combine(AppContext.BaseDirectory, "TeleDrive.WinUI.exe");

            if (!File.Exists(exePath))
            {
                exePath = Path.Combine(AppContext.BaseDirectory, "TeleDrive.WinUI.exe");
            }

            var quotedExe = $"\"{exePath}\"";

            // 1. File context menu: Right-click any file -> Upload to TeleDrive
            using (var fileKey = Registry.CurrentUser.CreateSubKey(@"Software\Classes\*\shell\TeleDriveUpload"))
            {
                fileKey.SetValue("", "Upload to TeleDrive");
                fileKey.SetValue("Icon", quotedExe);
                using var cmdKey = fileKey.CreateSubKey("command");
                cmdKey.SetValue("", $"{quotedExe} --upload \"%1\"");
            }

            // 2. Folder context menu: Right-click any folder -> Upload to TeleDrive
            using (var dirKey = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Directory\shell\TeleDriveUpload"))
            {
                dirKey.SetValue("", "Upload to TeleDrive");
                dirKey.SetValue("Icon", quotedExe);
                using var cmdKey = dirKey.CreateSubKey("command");
                cmdKey.SetValue("", $"{quotedExe} --upload \"%1\"");
            }

            // 3. Folder background: Right-click background inside a folder -> Upload to TeleDrive
            using (var bgKey = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Directory\Background\shell\TeleDriveUpload"))
            {
                bgKey.SetValue("", "Upload to TeleDrive");
                bgKey.SetValue("Icon", quotedExe);
                using var cmdKey = bgKey.CreateSubKey("command");
                cmdKey.SetValue("", $"{quotedExe} --upload \"%V\"");
            }

            // 4. URI Scheme: teledrive://
            using (var uriKey = Registry.CurrentUser.CreateSubKey(@"Software\Classes\teledrive"))
            {
                uriKey.SetValue("", "URL:TeleDrive Protocol");
                uriKey.SetValue("URL Protocol", "");
                using var iconKey = uriKey.CreateSubKey("DefaultIcon");
                iconKey.SetValue("", $"{quotedExe},0");
                using var openCmd = uriKey.CreateSubKey(@"shell\open\command");
                openCmd.SetValue("", $"{quotedExe} \"%1\"");
            }

            // 5. Send To Shortcut
            try
            {
                var sendToPath = Environment.GetFolderPath(Environment.SpecialFolder.SendTo);
                if (Directory.Exists(sendToPath))
                {
                    var shortcutFile = Path.Combine(sendToPath, "TeleDrive.lnk");
                    CreateWindowsShortcut(shortcutFile, exePath, "Upload to TeleDrive");
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Failed to create SendTo shortcut: {ex.Message}");
            }

            return true;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"RegisterShellIntegration failed: {ex.Message}");
            return false;
        }
    }

    public static bool UnregisterShellIntegration()
    {
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\*\shell\TeleDriveUpload", false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Directory\shell\TeleDriveUpload", false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Directory\Background\shell\TeleDriveUpload", false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\teledrive", false);

            try
            {
                var sendToPath = Environment.GetFolderPath(Environment.SpecialFolder.SendTo);
                var shortcutFile = Path.Combine(sendToPath, "TeleDrive.lnk");
                if (File.Exists(shortcutFile))
                {
                    File.Delete(shortcutFile);
                }
            }
            catch { }

            return true;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"UnregisterShellIntegration failed: {ex.Message}");
            return false;
        }
    }

    private static void CreateWindowsShortcut(string shortcutPath, string targetExePath, string description)
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            dynamic? shell = Activator.CreateInstance(shellType);
            if (shell == null) return;

            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = targetExePath;
            shortcut.WorkingDirectory = Path.GetDirectoryName(targetExePath) ?? "";
            shortcut.Description = description;
            shortcut.IconLocation = $"{targetExePath},0";
            shortcut.Save();
        }
        catch { }
    }
}
