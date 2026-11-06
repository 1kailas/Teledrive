using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Dispatching;
using TeleDrive_WinUI.Models;

namespace TeleDrive_WinUI.Services;

/// <summary>
/// Legacy transfer progress tracker. Values must only mirror daemon-confirmed bytes;
/// the UI currently reads its transfer models directly instead of running this timer.
/// </summary>
public sealed class TransferProgressEngine
{
    private static readonly Lazy<TransferProgressEngine> _lazy = new(() => new TransferProgressEngine());
    public static TransferProgressEngine Instance => _lazy.Value;

    private readonly ConcurrentDictionary<string, TrackedTransferState> _states = new();
    private DispatcherQueueTimer? _animTimer;
    private DateTime _lastAnimTick = DateTime.UtcNow;
    private readonly object _lock = new();

    public event Action? OnProgressUpdated;

    private TransferProgressEngine()
    {
    }

    /// <summary>
    /// Attach to the UI DispatcherQueue so that the smooth animation loop runs safely on the UI thread.
    /// </summary>
    public void Initialize(DispatcherQueue dispatcherQueue)
    {
        lock (_lock)
        {
            if (_animTimer != null) return;
            _animTimer = dispatcherQueue.CreateTimer();
            _animTimer.Interval = TimeSpan.FromMilliseconds(33); // 30 fps smooth glide
            _animTimer.Tick += AnimTimer_Tick;
        }
    }

    private void EnsureTimerRunning()
    {
        lock (_lock)
        {
            if (_animTimer != null && !_animTimer.IsRunning && _states.Values.Any(s => s.IsActive))
            {
                _lastAnimTick = DateTime.UtcNow;
                _animTimer.Start();
            }
        }
    }

    private void CheckTimerStop()
    {
        lock (_lock)
        {
            if (_animTimer != null && _animTimer.IsRunning && !_states.Values.Any(s => s.IsActive))
            {
                _animTimer.Stop();
            }
        }
    }

    private void AnimTimer_Tick(DispatcherQueueTimer sender, object args)
    {
        var now = DateTime.UtcNow;
        double dt = Math.Clamp((now - _lastAnimTick).TotalSeconds, 0.01, 0.1);
        _lastAnimTick = now;

        bool hasActive = false;

        foreach (var state in _states.Values)
        {
            if (!state.IsActive || state.IsDone || state.IsQueued)
                continue;

            hasActive = true;
            state.TickAnimation(dt);
        }

        if (hasActive)
        {
            OnProgressUpdated?.Invoke();
        }
        else
        {
            CheckTimerStop();
        }
    }

    /// <summary>
    /// Register or update a live TransferTaskModel directly bound to the UI.
    /// </summary>
    public void RegisterOrUpdateTask(TransferTaskModel liveTask)
    {
        var state = _states.GetOrAdd(liveTask.Id, id => new TrackedTransferState(id, liveTask));
        state.LiveModel = liveTask;
        state.UpdateFromModel(liveTask);
        EnsureTimerRunning();
    }

    /// <summary>
    /// Synchronize the collection of live tasks displayed in the UI.
    /// </summary>
    public void SyncLiveTasks(IEnumerable<TransferTaskModel> liveTasks)
    {
        var activeIds = new HashSet<string>();
        foreach (var task in liveTasks)
        {
            activeIds.Add(task.Id);
            RegisterOrUpdateTask(task);
        }

        // Clean up completed/removed tasks
        var toRemove = _states.Keys.Where(k => !activeIds.Contains(k)).ToList();
        foreach (var id in toRemove)
        {
            if (_states.TryGetValue(id, out var st) && (st.IsDone || !st.IsActive))
            {
                _states.TryRemove(id, out _);
            }
        }

        EnsureTimerRunning();
    }

    /// <summary>
    /// Computes accurate aggregate progress percentage across all currently active transfers.
    /// </summary>
    public double GetAggregatePercentage()
    {
        var activeStates = _states.Values.Where(s => s.IsActive && !s.IsDone).ToList();
        if (activeStates.Count == 0) return 0.0;

        ulong totalTransferred = 0;
        ulong totalSize = 0;

        foreach (var s in activeStates)
        {
            totalTransferred += (ulong)s.DisplayTransferred;
            totalSize += s.Size;
        }

        if (totalSize == 0) return 0.0;
        return Math.Clamp((double)totalTransferred / totalSize * 100.0, 0.0, 100.0);
    }
}

/// <summary>
/// Per-task snapshot of the last reported transfer progress.
/// </summary>
public sealed class TrackedTransferState
{
    public string Id { get; }
    public TransferTaskModel LiveModel { get; set; }
    public ulong Size => LiveModel.Size;
    public bool IsUpload => LiveModel.IsUpload;

    public double DisplayTransferred { get; private set; }
    public double TargetTransferred { get; private set; }

    public bool IsDone => LiveModel.IsDone;
    public bool IsQueued => LiveModel.Status == "queued" || LiveModel.Phase == "queued";
    public bool IsActive => LiveModel.IsActive && !IsDone && !IsQueued;

    public TrackedTransferState(string id, TransferTaskModel liveModel)
    {
        Id = id;
        LiveModel = liveModel;
        DisplayTransferred = liveModel.Transferred;
        TargetTransferred = liveModel.Transferred;
    }

    public void UpdateFromModel(TransferTaskModel task)
    {
        LiveModel = task;

        if (task.IsDone)
        {
            DisplayTransferred = task.Size;
            TargetTransferred = task.Size;
            task.Transferred = task.Size;
            return;
        }

        if (task.Status == "queued" || task.Phase == "queued")
        {
            DisplayTransferred = task.Transferred;
            TargetTransferred = task.Transferred;
            return;
        }

        // Snapshot only: never animate beyond bytes confirmed by the daemon.
        TargetTransferred = Math.Min(task.Size > 0 ? task.Size : task.Transferred, task.Transferred);
        DisplayTransferred = TargetTransferred;
    }

    /// <summary>
    /// Keep the snapshot current without inventing in-flight bytes.
    /// </summary>
    public void TickAnimation(double dt)
    {
        if (IsDone || IsQueued || !IsActive) return;

        DisplayTransferred = TargetTransferred;
    }
}
