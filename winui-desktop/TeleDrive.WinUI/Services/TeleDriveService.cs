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

    // Track upload & download progress to calculate live speed and ETA
    private readonly ConcurrentDictionary<string, (ulong Bytes, DateTime Time, ulong Speed)> _lastUploadProgress = new();
    private readonly ConcurrentDictionary<string, (ulong Bytes, DateTime Time, ulong Speed)> _lastDownloadProgress = new();
    // Cache completed uploads so they remain visible in transfers hub
    private readonly ConcurrentDictionary<string, TransferTaskModel> _completedTransfers = new();
    private int _previousActiveUploadCount = 0;
    private double _measuredUploadRate = 0;

    public double GetAdaptiveUploadRate(ulong daemonEstRate = 0)
    {
        if (_measuredUploadRate >= 256.0 * 1024.0)
        {
            return _measuredUploadRate;
        }
        if (daemonEstRate > 0 && daemonEstRate != 8 * 1024 * 1024)
        {
            return daemonEstRate;
        }
        return 3.5 * 1024 * 1024; // 3.5 MiB/s realistic default for domestic broadband
    }

    public void RecordCompletedUploadThroughput(ulong bytes, double elapsedSec)
    {
        if (bytes >= 1024 * 1024 && elapsedSec >= 0.5)
        {
            double rate = (double)bytes / elapsedSec;
            rate = Math.Clamp(rate, 256.0 * 1024.0, 100.0 * 1024.0 * 1024.0);
            _measuredUploadRate = _measuredUploadRate > 0
                ? (_measuredUploadRate * 0.6 + rate * 0.4)
                : rate;
        }
    }

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
        // 1. Quick check if daemon is already responding on BaseUrl (<200ms)
        if (await PingDaemonAsync(BaseUrl))
        {
            return;
        }

        // 2. Read daemon.json in AppData to check for an active daemon on an alternate port
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

        // 3. Not running, launch TeleDriveR.exe --daemon
        TryLaunchDaemon();

        // 4. Poll every 80ms up to 2.5 seconds for instant detection as soon as socket opens
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < 2500)
        {
            await Task.Delay(80);
            var port = ReadDaemonPort() ?? 48291;
            var url = $"http://127.0.0.1:{port}";
            if (await PingDaemonAsync(url))
            {
                BaseUrl = url;
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

    private void TryLaunchDaemon()
    {
        try
        {
            var exeDir = AppContext.BaseDirectory;
            var daemonPaths = new[]
            {
                Path.Combine(exeDir, "TeleDriveR.exe"),
                Path.Combine(exeDir, "..", "..", "..", "..", "..", "rust-desktop", "target", "x86_64-pc-windows-gnu", "release", "TeleDriveR.exe"),
                Path.Combine(exeDir, "..", "..", "..", "..", "..", "rust-desktop", "target", "release", "TeleDriveR.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "TeleDriveR", "TeleDriveR.exe")
            };

            foreach (var path in daemonPaths)
            {
                var full = Path.GetFullPath(path);
                if (File.Exists(full))
                {
                    var psi = new ProcessStartInfo
                    {
                        FileName = full,
                        Arguments = "--daemon",
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WorkingDirectory = Path.GetDirectoryName(full)
                    };
                    Process.Start(psi);
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"TryLaunchDaemon failed: {ex.Message}");
        }
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
                        ItemCount = f.TryGetProperty("itemCount", out var ic) ? ic.GetInt32() : 0,
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
                        dl = 0;
                        speed = 0;
                        eta = 0;
                        _lastDownloadProgress.TryRemove(id, out _);
                    }
                    else if (status == "downloading" || status == "finalizing")
                    {
                        // Progress is whatever the server measured; only guard against going backwards.
                        ulong prevDl = _lastDownloadProgress.TryGetValue(id, out var lastDl) ? lastDl.Bytes : 0;
                        if (dl < prevDl) dl = prevDl;
                        if (size > 0 && dl >= size && status != "done")
                        {
                            dl = Math.Min(dl, (ulong)(size * 0.99));
                        }

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
        try
        {
            var json = await _http.GetStringAsync($"{BaseUrl}/api/uploads");
            using var doc = JsonDocument.Parse(json);
            var tasks = new List<TransferTaskModel>();
            var now = DateTime.UtcNow;

            if (doc.RootElement.TryGetProperty("uploads", out var arr))
            {
                var rawUploads = arr.EnumerateArray().ToList();
                long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                // Count active uploads so domestic bandwidth is accurately shared per stream
                int activeCount = Math.Max(1, rawUploads.Count(u =>
                {
                    var st = u.TryGetProperty("status", out var s) ? s.GetString() : null;
                    return st != "failed" && st != "cancelled";
                }));

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
                    string status = "uploading";
                    string phase = "uploading";

                    try
                    {
                        using var res = await _http.GetAsync($"{BaseUrl}/api/uploads/{id}/progress");
                        if (res.StatusCode == System.Net.HttpStatusCode.NotFound)
                        {
                            // Upload completed on daemon and dropped from active_uploads
                            status = "done";
                            phase = "done";
                            transferred = size;
                            speed = 0;
                            eta = 0;
                        }
                        else if (res.IsSuccessStatusCode)
                        {
                            var detailJson = await res.Content.ReadAsStringAsync();
                            using var detailDoc = JsonDocument.Parse(detailJson);
                            var root = detailDoc.RootElement;
                            long serverNow = root.TryGetProperty("serverNow", out var sn) ? sn.GetInt64() : nowMs;

                            if (root.TryGetProperty("parts", out var partsArr))
                            {
                                ulong doneBytes = 0;
                                ulong activeSpeed = 0;
                                ulong activeEta = 0;
                                bool hasSending = false;
                                bool allStored = true;
                                int partsCount = partsArr.GetArrayLength();

                                foreach (var p in partsArr.EnumerateArray())
                                {
                                    var pStatus = p.TryGetProperty("status", out var ps) ? ps.GetString() : "pending";
                                    var pPhase = p.TryGetProperty("phase", out var ph) ? ph.GetString() : null;
                                    var pSize = p.TryGetProperty("size", out var pSz) ? pSz.GetUInt64() : 0;
                                    long? startedAt = p.TryGetProperty("startedAt", out var sa) && sa.ValueKind == JsonValueKind.Number ? sa.GetInt64() : null;
                                    ulong estRate = p.TryGetProperty("estRate", out var er) && er.ValueKind == JsonValueKind.Number ? er.GetUInt64() : 0;

                                    if (pStatus == "stored")
                                    {
                                        doneBytes += pSize;
                                    }
                                    else
                                    {
                                        allStored = false;
                                        if (pPhase == "sending" && startedAt.HasValue && startedAt.Value > 0)
                                        {
                                            hasSending = true;
                                            // Realistic per-stream upload bandwidth distributed across active streams
                                            double taskRate = Math.Max(128.0 * 1024.0, GetAdaptiveUploadRate(estRate) / activeCount);
                                            double elapsedSec = Math.Max(0.0, (serverNow - startedAt.Value) / 1000.0);
                                            double expectedSec = Math.Max(1.0, (double)pSize / taskRate);

                                            if (elapsedSec < expectedSec)
                                            {
                                                // Active progressive upload up to 95%
                                                double fraction = Math.Min(0.95, (elapsedSec / expectedSec) * 0.95);
                                                doneBytes += (ulong)(pSize * fraction);
                                                activeSpeed += (ulong)taskRate;
                                                ulong partEta = (ulong)Math.Max(1.0, Math.Ceiling(expectedSec - elapsedSec));
                                                activeEta = Math.Max(activeEta, partEta);
                                            }
                                            else
                                            {
                                                // Over expected time (network jitter or bot throttle):
                                                // Smooth asymptotic glide up to 98.8% without freezing or prematurely declaring finalizing
                                                double overtime = elapsedSec - expectedSec;
                                                double glide = 0.95 + 0.038 * (1.0 - Math.Exp(-overtime / 20.0));
                                                doneBytes += (ulong)(pSize * Math.Min(0.988, glide));
                                                activeSpeed += (ulong)(taskRate * Math.Max(0.2, 1.0 - (overtime / 30.0)));
                                                activeEta = 0; // Avoid false 1s left countdown
                                            }
                                        }
                                    }
                                }

                                if (allStored && partsCount > 0)
                                {
                                    // True finalization: all parts are confirmed in Telegram, now in final DB commit
                                    phase = "finalizing";
                                    status = "finalizing";
                                    transferred = size;
                                    speed = 0;
                                    eta = 0;
                                }
                                else if (hasSending)
                                {
                                    phase = "uploading";
                                    status = "uploading";
                                    transferred = Math.Min(doneBytes, size > 0 ? (ulong)(size * 0.988) : doneBytes);
                                    speed = activeSpeed;
                                    eta = activeEta;
                                }
                                else
                                {
                                    // Waiting for Telegram bot upload slot
                                    phase = "queued";
                                    status = "queued";
                                    transferred = doneBytes;
                                    speed = 0;
                                    eta = 0;
                                }
                            }
                        }
                    }
                    catch
                    {
                        // Clean fallback without faking speed or status
                        ulong bytesStored = 0;
                        if (u.TryGetProperty("bytesStored", out var bs)) bytesStored = bs.GetUInt64();
                        transferred = Math.Max(bytesStored, _lastUploadProgress.TryGetValue(id, out var prev) ? prev.Bytes : 0);
                        status = "uploading";
                        phase = "uploading";
                        speed = 0;
                        eta = 0;
                    }

                    // Monotonic forward progress guard: never step backwards during active upload
                    if (status == "uploading")
                    {
                        if (!_lastUploadProgress.TryGetValue(id, out var last))
                        {
                            _lastUploadProgress[id] = (transferred, now, speed);
                        }
                        else
                        {
                            if (transferred < last.Bytes) transferred = last.Bytes;
                            _lastUploadProgress[id] = (transferred, last.Time, speed);
                        }
                    }
                    else if (status == "finalizing")
                    {
                        transferred = size;
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
                        CreatedAt = createdAt
                    };

                    _completedTransfers[id] = task;
                    return task;
                });

                var results = await Task.WhenAll(queryTasks);
                tasks.AddRange(results);
            }

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
        var nowUtc = DateTime.UtcNow;
        foreach (var kvp in _completedTransfers.Where(c => c.Value.IsUpload && !activeUploadIds.Contains(c.Key)))
        {
            if (kvp.Value.Status != "done")
            {
                kvp.Value.Status = "done";
                kvp.Value.Phase = "done";
                kvp.Value.Transferred = kvp.Value.Size;
                kvp.Value.Speed = 0;
                kvp.Value.Eta = 0;
                anyFinished = true;

                if (_lastUploadProgress.TryRemove(kvp.Key, out var startInfo))
                {
                    double totalSec = (nowUtc - startInfo.Time).TotalSeconds;
                    RecordCompletedUploadThroughput(kvp.Value.Size, totalSec);
                }
            }
        }
        if (anyFinished)
        {
            OnUploadCompleted?.Invoke();
        }
        _previousActiveUploadCount = uploads.Count;

        var combined = new List<TransferTaskModel>();
        combined.AddRange(downloads);
        combined.AddRange(uploads);

        // Include remembered completed uploads
        var activeIds = new HashSet<string>(combined.Select(t => t.Id));
        foreach (var past in _completedTransfers.Values)
        {
            if (!activeIds.Contains(past.Id))
            {
                past.Status = "done";
                past.Phase = "done";
                past.Transferred = past.Size;
                past.Speed = 0;
                past.Eta = 0;
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
                        ItemCount = f.TryGetProperty("itemCount", out var ic) ? ic.GetInt32() : 0,
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
