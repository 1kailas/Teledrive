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
    /// </summary>
    public string? GetExistingLocalThumbnailPath(string fileId)
    {
        if (string.IsNullOrEmpty(fileId)) return null;

        var extensions = new[] { ".jpg", ".webp", ".png", ".jpeg" };

        // 1. Check Roaming AppData thumbnails (written by Rust daemon)
        foreach (var ext in extensions)
        {
            var path = Path.Combine(_appDataThumbsDir, fileId + ext);
            if (File.Exists(path))
            {
                return path;
            }
        }

        // 2. Check LocalAppData thumbnail cache
        foreach (var ext in extensions)
        {
            var path = Path.Combine(_localCacheThumbsDir, fileId + ext);
            if (File.Exists(path))
            {
                return path;
            }
        }

        return null;
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
        if (!string.IsNullOrEmpty(fileId))
        {
            var local = GetExistingLocalThumbnailPath(fileId);
            if (!string.IsNullOrEmpty(local))
            {
                _memoryCache[fileId] = local;
                return new Uri(local).AbsoluteUri;
            }
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
    /// </summary>
    private async Task TryExtractFromLocalFileAsync(string fileId, string fileName)
    {
        if (string.IsNullOrEmpty(fileName)) return;

        try
        {
            // 0. Check known upload paths from current session
            if (_knownLocalFiles.TryGetValue(fileName, out var knownPath) && File.Exists(knownPath))
            {
                var extracted = await GenerateAndUploadNativeThumbnailAsync(fileId, knownPath);
                if (!string.IsNullOrEmpty(extracted))
                {
                    _memoryCache[fileId] = extracted;
                    _memoryCacheByFileName[fileName] = extracted;
                    OnThumbnailResolved?.Invoke(fileId, extracted);
                    OnThumbnailResolved?.Invoke(fileName, extracted);
                    return;
                }
            }

            // 1. Check Downloads
            var dlPath = Path.Combine(_downloadsDir, fileName);
            if (File.Exists(dlPath))
            {
                var extracted = await GenerateAndUploadNativeThumbnailAsync(fileId, dlPath);
                if (!string.IsNullOrEmpty(extracted))
                {
                    _memoryCache[fileId] = extracted;
                    _memoryCacheByFileName[fileName] = extracted;
                    OnThumbnailResolved?.Invoke(fileId, extracted);
                    OnThumbnailResolved?.Invoke(fileName, extracted);
                    return;
                }
            }

            // 2. Check Desktop
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            var dtPath = Path.Combine(desktop, fileName);
            if (File.Exists(dtPath))
            {
                var extracted = await GenerateAndUploadNativeThumbnailAsync(fileId, dtPath);
                if (!string.IsNullOrEmpty(extracted))
                {
                    _memoryCache[fileId] = extracted;
                    _memoryCacheByFileName[fileName] = extracted;
                    OnThumbnailResolved?.Invoke(fileId, extracted);
                    OnThumbnailResolved?.Invoke(fileName, extracted);
                    return;
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
            var dummyPath = Path.Combine(_dummyTempDir, $"placeholder.{ext}");
            if (!File.Exists(dummyPath))
            {
                await File.WriteAllBytesAsync(dummyPath, Array.Empty<byte>());
            }

            var storageFile = await StorageFile.GetFileFromPathAsync(dummyPath);
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
    /// caches it locally, and syncs it to the TeleDrive server.
    /// </summary>
    public async Task<string?> GenerateAndUploadNativeThumbnailAsync(string fileId, string localFilePath)
    {
        try
        {
            if (!File.Exists(localFilePath)) return null;

            var storageFile = await StorageFile.GetFileFromPathAsync(localFilePath);
            using var thumb = await storageFile.GetThumbnailAsync(ThumbnailMode.SingleItem, 320, ThumbnailOptions.ResizeThumbnail);
            if (thumb != null && thumb.Size > 0)
            {
                var targetFile = Path.Combine(_localCacheThumbsDir, $"{fileId}.jpg");
                using var outStream = File.Create(targetFile);
                var stream = thumb.AsStream();
                await stream.CopyToAsync(outStream);
                outStream.Flush();

                _memoryCache[fileId] = targetFile;
                var fileName = Path.GetFileName(localFilePath);
                _memoryCacheByFileName[fileName] = targetFile;

                OnThumbnailResolved?.Invoke(fileId, targetFile);
                OnThumbnailResolved?.Invoke(fileName, targetFile);

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
