using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Only this native background worker sees the complete galaxy. The renderer receives
// the compact 100%-only snapshot, never the response or the account's API key.
internal sealed class PerfectNodeIndex
{
    private const long RefreshInterval = 60 * 60 * 1000L;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("WookiesStarwatch perfect index v1");
    private readonly object gate = new object();
    private readonly string path;
    private readonly Func<string> readKey;
    private readonly Action throttle;
    private Dictionary<string, object> data;
    private string etag = "", error = "", remaining = "", limit = "", reset = "";
    private long fetchedAt, checkedAt, nextAttemptAt;
    private int generation;
    private bool refreshing, stopped;
    private HttpWebRequest activeRequest;

    internal PerfectNodeIndex(string directory, Func<string> keyReader, Action requestThrottle)
    {
        path = Path.Combine(directory, "perfect-node-index.bin");
        readKey = keyReader;
        throttle = requestThrottle;
        Load();
    }

    private static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
    private static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }; }
    private static object Value(Dictionary<string, object> row, string field) { object value; return row != null && row.TryGetValue(field, out value) ? value : null; }

    internal object Snapshot()
    {
        var key = readKey();
        lock (gate)
        {
            if (!stopped && !refreshing && key.Length > 0 && Now() >= nextAttemptAt)
            {
                refreshing = true;
                nextAttemptAt = Now() + RefreshInterval;
                var expectedGeneration = generation;
                // Persist the attempt before the request so restarting cannot spend the quota repeatedly.
                try { Save(); }
                catch { refreshing = false; error = "Cannot save the local index cache."; }
                if (refreshing) new Thread(() => Refresh(key, expectedGeneration))
                {
                    IsBackground = true, Name = "Starwatch public map index", Priority = ThreadPriority.BelowNormal
                }.Start();
            }
            return new Dictionary<string, object>
            {
                { "ok", true }, { "route", "systems" }, { "hasSnapshot", data != null },
                { "data", data ?? new Dictionary<string, object> { { "systems", new object[0] }, { "totalSystems", 0 } } },
                { "fetchedAt", fetchedAt }, { "checkedAt", checkedAt }, { "refreshing", refreshing },
                { "stale", data != null && (error.Length > 0 || Now() - checkedAt > RefreshInterval * 2) },
                { "cached", true }, { "remaining", remaining }, { "limit", limit }, { "reset", reset },
                { "message", key.Length == 0 ? "Add your official API key in Sync to load the public index." : error },
            };
        }
    }

    private void Refresh(string key, int expectedGeneration)
    {
        HttpWebRequest request = null;
        try
        {
            string previousTag;
            lock (gate)
            {
                if (stopped || generation != expectedGeneration) return;
                previousTag = data == null ? "" : etag;
            }
            throttle();
            request = WebRequest.CreateHttp("https://steamapi.stellarodyssey.app/api/public/systems");
            request.Method = "GET";
            request.Proxy = null;
            request.Timeout = 90000;
            request.ReadWriteTimeout = 30000;
            request.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            request.Accept = "application/json";
            request.UserAgent = "WookiesStarwatch/2.2.0";
            request.Headers["sodyssey-api-key"] = key;
            if (previousTag.Length > 0) request.Headers["If-None-Match"] = previousTag;
            lock (gate)
            {
                if (stopped || generation != expectedGeneration) return;
                activeRequest = request;
            }
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), true, 65536))
            {
                var fresh = PerfectSystemReader.Read(reader);
                lock (gate)
                {
                    if (stopped || generation != expectedGeneration) return;
                    data = fresh;
                    etag = response.Headers["ETag"] ?? "";
                    fetchedAt = checkedAt = Now();
                    error = "";
                    ReadQuota(response);
                    Save();
                }
            }
        }
        catch (WebException exception)
        {
            using (var response = exception.Response as HttpWebResponse)
            lock (gate)
            {
                if (stopped || generation != expectedGeneration) return;
                if (response != null) ReadQuota(response);
                if (response != null && response.StatusCode == HttpStatusCode.NotModified && data != null)
                {
                    checkedAt = Now();
                    error = "";
                }
                else
                {
                    var code = response == null ? 0 : (int)response.StatusCode;
                    error = code == 401 || code == 403 ? "The API key was rejected; check it in Sync."
                        : code == 429 ? "Systems API quota reached. The saved index remains available."
                        : "Public index refresh failed. Retrying after the hourly pause.";
                    if (code == 429)
                    {
                        long seconds;
                        if (Int64.TryParse(reset, out seconds) && seconds > 0 && seconds < Int64.MaxValue / 1000)
                            nextAttemptAt = Math.Max(nextAttemptAt, seconds * 1000);
                    }
                }
                try { Save(); } catch { }
            }
        }
        catch
        {
            lock (gate)
            {
                if (stopped || generation != expectedGeneration) return;
                error = "Public index could not be validated or saved. Keeping the last usable snapshot.";
                try { Save(); } catch { }
            }
        }
        finally
        {
            key = null;
            lock (gate)
            {
                if (generation == expectedGeneration) { refreshing = false; activeRequest = null; }
            }
        }
    }

    private void ReadQuota(HttpWebResponse response)
    {
        remaining = response.Headers["X-Daily-Remaining"] ?? remaining;
        limit = response.Headers["X-Daily-Limit"] ?? limit;
        reset = response.Headers["X-Daily-Reset"] ?? reset;
    }

    internal void Reset()
    {
        lock (gate)
        {
            generation++;
            if (activeRequest != null) activeRequest.Abort();
            activeRequest = null;
            refreshing = false;
            data = null;
            fetchedAt = checkedAt = nextAttemptAt = 0;
            etag = error = remaining = limit = reset = "";
            if (File.Exists(path)) File.Delete(path);
        }
    }

    internal void Stop()
    {
        lock (gate)
        {
            stopped = true;
            generation++;
            if (activeRequest != null) activeRequest.Abort();
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(path)) return;
            var clear = ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser);
            var saved = Serializer().DeserializeObject(Encoding.UTF8.GetString(clear)) as Dictionary<string, object>;
            if (Convert.ToInt32(Value(saved, "version")) != 1) return;
            data = Value(saved, "data") as Dictionary<string, object>;
            etag = Convert.ToString(Value(saved, "etag"));
            error = Convert.ToString(Value(saved, "error"));
            remaining = Convert.ToString(Value(saved, "remaining"));
            limit = Convert.ToString(Value(saved, "limit"));
            reset = Convert.ToString(Value(saved, "reset"));
            fetchedAt = Convert.ToInt64(Value(saved, "fetchedAt") ?? 0);
            checkedAt = Convert.ToInt64(Value(saved, "checkedAt") ?? 0);
            nextAttemptAt = Math.Min(Convert.ToInt64(Value(saved, "nextAttemptAt") ?? 0), Now() + 24 * RefreshInterval);
        }
        catch { data = null; etag = ""; fetchedAt = checkedAt = nextAttemptAt = 0; }
    }

    private void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        var bytes = Encoding.UTF8.GetBytes(Serializer().Serialize(new Dictionary<string, object>
        {
            { "version", 1 }, { "data", data }, { "etag", etag }, { "error", error },
            { "remaining", remaining }, { "limit", limit }, { "reset", reset },
            { "fetchedAt", fetchedAt }, { "checkedAt", checkedAt }, { "nextAttemptAt", nextAttemptAt },
        }));
        var encrypted = ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser);
        var temporary = path + ".new";
        File.WriteAllBytes(temporary, encrypted);
        if (File.Exists(path)) File.Replace(temporary, path, null);
        else File.Move(temporary, path);
    }
}

