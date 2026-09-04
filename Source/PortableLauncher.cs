using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Media;
using System.Net;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Wookie's Starwatch")]
[assembly: AssemblyDescription("Informational companion overlay launcher for Stellar Odyssey")]
[assembly: AssemblyCompany("Wookie's Starwatch community project")]
[assembly: AssemblyProduct("Wookie's Starwatch")]
[assembly: AssemblyVersion("2.1.0.0")]
[assembly: AssemblyFileVersion("2.1.0.0")]

internal static class PortableLauncher
{
    internal const string Version = "2.1.0";
    private const string InstanceName = "Local\\StellarOdysseyIntelOverlayLauncher";
    private const string OpenSignalName = "Local\\StellarOdysseyIntelOverlayOpen";
    private const string LicenseResourceName = "WookiesStarwatch.LICENSE.txt";
    internal const string StartupValueName = "Wookie's Starwatch";
    internal const string LegacyStartupValueName = "Stellar Odyssey Intel Overlay";

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 4 && String.Equals(args[0], "--official-api-bridge", StringComparison.Ordinal))
            return OfficialApiBridge.Run(args[1], args[2], args[3]);

        if (args.Length == 1 && String.Equals(args[0], "--self-test", StringComparison.Ordinal))
            return RunSelfTest();

        bool ownsInstance;
        bool createdSignal;
        using (var openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, OpenSignalName, out createdSignal))
        using (var instance = new Mutex(true, InstanceName, out ownsInstance))
        {
            if (!ownsInstance)
            {
                openSignal.Set();
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            PortableLog.Write("Launcher " + Version + " started.");
            using (var context = new PortableLauncherContext(openSignal)) Application.Run(context);
            GC.KeepAlive(instance);
            return 0;
        }
    }

    private static int RunSelfTest()
    {
        try
        {
            var package = PortableUpdater.LoadBestLocal();
            if (package == null || String.IsNullOrWhiteSpace(package.Source) || package.Version == null)
                throw new InvalidOperationException("No usable embedded or cached overlay was found.");
            var license = LoadLicenseText();
            if (license.IndexOf("MIT License", StringComparison.Ordinal) < 0 ||
                license.IndexOf("Wookie's Starwatch contributors", StringComparison.Ordinal) < 0)
                throw new InvalidOperationException("The embedded MIT license notice is missing or invalid.");
            Console.WriteLine("Portable launcher self-test passed.");
            Console.WriteLine("Launcher: " + Version);
            Console.WriteLine("Overlay: " + package.Version + " (" + package.Origin + ")");
            Console.WriteLine("Storage: " + PortablePaths.StorageDirectory);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Portable launcher self-test failed: " + error.Message);
            return 1;
        }
    }

    internal static string LoadLicenseText()
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(LicenseResourceName))
        {
            if (stream == null) throw new InvalidOperationException("The embedded MIT license notice is missing.");
            using (var reader = new StreamReader(stream, Encoding.UTF8, true)) return reader.ReadToEnd();
        }
    }
}

internal sealed class PortableLauncherContext : ApplicationContext
{
    private readonly object packageGate = new object();
    private readonly Control dispatcher;
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem statusItem;
    private readonly ToolStripMenuItem startupItem;
    private readonly System.Threading.Timer monitor;
    private readonly RegisteredWaitHandle openSignalRegistration;
    private PortableOverlayPackage package;
    private OfficialApiBridgeProcess bridge;
    private string activeSocketUrl;
    private int activePort;
    private int busy;
    private int consecutiveMisses;
    private bool disposed;
    private bool firstInjectionNoticeShown;
    private DateTime nextUpdateCheckUtc = DateTime.MinValue;
    private string status = "Starting";

