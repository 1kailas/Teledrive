using System;
using System.Runtime.InteropServices;

namespace TeleDrive_WinUI.Services;

public enum TaskbarProgressState
{
    NoProgress = 0,
    Indeterminate = 0x1,
    Normal = 0x2,
    Error = 0x4,
    Paused = 0x8
}

[ComImport]
[Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ITaskbarList3
{
    [PreserveSig] void HrInit();
    [PreserveSig] void AddTab(IntPtr hwnd);
    [PreserveSig] void DeleteTab(IntPtr hwnd);
    [PreserveSig] void ActivateTab(IntPtr hwnd);
    [PreserveSig] void SetActiveAlt(IntPtr hwnd);
    [PreserveSig] void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
    [PreserveSig] void SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
    [PreserveSig] void SetProgressState(IntPtr hwnd, TaskbarProgressState tbpFlags);
}

[ComImport]
[Guid("56fdf344-fd6d-11d0-958a-006097c5144e")]
internal class TaskbarListCoClass
{
}

public static class TaskbarProgressService
{
    private static ITaskbarList3? _taskbar;
    private static bool _initialized;

    public static void Initialize()
    {
        if (_initialized) return;
        try
        {
            _taskbar = (ITaskbarList3)new TaskbarListCoClass();
            _taskbar.HrInit();
            _initialized = true;
        }
        catch
        {
            _initialized = false;
        }
    }

    public static void SetProgress(IntPtr hwnd, ulong completed, ulong total, TaskbarProgressState state = TaskbarProgressState.Normal)
    {
        if (!_initialized) Initialize();
        try
        {
            if (_taskbar != null && hwnd != IntPtr.Zero)
            {
                _taskbar.SetProgressState(hwnd, state);
                if (state == TaskbarProgressState.Normal && total > 0)
                {
                    _taskbar.SetProgressValue(hwnd, completed, total);
                }
            }
        }
        catch { }
    }

    public static void Clear(IntPtr hwnd)
    {
        if (!_initialized) Initialize();
        try
        {
            if (_taskbar != null && hwnd != IntPtr.Zero)
            {
                _taskbar.SetProgressState(hwnd, TaskbarProgressState.NoProgress);
            }
        }
        catch { }
    }
}
