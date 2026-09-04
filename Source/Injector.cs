using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Diagnostics;

internal static class Injector
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    private const string LauncherVersion = "2.1.0";
    private const string UpdateManifestUrl = "https://stellar-odyssey-intel-sync.sthess28.workers.dev/updates/manifest.json";
    private const string UpdateHost = "stellar-odyssey-intel-sync.sthess28.workers.dev";
    private const string UpdatePublicKey = "<RSAKeyValue><Modulus>qdHNT6Oeu2ON9sMOMvvK+C8z/xle21JIMw9dCxVj7b00NSTLzsX1BcBtVfosAyHiDoic5oTjtQZYZMyWS0YHIRvgN30k1AJ5zewcAevVhdcdlIdX0uyDsonY0S6+fJYiIa92jPByNnFMd0kQDJV6yBGaGIivX1TXlsXow0Oi21lwxib+WcgLSXlba9Gnq4yPO/gs/o6Jk5/8PoOIZSDWRw2efoicOxGTltu0+su3AHClZNQaPRhx2sbmAB1AcRK/nq8pDL7goNasoC8LT6bbRBPGKabGIR+X7WbvFbxDMDpHZDAvMPL3bJsHK/sqQgl5BPiGN9UbOttI1loXmOLHzQ==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>";

    private static int Main(string[] args)
    {
        if (args.Length == 4 && String.Equals(args[0], "--official-api-bridge", StringComparison.Ordinal))
            return OfficialApiBridge.Run(args[1], args[2], args[3]);

        OfficialApiBridgeProcess bridge = null;
        try
        {
            var baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            var overlayPath = Path.Combine(baseDirectory, "overlay.js");
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var portFile = Path.Combine(appData, "Stellar Odyssey Game", "DevToolsActivePort");
            var updateMessage = TryUpdateOverlay(overlayPath);

            if (!File.Exists(overlayPath))
                throw new InvalidOperationException("overlay.js was not found and a verified copy could not be downloaded.");
            if (!File.Exists(portFile))
                throw new InvalidOperationException("Stellar Odyssey is not running, or its local renderer port is unavailable. Start the Steam game first.");

            var portText = File.ReadLines(portFile).FirstOrDefault();
            int port;
            if (!int.TryParse(portText, out port) || port < 1 || port > 65535)
                throw new InvalidOperationException("The game's renderer port file is invalid. Restart Stellar Odyssey and try again.");

            bridge = OfficialApiBridgeProcess.Start(port);

            var listUrl = "http://127.0.0.1:" + port + "/json/list";
            string targetJson;
            using (var client = new WebClient { Proxy = null })
                targetJson = client.DownloadString(listUrl);

            var targets = Json.DeserializeObject(targetJson) as object[];
            var page = targets == null
                ? null
                : targets.OfType<Dictionary<string, object>>().FirstOrDefault(target =>
                    String.Equals(Convert.ToString(Value(target, "type")), "page", StringComparison.OrdinalIgnoreCase) &&
                    Convert.ToString(Value(target, "title")).IndexOf("Stellar Odyssey", StringComparison.OrdinalIgnoreCase) >= 0);
            if (page == null)
                throw new InvalidOperationException("The Stellar Odyssey renderer was not found. Restart the game and try again.");

            var socketUrl = Convert.ToString(Value(page, "webSocketDebuggerUrl"));
            Uri socketUri;
            if (!Uri.TryCreate(socketUrl, UriKind.Absolute, out socketUri) ||
                socketUri.Scheme != "ws" ||
                !(socketUri.Host == "127.0.0.1" || socketUri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("The game returned an unsafe or invalid local renderer address.");

            var nativeBridgeConfig = new Dictionary<string, object>
            {
                { "baseUrl", bridge.BaseUrl },
                { "token", bridge.SessionToken },
                { "launcherVersion", LauncherVersion }
            };
            var source = "window.__soIntelNativeBridge=" + Json.Serialize(nativeBridgeConfig) + ";\n" + File.ReadAllText(overlayPath, Encoding.UTF8);
            var request = new Dictionary<string, object>
            {
                { "id", 1 },
                { "method", "Runtime.evaluate" },
                { "params", new Dictionary<string, object>
                    {
                        { "expression", source },
                        { "awaitPromise", true },
                        { "returnByValue", true }
                    }
                }
            };

            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
            using (var socket = new ClientWebSocket())
            {
                socket.ConnectAsync(socketUri, timeout.Token).GetAwaiter().GetResult();
                var requestBytes = Encoding.UTF8.GetBytes(Json.Serialize(request));
                socket.SendAsync(new ArraySegment<byte>(requestBytes), WebSocketMessageType.Text, true, timeout.Token).GetAwaiter().GetResult();

                Dictionary<string, object> response = null;
                while (response == null)
                {
                    var text = ReceiveText(socket, timeout.Token);
                    var message = Json.DeserializeObject(text) as Dictionary<string, object>;
                    if (message != null && Convert.ToInt32(Value(message, "id") ?? 0) == 1)
                        response = message;
                }

                if (response.ContainsKey("error"))
                    throw new InvalidOperationException("The renderer rejected the overlay: " + Json.Serialize(response["error"]));

                var result = Value(response, "result") as Dictionary<string, object>;
                if (result != null && result.ContainsKey("exceptionDetails"))
                    throw new InvalidOperationException("The overlay script reported an error: " + Json.Serialize(result["exceptionDetails"]));

                if (socket.State == WebSocketState.Open)
                    socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Overlay injected", CancellationToken.None).GetAwaiter().GetResult();
            }

            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("Wookie's Starwatch is active.");
            Console.ResetColor();
            if (!String.IsNullOrEmpty(updateMessage)) Console.WriteLine(updateMessage);
            Console.WriteLine("Use the Starwatch button in the game, or press Alt+I.");
            Console.WriteLine("The secure official-API helper is running quietly in the background until the game exits.");
            return 0;
        }
        catch (Exception error)
        {
            if (bridge != null) bridge.Stop();
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine("Could not start the overlay:");
            Console.ResetColor();
            Console.WriteLine(error.Message);
            return 1;
        }
    }

    private static string TryUpdateOverlay(string overlayPath)
    {
        try
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            var manifestBytes = DownloadLimited(UpdateManifestUrl, 65536);
            var manifest = Json.DeserializeObject(Encoding.UTF8.GetString(manifestBytes)) as Dictionary<string, object>;
            if (manifest == null) throw new InvalidOperationException("The update manifest is invalid.");

            var versionText = Convert.ToString(Value(manifest, "version"));
            var overlayUrl = Convert.ToString(Value(manifest, "overlayUrl"));
            var expectedHash = Convert.ToString(Value(manifest, "sha256")).ToUpperInvariant();
            var minimumLauncherText = Convert.ToString(Value(manifest, "minimumLauncherVersion"));
            var publishedAt = Convert.ToString(Value(manifest, "publishedAt"));
            var signatureText = Convert.ToString(Value(manifest, "signature"));
            Version remoteVersion;
            Version minimumLauncher;
            Version currentLauncher;
            Uri overlayUri;
            if (!Version.TryParse(versionText, out remoteVersion) ||
                !Version.TryParse(minimumLauncherText, out minimumLauncher) ||
                !Version.TryParse(LauncherVersion, out currentLauncher) ||
                !Uri.TryCreate(overlayUrl, UriKind.Absolute, out overlayUri) ||
                overlayUri.Scheme != Uri.UriSchemeHttps ||
                !overlayUri.Host.Equals(UpdateHost, StringComparison.OrdinalIgnoreCase) ||
                !overlayUri.AbsolutePath.StartsWith("/updates/", StringComparison.Ordinal) ||
                !Regex.IsMatch(expectedHash, "^[A-F0-9]{64}$"))
                throw new InvalidOperationException("The update manifest contains unsafe values.");

            var signedText = versionText + "\n" + overlayUrl + "\n" + expectedHash + "\n" + minimumLauncherText + "\n" + publishedAt + "\n";
            byte[] signature;
            try { signature = Convert.FromBase64String(signatureText); }
            catch (FormatException) { throw new InvalidOperationException("The update signature is invalid."); }
            if (!VerifySignature(Encoding.UTF8.GetBytes(signedText), signature))
                throw new InvalidOperationException("The update signature was not trusted.");
            if (minimumLauncher > currentLauncher)
                return "A newer launcher is required for overlay " + remoteVersion + "; the installed overlay was left unchanged.";

            Version localVersion;
            var hasLocalVersion = TryReadOverlayVersion(overlayPath, out localVersion);
            if (hasLocalVersion && localVersion > remoteVersion) return null;
            if (File.Exists(overlayPath) && Sha256(File.ReadAllBytes(overlayPath)) == expectedHash) return null;

            var overlayBytes = DownloadLimited(overlayUri.ToString(), 1048576);
            if (Sha256(overlayBytes) != expectedHash)
                throw new InvalidOperationException("The downloaded overlay did not match its signed checksum.");
            ReplaceFileAtomically(overlayPath, overlayBytes);
            return "Updated overlay" + (hasLocalVersion ? " from " + localVersion : "") + " to " + remoteVersion + ".";
        }
        catch (Exception error)
        {
            return "Secure update check skipped: " + error.Message;
        }
    }

    private static byte[] DownloadLimited(string address, int maximumBytes)
    {
        var request = WebRequest.CreateHttp(address);
        request.Method = "GET";
        request.Proxy = null;
        request.Timeout = 7000;
        request.ReadWriteTimeout = 7000;
        request.UserAgent = "StellarOdysseyIntelUpdater/" + LauncherVersion;
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
            rsa.FromXmlString(UpdatePublicKey);
            return rsa.VerifyData(value, CryptoConfig.MapNameToOID("SHA256"), signature);
        }
    }

    private static string Sha256(byte[] value)
    {
        using (var algorithm = SHA256.Create())
            return BitConverter.ToString(algorithm.ComputeHash(value)).Replace("-", "");
    }

    private static bool TryReadOverlayVersion(string overlayPath, out Version version)
    {
        version = null;
        if (!File.Exists(overlayPath)) return false;
        var match = Regex.Match(File.ReadAllText(overlayPath, Encoding.UTF8), "const\\s+VERSION\\s*=\\s*[\\\"']([0-9]+(?:\\.[0-9]+){1,3})[\\\"']");
        return match.Success && Version.TryParse(match.Groups[1].Value, out version);
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
            else
            {
                File.Move(temporaryPath, targetPath);
            }
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    private static object Value(Dictionary<string, object> dictionary, string key)
    {
        object value;
        return dictionary != null && dictionary.TryGetValue(key, out value) ? value : null;
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
                if (received.MessageType == WebSocketMessageType.Close)
                    throw new InvalidOperationException("The game closed the local renderer connection before the overlay was injected.");
                stream.Write(buffer, 0, received.Count);
            } while (!received.EndOfMessage);
            return Encoding.UTF8.GetString(stream.ToArray());
        }
    }
}