    public PortableLauncherContext(EventWaitHandle openSignal)
    {
        dispatcher = new Control();
        dispatcher.CreateControl();

        statusItem = new ToolStripMenuItem("Status: Starting") { Enabled = false };
        startupItem = new ToolStripMenuItem("Start with Windows") { CheckOnClick = true, Checked = IsStartupEnabled() };
        startupItem.Click += delegate { SetStartupEnabled(startupItem.Checked); };

        var openItem = new ToolStripMenuItem("Open overlay");
        openItem.Click += delegate { QueueCheck(true, false); };
        var updateItem = new ToolStripMenuItem("Check for updates");
        updateItem.Click += delegate { QueueCheck(false, true); };
        var diagnosticsItem = new ToolStripMenuItem("Open diagnostics folder");
        diagnosticsItem.Click += delegate { OpenDiagnostics(); };
        var licenseItem = new ToolStripMenuItem("About and MIT license");
        licenseItem.Click += delegate
        {
            MessageBox.Show(
                "Wookie's Starwatch\r\nLauncher " + PortableLauncher.Version + "\r\n\r\n" + PortableLauncher.LoadLicenseText(),
                "About Wookie's Starwatch",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        };
        var exitItem = new ToolStripMenuItem("Exit");
        exitItem.Click += delegate { ExitThread(); };

        var menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(openItem);
        menu.Items.Add(updateItem);
        menu.Items.Add(startupItem);
        menu.Items.Add(diagnosticsItem);
        menu.Items.Add(licenseItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Wookie's Starwatch - Starting",
            ContextMenuStrip = menu,
            Visible = true
        };
        tray.DoubleClick += delegate { QueueCheck(true, false); };

        try
        {
            package = PortableUpdater.LoadBestLocal();
            PortableLog.Write("Loaded overlay " + package.Version + " from " + package.Origin + ".");
        }
        catch (Exception error)
        {
            PortableLog.Write("Fatal overlay load error: " + error.Message);
            MessageBox.Show(error.Message, "Wookie's Starwatch", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitThread();
            return;
        }

        SetStatus("Waiting for Stellar Odyssey");
        monitor = new System.Threading.Timer(delegate { QueueCheck(false, false); }, null, 100, 2500);
        openSignalRegistration = ThreadPool.RegisterWaitForSingleObject(
            openSignal,
            delegate { QueueCheck(true, false); },
            null,
            Timeout.Infinite,
            false);
        ShowFirstRunHint();
    }

    private void QueueCheck(bool forceOpen, bool forceUpdate)
    {
        if (disposed) return;
        if (Interlocked.CompareExchange(ref busy, 1, 0) != 0) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try { Check(forceOpen, forceUpdate); }
            catch (Exception error)
            {
                PortableLog.Write("Monitor error: " + error.Message);
                SetStatus("Waiting - " + ShortMessage(error.Message));
            }
            finally { Interlocked.Exchange(ref busy, 0); }
        });
    }

    private void Check(bool forceOpen, bool forceUpdate)
    {
        DispatchNativeAlerts();
        var now = DateTime.UtcNow;
        if (forceUpdate || now >= nextUpdateCheckUtc)
        {
            nextUpdateCheckUtc = now.AddMinutes(30);
            RefreshOverlay(forceUpdate);
        }

        int port;
        string socketUrl;
        if (!PortableGame.TryFind(out port, out socketUrl))
        {
            consecutiveMisses++;
            if (consecutiveMisses >= 3)
            {
                NativeAlertStore.Clear();
                StopBridge();
                activeSocketUrl = null;
                activePort = 0;
                SetStatus("Waiting for Stellar Odyssey");
            }
            return;
        }
        consecutiveMisses = 0;

        if (bridge != null && !bridge.IsRunning)
        {
            PortableLog.Write("Local official-API helper stopped unexpectedly; restarting it.");
            bridge = null;
            activeSocketUrl = null;
            activePort = 0;
        }

        var targetChanged = activePort != port || !String.Equals(activeSocketUrl, socketUrl, StringComparison.Ordinal);
        if (targetChanged)
        {
            StopBridge();
        }

        if (bridge == null) bridge = OfficialApiBridgeProcess.Start(port);
        if (!targetChanged && !forceOpen) return;

        PortableOverlayPackage selected;
        lock (packageGate) selected = package;
        PortableGame.Inject(socketUrl, selected, bridge, forceOpen);
        activePort = port;
        activeSocketUrl = socketUrl;
        SetStatus("Active - overlay " + selected.Version);
        PortableLog.Write((targetChanged ? "Injected" : "Opened") + " overlay " + selected.Version + ".");
        if (!firstInjectionNoticeShown)
        {
            firstInjectionNoticeShown = true;
            ShowBalloon("Wookie's Starwatch", "Overlay " + selected.Version + " is active. Double-click the tray icon to open it again.", ToolTipIcon.Info);
        }
    }

