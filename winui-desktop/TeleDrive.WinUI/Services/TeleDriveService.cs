using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using TeleDrive_WinUI.Models;

namespace TeleDrive_WinUI.Services;

public class TeleDriveService
{
    private static TeleDriveService? _instance;
    public static TeleDriveService Instance => _instance ??= new TeleDriveService();

    private readonly HttpClient _http;
    public string BaseUrl { get; private set; } = "http://127.0.0.1:48291";
    public bool LastRequestFailed { get; private set; }

    public event Action? OnUploadCompleted;

    // Retain the last confirmed value across polling errors.
    private readonly ConcurrentDictionary<string, ulong> _lastUploadProgress = new();
    private readonly ConcurrentDictionary<string, (ulong Bytes, DateTime Time, ulong Speed)> _lastDownloadProgress = new();
    // Cache completed uploads so they remain visible in transfers hub
    private readonly ConcurrentDictionary<string, TransferTaskModel> _completedTransfers = new();
    private bool _uploadListFetchSucceeded;

    public TeleDriveService()
    {
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        _http.DefaultRequestHeaders.Add("X-Requested-With", "teledrive");
    }

    public async Task<(bool DaemonOk, bool BotApiOk, string? Error, string Version)> GetSystemStatusAsync()
    {
        try
        {
            using var doc = JsonDocument.Parse(await _http.GetStringAsync($"{BaseUrl}/api/system"));
            var root = doc.RootElement;
            bool botOk = false;
            string? err = null;
            if (root.TryGetProperty("botApi", out var bot))
            {
                botOk = bot.TryGetProperty("reachable", out var r) && r.ValueKind == JsonValueKind.True;
                if (bot.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String) err = e.GetString();
            }
            var ver = root.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
            return (true, botOk, err, ver);
        }
        catch
        {
            return (false, false, "Local service is not responding", "");
        }
    }

    public async Task EnsureDaemonRunningAsync()
    {
        // 1. Quick check if service is already responding on BaseUrl (<200ms)
        if (await PingDaemonAsync(BaseUrl))
        {
            return;
        }

        // 2. Check standard Fastify server port 8080
        if (await PingDaemonAsync("http://127.0.0.1:8080"))
        {
            BaseUrl = "http://127.0.0.1:8080";
            return;
        }

        // 3. Read daemon.json in AppData to check for an active daemon on an alternate port
        var detectedPort = ReadDaemonPort();
        if (detectedPort.HasValue && detectedPort.Value != 48291)
        {
            var detectedUrl = $"http://127.0.0.1:{detectedPort.Value}";
            if (await PingDaemonAsync(detectedUrl))
            {
                BaseUrl = detectedUrl;
                return;
            }
        }
    }