internal sealed class OfficialApiBridgeProcess
{
    public string BaseUrl { get; private set; }
    public string SessionToken { get; private set; }
    private Process Process { get; set; }

    public bool IsRunning
    {
        get
        {
            try { return Process != null && !Process.HasExited; }
            catch { return false; }
        }
    }

    public static OfficialApiBridgeProcess Start(int devToolsPort)
    {
        int port;
        var reservation = new TcpListener(IPAddress.Loopback, 0);
        reservation.Start();
        try { port = ((IPEndPoint)reservation.LocalEndpoint).Port; }
        finally { reservation.Stop(); }

        var tokenBytes = new byte[32];
        using (var random = RandomNumberGenerator.Create()) random.GetBytes(tokenBytes);
        var token = BitConverter.ToString(tokenBytes).Replace("-", "").ToLowerInvariant();
        var executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
        var start = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = "--official-api-bridge " + port + " " + token + " " + devToolsPort,
            UseShellExecute = true,
            CreateNoWindow = false,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        var process = Process.Start(start);
        if (process == null) throw new InvalidOperationException("The secure official-API helper could not be started.");

        var bridge = new OfficialApiBridgeProcess
        {
            BaseUrl = "http://127.0.0.1:" + port,
            SessionToken = token,
            Process = process,
        };
        var deadline = DateTime.UtcNow.AddSeconds(5);
        Exception lastError = null;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var request = WebRequest.CreateHttp(bridge.BaseUrl + "/status");
                request.Proxy = null;
                request.Timeout = 500;
                request.Headers["X-SO-Intel-Token"] = token;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode == HttpStatusCode.OK) return bridge;
                }
            }
            catch (Exception error) { lastError = error; }
            if (process.HasExited) break;
            Thread.Sleep(100);
        }
        try { if (!process.HasExited) process.Kill(); }
        catch { }
        throw new InvalidOperationException("The secure official-API helper did not become ready." + (lastError == null ? "" : " " + lastError.Message));
    }

    public void Stop()
    {
        try
        {
            var request = WebRequest.CreateHttp(BaseUrl + "/shutdown");
            request.Method = "POST";
            request.Proxy = null;
            request.Timeout = 1000;
            request.ContentLength = 0;
            request.Headers["X-SO-Intel-Token"] = SessionToken;
            using (request.GetResponse()) { }
        }
        catch
        {
            try { if (Process != null && !Process.HasExited) Process.Kill(); }
            catch { }
        }
    }
}