    private void DispatchNativeAlerts()
    {
        var now = NativeAlertStore.UtcNowMilliseconds();
        foreach (var alert in NativeAlertStore.TakeDue(now))
        {
            if (alert.BackgroundOnly && PortableGame.IsForeground())
            {
                PortableLog.Write("Native alert suppressed while the game was foreground: " + alert.Id + ".");
                continue;
            }
            if (alert.Desktop) ShowBalloon(alert.Title, alert.Body, ToolTipIcon.Info);
            if (alert.Attention) PortableGame.FlashForAttention();
            if (alert.Sound && alert.Volume > 0) NativeChime.Play(alert.Volume);
            PortableLog.Write("Native alert fired: " + alert.Id + ".");
        }
    }

    private void RefreshOverlay(bool showResult)
    {
        PortableOverlayPackage current;
        lock (packageGate) current = package;
        string message;
        var refreshed = PortableUpdater.TryRefresh(current, out message);
        if (refreshed != null)
        {
            var changed = current == null || refreshed.Version != current.Version || refreshed.Hash != current.Hash;
            lock (packageGate) package = refreshed;
            if (changed)
            {
                PortableLog.Write("Selected overlay " + refreshed.Version + " from " + refreshed.Origin + ".");
                activeSocketUrl = null;
            }
        }
        if (!String.IsNullOrWhiteSpace(message)) PortableLog.Write(message);
        if (showResult)
        {
            var warning = refreshed == null || (message ?? "").StartsWith("Update check skipped", StringComparison.Ordinal) ||
                (message ?? "").IndexOf("needs launcher", StringComparison.OrdinalIgnoreCase) >= 0;
            ShowBalloon("Starwatch update", message, warning ? ToolTipIcon.Warning : ToolTipIcon.Info);
        }
    }

    private void SetStatus(string value)
    {
        status = value;
        Post(delegate
        {
            statusItem.Text = "Status: " + status;
            var tooltip = "Wookie's Starwatch - " + status;
            tray.Text = tooltip.Substring(0, Math.Min(63, tooltip.Length));
        });
    }

    private void ShowBalloon(string title, string text, ToolTipIcon icon)
    {
        Post(delegate
        {
            tray.BalloonTipTitle = title;
            tray.BalloonTipText = ShortMessage(text);
            tray.BalloonTipIcon = icon;
            tray.ShowBalloonTip(5000);
        });
    }

    private void ShowFirstRunHint()
    {
        if (File.Exists(PortablePaths.FirstRunMarker)) return;
        try
        {
            Directory.CreateDirectory(PortablePaths.StorageDirectory);
            File.WriteAllText(PortablePaths.FirstRunMarker, DateTime.UtcNow.ToString("o"), Encoding.UTF8);
        }
        catch { }
        ShowBalloon("Wookie's Starwatch is running", "It will wait for Stellar Odyssey in the tray. Enable Start with Windows from the tray menu if you want it ready after every sign-in.", ToolTipIcon.Info);
    }

    private static string ShortMessage(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return "No additional details are available.";
        value = Regex.Replace(value, "\\s+", " ").Trim();
        return value.Substring(0, Math.Min(180, value.Length));
    }