    private async Task<bool> PingDaemonAsync(string url)
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(250));
            var res = await _http.GetAsync($"{url}/api/auth/me", cts.Token);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private int? ReadDaemonPort()
    {
        try
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var candidates = new[]
            {
                Path.Combine(appData, "TeleDrive", "data", "daemon.json"),
                Path.Combine(appData, "TeleDrive", "daemon.json"),
                Path.Combine(AppContext.BaseDirectory, "daemon.json")
            };

            foreach (var path in candidates)
            {
                if (File.Exists(path))
                {
                    var text = File.ReadAllText(path);
                    using var doc = JsonDocument.Parse(text);
                    if (doc.RootElement.TryGetProperty("port", out var p) && p.TryGetInt32(out var port))
                    {
                        return port;
                    }
                }
            }
        }
        catch { }
        return null;
    }

    public async Task<(List<FolderModel> Folders, List<FileModel> Files)> GetDriveAsync(string? folderId = null)
    {
        try
        {
            var url = string.IsNullOrEmpty(folderId) ? $"{BaseUrl}/api/drive" : $"{BaseUrl}/api/drive?folderId={Uri.EscapeDataString(folderId)}";
            var json = await _http.GetStringAsync(url);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var folders = new List<FolderModel>();
            bool isInsideStream = false;
            if (root.TryGetProperty("folder", out var curFolder) && curFolder.ValueKind != JsonValueKind.Null)
            {
                if (curFolder.TryGetProperty("name", out var cfName) && cfName.GetString()?.Equals("stream", StringComparison.OrdinalIgnoreCase) == true)
                {
                    isInsideStream = true;
                }
            }

            if (root.TryGetProperty("folders", out var foldersArr))
            {
                foreach (var f in foldersArr.EnumerateArray())
                {
                    folders.Add(new FolderModel
                    {
                        Id = f.GetProperty("id").GetString() ?? "",
                        ParentId = f.TryGetProperty("parentId", out var pid) ? pid.GetString() : null,
                        Name = f.GetProperty("name").GetString() ?? "",
                        Starred = f.TryGetProperty("starred", out var st) && st.GetBoolean(),
                        CreatedAt = f.TryGetProperty("createdAt", out var ca) ? ca.GetInt64() : 0,
                        UpdatedAt = f.TryGetProperty("updatedAt", out var ua) ? ua.GetInt64() : 0,
                        ItemCount = f.TryGetProperty("itemCount", out var ic) ? ic.GetInt32()
                            : (f.TryGetProperty("childCount", out var cc) ? cc.GetInt32()
                            : (f.TryGetProperty("count", out var cnt) ? cnt.GetInt32() : 0)),
                        IsSeries = isInsideStream,
                    });
                }
            }

            var files = new List<FileModel>();
            if (root.TryGetProperty("files", out var filesArr))
            {
                foreach (var f in filesArr.EnumerateArray())
                {
                    var fid = f.GetProperty("id").GetString() ?? "";
                    files.Add(new FileModel
                    {
                        Id = fid,
                        FolderId = f.TryGetProperty("folderId", out var fidElem) ? fidElem.GetString() : null,
                        BlobId = f.TryGetProperty("blobId", out var bid) ? bid.GetString() : null,
                        Name = f.GetProperty("name").GetString() ?? "",
                        Extension = f.TryGetProperty("extension", out var ext) ? ext.GetString() ?? "" : "",
                        MimeType = f.TryGetProperty("mimeType", out var mt) ? mt.GetString() ?? "" : "",
                        Category = f.TryGetProperty("category", out var cat) ? cat.GetString() ?? "document" : "document",
                        Size = f.TryGetProperty("size", out var sz) ? sz.GetUInt64() : 0,
                        Starred = f.TryGetProperty("starred", out var st) && st.GetBoolean(),
                        HasThumbnail = f.TryGetProperty("hasThumbnail", out var ht) && ht.GetBoolean(),
                        ThumbnailUrl = $"{BaseUrl}/api/thumbnails/{fid}",
                        CreatedAt = f.TryGetProperty("createdAt", out var ca) ? ca.GetInt64() : 0,
                        UpdatedAt = f.TryGetProperty("updatedAt", out var ua) ? ua.GetInt64() : 0,
                        Width = f.TryGetProperty("width", out var wElem) && wElem.ValueKind == JsonValueKind.Number ? wElem.GetInt32() : null,
                        Height = f.TryGetProperty("height", out var hElem) && hElem.ValueKind == JsonValueKind.Number ? hElem.GetInt32() : null,
                        Duration = f.TryGetProperty("duration", out var dElem) && dElem.ValueKind == JsonValueKind.Number ? dElem.GetDouble() : null,
                        PartCount = f.TryGetProperty("partCount", out var pcElem) && pcElem.ValueKind == JsonValueKind.Number ? pcElem.GetInt32() : null,
                        TakenAt = f.TryGetProperty("takenAt", out var tkElem) && tkElem.ValueKind == JsonValueKind.Number ? tkElem.GetInt64() : null,
                        MetadataJson = f.TryGetProperty("metadata", out var metaElem) && metaElem.ValueKind != JsonValueKind.Null ? metaElem.ToString() : null,
                    });
                }
            }

            LastRequestFailed = false;
            return (folders, files);
        }
        catch
        {
            LastRequestFailed = true;
            return (new List<FolderModel>(), new List<FileModel>());
        }
    }

    public async Task<List<FolderModel>> GetFolderTreeAsync()
    {
        try
        {
            var json = await _http.GetStringAsync($"{BaseUrl}/api/folders/tree");
            using var doc = JsonDocument.Parse(json);
            var list = new List<FolderModel>();
            if (doc.RootElement.TryGetProperty("folders", out var arr))
            {
                foreach (var el in arr.EnumerateArray())
                {
                    list.Add(new FolderModel
                    {
                        Id = el.GetProperty("id").GetString() ?? "",
                        ParentId = el.TryGetProperty("parentId", out var pid) && pid.ValueKind == JsonValueKind.String ? pid.GetString() : null,
                        Name = el.TryGetProperty("name", out var nm) ? nm.GetString() ?? "" : ""
                    });
                }
            }
            return list;
        }
        catch
        {
            return new List<FolderModel>();
        }
    }

    public async Task<FileModel?> GetFileDetailsAsync(string fileId)
    {
        try
        {
            var json = await _http.GetStringAsync($"{BaseUrl}/api/files/{fileId}");
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("file", out var f))
            {
                var fid = f.GetProperty("id").GetString() ?? "";
                return new FileModel
                {
                    Id = fid,
                    FolderId = f.TryGetProperty("folderId", out var fidElem) ? fidElem.GetString() : null,
                    BlobId = f.TryGetProperty("blobId", out var bid) ? bid.GetString() : null,
                    Name = f.GetProperty("name").GetString() ?? "",
                    Extension = f.TryGetProperty("extension", out var ext) ? ext.GetString() ?? "" : "",
                    MimeType = f.TryGetProperty("mimeType", out var mt) ? mt.GetString() ?? "" : "",
                    Category = f.TryGetProperty("category", out var cat) ? cat.GetString() ?? "document" : "document",
                    Size = f.TryGetProperty("size", out var sz) ? sz.GetUInt64() : 0,
                    Starred = f.TryGetProperty("starred", out var st) && st.GetBoolean(),
                    HasThumbnail = f.TryGetProperty("hasThumbnail", out var ht) && ht.GetBoolean(),
                    ThumbnailUrl = $"{BaseUrl}/api/thumbnails/{fid}",
                    CreatedAt = f.TryGetProperty("createdAt", out var ca) ? ca.GetInt64() : 0,
                    UpdatedAt = f.TryGetProperty("updatedAt", out var ua) ? ua.GetInt64() : 0,
                    Width = f.TryGetProperty("width", out var wElem) && wElem.ValueKind == JsonValueKind.Number ? wElem.GetInt32() : null,
                    Height = f.TryGetProperty("height", out var hElem) && hElem.ValueKind == JsonValueKind.Number ? hElem.GetInt32() : null,
                    Duration = f.TryGetProperty("duration", out var dElem) && dElem.ValueKind == JsonValueKind.Number ? dElem.GetDouble() : null,
                    PartCount = f.TryGetProperty("partCount", out var pcElem) && pcElem.ValueKind == JsonValueKind.Number ? pcElem.GetInt32() : null,
                    TakenAt = f.TryGetProperty("takenAt", out var tkElem) && tkElem.ValueKind == JsonValueKind.Number ? tkElem.GetInt64() : null,
                    MetadataJson = f.TryGetProperty("metadata", out var metaElem) && metaElem.ValueKind != JsonValueKind.Null ? metaElem.ToString() : null,
                };
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<List<FileModel>> GetRecentAsync()
    {
        try
        {
            var json = await _http.GetStringAsync($"{BaseUrl}/api/recent");
            using var doc = JsonDocument.Parse(json);
            var files = new List<FileModel>();
            if (doc.RootElement.TryGetProperty("files", out var arr))
            {
                foreach (var f in arr.EnumerateArray())
                {
                    var fid = f.GetProperty("id").GetString() ?? "";
                    files.Add(new FileModel
                    {
                        Id = fid,
                        Name = f.GetProperty("name").GetString() ?? "",
                        Category = f.TryGetProperty("category", out var cat) ? cat.GetString() ?? "document" : "document",
                        Size = f.TryGetProperty("size", out var sz) ? sz.GetUInt64() : 0,
                        Starred = f.TryGetProperty("starred", out var st) && st.GetBoolean(),
                        HasThumbnail = f.TryGetProperty("hasThumbnail", out var ht) && ht.GetBoolean(),
                        ThumbnailUrl = $"{BaseUrl}/api/thumbnails/{fid}",
                        UpdatedAt = f.TryGetProperty("updatedAt", out var ua) ? ua.GetInt64() : 0,
                    });
                }
            }
            return files;
        }
        catch
        {
            return new List<FileModel>();
        }
    }

    public async Task<List<TransferTaskModel>> GetDownloadsAsync()
    {
        try
        {
            var json = await _http.GetStringAsync($"{BaseUrl}/api/native-downloads");
            using var doc = JsonDocument.Parse(json);
            var tasks = new List<TransferTaskModel>();
            var now = DateTime.UtcNow;

            if (doc.RootElement.TryGetProperty("downloads", out var arr))
            {
                foreach (var t in arr.EnumerateArray())
                {
                    var id = t.GetProperty("id").GetString() ?? "";
                    var fileId = t.TryGetProperty("fileId", out var fid) ? fid.GetString() ?? "" : "";
                    var name = t.GetProperty("name").GetString() ?? "";
                    var size = t.TryGetProperty("size", out var sz) ? sz.GetUInt64() : 0;
                    var dl = t.TryGetProperty("downloaded", out var d) ? d.GetUInt64() : 0;
                    var status = t.TryGetProperty("status", out var st) ? st.GetString() ?? "queued" : "queued";
                    var speed = t.TryGetProperty("speed", out var sp) ? sp.GetUInt64() : 0;
                    var eta = t.TryGetProperty("eta", out var et) ? et.GetUInt64() : 0;
                    var destPath = t.TryGetProperty("destPath", out var dp) ? dp.GetString() ?? "" : "";
                    var error = t.TryGetProperty("error", out var er) ? er.GetString() : null;
                    var createdAt = t.TryGetProperty("createdAt", out var ca) ? ca.GetInt64() : 0;

                    if (status == "done" || status == "complete")
                    {
                        dl = size;
                        speed = 0;
                        eta = 0;
                    }
                    else if (status == "queued")
                    {
                        speed = 0;
                        eta = 0;
                    }
                    else if (status == "downloading" || status == "finalizing")
                    {
                        // Progress is whatever the server measured; only guard against going backwards.
                        ulong prevDl = _lastDownloadProgress.TryGetValue(id, out var lastDl) ? lastDl.Bytes : 0;
                        if (dl < prevDl) dl = prevDl;
                        dl = Math.Min(dl, size);

                        // If server hasn't calculated speed yet, derive smooth speed from delta
                        if (speed == 0 && _lastDownloadProgress.TryGetValue(id, out var lastInfo))
                        {
                            var elapsed = (now - lastInfo.Time).TotalSeconds;
                            if (elapsed >= 0.2 && dl > lastInfo.Bytes)
                            {
                                speed = (ulong)((dl - lastInfo.Bytes) / elapsed);
                                if (speed > 0 && size > dl)
                                {
                                    eta = (size - dl) / speed;
                                }
                            }
                        }

                        _lastDownloadProgress[id] = (dl, now, speed);
                    }

                    tasks.Add(new TransferTaskModel
                    {
                        Id = id,
                        FileId = fileId,
                        Name = name,
                        Type = "download",
                        Size = size,
                        Transferred = dl,
                        Status = status,
                        DestPath = destPath,
                        Speed = speed,
                        Eta = eta,
                        Error = error,
                        CreatedAt = createdAt,
                    });
                }
            }
            return tasks;
        }
        catch
        {
            return new List<TransferTaskModel>();
        }
    }

    public async Task<List<TransferTaskModel>> GetUploadsAsync()
    {
        _uploadListFetchSucceeded = false;
        try
        {
            var json = await _http.GetStringAsync($"{BaseUrl}/api/uploads");
            using var doc = JsonDocument.Parse(json);
            var tasks = new List<TransferTaskModel>();
            if (doc.RootElement.TryGetProperty("uploads", out var arr))
            {
                var rawUploads = arr.EnumerateArray().ToList();
                var queryTasks = rawUploads.Select(async u =>
                {
                    var id = u.GetProperty("id").GetString() ?? "";
                    var size = u.TryGetProperty("size", out var sz) ? sz.GetUInt64() : 0;
                    var name = u.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                    var fileId = u.TryGetProperty("fileId", out var fid) ? fid.GetString() ?? "" : "";
                    var createdAt = u.TryGetProperty("createdAt", out var ca) ? ca.GetInt64() : 0;

                    ulong transferred = 0;
                    ulong speed = 0;
                    ulong eta = 0;
                    string status = "preparing";
                    string phase = "preparing";
                    string? error = null;

                    try
                    {
                        using var res = await _http.GetAsync($"{BaseUrl}/api/uploads/{id}/progress");
                        if (res.StatusCode == System.Net.HttpStatusCode.NotFound)
                        {
                            // The list can outlive its session for a poll; disappearance
                            // from /api/uploads, not a 404, confirms completion.
                            status = "pending";
                            phase = "waiting-bot";
                            transferred = u.TryGetProperty("bytesStored", out var stored) ? stored.GetUInt64() : 0;
                        }
                        else if (res.IsSuccessStatusCode)
                        {
                            var detailJson = await res.Content.ReadAsStringAsync();
                            using var detailDoc = JsonDocument.Parse(detailJson);
                            var root = detailDoc.RootElement;
                            var snapshot = UploadProgressSnapshot.Read(root, size);
                            transferred = snapshot.ConfirmedBytes;
                            error = snapshot.Error;
                            if (snapshot.Failed)
                            {
                                status = "failed";
                                phase = "failed";
                            }
                            else if (snapshot.AllStored)
                            {
                                status = "finalizing";
                                phase = "finalizing";
                            }
                            else if (snapshot.Sending)
                            {
                                status = "uploading";
                                phase = "sending";
                            }
                            else if (snapshot.WaitingForBot)
                            {
                                status = "queued";
                                phase = "waiting-bot";
                            }
                        }
                    }
                    catch
                    {
                        // Clean fallback without faking speed or status
                        ulong bytesStored = 0;
                        if (u.TryGetProperty("bytesStored", out var bs)) bytesStored = bs.GetUInt64();
                        transferred = bytesStored;
                        status = "queued";
                        phase = "waiting-bot";
                    }

                    if (status != "done" && status != "failed")
                    {
                        transferred = Math.Min(size, _lastUploadProgress.AddOrUpdate(
                            id, transferred, (_, previous) => Math.Max(previous, transferred)));
                    }

                    var task = new TransferTaskModel
                    {
                        Id = id,
                        FileId = fileId,
                        Name = name,
                        Type = "upload",
                        Size = size,
                        Transferred = transferred,
                        Status = status,
                        Speed = speed,
                        Eta = eta,
                        Phase = phase,
                        Error = error,
                        CreatedAt = createdAt
                    };

                    _completedTransfers[id] = task;
                    return task;
                });

                var results = await Task.WhenAll(queryTasks);
                tasks.AddRange(results);
            }

            _uploadListFetchSucceeded = true;
            return tasks;
        }
        catch
        {
            return new List<TransferTaskModel>();
        }
    }

    public async Task<List<TransferTaskModel>> GetAllTransfersAsync()
    {
        var downloads = await GetDownloadsAsync();
        var uploads = await GetUploadsAsync();

        // Check if any upload completed: any item in _completedTransfers that is no longer active
        var activeUploadIds = new HashSet<string>(uploads.Select(u => u.Id));
        bool anyFinished = false;
        foreach (var kvp in _completedTransfers.Where(c => _uploadListFetchSucceeded && c.Value.IsUpload && !activeUploadIds.Contains(c.Key)))
        {
            if (kvp.Value.Status != "done" && kvp.Value.Status != "failed")
            {
                kvp.Value.Status = "done";
                kvp.Value.Phase = "done";
                kvp.Value.Transferred = kvp.Value.Size;
                kvp.Value.Speed = 0;
                kvp.Value.Eta = 0;
                anyFinished = true;

                _lastUploadProgress.TryRemove(kvp.Key, out _);
            }
        }
        if (anyFinished)
        {
            OnUploadCompleted?.Invoke();
        }

        var combined = new List<TransferTaskModel>();
        combined.AddRange(downloads);
        combined.AddRange(uploads);

        // Include remembered completed uploads
        var activeIds = new HashSet<string>(combined.Select(t => t.Id));
        foreach (var past in _completedTransfers.Values)
        {
            if (!activeIds.Contains(past.Id))
            {
                combined.Add(past);
            }
        }

        // Active first, then latest by CreatedAt
        return combined
            .OrderByDescending(t => t.IsActive)
            .ThenByDescending(t => t.CreatedAt)
            .ToList();
    }

    public async Task<bool> StartDownloadAsync(string fileId)
    {
        try
        {
            var payload = new { fileId };
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/native-downloads/start", payload);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> PauseDownloadAsync(string taskId)
    {
        try
        {
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/native-downloads/pause", new { taskId });
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> ResumeDownloadAsync(string taskId)
    {
        try
        {
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/native-downloads/resume", new { taskId });
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> RetryUploadAsync(string uploadId)
    {
        try
        {
            var res = await _http.PostAsync($"{BaseUrl}/api/uploads/{uploadId}/retry", null);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> CancelTransferAsync(TransferTaskModel task)
    {
        try
        {
            if (task.IsUpload)
            {
                var res = await _http.DeleteAsync($"{BaseUrl}/api/uploads/{task.Id}");
                _completedTransfers.TryRemove(task.Id, out _);
                return res.IsSuccessStatusCode;
            }
            else
            {
                var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/native-downloads/cancel", new { taskId = task.Id });
                return res.IsSuccessStatusCode;
            }
        }
        catch
        {
            return false;
        }
    }

    public async Task<string?> GetDownloadDirectoryAsync()
    {
        try
        {
            using var doc = JsonDocument.Parse(await _http.GetStringAsync($"{BaseUrl}/api/native-downloads"));
            return doc.RootElement.TryGetProperty("downloadDir", out var dir) ? dir.GetString() : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<bool> OpenFileAsync(string taskId)
    {
        try
        {
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/native-downloads/open", new { taskId });
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> RevealFileAsync(string taskId)
    {
        try
        {
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/native-downloads/reveal", new { taskId });
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> ClearFinishedDownloadsAsync()
    {
        try
        {
            // Clear local cached completed uploads
            var toRemove = _completedTransfers.Where(c => c.Value.IsDone).Select(c => c.Key).ToList();
            foreach (var k in toRemove) _completedTransfers.TryRemove(k, out _);

            var res = await _http.PostAsync($"{BaseUrl}/api/native-downloads/clear-done", null);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> UploadFilesAsync(IEnumerable<string> filePaths, string? folderId = null, string conflict = "rename")
    {
        try
        {
            var validPaths = filePaths.Where(p => !string.IsNullOrWhiteSpace(p) && File.Exists(p)).ToList();
            if (validPaths.Count == 0) return false;

            ThumbnailCacheService.Instance.PrecacheLocalUploads(validPaths);

            var payload = new
            {
                paths = validPaths,
                folderId,
                conflict
            };
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/native-uploads", payload);
            return res.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"UploadFilesAsync error: {ex.Message}");
            return false;
        }
    }

    public async Task UploadDirectoryAsync(string dirPath, string? parentFolderId = null, string conflict = "rename")
    {
        try
        {
            if (!Directory.Exists(dirPath)) return;
            var dirInfo = new DirectoryInfo(dirPath);
            var folderName = dirInfo.Name;

            var createdFolderId = await CreateFolderAsync(folderName, parentFolderId);
            var targetFolderId = !string.IsNullOrEmpty(createdFolderId) ? createdFolderId : parentFolderId;

            var files = Directory.GetFiles(dirPath);
            if (files.Length > 0)
            {
                await UploadFilesAsync(files, targetFolderId, conflict);
            }

            var subDirs = Directory.GetDirectories(dirPath);
            foreach (var sub in subDirs)
            {
                await UploadDirectoryAsync(sub, targetFolderId, conflict);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"UploadDirectoryAsync error: {ex.Message}");
        }
    }

    public async Task<string?> EnsureFolderPathAsync(string path, string? parentId = null)
    {
        try
        {
            var segments = path.Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries)
                               .Select(s => s.Trim())
                               .Where(s => !string.IsNullOrEmpty(s))
                               .ToList();
            if (segments.Count == 0) return parentId;

            // 1. Try server's fast ensure-path endpoint first
            try
            {
                var payload = new { path = string.Join("/", segments), parentId };
                var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/folders/ensure-path", payload);
                if (res.IsSuccessStatusCode)
                {
                    var json = await res.Content.ReadAsStringAsync();
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.TryGetProperty("folder", out var f) && f.TryGetProperty("id", out var idElem))
                    {
                        return idElem.GetString();
                    }
                }
            }
            catch { }

            // 2. Resilient fallback: ensure each segment step-by-step
            string? currentParent = parentId;
            foreach (var seg in segments)
            {
                var (folders, _) = await GetDriveAsync(currentParent);
                var existing = folders.FirstOrDefault(f => f.Name.Equals(seg, StringComparison.OrdinalIgnoreCase));
                if (existing != null)
                {
                    currentParent = existing.Id;
                }
                else
                {
                    var payload = new { name = seg, parentId = currentParent };
                    var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/folders", payload);
                    if (res.IsSuccessStatusCode)
                    {
                        var json = await res.Content.ReadAsStringAsync();
                        using var doc = JsonDocument.Parse(json);
                        if (doc.RootElement.TryGetProperty("folder", out var f) && f.TryGetProperty("id", out var idElem))
                        {
                            currentParent = idElem.GetString();
                            continue;
                        }
                    }
                    return currentParent;
                }
            }
            return currentParent;
        }
        catch
        {
            return parentId;
        }
    }

    public async Task<string?> CreateFolderAsync(string name, string? parentId = null)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(name)) return null;
            if (name.Contains('/') || name.Contains('\\'))
            {
                return await EnsureFolderPathAsync(name, parentId);
            }

            var payload = new { name, parentId };
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/folders", payload);
            if (res.IsSuccessStatusCode)
            {
                var json = await res.Content.ReadAsStringAsync();
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("folder", out var f) && f.TryGetProperty("id", out var idElem))
                {
                    return idElem.GetString();
                }
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    public async Task<bool> RenameAsync(string id, bool isFolder, string newName)
    {
        try
        {
            var url = isFolder ? $"{BaseUrl}/api/folders/{id}" : $"{BaseUrl}/api/files/{id}";
            var payload = new { name = newName };
            var res = await _http.PatchAsJsonAsync(url, payload);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> TrashAsync(string id, bool isFolder)
    {
        return await TrashItemsAsync(isFolder ? Array.Empty<string>() : new[] { id }, isFolder ? new[] { id } : Array.Empty<string>());
    }

    public async Task<bool> TrashItemsAsync(IEnumerable<string> fileIds, IEnumerable<string> folderIds)
    {
        try
        {
            var payload = new
            {
                fileIds = fileIds.ToArray(),
                folderIds = folderIds.ToArray()
            };
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/items/trash", payload);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> MoveItemsAsync(IEnumerable<string> fileIds, IEnumerable<string> folderIds, string? targetFolderId)
    {
        try
        {
            var payload = new
            {
                fileIds = fileIds.ToArray(),
                folderIds = folderIds.ToArray(),
                targetFolderId = targetFolderId,
                copy = false
            };
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/items/move", payload);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> CopyItemsAsync(IEnumerable<string> fileIds, IEnumerable<string> folderIds, string? targetFolderId)
    {
        try
        {
            var payload = new
            {
                fileIds = fileIds.ToArray(),
                folderIds = folderIds.ToArray(),
                targetFolderId = targetFolderId
            };
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/items/copy", payload);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<(List<FolderModel> Folders, List<FileModel> Files, ulong TotalSize)> GetTrashAsync()
    {
        try
        {
            var json = await _http.GetStringAsync($"{BaseUrl}/api/trash");
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var folders = new List<FolderModel>();
            bool isInsideStream = false;
            if (root.TryGetProperty("folder", out var curFolder) && curFolder.ValueKind != JsonValueKind.Null)
            {
                if (curFolder.TryGetProperty("name", out var cfName) && cfName.GetString()?.Equals("stream", StringComparison.OrdinalIgnoreCase) == true)
                {
                    isInsideStream = true;
                }
            }

            if (root.TryGetProperty("folders", out var foldersArr))
            {
                foreach (var f in foldersArr.EnumerateArray())
                {
                    folders.Add(new FolderModel
                    {
                        Id = f.GetProperty("id").GetString() ?? "",
                        ParentId = f.TryGetProperty("parentId", out var pid) ? pid.GetString() : null,
                        Name = f.GetProperty("name").GetString() ?? "",
                        Starred = f.TryGetProperty("starred", out var st) && st.GetBoolean(),
                        CreatedAt = f.TryGetProperty("createdAt", out var ca) ? ca.GetInt64() : 0,
                        UpdatedAt = f.TryGetProperty("updatedAt", out var ua) ? ua.GetInt64() : 0,
                        ItemCount = f.TryGetProperty("itemCount", out var ic) ? ic.GetInt32()
                            : (f.TryGetProperty("childCount", out var cc) ? cc.GetInt32()
                            : (f.TryGetProperty("count", out var cnt) ? cnt.GetInt32() : 0)),
                        IsSeries = isInsideStream,
                    });
                }
            }

            var files = new List<FileModel>();
            if (root.TryGetProperty("files", out var filesArr))
            {
                foreach (var f in filesArr.EnumerateArray())
                {
                    var fid = f.GetProperty("id").GetString() ?? "";
                    files.Add(new FileModel
                    {
                        Id = fid,
                        FolderId = f.TryGetProperty("folderId", out var fidElem) ? fidElem.GetString() : null,
                        BlobId = f.TryGetProperty("blobId", out var bid) ? bid.GetString() : null,
                        Name = f.GetProperty("name").GetString() ?? "",
                        Extension = f.TryGetProperty("extension", out var ext) ? ext.GetString() ?? "" : "",
                        MimeType = f.TryGetProperty("mimeType", out var mt) ? mt.GetString() ?? "" : "",
                        Category = f.TryGetProperty("category", out var cat) ? cat.GetString() ?? "document" : "document",
                        Size = f.TryGetProperty("size", out var sz) ? sz.GetUInt64() : 0,
                        Starred = f.TryGetProperty("starred", out var st) && st.GetBoolean(),
                        HasThumbnail = f.TryGetProperty("hasThumbnail", out var ht) && ht.GetBoolean(),
                        ThumbnailUrl = $"{BaseUrl}/api/thumbnails/{fid}",
                        CreatedAt = f.TryGetProperty("createdAt", out var ca) ? ca.GetInt64() : 0,
                        UpdatedAt = f.TryGetProperty("updatedAt", out var ua) ? ua.GetInt64() : 0,
                        Width = f.TryGetProperty("width", out var wElem) && wElem.ValueKind == JsonValueKind.Number ? wElem.GetInt32() : null,
                        Height = f.TryGetProperty("height", out var hElem) && hElem.ValueKind == JsonValueKind.Number ? hElem.GetInt32() : null,
                        Duration = f.TryGetProperty("duration", out var dElem) && dElem.ValueKind == JsonValueKind.Number ? dElem.GetDouble() : null,
                        PartCount = f.TryGetProperty("partCount", out var pcElem) && pcElem.ValueKind == JsonValueKind.Number ? pcElem.GetInt32() : null,
                        TakenAt = f.TryGetProperty("takenAt", out var tkElem) && tkElem.ValueKind == JsonValueKind.Number ? tkElem.GetInt64() : null,
                        MetadataJson = f.TryGetProperty("metadata", out var metaElem) && metaElem.ValueKind != JsonValueKind.Null ? metaElem.ToString() : null,
                    });
                }
            }

            ulong totalSize = 0;
            if (root.TryGetProperty("totalSize", out var tsElem) && tsElem.ValueKind == JsonValueKind.Number)
            {
                totalSize = tsElem.GetUInt64();
            }

            return (folders, files, totalSize);
        }
        catch
        {
            return (new List<FolderModel>(), new List<FileModel>(), 0);
        }
    }

    public async Task<bool> RestoreAsync(IEnumerable<string> fileIds, IEnumerable<string> folderIds)
    {
        try
        {
            var payload = new
            {
                fileIds = fileIds.ToArray(),
                folderIds = folderIds.ToArray()
            };
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/items/restore", payload);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> DeletePermanentlyAsync(IEnumerable<string> fileIds, IEnumerable<string> folderIds)
    {
        try
        {
            var payload = new
            {
                fileIds = fileIds.ToArray(),
                folderIds = folderIds.ToArray()
            };
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/items/delete", payload);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> EmptyTrashAsync()
    {
        try
        {
            var res = await _http.DeleteAsync($"{BaseUrl}/api/trash");
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> SetStarredAsync(string id, bool isFolder, bool star)
    {
        try
        {
            var payload = new
            {
                fileIds = isFolder ? Array.Empty<string>() : new[] { id },
                folderIds = isFolder ? new[] { id } : Array.Empty<string>(),
                starred = star
            };
            var res = await _http.PostAsJsonAsync($"{BaseUrl}/api/items/star", payload);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }
}
