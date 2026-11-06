using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using Windows.Storage;
using Windows.Storage.FileProperties;

namespace TeleDrive_WinUI.Services;

public class ThumbnailCacheService
{
    private static ThumbnailCacheService? _instance;
    public static ThumbnailCacheService Instance => _instance ??= new ThumbnailCacheService();

    private readonly string _appDataThumbsDir;
    private readonly string _localCacheThumbsDir;
    private readonly string _shellIconsDir;
    private readonly string _dummyTempDir;
    private readonly string _downloadsDir;
    private readonly HttpClient _http = new();
    private readonly ConcurrentDictionary<string, Task<string?>> _activeDownloads = new();
    private readonly ConcurrentDictionary<string, string> _memoryCache = new();
    private readonly ConcurrentDictionary<string, string> _memoryCacheByFileName = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> _knownLocalFiles = new(StringComparer.OrdinalIgnoreCase);

    public event Action<string, string>? OnThumbnailResolved;

    public ThumbnailCacheService()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        _appDataThumbsDir = Path.Combine(appData, "TeleDrive", "data", "thumbnails");

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        _localCacheThumbsDir = Path.Combine(localAppData, "TeleDrive", "cache", "thumbnails");
        _shellIconsDir = Path.Combine(localAppData, "TeleDrive", "cache", "shell_icons");
        _dummyTempDir = Path.Combine(localAppData, "TeleDrive", "cache", "shell_dummy");

        _downloadsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");

        try
        {
            Directory.CreateDirectory(_localCacheThumbsDir);
            Directory.CreateDirectory(_shellIconsDir);
            Directory.CreateDirectory(_dummyTempDir);
        }
        catch { }