// Parse one system at a time. Memory is bounded by a system record and the compact
// perfect-node index, rather than the 50+ MB (and growing) decompressed galaxy.
internal sealed class PerfectSystemReader
{
    private readonly TextReader input;
    private long readCharacters;
    private PerfectSystemReader(TextReader reader) { input = reader; }
    private int ReadChar()
    {
        if (++readCharacters > 640L * 1024 * 1024) throw new InvalidDataException("Galaxy response exceeds the limit.");
        return input.Read();
    }
    private void White() { while (input.Peek() >= 0 && Char.IsWhiteSpace((char)input.Peek())) ReadChar(); }
    private void Expect(char value) { White(); if (ReadChar() != value) throw new InvalidDataException("Invalid galaxy JSON."); }

    private string ReadValue()
    {
        White();
        var builder = new StringBuilder();
        var brackets = new Stack<char>();
        var quoted = false;
        var escaped = false;
        while (true)
        {
            var peek = input.Peek();
            if (peek < 0) break;
            var ch = (char)peek;
            if (!quoted && brackets.Count == 0 && builder.Length > 0 && (ch == ',' || ch == '}' || ch == ']' || Char.IsWhiteSpace(ch))) break;
            ReadChar();
            builder.Append(ch);
            if (builder.Length > 1024 * 1024) throw new InvalidDataException("A galaxy record is too large.");
            if (quoted)
            {
                if (escaped) escaped = false;
                else if (ch == '\\') escaped = true;
                else if (ch == '"') { quoted = false; if (brackets.Count == 0) break; }
            }
            else if (ch == '"') quoted = true;
            else if (ch == '{' || ch == '[')
            {
                brackets.Push(ch);
                if (brackets.Count > 64) throw new InvalidDataException("Galaxy JSON is too deeply nested.");
            }
            else if (ch == '}' || ch == ']')
            {
                if (brackets.Count == 0 || brackets.Pop() != (ch == '}' ? '{' : '[')) throw new InvalidDataException("Unbalanced galaxy JSON.");
                if (brackets.Count == 0) break;
            }
        }
        if (builder.Length == 0 || quoted || brackets.Count > 0) throw new InvalidDataException("Incomplete galaxy JSON.");
        return builder.ToString();
    }