internal sealed class NativeAlertRecord
{
    public string Id;
    public string Title;
    public string Body;
    public long DueAt;
    public long ExpiresAt;
    public bool Desktop;
    public bool Sound;
    public bool Attention;
    public bool BackgroundOnly;
    public double Volume;
}

internal static class NativeAlertStore
{
    private const string MutexName = "Local\\WookiesStarwatchNativeAlerts";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    private static readonly string StorageDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Stellar Odyssey Intel Overlay");
    private static readonly string QueuePath = Path.Combine(StorageDirectory, "native-alerts.json");

    public static long UtcNowMilliseconds()
    {
        return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    }

    public static void Upsert(NativeAlertRecord alert)
    {
        WithLock(delegate
        {
            var rows = Load().Where(row => !String.Equals(row.Id, alert.Id, StringComparison.Ordinal)).ToList();
            rows.Add(alert);
            Save(rows.OrderBy(row => row.DueAt).Take(64).ToList());
        });
    }

    public static void Cancel(string id)
    {
        WithLock(delegate
        {
            var rows = Load();
            var remaining = rows.Where(row => !String.Equals(row.Id, id, StringComparison.Ordinal)).ToList();
            if (remaining.Count != rows.Count) Save(remaining);
        });
    }

    public static void CancelPrefix(string prefix)
    {
        WithLock(delegate
        {
            var rows = Load();
            var remaining = rows.Where(row => !row.Id.StartsWith(prefix, StringComparison.Ordinal)).ToList();
            if (remaining.Count != rows.Count) Save(remaining);
        });
    }