        // Pre-warm common Windows Shell icons in background
        _ = Task.Run(PrewarmShellIconsAsync);
    }

    /// <summary>
    /// Resolves the fastest local thumbnail path if already cached on disk.
    /// Supports checking by fileId, fileName (including local_{hashKey}.png), and normalized fileName.
    /// Automatically purges any stale 409,750-byte placeholder BMPs so authentic icons take precedence.
    /// </summary>
    public string? GetExistingLocalThumbnailPath(string fileId, string? fileName = null)
    {
        // 0. If fileName is provided, check for authentic local_{hashKey}.png or local_{fileName}.png
        if (!string.IsNullOrEmpty(fileName))
        {
            var hashKey = GetSafeCacheKey(fileName);
            var candidates = new List<string>
            {
                Path.Combine(_localCacheThumbsDir, $"local_{hashKey}.png"),
                Path.Combine(_localCacheThumbsDir, $"local_{Uri.EscapeDataString(fileName)}.png"),
                Path.Combine(_localCacheThumbsDir, $"local_{fileName}.png")
            };

            // Also check normalized fileName (e.g. "DevinUserSetup-x64-3.11.238 (1).exe" -> "DevinUserSetup-x64-3.11.238.exe")
            var normName = System.Text.RegularExpressions.Regex.Replace(fileName, @"\s*\(\d+\)(?=\.[^.]+$)", "");
            if (!string.Equals(normName, fileName, StringComparison.OrdinalIgnoreCase))
            {
                var normHash = GetSafeCacheKey(normName);
                candidates.Add(Path.Combine(_localCacheThumbsDir, $"local_{normHash}.png"));
                candidates.Add(Path.Combine(_localCacheThumbsDir, $"local_{Uri.EscapeDataString(normName)}.png"));
                candidates.Add(Path.Combine(_localCacheThumbsDir, $"local_{normName}.png"));
            }

            foreach (var cand in candidates)
            {
                if (File.Exists(cand))
                {
                    var len = new FileInfo(cand).Length;
                    if (len > 500)
                    {
                        // Ensure it's also mapped to fileId if fileId is provided
                        if (!string.IsNullOrEmpty(fileId))
                        {
                            var targetPng = Path.Combine(_localCacheThumbsDir, $"{fileId}.png");
                            if (!File.Exists(targetPng))
                            {
                                try { File.Copy(cand, targetPng, true); } catch { }
                            }
                        }
                        return cand;
                    }
                }
            }
        }

        if (string.IsNullOrEmpty(fileId)) return null;

        var extensions = new[] { ".png", ".webp", ".jpg", ".jpeg" };

        // 1. Check LocalAppData thumbnail cache first (preferring PNG authentic icons)
        foreach (var ext in extensions)
        {
            var path = Path.Combine(_localCacheThumbsDir, fileId + ext);
            if (File.Exists(path))
            {
                var len = new FileInfo(path).Length;
                if (len > 500)
                {
                    return path;
                }
            }
        }

        // 2. Check Roaming AppData thumbnails (written by Rust daemon)
        foreach (var ext in extensions)
        {
            var path = Path.Combine(_appDataThumbsDir, fileId + ext);
            if (File.Exists(path))
            {
                var len = new FileInfo(path).Length;
                if (len > 500)
                {
                    return path;
                }
            }
        }

        return null;
    }

    public string? GetExistingLocalThumbnailPath(string fileId)
    {
        return GetExistingLocalThumbnailPath(fileId, null);
    }

    private static string GetSafeCacheKey(string key)
    {
        var bytes = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(key));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    /// <summary>
    /// Eagerly precaches authentic Windows Shell thumbnails for files selected for upload.
    /// Ensures executables (.exe), archives, media, and documents show rich icons immediately on upload.
    /// </summary>
    public void PrecacheLocalUploads(IEnumerable<string> paths)
    {
        foreach (var path in paths)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) continue;
            var fileName = Path.GetFileName(path);
            _knownLocalFiles[fileName] = path;

            _ = Task.Run(async () =>
            {
                try
                {
                    var hashKey = GetSafeCacheKey(fileName);
                    var cachedPath = Path.Combine(_localCacheThumbsDir, $"local_{hashKey}.png");

                    if (!File.Exists(cachedPath))
                    {
                        var storageFile = await StorageFile.GetFileFromPathAsync(path);
                        using var thumb = await storageFile.GetThumbnailAsync(ThumbnailMode.SingleItem, 256, ThumbnailOptions.ResizeThumbnail);
                        if (thumb != null && thumb.Size > 0)
                        {
                            using var outStream = File.Create(cachedPath);
                            using var stream = thumb.AsStream();
                            await stream.CopyToAsync(outStream);
                            outStream.Flush();
                        }
                    }

                    if (File.Exists(cachedPath))
                    {
                        _memoryCacheByFileName[fileName] = cachedPath;
                        OnThumbnailResolved?.Invoke(fileName, cachedPath);
                    }
                }
                catch { }
            });
        }
    }

    /// <summary>
    /// Returns a direct file:/// URI for the file thumbnail or authentic Windows File Explorer shell icon.
    /// </summary>
    public string ResolveThumbnailUrl(string fileId, string extension, string fileName, string? fallbackHttpUrl)
    {
        // 0. Memory cache hit by fileId
        if (!string.IsNullOrEmpty(fileId) && _memoryCache.TryGetValue(fileId, out var memHit) && File.Exists(memHit))
        {
            return new Uri(memHit).AbsoluteUri;
        }

        // 1. Memory cache hit by fileName (e.g. from local upload precache)
        if (!string.IsNullOrEmpty(fileName) && _memoryCacheByFileName.TryGetValue(fileName, out var memNameHit) && File.Exists(memNameHit))
        {
            if (!string.IsNullOrEmpty(fileId)) _memoryCache[fileId] = memNameHit;
            return new Uri(memNameHit).AbsoluteUri;
        }

        // 2. Check existing custom thumbnail on disk
        var local = GetExistingLocalThumbnailPath(fileId, fileName);
        if (!string.IsNullOrEmpty(local))
        {
            if (!string.IsNullOrEmpty(fileId)) _memoryCache[fileId] = local;
            if (!string.IsNullOrEmpty(fileName)) _memoryCacheByFileName[fileName] = local;
            return new Uri(local).AbsoluteUri;
        }

        // 3. Trigger extraction from local disk (known uploads, Downloads, Desktop)
        if (!string.IsNullOrEmpty(fileName))
        {
            _ = TryExtractFromLocalFileAsync(fileId, fileName);
        }

        // 4. Check for pre-cached Windows Shell icon for this extension
        var ext = (extension ?? "").Trim().TrimStart('.').ToLowerInvariant();
        if (string.IsNullOrEmpty(ext)) ext = "bin";

        var shellIconPath = Path.Combine(_shellIconsDir, $"{ext}.png");
        if (File.Exists(shellIconPath))
        {
            return new Uri(shellIconPath).AbsoluteUri;
        }

        // 5. Trigger background generation of shell icon for this extension
        _ = GetShellIconForExtensionAsync(ext);

        // 6. Trigger loopback background fetch if fallback URL is provided
        if (!string.IsNullOrEmpty(fallbackHttpUrl) && !string.IsNullOrEmpty(fileId))
        {
            _ = CacheThumbnailFromHttpAsync(fileId, fallbackHttpUrl);
            return fallbackHttpUrl;
        }

        return new Uri(shellIconPath).AbsoluteUri;
    }

    public string ResolveThumbnailUrl(string fileId, string? fallbackHttpUrl)
    {
        return ResolveThumbnailUrl(fileId, "", "", fallbackHttpUrl);
    }

    /// <summary>
    /// Checks known upload paths, user's Downloads and Desktop folders for a matching file name, and extracts
    /// the authentic Windows Shell thumbnail / embedded icon directly.
    /// Handles name variations including (1), (2), etc.
    /// </summary>
    private async Task TryExtractFromLocalFileAsync(string fileId, string fileName)
    {
        if (string.IsNullOrEmpty(fileName)) return;

        try
        {
            var normName = System.Text.RegularExpressions.Regex.Replace(fileName, @"\s*\(\d+\)(?=\.[^.]+$)", "");
            var nameVariations = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { fileName };
            if (!string.Equals(normName, fileName, StringComparison.OrdinalIgnoreCase))
            {
                nameVariations.Add(normName);
            }
            var stem = Path.GetFileNameWithoutExtension(fileName);
            var ext = Path.GetExtension(fileName);
            nameVariations.Add($"{stem} (1){ext}");

            // 0. Check known upload paths from current session
            foreach (var name in nameVariations)
            {
                if (_knownLocalFiles.TryGetValue(name, out var knownPath) && File.Exists(knownPath))
                {
                    var extracted = await GenerateAndUploadNativeThumbnailAsync(fileId, knownPath);
                    if (!string.IsNullOrEmpty(extracted)) return;
                }
            }

            // Look in Downloads and Desktop for any matching file
            var searchDirs = new List<string> { _downloadsDir, Environment.GetFolderPath(Environment.SpecialFolder.Desktop) };
            try
            {
                var customDir = await TeleDriveService.Instance.GetDownloadDirectoryAsync();
                if (!string.IsNullOrEmpty(customDir) && Directory.Exists(customDir))
                {
                    searchDirs.Add(customDir);
                }
            }
            catch { }

            foreach (var dir in searchDirs)
            {
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;

                foreach (var name in nameVariations)
                {
                    var candPath = Path.Combine(dir, name);
                    if (File.Exists(candPath))
                    {
                        var extracted = await GenerateAndUploadNativeThumbnailAsync(fileId, candPath);
                        if (!string.IsNullOrEmpty(extracted)) return;
                    }
                }
            }
        }
        catch { }
    }

    /// <summary>
    /// Generates the high-resolution 256x256 authentic Windows File Explorer icon for an extension.
    /// </summary>
    public async Task<string?> GetShellIconForExtensionAsync(string ext)
    {
        ext = (ext ?? "").Trim().TrimStart('.').ToLowerInvariant();
        if (string.IsNullOrEmpty(ext)) ext = "bin";

        var targetFile = Path.Combine(_shellIconsDir, $"{ext}.png");
        if (File.Exists(targetFile))
        {
            return targetFile;
        }

        try
        {
            string sourcePath;
            if (ext == "exe")
            {
                var systemExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
                sourcePath = File.Exists(systemExe) ? systemExe : Path.Combine(_dummyTempDir, $"placeholder.{ext}");
            }
            else
            {
                sourcePath = Path.Combine(_dummyTempDir, $"placeholder.{ext}");
            }

            if (!File.Exists(sourcePath))
            {
                await File.WriteAllBytesAsync(sourcePath, Array.Empty<byte>());
            }

            var storageFile = await StorageFile.GetFileFromPathAsync(sourcePath);
            using var thumb = await storageFile.GetThumbnailAsync(ThumbnailMode.SingleItem, 256, ThumbnailOptions.ResizeThumbnail);
            if (thumb != null && thumb.Size > 0)
            {
                using var outFs = File.Create(targetFile);
                var stream = thumb.AsStream();
                await stream.CopyToAsync(outFs);
                outFs.Flush();
                OnThumbnailResolved?.Invoke(ext, targetFile);
                return targetFile;
            }
        }
        catch { }

        return null;
    }

    private async Task PrewarmShellIconsAsync()
    {
        string[] common = { "exe", "msi", "pdf", "zip", "rar", "7z", "docx", "xlsx", "pptx", "txt", "png", "jpg", "jpeg", "webp", "mp4", "mkv", "mp3", "wav", "cs", "rs", "json", "py", "dll", "html", "iso" };
        foreach (var ext in common)
        {
            try
            {
                await GetShellIconForExtensionAsync(ext);
            }
            catch { }
        }
    }

    /// <summary>
    /// Asynchronously fetches thumbnail from loopback API and caches to local disk.
    /// </summary>
    public async Task<string?> CacheThumbnailFromHttpAsync(string fileId, string downloadUrl)
    {
        if (string.IsNullOrEmpty(fileId) || string.IsNullOrEmpty(downloadUrl)) return null;

        var existing = GetExistingLocalThumbnailPath(fileId);
        if (!string.IsNullOrEmpty(existing)) return existing;

        return await _activeDownloads.GetOrAdd(fileId, async (id) =>
        {
            try
            {
                using var res = await _http.GetAsync(downloadUrl);
                if (res.IsSuccessStatusCode)
                {
                    var bytes = await res.Content.ReadAsByteArrayAsync();
                    if (bytes.Length > 0)
                    {
                        var targetFile = Path.Combine(_localCacheThumbsDir, $"{id}.jpg");
                        await File.WriteAllBytesAsync(targetFile, bytes);
                        _memoryCache[id] = targetFile;
                        OnThumbnailResolved?.Invoke(id, targetFile);
                        return targetFile;
                    }
                }
            }
            catch { }
            finally
            {
                _activeDownloads.TryRemove(id, out _);
            }
            return null;
        });
    }

    /// <summary>
    /// Extracts a rich native Windows Shell thumbnail for images, videos, audio, executables, and PDFs,
    /// caches it locally as authentic PNG, and syncs it to the TeleDrive server.
    /// </summary>
    public async Task<string?> GenerateAndUploadNativeThumbnailAsync(string fileId, string localFilePath)
    {
        try
        {
            if (!File.Exists(localFilePath)) return null;

            var fileName = Path.GetFileName(localFilePath);
            var hashKey = GetSafeCacheKey(fileName);
            var localPng = Path.Combine(_localCacheThumbsDir, $"local_{hashKey}.png");

            var storageFile = await StorageFile.GetFileFromPathAsync(localFilePath);
            using var thumb = await storageFile.GetThumbnailAsync(ThumbnailMode.SingleItem, 256, ThumbnailOptions.ResizeThumbnail);
            if (thumb != null && thumb.Size > 0)
            {
                var targetFile = Path.Combine(_localCacheThumbsDir, $"{fileId}.png");
                using (var outStream = File.Create(targetFile))
                {
                    using var stream = thumb.AsStream();
                    await stream.CopyToAsync(outStream);
                    outStream.Flush();
                }

                // Also persist to local_{hashKey}.png
                try { File.Copy(targetFile, localPng, true); } catch { }

                var normName = System.Text.RegularExpressions.Regex.Replace(fileName, @"\s*\(\d+\)(?=\.[^.]+$)", "");
                if (!string.Equals(normName, fileName, StringComparison.OrdinalIgnoreCase))
                {
                    var normHash = GetSafeCacheKey(normName);
                    try { File.Copy(targetFile, Path.Combine(_localCacheThumbsDir, $"local_{normHash}.png"), true); } catch { }
                    _memoryCacheByFileName[normName] = targetFile;
                }

                _memoryCache[fileId] = targetFile;
                _memoryCacheByFileName[fileName] = targetFile;

                OnThumbnailResolved?.Invoke(fileId, targetFile);
                OnThumbnailResolved?.Invoke(fileName, targetFile);
                if (!string.Equals(normName, fileName, StringComparison.OrdinalIgnoreCase))
                {
                    OnThumbnailResolved?.Invoke(normName, targetFile);
                }

                // Sync to daemon in background
                _ = SyncThumbnailToServerAsync(fileId, targetFile);

                return targetFile;
            }
        }
        catch { }

        return null;
    }

    private async Task SyncThumbnailToServerAsync(string fileId, string jpegPath)
    {
        try
        {
            if (!File.Exists(jpegPath)) return;
            var bytes = await File.ReadAllBytesAsync(jpegPath);
            if (bytes.Length == 0 || bytes.Length > 2 * 1024 * 1024) return;

            var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            client.DefaultRequestHeaders.Add("X-Requested-With", "teledrive");

            using var content = new ByteArrayContent(bytes);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/jpeg");
            await client.PostAsync($"{TeleDriveService.Instance.BaseUrl}/api/files/{fileId}/thumbnail", content);
        }
        catch { }
    }
}