    private void Post(Action action)
    {
        if (disposed) return;
        try
        {
            if (dispatcher.InvokeRequired) dispatcher.BeginInvoke(action);
            else action();
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    private void OpenDiagnostics()
    {
        try
        {
            Directory.CreateDirectory(PortablePaths.StorageDirectory);
            Process.Start(new ProcessStartInfo
            {
                FileName = PortablePaths.StorageDirectory,
                UseShellExecute = true
            });
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Starwatch diagnostics", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private static bool IsStartupEnabled()
    {
        try
        {
            string value;
            using (var key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", false))
            {
                value = key == null ? null : Convert.ToString(key.GetValue(PortableLauncher.StartupValueName));
                if (String.IsNullOrWhiteSpace(value) && key != null)
                    value = Convert.ToString(key.GetValue(PortableLauncher.LegacyStartupValueName));
            }
            if (String.IsNullOrWhiteSpace(value)) return false;
            var expected = Quote(Assembly.GetExecutingAssembly().Location);
            using (var key = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run"))
            {
                key.SetValue(PortableLauncher.StartupValueName, expected, RegistryValueKind.String);
                key.DeleteValue(PortableLauncher.LegacyStartupValueName, false);
            }
            if (!String.Equals(value, expected, StringComparison.OrdinalIgnoreCase))
                PortableLog.Write("Updated the existing Start with Windows entry to this launcher location.");
            return true;
        }
        catch { return false; }
    }

    private void SetStartupEnabled(bool enabled)
    {
        try
        {
            using (var key = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run"))
            {
                if (enabled) key.SetValue(PortableLauncher.StartupValueName, Quote(Assembly.GetExecutingAssembly().Location), RegistryValueKind.String);
                else key.DeleteValue(PortableLauncher.StartupValueName, false);
                key.DeleteValue(PortableLauncher.LegacyStartupValueName, false);
            }
            PortableLog.Write("Start with Windows " + (enabled ? "enabled." : "disabled."));
        }
        catch (Exception error)
        {
            startupItem.Checked = !enabled;
            MessageBox.Show(error.Message, "Starwatch startup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private static string Quote(string value) { return "\"" + value + "\""; }

    private void StopBridge()
    {
        var value = bridge;
        bridge = null;
        if (value != null) value.Stop();
    }

    protected override void ExitThreadCore()
    {
        disposed = true;
        if (monitor != null) monitor.Dispose();
        if (openSignalRegistration != null) openSignalRegistration.Unregister(null);
        StopBridge();
        tray.Visible = false;
        tray.Dispose();
        dispatcher.Dispose();
        PortableLog.Write("Launcher stopped.");
        base.ExitThreadCore();
    }

    public new void Dispose()
    {
        if (!disposed) ExitThreadCore();
        base.Dispose();
    }
}

internal static class PortableGame
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
    private const uint FlashTray = 0x00000002;
    private const uint FlashTimerNoForeground = 0x0000000C;

    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo
    {
        public uint Size;
        public IntPtr Window;
        public uint Flags;
        public uint Count;
        public uint Timeout;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlashWindowEx(ref FlashInfo info);

    private static List<IntPtr> GameWindows()
    {
        var windows = new List<IntPtr>();
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                if (process.MainWindowHandle != IntPtr.Zero &&
                    process.MainWindowTitle.IndexOf("Stellar Odyssey", StringComparison.OrdinalIgnoreCase) >= 0)
                    windows.Add(process.MainWindowHandle);
            }
            catch { }
            finally { process.Dispose(); }
        }
        return windows;
    }

    public static bool IsForeground()
    {
        var foreground = GetForegroundWindow();
        return foreground != IntPtr.Zero && GameWindows().Any(window => window == foreground);
    }

    public static void FlashForAttention()
    {
        foreach (var window in GameWindows())
        {
            var info = new FlashInfo
            {
                Size = (uint)Marshal.SizeOf(typeof(FlashInfo)),
                Window = window,
                Flags = FlashTray | FlashTimerNoForeground,
                Count = 5,
                Timeout = 0,
            };
            try { FlashWindowEx(ref info); }
            catch { }
        }
    }

    public static bool TryFind(out int port, out string socketUrl)
    {
        port = 0;
        socketUrl = null;
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var portFile = Path.Combine(appData, "Stellar Odyssey Game", "DevToolsActivePort");
        if (!File.Exists(portFile)) return false;

        string portText;
        try { portText = File.ReadLines(portFile).FirstOrDefault(); }
        catch { return false; }
        if (!Int32.TryParse(portText, out port) || port < 1 || port > 65535) return false;

        try
        {
            string targetJson;
            using (var client = new WebClient { Proxy = null }) targetJson = client.DownloadString("http://127.0.0.1:" + port + "/json/list");
            var targets = Json.DeserializeObject(targetJson) as object[];
            var page = targets == null
                ? null
                : targets.OfType<Dictionary<string, object>>().FirstOrDefault(target =>
                    String.Equals(Convert.ToString(Value(target, "type")), "page", StringComparison.OrdinalIgnoreCase) &&
                    Convert.ToString(Value(target, "title")).IndexOf("Stellar Odyssey", StringComparison.OrdinalIgnoreCase) >= 0);
            if (page == null) return false;
            var candidate = Convert.ToString(Value(page, "webSocketDebuggerUrl"));
            Uri uri;
            if (!Uri.TryCreate(candidate, UriKind.Absolute, out uri) || uri.Scheme != "ws" ||
                !(uri.Host == "127.0.0.1" || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase))) return false;
            socketUrl = candidate;
            return true;
        }
        catch { return false; }
    }

    public static void Inject(string socketUrl, PortableOverlayPackage package, OfficialApiBridgeProcess bridge, bool forceOpen)
    {
        var nativeBridge = new Dictionary<string, object>
        {
            { "baseUrl", bridge.BaseUrl },
            { "token", bridge.SessionToken },
            { "launcherVersion", PortableLauncher.Version }
        };
        var expression = "(async function(){" +
            "var desired=" + Json.Serialize(package.Version.ToString()) + ";" +
            "var existing=window.__stellarOdysseyIntelOverlay;" +
            "window.__soIntelNativeBridge=" + Json.Serialize(nativeBridge) + ";" +
            "if(existing&&existing.version===desired){if(" + (forceOpen ? "true" : "false") + "&&typeof existing.show==='function')existing.show();return {ok:true,reused:true,version:desired};}" +
            "if(existing&&typeof existing.destroy==='function')existing.destroy();" +
            "return await (0,eval)(" + Json.Serialize(package.Source) + ");" +
            "})()";
        Evaluate(socketUrl, expression);
    }

    private static void Evaluate(string socketUrl, string expression)
    {
        Uri socketUri;
        if (!Uri.TryCreate(socketUrl, UriKind.Absolute, out socketUri)) throw new InvalidOperationException("The game renderer address is invalid.");
        var request = new Dictionary<string, object>
        {
            { "id", 1 },
            { "method", "Runtime.evaluate" },
            { "params", new Dictionary<string, object>
                {
                    { "expression", expression },
                    { "awaitPromise", true },
                    { "returnByValue", true }
                }
            }
        };

        using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
        using (var socket = new ClientWebSocket())
        {
            socket.ConnectAsync(socketUri, timeout.Token).GetAwaiter().GetResult();
            var bytes = Encoding.UTF8.GetBytes(Json.Serialize(request));
            socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, timeout.Token).GetAwaiter().GetResult();
            Dictionary<string, object> response = null;
            while (response == null)
            {
                var text = ReceiveText(socket, timeout.Token);
                var message = Json.DeserializeObject(text) as Dictionary<string, object>;
                if (message != null && Convert.ToInt32(Value(message, "id") ?? 0) == 1) response = message;
            }
            if (response.ContainsKey("error")) throw new InvalidOperationException("The renderer rejected the overlay.");
            var result = Value(response, "result") as Dictionary<string, object>;
            if (result != null && result.ContainsKey("exceptionDetails"))
                throw new InvalidOperationException("The overlay reported a script error: " + Json.Serialize(result["exceptionDetails"]));
            if (socket.State == WebSocketState.Open)
                socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Overlay ready", CancellationToken.None).GetAwaiter().GetResult();
        }
    }

    private static string ReceiveText(ClientWebSocket socket, CancellationToken token)
    {
        var buffer = new byte[65536];
        using (var stream = new MemoryStream())
        {
            WebSocketReceiveResult received;
            do
            {
                received = socket.ReceiveAsync(new ArraySegment<byte>(buffer), token).GetAwaiter().GetResult();
                if (received.MessageType == WebSocketMessageType.Close) throw new InvalidOperationException("The game closed its local renderer connection.");
                stream.Write(buffer, 0, received.Count);
            } while (!received.EndOfMessage);
            return Encoding.UTF8.GetString(stream.ToArray());
        }
    }

    private static object Value(Dictionary<string, object> dictionary, string key)
    {
        object value;
        return dictionary != null && dictionary.TryGetValue(key, out value) ? value : null;
    }
}

internal static class NativeChime
{
    public static void Play(double volume)
    {
        try
        {
            volume = Math.Max(0, Math.Min(1, volume));
            if (volume <= 0) return;
            const int sampleRate = 22050;
            const double toneSeconds = 0.22;
            const double gapSeconds = 0.045;
            var frequencies = new[] { 659.25, 783.99, 987.77 };
            var toneSamples = (int)(sampleRate * toneSeconds);
            var gapSamples = (int)(sampleRate * gapSeconds);
            var sampleCount = frequencies.Length * toneSamples + (frequencies.Length - 1) * gapSamples;
            using (var stream = new MemoryStream())
            using (var writer = new BinaryWriter(stream, Encoding.ASCII, true))
            {
                writer.Write(Encoding.ASCII.GetBytes("RIFF"));
                writer.Write(36 + sampleCount * 2);
                writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
                writer.Write(16);
                writer.Write((short)1);
                writer.Write((short)1);
                writer.Write(sampleRate);
                writer.Write(sampleRate * 2);
                writer.Write((short)2);
                writer.Write((short)16);
                writer.Write(Encoding.ASCII.GetBytes("data"));
                writer.Write(sampleCount * 2);
                for (var tone = 0; tone < frequencies.Length; tone++)
                {
                    for (var sample = 0; sample < toneSamples; sample++)
                    {
                        var position = sample / (double)toneSamples;
                        var envelope = Math.Min(1, position / 0.08) * Math.Min(1, (1 - position) / 0.22);
                        var value = Math.Sin(2 * Math.PI * frequencies[tone] * sample / sampleRate);
                        writer.Write((short)(value * envelope * volume * 9000));
                    }
                    if (tone < frequencies.Length - 1)
                        for (var sample = 0; sample < gapSamples; sample++) writer.Write((short)0);
                }
                writer.Flush();
                stream.Position = 0;
                using (var player = new SoundPlayer(stream)) player.PlaySync();
            }
        }
        catch
        {
            try { SystemSounds.Asterisk.Play(); }
            catch { }
        }
    }
}

internal static class PortableUpdater
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
    private const string ResourceName = "WookiesStarwatch.overlay.js";
    private const string ManifestUrl = "https://stellar-odyssey-intel-sync.sthess28.workers.dev/updates/manifest.json";
    private const string UpdateHost = "stellar-odyssey-intel-sync.sthess28.workers.dev";
    private const string PublicKey = "<RSAKeyValue><Modulus>qdHNT6Oeu2ON9sMOMvvK+C8z/xle21JIMw9dCxVj7b00NSTLzsX1BcBtVfosAyHiDoic5oTjtQZYZMyWS0YHIRvgN30k1AJ5zewcAevVhdcdlIdX0uyDsonY0S6+fJYiIa92jPByNnFMd0kQDJV6yBGaGIivX1TXlsXow0Oi21lwxib+WcgLSXlba9Gnq4yPO/gs/o6Jk5/8PoOIZSDWRw2efoicOxGTltu0+su3AHClZNQaPRhx2sbmAB1AcRK/nq8pDL7goNasoC8LT6bbRBPGKabGIR+X7WbvFbxDMDpHZDAvMPL3bJsHK/sqQgl5BPiGN9UbOttI1loXmOLHzQ==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>";

    public static PortableOverlayPackage LoadBestLocal()
    {
        var embedded = LoadEmbedded();
        PortableOverlayPackage cached;
        string ignored;
        if (TryLoadCache(out cached, out ignored) && cached.Version >= embedded.Version) return cached;
        return embedded;
    }

    public static PortableOverlayPackage TryRefresh(PortableOverlayPackage current, out string message)
    {
        try
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            var manifestBytes = DownloadLimited(ManifestUrl, 65536);
            var manifest = ParseAndVerifyManifest(manifestBytes);
            Version launcherVersion;
            Version.TryParse(PortableLauncher.Version, out launcherVersion);
            if (manifest.MinimumLauncher > launcherVersion)
            {
                message = "Overlay " + manifest.Version + " needs launcher " + manifest.MinimumLauncher + " or newer. Your current overlay remains available.";
                return current;
            }
            if (current != null && manifest.Version < current.Version)
            {
                message = "You already have a newer overlay than the update channel.";
                return current;
            }
            if (current != null && manifest.Version == current.Version && manifest.Hash != current.Hash)
                throw new InvalidOperationException("The update channel attempted to replace an existing version. A higher overlay version is required.");
            if (current != null && manifest.Version == current.Version && manifest.Hash == current.Hash)
            {
                message = "Overlay " + current.Version + " is up to date.";
                return current;
            }

            var overlayBytes = DownloadLimited(manifest.OverlayUrl, 1048576);
            if (Sha256(overlayBytes) != manifest.Hash) throw new InvalidOperationException("The downloaded overlay did not match its signed checksum.");
            var source = Encoding.UTF8.GetString(overlayBytes);
            Version sourceVersion;
            if (!TryReadOverlayVersion(source, out sourceVersion) || sourceVersion != manifest.Version)
                throw new InvalidOperationException("The downloaded overlay version did not match its signed manifest.");

            Directory.CreateDirectory(PortablePaths.UpdateDirectory);
            ReplaceFileAtomically(PortablePaths.CachedOverlayPath, overlayBytes);
            ReplaceFileAtomically(PortablePaths.CachedManifestPath, manifestBytes);
            var refreshed = new PortableOverlayPackage(source, sourceVersion, manifest.Hash, "verified update cache");
            message = "Updated to overlay " + sourceVersion + ".";
            return refreshed;
        }
        catch (Exception error)
        {
            message = "Update check skipped; using the verified local overlay. " + error.Message;
            return current;
        }
    }

    private static PortableOverlayPackage LoadEmbedded()
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName))
        {
            if (stream == null) throw new InvalidOperationException("The built-in overlay resource is missing.");
            using (var output = new MemoryStream())
            {
                stream.CopyTo(output);
                var bytes = output.ToArray();
                var source = Encoding.UTF8.GetString(bytes);
                Version version;
                if (!TryReadOverlayVersion(source, out version)) throw new InvalidOperationException("The built-in overlay version is invalid.");
                return new PortableOverlayPackage(source, version, Sha256(bytes), "built-in fallback");
            }
        }
    }