    public static void Clear()
    {
        WithLock(delegate
        {
            if (File.Exists(QueuePath)) File.Delete(QueuePath);
        });
    }

    public static List<NativeAlertRecord> TakeDue(long now)
    {
        var due = new List<NativeAlertRecord>();
        WithLock(delegate
        {
            var rows = Load();
            due.AddRange(rows.Where(row => row.DueAt <= now && row.ExpiresAt >= now));
            var remaining = rows.Where(row => row.DueAt > now && row.ExpiresAt >= now).ToList();
            if (remaining.Count != rows.Count) Save(remaining);
        });
        return due;
    }

    private static List<NativeAlertRecord> Load()
    {
        if (!File.Exists(QueuePath)) return new List<NativeAlertRecord>();
        try
        {
            var rows = Json.Deserialize<NativeAlertRecord[]>(File.ReadAllText(QueuePath, Encoding.UTF8));
            return rows == null ? new List<NativeAlertRecord>() : rows.Where(ValidStoredAlert).ToList();
        }
        catch { return new List<NativeAlertRecord>(); }
    }

    private static bool ValidStoredAlert(NativeAlertRecord alert)
    {
        return alert != null && !String.IsNullOrWhiteSpace(alert.Id) && !String.IsNullOrWhiteSpace(alert.Title) &&
            alert.DueAt > 0 && alert.ExpiresAt >= alert.DueAt;
    }

    private static void Save(List<NativeAlertRecord> rows)
    {
        Directory.CreateDirectory(StorageDirectory);
        if (rows.Count == 0)
        {
            if (File.Exists(QueuePath)) File.Delete(QueuePath);
            return;
        }
        var temporary = QueuePath + ".new";
        var backup = QueuePath + ".old";
        File.WriteAllText(temporary, Json.Serialize(rows), new UTF8Encoding(false));
        if (File.Exists(QueuePath))
        {
            if (File.Exists(backup)) File.Delete(backup);
            File.Replace(temporary, QueuePath, backup, true);
            if (File.Exists(backup)) File.Delete(backup);
        }
        else File.Move(temporary, QueuePath);
    }

    private static void WithLock(Action action)
    {
        using (var mutex = new Mutex(false, MutexName))
        {
            var acquired = false;
            try
            {
                try { acquired = mutex.WaitOne(3000); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new TimeoutException("The native alert queue is busy.");
                action();
            }
            finally { if (acquired) mutex.ReleaseMutex(); }
        }
    }
}

internal sealed class OfficialApiBridge : IDisposable
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Stellar Odyssey Intel Overlay official API v1");
    private const string LauncherVersion = "2.1.0";
    private const string ApiOrigin = "https://steamapi.stellarodyssey.app";
    private const int MaximumApiBytes = 32 * 1024 * 1024;
    private readonly object gate = new object();
    private readonly TcpListener listener;
    private readonly string token;
    private readonly int devToolsPort;
    private readonly string storageDirectory;
    private readonly string keyPath;
    private volatile bool stopping;

    private OfficialApiBridge(int port, string sessionToken, int gamePort)
    {
        token = sessionToken;
        devToolsPort = gamePort;
        storageDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Stellar Odyssey Intel Overlay");
        keyPath = Path.Combine(storageDirectory, "official-api-key.bin");
        listener = new TcpListener(IPAddress.Loopback, port);
    }

