using System;
using System.Text.Json;

namespace TeleDrive_WinUI.Services;

// Only Telegram-confirmed parts count toward stored bytes. The local Bot API
// does not expose how many bytes of a file:// upload it has sent to Telegram.
public readonly record struct UploadProgressSnapshot(ulong ConfirmedBytes, bool Sending, bool WaitingForBot, bool AllStored, bool Failed)
{
    public static UploadProgressSnapshot Read(JsonElement root, ulong fileSize)
    {
        ulong confirmed = 0;
        bool sending = false;
        bool waiting = false;
        bool allStored = true;
        bool failed = root.TryGetProperty("status", out var uploadStatus)
            && uploadStatus.GetString() == "failed";
        int count = 0;

        if (root.TryGetProperty("parts", out var parts) && parts.ValueKind == JsonValueKind.Array)
        {
            foreach (var part in parts.EnumerateArray())
            {
                count++;
                var status = part.TryGetProperty("status", out var s) ? s.GetString() : null;
                if (status == "stored")
                {
                    if (part.TryGetProperty("size", out var size) && size.TryGetUInt64(out var bytes))
                        confirmed += Math.Min(bytes, fileSize - confirmed);
                }
                else
                {
                    allStored = false;
                    sending |= status == "uploading";
                    failed |= status == "failed";
                    waiting |= part.TryGetProperty("phase", out var phase) && phase.GetString() == "waiting-bot";
                }
            }
        }

        return new UploadProgressSnapshot(confirmed, sending, waiting, count > 0 && allStored, failed);
    }
}
