using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.Foundation;
using Windows.Foundation.Collections;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.UI.Xaml.Shapes;
using TeleDrive_WinUI.Services;

namespace TeleDrive_WinUI;

/// <summary>
/// Provides application-specific behavior to supplement the default Application class.
/// </summary>
public partial class App : Application
{
    private Window? _window;
    public static Window? CurrentWindow { get; private set; }
    private static Mutex? _singleInstanceMutex;
    public static List<string> InitialLaunchPaths { get; } = new();

    /// <summary>
    /// Initializes the singleton application object.  This is the first line of authored code
    /// executed, and as such is the logical equivalent of main() or WinMain().
    /// </summary>
    public App()
    {
        var rawArgs = Environment.GetCommandLineArgs();

        if (rawArgs.Any(a => a.Equals("--register-shell", StringComparison.OrdinalIgnoreCase)))
        {
            ShellIntegrationService.RegisterShellIntegration();
            Environment.Exit(0);
            return;
        }
        if (rawArgs.Any(a => a.Equals("--unregister-shell", StringComparison.OrdinalIgnoreCase)))
        {
            ShellIntegrationService.UnregisterShellIntegration();
            Environment.Exit(0);
            return;
        }

        var incomingPaths = ShellIntegrationService.ExtractPathsFromArgs(rawArgs);

        _singleInstanceMutex = new Mutex(true, ShellIntegrationService.MutexName, out bool createdNew);
        if (!createdNew)
        {
            if (incomingPaths.Count > 0)
            {
                ShellIntegrationService.TrySendToExistingInstance(incomingPaths);
            }
            ShellIntegrationService.BringExistingWindowToFront();
            Environment.Exit(0);
            return;
        }

        if (incomingPaths.Count > 0)
        {
            InitialLaunchPaths.AddRange(incomingPaths);
        }

        InitializeComponent();

        UnhandledException += (sender, e) =>
        {
            try
            {
                var dir = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TeleDrive");
                System.IO.Directory.CreateDirectory(dir);
                System.IO.File.AppendAllText(System.IO.Path.Combine(dir, "crash.log"),
                    $"[{DateTime.UtcNow:O}] XAML UnhandledException: {e.Message}\n{e.Exception}\n{e.Exception?.StackTrace}\n\n");
            }
            catch { }
            e.Handled = true;
        };

        AppDomain.CurrentDomain.UnhandledException += (sender, e) =>
        {
            try
            {
                var dir = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TeleDrive");
                System.IO.Directory.CreateDirectory(dir);
                System.IO.File.AppendAllText(System.IO.Path.Combine(dir, "crash.log"),
                    $"[{DateTime.UtcNow:O}] AppDomain UnhandledException: {e.ExceptionObject}\n\n");
            }
            catch { }
        };
    }

    /// <summary>
    /// Invoked when the application is launched.
    /// </summary>
    /// <param name="args">Details about the launch request and process.</param>
    protected override void OnLaunched(Microsoft.UI.Xaml.LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        CurrentWindow = _window;
        _window.Activate();

        // Start pipe server to receive incoming files/folders from Explorer context menu and SendTo
        var dispatcher = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread();
        ShellIntegrationService.StartPipeServer(dispatcher, (paths) =>
        {
            if (MainPage.Current != null) MainPage.Current.QueueExternalPaths(paths);
            else InitialLaunchPaths.AddRange(paths);
        });

        _window.Closed += (s, e) =>
        {
            ShellIntegrationService.StopPipeServer();
            _singleInstanceMutex?.Dispose();
        };
    }
}