    public static int Run(string portText, string sessionToken, string gamePortText)
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
        int port;
        int gamePort;
        if (!Int32.TryParse(portText, out port) || port < 1 || port > 65535 ||
            !Int32.TryParse(gamePortText, out gamePort) || gamePort < 1 || gamePort > 65535 ||
            !Regex.IsMatch(sessionToken ?? "", "^[a-f0-9]{64}$")) return 2;
        try
        {
            using (var bridge = new OfficialApiBridge(port, sessionToken, gamePort)) bridge.Listen();
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Official API helper could not start: " + error.Message);
            return 1;
        }
    }

    private void Listen()
    {
        listener.Start();
        var monitor = new Thread(MonitorGame) { IsBackground = true, Name = "Starwatch game monitor" };
        monitor.Start();
        while (!stopping)
        {
            try
            {
                var client = listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(_ => HandleClient(client));
            }
            catch (SocketException) { if (!stopping) throw; }
        }
    }

    private void MonitorGame()
    {
        var misses = 0;
        while (!stopping)
        {
            Thread.Sleep(5000);
            try
            {
                using (var client = new WebClient { Proxy = null })
                {
                    client.DownloadString("http://127.0.0.1:" + devToolsPort + "/json/list");
                    misses = 0;
                }
            }
            catch
            {
                misses++;
                if (misses >= 3) StopListening();
            }
        }
    }

    private void HandleClient(TcpClient client)
    {
        using (client)
        {
            try
            {
                client.ReceiveTimeout = 10000;
                client.SendTimeout = 30000;
                var request = ReadLocalRequest(client.GetStream());
                Handle(new LocalContext(client, request));
            }
            catch
            {
                try { client.Close(); }
                catch { }
            }
        }
    }

    private void Handle(LocalContext context)
    {
        try
        {
            if (context.Request.HttpMethod == "OPTIONS")
            {
                WriteEmpty(context, 204);
                return;
            }
            string providedToken;
            context.Request.Headers.TryGetValue("X-SO-Intel-Token", out providedToken);
            if (!TokensMatch(providedToken, token))
            {
                WriteJson(context, 403, new Dictionary<string, object> { { "ok", false }, { "error", "Local helper authorization failed" } });
                return;
            }

            var path = (context.Request.Path ?? "").ToLowerInvariant();
            if (path == "/status" && context.Request.HttpMethod == "GET") WriteStatus(context);
            else if (path == "/key" && context.Request.HttpMethod == "POST") SaveKey(context);
            else if (path == "/key" && context.Request.HttpMethod == "DELETE") DeleteKey(context);
            else if (path == "/alert/schedule" && context.Request.HttpMethod == "POST") ScheduleAlert(context);
            else if (path == "/alert/cancel" && context.Request.HttpMethod == "POST") CancelAlert(context);
            else if (path == "/alert/cancel-prefix" && context.Request.HttpMethod == "POST") CancelAlertPrefix(context);
            else if (path == "/shutdown" && context.Request.HttpMethod == "POST")
            {
                WriteJson(context, 200, new Dictionary<string, object> { { "ok", true } });
                StopListening();
            }
            else if (path.StartsWith("/official/", StringComparison.Ordinal) && context.Request.HttpMethod == "GET") ProxyOfficial(context, path.Substring(10));
            else WriteJson(context, 404, new Dictionary<string, object> { { "ok", false }, { "error", "Unknown local helper route" } });
        }
        catch (Exception error)
        {
            try { WriteJson(context, 500, new Dictionary<string, object> { { "ok", false }, { "error", SafeError(error) } }); }
            catch { }
        }
    }

    private void WriteStatus(LocalContext context)
    {
        var caches = new Dictionary<string, object>();
        foreach (var route in new[] { "user", "journal", "stations", "market", "dungeons", "solodungeons", "activerunes" })
        {
            var cached = LoadCache(route);
            if (cached != null) caches[route] = new Dictionary<string, object>
            {
                { "fetchedAt", cached.FetchedAt },
                { "remaining", cached.Remaining },
                { "limit", cached.Limit },
                { "reset", cached.Reset },
            };
        }
        WriteJson(context, 200, new Dictionary<string, object>
        {
            { "ok", true },
            { "configured", File.Exists(keyPath) },
            { "launcherVersion", LauncherVersion },
            { "nativeAlerts", true },
            { "storage", "Windows DPAPI (current user)" },
            { "caches", caches },
        });
    }

    private void ScheduleAlert(LocalContext context)
    {
        var parsed = Json.DeserializeObject(context.Request.Body ?? "") as Dictionary<string, object>;
        var id = CleanText(Get(parsed, "id"), 64);
        var title = CleanText(Get(parsed, "title"), 80);
        var body = CleanText(Get(parsed, "body"), 300);
        var dueAt = LongValue(Get(parsed, "dueAt"));
        var expiresAt = LongValue(Get(parsed, "expiresAt"));
        var now = NativeAlertStore.UtcNowMilliseconds();
        if (!Regex.IsMatch(id, "^[a-z0-9][a-z0-9._-]{0,63}$") || String.IsNullOrWhiteSpace(title) || String.IsNullOrWhiteSpace(body) ||
            dueAt < now - 30000 || dueAt > now + 30L * 24 * 60 * 60 * 1000)
        {
            WriteJson(context, 400, new Dictionary<string, object> { { "ok", false }, { "error", "The native alert is invalid" } });
            return;
        }
        if (expiresAt < dueAt) expiresAt = dueAt + 10 * 60 * 1000L;
        expiresAt = Math.Min(expiresAt, dueAt + 60 * 60 * 1000L);
        var desktop = BoolValue(Get(parsed, "desktop"), false);
        var sound = BoolValue(Get(parsed, "sound"), false);
        var attention = BoolValue(Get(parsed, "attention"), false);
        if (!desktop && !sound && !attention)
        {
            NativeAlertStore.Cancel(id);
            WriteJson(context, 200, new Dictionary<string, object> { { "ok", true }, { "scheduled", false } });
            return;
        }
        NativeAlertStore.Upsert(new NativeAlertRecord
        {
            Id = id,
            Title = title,
            Body = body,
            DueAt = dueAt,
            ExpiresAt = expiresAt,
            Desktop = desktop,
            Sound = sound,
            Attention = attention,
            BackgroundOnly = BoolValue(Get(parsed, "backgroundOnly"), true),
            Volume = Math.Max(0, Math.Min(1, DoubleValue(Get(parsed, "volume"), 0.55))),
        });
        WriteJson(context, 200, new Dictionary<string, object> { { "ok", true }, { "scheduled", true }, { "dueAt", dueAt } });
    }

    private void CancelAlert(LocalContext context)
    {
        var parsed = Json.DeserializeObject(context.Request.Body ?? "") as Dictionary<string, object>;
        var id = CleanText(Get(parsed, "id"), 64);
        if (!Regex.IsMatch(id, "^[a-z0-9][a-z0-9._-]{0,63}$"))
        {
            WriteJson(context, 400, new Dictionary<string, object> { { "ok", false }, { "error", "The native alert id is invalid" } });
            return;
        }
        NativeAlertStore.Cancel(id);
        WriteJson(context, 200, new Dictionary<string, object> { { "ok", true } });
    }

    private void CancelAlertPrefix(LocalContext context)
    {
        var parsed = Json.DeserializeObject(context.Request.Body ?? "") as Dictionary<string, object>;
        var prefix = CleanText(Get(parsed, "prefix"), 32);
        if (!String.Equals(prefix, "operation-", StringComparison.Ordinal))
        {
            WriteJson(context, 400, new Dictionary<string, object> { { "ok", false }, { "error", "That native alert namespace cannot be cleared" } });
            return;
        }
        NativeAlertStore.CancelPrefix(prefix);
        WriteJson(context, 200, new Dictionary<string, object> { { "ok", true } });
    }

    private static string CleanText(object value, int maximum)
    {
        var text = Regex.Replace(Convert.ToString(value) ?? "", "[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]", "").Trim();
        return text.Substring(0, Math.Min(maximum, text.Length));
    }

    private static long LongValue(object value)
    {
        double number;
        return Double.TryParse(Convert.ToString(value), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out number) &&
            number >= Int64.MinValue && number <= Int64.MaxValue ? (long)number : 0;
    }

    private static double DoubleValue(object value, double fallback)
    {
        double number;
        return Double.TryParse(Convert.ToString(value), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out number) ? number : fallback;
    }

    private static bool BoolValue(object value, bool fallback)
    {
        if (value is bool) return (bool)value;
        bool parsed;
        return Boolean.TryParse(Convert.ToString(value), out parsed) ? parsed : fallback;
    }

    private void SaveKey(LocalContext context)
    {
        var body = context.Request.Body ?? "";
        if (Encoding.UTF8.GetByteCount(body) > 4096) throw new InvalidDataException("The request is too large.");
        var parsed = Json.DeserializeObject(body) as Dictionary<string, object>;
        var key = parsed != null && parsed.ContainsKey("key") ? Convert.ToString(parsed["key"]).Trim() : "";
        if (key.Length < 16 || key.Length > 1024 || key.Any(Char.IsControl))
        {
            WriteJson(context, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Enter a valid Stellar Odyssey API key" } });
            return;
        }
        lock (gate)
        {
            Directory.CreateDirectory(storageDirectory);
            WriteProtected(keyPath, Encoding.UTF8.GetBytes(key));
            foreach (var route in new[] { "user", "journal", "stations", "market", "dungeons", "solodungeons", "activerunes" })
            {
                var cachePath = CachePath(route);
                if (File.Exists(cachePath)) File.Delete(cachePath);
            }
        }
        WriteJson(context, 200, new Dictionary<string, object> { { "ok", true }, { "configured", true } });
    }

    private void DeleteKey(LocalContext context)
    {
        lock (gate)
        {
            if (File.Exists(keyPath)) File.Delete(keyPath);
            foreach (var route in new[] { "user", "journal", "stations", "market", "dungeons", "solodungeons", "activerunes" })
            {
                var cachePath = CachePath(route);
                if (File.Exists(cachePath)) File.Delete(cachePath);
            }
        }
        WriteJson(context, 200, new Dictionary<string, object> { { "ok", true }, { "configured", false } });
    }

    private void ProxyOfficial(LocalContext context, string route)
    {
        var intervals = new Dictionary<string, long>
        {
            { "user", 30 * 60 * 1000L },
            { "journal", 30 * 60 * 1000L },
            { "stations", 30 * 60 * 1000L },
            { "market", 60 * 60 * 1000L },
            { "dungeons", 30 * 60 * 1000L },
            { "solodungeons", 30 * 60 * 1000L },
            { "activerunes", 30 * 60 * 1000L },
        };
        if (!intervals.ContainsKey(route))
        {
            WriteJson(context, 404, new Dictionary<string, object> { { "ok", false }, { "error", "That official API route is not allow-listed" } });
            return;
        }

        lock (gate)
        {
            var key = ReadKey();
            if (String.IsNullOrEmpty(key))
            {
                WriteJson(context, 409, new Dictionary<string, object> { { "ok", false }, { "error", "Add your official API key in the overlay first" } });
                return;
            }
            var now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            var cached = LoadCache(route);
            if (cached != null && now - cached.FetchedAt < intervals[route])
            {
                WriteApiResult(context, route, cached, true, false);
                return;
            }

            try
            {
                var request = WebRequest.CreateHttp(ApiOrigin + "/api/public/" + route);
                request.Method = "GET";
                request.Proxy = null;
                request.Timeout = 20000;
                request.ReadWriteTimeout = 20000;
                request.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
                request.Accept = "application/json";
                request.UserAgent = "WookiesStarwatch/" + LauncherVersion;
                request.Headers["sodyssey-api-key"] = key;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    var body = SanitizeOfficialBody(route, ReadResponseText(response, MaximumApiBytes));
                    var fresh = new ApiCache
                    {
                        Body = body,
                        FetchedAt = now,
                        Limit = response.Headers["X-Daily-Limit"],
                        Remaining = response.Headers["X-Daily-Remaining"],
                        Reset = response.Headers["X-Daily-Reset"],
                    };
                    SaveCache(route, fresh);
                    WriteApiResult(context, route, fresh, false, false);
                }
            }
            catch (WebException error)
            {
                var response = error.Response as HttpWebResponse;
                var code = response == null ? 0 : (int)response.StatusCode;
                if (cached != null && code != 401 && code != 403)
                {
                    WriteApiResult(context, route, cached, true, true);
                    return;
                }
                var message = code == 401 || code == 403
                    ? "The official API rejected this key. Check it in your Stellar Odyssey profile."
                    : code == 429
                        ? "The official API daily limit is exhausted for this route."
                        : "The official API is temporarily unavailable" + (code > 0 ? " (HTTP " + code + ")" : "") + ".";
                WriteJson(context, code == 429 ? 429 : 502, new Dictionary<string, object> { { "ok", false }, { "error", message } });
            }
        }
    }

    private void WriteApiResult(LocalContext context, string route, ApiCache cache, bool cached, bool stale)
    {
        object data;
        try { data = Json.DeserializeObject(cache.Body); }
        catch { throw new InvalidDataException("The official API returned invalid JSON."); }
        WriteJson(context, 200, new Dictionary<string, object>
        {
            { "ok", true },
            { "route", route },
            { "fetchedAt", cache.FetchedAt },
            { "cached", cached },
            { "stale", stale },
            { "limit", cache.Limit },
            { "remaining", cache.Remaining },
            { "reset", cache.Reset },
            { "data", data },
        });
    }

    private string ReadKey()
    {
        if (!File.Exists(keyPath)) return "";
        try { return Encoding.UTF8.GetString(ReadProtected(keyPath)); }
        catch { return ""; }
    }

    private string CachePath(string route) { return Path.Combine(storageDirectory, "cache-" + route + ".bin"); }

    private ApiCache LoadCache(string route)
    {
        var path = CachePath(route);
        if (!File.Exists(path)) return null;
        try
        {
            var value = Json.DeserializeObject(Encoding.UTF8.GetString(ReadProtected(path))) as Dictionary<string, object>;
            if (value == null) return null;
            return new ApiCache
            {
                Body = Convert.ToString(Get(value, "body")),
                FetchedAt = Convert.ToInt64(Get(value, "fetchedAt") ?? 0),
                Limit = Convert.ToString(Get(value, "limit")),
                Remaining = Convert.ToString(Get(value, "remaining")),
                Reset = Convert.ToString(Get(value, "reset")),
            };
        }
        catch { return null; }
    }

    private void SaveCache(string route, ApiCache cache)
    {
        Directory.CreateDirectory(storageDirectory);
        var value = new Dictionary<string, object>
        {
            { "body", cache.Body },
            { "fetchedAt", cache.FetchedAt },
            { "limit", cache.Limit },
            { "remaining", cache.Remaining },
            { "reset", cache.Reset },
        };
        WriteProtected(CachePath(route), Encoding.UTF8.GetBytes(Json.Serialize(value)));
    }

    private static void WriteProtected(string path, byte[] clear)
    {
        var encrypted = ProtectedData.Protect(clear, Entropy, DataProtectionScope.CurrentUser);
        var temporary = path + ".new";
        var backup = path + ".old";
        File.WriteAllBytes(temporary, encrypted);
        if (File.Exists(path))
        {
            if (File.Exists(backup)) File.Delete(backup);
            File.Replace(temporary, path, backup, true);
            if (File.Exists(backup)) File.Delete(backup);
        }
        else File.Move(temporary, path);
    }

    private static byte[] ReadProtected(string path)
    {
        return ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser);
    }

    private static object Get(Dictionary<string, object> value, string key)
    {
        object result;
        return value != null && value.TryGetValue(key, out result) ? result : null;
    }

    private static string ReadResponseText(HttpWebResponse response, int limit)
    {
        if (response.ContentLength > limit) throw new InvalidDataException("The official API response is too large.");
        using (var stream = response.GetResponseStream())
        using (var output = new MemoryStream())
        {
            var buffer = new byte[16384];
            int read;
            while (stream != null && (read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (output.Length + read > limit) throw new InvalidDataException("The official API response is too large.");
                output.Write(buffer, 0, read);
            }
            return Encoding.UTF8.GetString(output.ToArray());
        }
    }

    private static string SanitizeOfficialBody(string route, string body)
    {
        if (route != "user") return body;
        var root = Json.DeserializeObject(body) as Dictionary<string, object>;
        if (root == null) throw new InvalidDataException("The official user response is invalid.");
        var wrapped = Get(root, "data") as Dictionary<string, object>;
        var user = wrapped ?? root;
        var allowed = new[]
        {
            "username", "registered", "premium", "reputation", "stats", "pvpstats", "pvp_gear",
            "levels", "skills", "statistics", "clones", "droids", "ship", "currentSystem", "pet_slots",
            "squadron", "squadronSpaceStations", "voyager", "dungeons", "globalBoosts", "actions",
            "laboratory", "labqueue", "base", "currency"
        };
        var clean = new Dictionary<string, object>();
        foreach (var field in allowed)
        {
            object value;
            if (user.TryGetValue(field, out value)) clean[field] = value;
        }
        return Json.Serialize(wrapped == null ? (object)clean : new Dictionary<string, object> { { "data", clean } });
    }

    private static void WriteJson(LocalContext context, int status, object value)
    {
        var bytes = Encoding.UTF8.GetBytes(Json.Serialize(value));
        WriteResponse(context, status, "application/json; charset=utf-8", bytes);
    }

    private static LocalRequest ReadLocalRequest(NetworkStream stream)
    {
        var header = new MemoryStream();
        var matched = 0;
        var marker = new byte[] { 13, 10, 13, 10 };
        while (header.Length < 16384 && matched < marker.Length)
        {
            var value = stream.ReadByte();
            if (value < 0) throw new EndOfStreamException("The local request ended unexpectedly.");
            header.WriteByte((byte)value);
            matched = value == marker[matched] ? matched + 1 : value == marker[0] ? 1 : 0;
        }
        if (matched != marker.Length) throw new InvalidDataException("The local request headers are too large.");
        var lines = Encoding.ASCII.GetString(header.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None);
        var first = lines[0].Split(' ');
        if (first.Length < 2) throw new InvalidDataException("The local request is invalid.");
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index < lines.Length; index++)
        {
            var separator = lines[index].IndexOf(':');
            if (separator <= 0) continue;
            headers[lines[index].Substring(0, separator).Trim()] = lines[index].Substring(separator + 1).Trim();
        }
        int contentLength;
        string lengthText;
        if (!headers.TryGetValue("Content-Length", out lengthText) || !Int32.TryParse(lengthText, out contentLength)) contentLength = 0;
        if (contentLength < 0 || contentLength > 4096) throw new InvalidDataException("The local request body is too large.");
        var body = new byte[contentLength];
        var offset = 0;
        while (offset < body.Length)
        {
            var read = stream.Read(body, offset, body.Length - offset);
            if (read <= 0) throw new EndOfStreamException("The local request body ended unexpectedly.");
            offset += read;
        }
        var path = first[1];
        var query = path.IndexOf('?');
        if (query >= 0) path = path.Substring(0, query);
        return new LocalRequest
        {
            HttpMethod = first[0].ToUpperInvariant(),
            Path = path,
            Headers = headers,
            Body = Encoding.UTF8.GetString(body),
        };
    }

    private static void WriteEmpty(LocalContext context, int status)
    {
        WriteResponse(context, status, "text/plain; charset=utf-8", new byte[0]);
    }

    private static void WriteResponse(LocalContext context, int status, string contentType, byte[] body)
    {
        var reason = status == 200 ? "OK" : status == 204 ? "No Content" : status == 400 ? "Bad Request" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : status == 409 ? "Conflict" : status == 429 ? "Too Many Requests" : status == 502 ? "Bad Gateway" : "Internal Server Error";
        var head = "HTTP/1.1 " + status + " " + reason + "\r\n" +
            "Content-Type: " + contentType + "\r\n" +
            "Content-Length: " + body.Length + "\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type, X-SO-Intel-Token\r\n" +
            "Access-Control-Allow-Private-Network: true\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n";
        var stream = context.Client.GetStream();
        var headBytes = Encoding.ASCII.GetBytes(head);
        stream.Write(headBytes, 0, headBytes.Length);
        if (body.Length > 0) stream.Write(body, 0, body.Length);
        stream.Flush();
        context.Client.Close();
    }

    private static bool TokensMatch(string provided, string expected)
    {
        if (provided == null || expected == null || provided.Length != expected.Length) return false;
        var difference = 0;
        for (var index = 0; index < provided.Length; index++) difference |= provided[index] ^ expected[index];
        return difference == 0;
    }

    private static string SafeError(Exception error)
    {
        return String.IsNullOrWhiteSpace(error.Message) ? "The local helper could not complete that request." : error.Message.Substring(0, Math.Min(180, error.Message.Length));
    }

    private void StopListening()
    {
        if (stopping) return;
        stopping = true;
        try { listener.Stop(); }
        catch { }
    }

    public void Dispose()
    {
        StopListening();
    }

    private sealed class ApiCache
    {
        public string Body;
        public long FetchedAt;
        public string Limit;
        public string Remaining;
        public string Reset;
    }

    private sealed class LocalRequest
    {
        public string HttpMethod;
        public string Path;
        public Dictionary<string, string> Headers;
        public string Body;
    }

    private sealed class LocalContext
    {
        public readonly TcpClient Client;
        public readonly LocalRequest Request;

        public LocalContext(TcpClient client, LocalRequest request)
        {
            Client = client;
            Request = request;
        }
    }
}