    internal static Dictionary<string, object> Read(TextReader reader)
    {
        return new PerfectSystemReader(reader).ReadRoot();
    }

    private Dictionary<string, object> ReadRoot()
    {
        var json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 64 };
        var perfect = new Dictionary<string, Dictionary<string, object>>();
        var totalSystems = 0;
        var totalBodies = 0;
        var foundSystems = false;
        Expect('{');
        White();
        if (input.Peek() == '}') throw new InvalidDataException("Systems are missing.");
        while (true)
        {
            var name = json.Deserialize<string>(ReadValue());
            Expect(':');
            if (name == "systems")
            {
                if (foundSystems) throw new InvalidDataException("Duplicate systems field.");
                foundSystems = true;
                Expect('[');
                White();
                if (input.Peek() != ']')
                while (true)
                {
                    var system = json.DeserializeObject(ReadValue()) as Dictionary<string, object>;
                    if (system == null) throw new InvalidDataException("Invalid system record.");
                    var normalized = NormalizeSystem(system, ref totalBodies);
                    totalSystems++;
                    if (totalSystems > 3000000) throw new InvalidDataException("Too many systems.");
                    if (normalized != null)
                    {
                        var key = normalized["z"] + ":" + normalized["x"] + "," + normalized["y"];
                        perfect[key] = normalized;
                        if (perfect.Count > 25000) throw new InvalidDataException("Perfect index capacity exceeded.");
                    }
                    White();
                    if (input.Peek() == ']') break;
                    Expect(',');
                }
                Expect(']');
            }
            else json.DeserializeObject(ReadValue());
            White();
            if (input.Peek() == '}') break;
            Expect(',');
        }
        Expect('}');
        White();
        if (!foundSystems || input.Peek() != -1) throw new InvalidDataException("Invalid galaxy response.");
        var systems = perfect.Values.OrderBy(row => (int)row["x"]).ThenBy(row => (int)row["y"]).ToArray();
        return new Dictionary<string, object>
        {
            { "systems", systems }, { "totalSystems", totalSystems }, { "totalBodies", totalBodies },
            { "perfectNodeCount", systems.Sum(row => ((List<object>)row["nodes"]).Count) },
            { "realm", "steam" }, { "z", 1 },
        };
    }

    private static object Value(Dictionary<string, object> row, string field) { object value; return row.TryGetValue(field, out value) ? value : null; }
    private static bool Numeric(object value) { return value is int || value is long || value is double || value is decimal; }
    private static int Coordinate(object value)
    {
        if (!Numeric(value)) throw new InvalidDataException("Missing system coordinate.");
        var number = Convert.ToDouble(value);
        if (Double.IsNaN(number) || Double.IsInfinity(number) || number != Math.Floor(number) || number < 0 || number > 7000)
            throw new InvalidDataException("Invalid system coordinate.");
        return (int)number;
    }
    private static string Text(object value, int maximum)
    {
        var text = Convert.ToString(value) ?? "";
        return text.Substring(0, Math.Min(text.Length, maximum));
    }
    private static Dictionary<string, object> NormalizeSystem(Dictionary<string, object> row, ref int totalBodies)
    {
        var x = Coordinate(Value(row, "coordinate_x"));
        var y = Coordinate(Value(row, "coordinate_y"));
        var bodies = Value(row, "bodies") as object[];
        if (bodies == null) throw new InvalidDataException("Body data is missing.");
        var nodes = new List<object>();
        for (var i = 0; i < bodies.Length; i++)
        {
            totalBodies++;
            var body = bodies[i] as Dictionary<string, object>;
            if (body == null || !(Value(body, "hasNodes") is bool)) throw new InvalidDataException("Invalid body data.");
            var quality = Value(body, "nodeQuality");
            if (!(bool)Value(body, "hasNodes") || !Numeric(quality) || Convert.ToDouble(quality) != 100) continue;
            var resource = Text(Value(body, "nodeType"), 40);
            if (resource.Length == 0) throw new InvalidDataException("A perfect resource type is missing.");
            nodes.Add(new Dictionary<string, object>
            {
                { "id", "api-body-" + i }, { "type", resource }, { "body", Text(Value(body, "type"), 80) }, { "quality", 100 },
            });
        }
        if (nodes.Count == 0) return null;
        // /systems currently documents only X/Y for the main Steam galaxy.
        // Never project these results onto another Z layer.
        return new Dictionary<string, object>
        {
            { "name", Text(Value(row, "name"), 100) }, { "x", x }, { "y", y }, { "z", 1 }, { "nodes", nodes },
        };
    }
}