    private static bool TryLoadCache(out PortableOverlayPackage package, out string error)
    {
        package = null;
        error = null;
        try
        {
            if (!File.Exists(PortablePaths.CachedManifestPath) || !File.Exists(PortablePaths.CachedOverlayPath)) return false;
            var manifest = ParseAndVerifyManifest(File.ReadAllBytes(PortablePaths.CachedManifestPath));
            Version launcherVersion;
            Version.TryParse(PortableLauncher.Version, out launcherVersion);
            if (manifest.MinimumLauncher > launcherVersion) throw new InvalidOperationException("The cached overlay needs a newer launcher.");
            var bytes = File.ReadAllBytes(PortablePaths.CachedOverlayPath);
            if (Sha256(bytes) != manifest.Hash) throw new InvalidOperationException("The cached overlay checksum is invalid.");
            var source = Encoding.UTF8.GetString(bytes);
            Version sourceVersion;
            if (!TryReadOverlayVersion(source, out sourceVersion) || sourceVersion != manifest.Version)
                throw new InvalidOperationException("The cached overlay version is invalid.");
            package = new PortableOverlayPackage(source, sourceVersion, manifest.Hash, "verified update cache");
            return true;
        }
        catch (Exception value)
        {
            error = value.Message;
            PortableLog.Write("Ignored invalid update cache: " + error);
            return false;
        }
    }

