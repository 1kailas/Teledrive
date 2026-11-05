using System;
using System.IO;
using System.Text.Json;

namespace TeleDrive_WinUI.Services;

public class AppConfig
{
    public int CardSizeTier { get; set; } = 3; // 0=Tiny, 1=Mini, 2=Compact, 3=Standard, 4=Large
    public double TargetTileWidth { get; set; } = 205;
    public int ViewMode { get; set; } = 0; // 0=Grid, 1=List
    public string Theme { get; set; } = "Default"; // "Default", "Dark", "Light"
    public bool IsPaneOpen { get; set; } = true;
    public bool IsDetailsPaneVisible { get; set; } = false;
    public int WindowX { get; set; } = -1;
    public int WindowY { get; set; } = -1;
    public int WindowWidth { get; set; } = 1280;
    public int WindowHeight { get; set; } = 820;
    public bool IsMaximized { get; set; } = false;
}

public static class AppConfigService
{
    private static readonly string ConfigDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TeleDrive");
    private static readonly string ConfigPath = Path.Combine(ConfigDir, "config.json");

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    private static AppConfig? _current;
    private static readonly object _lock = new();

    public static AppConfig Current
    {
        get
        {
            if (_current == null)
            {
                lock (_lock)
                {
                    _current ??= Load();
                }
            }
            return _current;
        }
    }

    public static AppConfig Load()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath);
                var config = JsonSerializer.Deserialize<AppConfig>(json, JsonOptions);
                if (config != null)
                {
                    return config;
                }
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[AppConfigService] Failed to load config: {ex.Message}");
        }

        var def = new AppConfig();
        try
        {
            if (!Directory.Exists(ConfigDir)) Directory.CreateDirectory(ConfigDir);
            var json = JsonSerializer.Serialize(def, JsonOptions);
            File.WriteAllText(ConfigPath, json);
        }
        catch { }
        return def;
    }

    public static void Save()
    {
        try
        {
            lock (_lock)
            {
                if (!Directory.Exists(ConfigDir))
                {
                    Directory.CreateDirectory(ConfigDir);
                }

                var config = Current;
                var json = JsonSerializer.Serialize(config, JsonOptions);

                var tempPath = ConfigPath + ".tmp";
                File.WriteAllText(tempPath, json);
                File.Move(tempPath, ConfigPath, true);
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[AppConfigService] Failed to save config: {ex.Message}");
        }
    }
}
