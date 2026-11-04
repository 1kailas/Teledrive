using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using TeleDrive_WinUI.Services;

namespace TeleDrive_WinUI;

public sealed partial class MainWindow : Window
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    private const int SW_RESTORE = 9;

    public static void BringToForeground()
    {
        if (WindowHandle != IntPtr.Zero)
        {
            ShowWindow(WindowHandle, SW_RESTORE);
            SetForegroundWindow(WindowHandle);
        }
    }

    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_TOPMOST = 0x00000008L;
    private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;

    public static IntPtr WindowHandle { get; private set; }

    public MainWindow()
    {
        InitializeComponent();

        Title = "TeleDrive";
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        if (AppTitleBar != null)
        {
            AppTitleBar.Title = "TeleDrive";
        }

        try
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
            WindowHandle = hwnd;

            // Strip any WS_EX_TOPMOST style and force standard native Z-order (HWND_NOTOPMOST)
            long exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
            if ((exStyle & WS_EX_TOPMOST) != 0)
            {
                SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(exStyle & ~WS_EX_TOPMOST));
            }
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);

            var windowId = Microsoft.UI.Win32Interop.GetWindowIdFromWindow(hwnd);
            var appWindow = AppWindow.GetFromWindowId(windowId);
            if (appWindow != null)
            {
                appWindow.Title = "TeleDrive";

                var presenter = appWindow.Presenter as OverlappedPresenter;
                if (presenter != null)
                {
                    presenter.IsAlwaysOnTop = false; // Strictly standard Z-order (goes back when other windows are focused)
                    presenter.IsResizable = true;
                    presenter.IsMinimizable = true;
                    presenter.IsMaximizable = true;
                }

                var iconPath = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico");
                if (File.Exists(iconPath))
                {
                    appWindow.SetIcon(iconPath);
                }

                // Restore saved geometry from config
                var cfg = AppConfigService.Current;
                var displayArea = DisplayArea.GetFromWindowId(windowId, DisplayAreaFallback.Primary);
                if (displayArea != null)
                {
                    int width = (cfg.WindowWidth >= 640 && cfg.WindowWidth <= displayArea.WorkArea.Width)
                        ? cfg.WindowWidth
                        : Math.Min(1280, (int)(displayArea.WorkArea.Width * 0.85));

                    int height = (cfg.WindowHeight >= 480 && cfg.WindowHeight <= displayArea.WorkArea.Height)
                        ? cfg.WindowHeight
                        : Math.Min(820, (int)(displayArea.WorkArea.Height * 0.85));

                    int x = cfg.WindowX >= displayArea.WorkArea.X && (cfg.WindowX + width) <= (displayArea.WorkArea.X + displayArea.WorkArea.Width)
                        ? cfg.WindowX
                        : (displayArea.WorkArea.Width - width) / 2 + displayArea.WorkArea.X;

                    int y = cfg.WindowY >= displayArea.WorkArea.Y && (cfg.WindowY + height) <= (displayArea.WorkArea.Y + displayArea.WorkArea.Height)
                        ? cfg.WindowY
                        : (displayArea.WorkArea.Height - height) / 2 + displayArea.WorkArea.Y;

                    appWindow.MoveAndResize(new Windows.Graphics.RectInt32(x, y, width, height));
                }

                if (cfg.IsMaximized && presenter != null)
                {
                    presenter.Maximize();
                }

                DispatcherTimer? saveGeometryDebounceTimer = null;

                appWindow.Changed += (sender, args) =>
                {
                    try
                    {
                        if (presenter != null)
                        {
                            if (presenter.State == OverlappedPresenterState.Maximized)
                            {
                                cfg.IsMaximized = true;
                            }
                            else if (presenter.State == OverlappedPresenterState.Restored)
                            {
                                cfg.IsMaximized = false;
                                if (args.DidPositionChange)
                                {
                                    cfg.WindowX = appWindow.Position.X;
                                    cfg.WindowY = appWindow.Position.Y;
                                }
                                if (args.DidSizeChange)
                                {
                                    cfg.WindowWidth = appWindow.Size.Width;
                                    cfg.WindowHeight = appWindow.Size.Height;
                                }
                            }

                            if (saveGeometryDebounceTimer == null)
                            {
                                saveGeometryDebounceTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
                                saveGeometryDebounceTimer.Tick += (tSender, tArgs) =>
                                {
                                    saveGeometryDebounceTimer?.Stop();
                                    AppConfigService.Save();
                                };
                            }
                            saveGeometryDebounceTimer.Stop();
                            saveGeometryDebounceTimer.Start();
                        }
                    }
                    catch { }
                };

                this.Closed += (sender, args) =>
                {
                    try
                    {
                        saveGeometryDebounceTimer?.Stop();
                        AppConfigService.Save();
                    }
                    catch { }
                };
            }
        }
        catch { }

        RootFrame.Navigate(typeof(MainPage));
    }
}