    private static PortableSignedManifest ParseAndVerifyManifest(byte[] bytes)
    {
        var value = Json.DeserializeObject(Encoding.UTF8.GetString(bytes)) as Dictionary<string, object>;
        if (value == null) throw new InvalidOperationException("The update manifest is invalid.");
        var versionText = Convert.ToString(Get(value, "version"));
        var overlayUrl = Convert.ToString(Get(value, "overlayUrl"));
        var hash = Convert.ToString(Get(value, "sha256")).ToUpperInvariant();
        var minimumText = Convert.ToString(Get(value, "minimumLauncherVersion"));
        var publishedAt = Convert.ToString(Get(value, "publishedAt"));
        var signatureText = Convert.ToString(Get(value, "signature"));
        Version version;
        Version minimum;
        Uri uri;
        if (!Version.TryParse(versionText, out version) || !Version.TryParse(minimumText, out minimum) ||
            !Uri.TryCreate(overlayUrl, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps ||
            !uri.Host.Equals(UpdateHost, StringComparison.OrdinalIgnoreCase) ||
            !uri.AbsolutePath.StartsWith("/updates/", StringComparison.Ordinal) ||
            !Regex.IsMatch(hash, "^[A-F0-9]{64}$"))
            throw new InvalidOperationException("The update manifest contains unsafe values.");
        byte[] signature;
        try { signature = Convert.FromBase64String(signatureText); }
        catch (FormatException) { throw new InvalidOperationException("The update signature is invalid."); }
        var signedText = versionText + "\n" + overlayUrl + "\n" + hash + "\n" + minimumText + "\n" + publishedAt + "\n";
        if (!VerifySignature(Encoding.UTF8.GetBytes(signedText), signature))
            throw new InvalidOperationException("The update signature was not trusted.");
        return new PortableSignedManifest(version, minimum, overlayUrl, hash);
    }

    private static byte[] DownloadLimited(string address, int maximumBytes)
    {
        var request = WebRequest.CreateHttp(address);
        request.Method = "GET";
        request.Proxy = null;
        request.Timeout = 7000;
        request.ReadWriteTimeout = 7000;
        request.UserAgent = "WookiesStarwatchUpdater/" + PortableLauncher.Version;
        request.Headers[HttpRequestHeader.CacheControl] = "no-cache";
        using (var response = (HttpWebResponse)request.GetResponse())
        {
            if (response.StatusCode != HttpStatusCode.OK) throw new WebException("Update server returned HTTP " + (int)response.StatusCode + ".");
            if (response.ContentLength > maximumBytes) throw new InvalidOperationException("The update download is too large.");
            using (var input = response.GetResponseStream())
            using (var output = new MemoryStream())
            {
                var buffer = new byte[16384];
                int read;
                while (input != null && (read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (output.Length + read > maximumBytes) throw new InvalidOperationException("The update download is too large.");
                    output.Write(buffer, 0, read);
                }
                return output.ToArray();
            }
        }
    }

    private static bool VerifySignature(byte[] value, byte[] signature)
    {
        var parameters = new CspParameters { ProviderType = 24 };
        using (var rsa = new RSACryptoServiceProvider(parameters))
        {
            rsa.PersistKeyInCsp = false;
            rsa.FromXmlString(PublicKey);
            return rsa.VerifyData(value, CryptoConfig.MapNameToOID("SHA256"), signature);
        }
    }

    private static bool TryReadOverlayVersion(string source, out Version version)
    {
        version = null;
        var match = Regex.Match(source ?? "", "const\\s+VERSION\\s*=\\s*[\"']([0-9]+(?:\\.[0-9]+){1,3})[\"']");
        return match.Success && Version.TryParse(match.Groups[1].Value, out version);
    }

    private static string Sha256(byte[] value)
    {
        using (var algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(value)).Replace("-", "");
    }

    private static void ReplaceFileAtomically(string targetPath, byte[] content)
    {
        var temporaryPath = targetPath + ".download";
        var backupPath = targetPath + ".previous";
        try
        {
            File.WriteAllBytes(temporaryPath, content);
            if (File.Exists(targetPath))
            {
                if (File.Exists(backupPath)) File.Delete(backupPath);
                File.Replace(temporaryPath, targetPath, backupPath, true);
                if (File.Exists(backupPath)) File.Delete(backupPath);
            }
            else File.Move(temporaryPath, targetPath);
        }
        finally { if (File.Exists(temporaryPath)) File.Delete(temporaryPath); }
    }

    private static object Get(Dictionary<string, object> dictionary, string key)
    {
        object value;
        return dictionary != null && dictionary.TryGetValue(key, out value) ? value : null;
    }
}

internal sealed class PortableOverlayPackage
{
    public readonly string Source;
    public readonly Version Version;
    public readonly string Hash;
    public readonly string Origin;

    public PortableOverlayPackage(string source, Version version, string hash, string origin)
    {
        Source = source;
        Version = version;
        Hash = hash;
        Origin = origin;
    }
}

internal sealed class PortableSignedManifest
{
    public readonly Version Version;
    public readonly Version MinimumLauncher;
    public readonly string OverlayUrl;
    public readonly string Hash;

    public PortableSignedManifest(Version version, Version minimumLauncher, string overlayUrl, string hash)
    {
        Version = version;
        MinimumLauncher = minimumLauncher;
        OverlayUrl = overlayUrl;
        Hash = hash;
    }
}

internal static class PortablePaths
{
    public static readonly string StorageDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Stellar Odyssey Intel Overlay");
    public static readonly string UpdateDirectory = Path.Combine(StorageDirectory, "updates");
    public static readonly string CachedOverlayPath = Path.Combine(UpdateDirectory, "overlay.js");
    public static readonly string CachedManifestPath = Path.Combine(UpdateDirectory, "manifest.json");
    public static readonly string LogPath = Path.Combine(StorageDirectory, "launcher.log");
    public static readonly string FirstRunMarker = Path.Combine(StorageDirectory, "launcher-v2-seen.txt");
}

internal static class PortableLog
{
    private static readonly object Gate = new object();

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(PortablePaths.StorageDirectory);
                if (File.Exists(PortablePaths.LogPath) && new FileInfo(PortablePaths.LogPath).Length > 524288)
                    File.WriteAllText(PortablePaths.LogPath, "Log truncated at " + DateTime.UtcNow.ToString("o") + Environment.NewLine, Encoding.UTF8);
                File.AppendAllText(PortablePaths.LogPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch { }
    }
}
