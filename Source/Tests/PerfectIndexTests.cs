using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;

internal static class PerfectIndexTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static Dictionary<string, object> Parse(string text) { using (var reader = new StringReader(text)) return PerfectSystemReader.Read(reader); }
    private static string Body(string quality, string hasNodes, string type)
    {
        return "{\"type\":\"Rocky Planet\",\"nodeType\":\"" + type + "\",\"nodeQuality\":" + quality + ",\"hasNodes\":" + hasNodes + "}";
    }
    private static string Row(string bodies, int x = 10)
    {
        return "{\"name\":\"Escaped \\\"star\\\" \\u2605\",\"coordinate_x\":" + x + ",\"coordinate_y\":20,\"bodies\":[" + bodies + "]}";
    }
    private static void Invalid(string json)
    {
        try { Parse(json); }
        catch { return; }
        throw new Exception("Invalid response was accepted: " + json.Substring(0, Math.Min(80, json.Length)));
    }
    private static int Main()
    {
        try
        {
            var exact = Row(Body("100", "true", "rocky") + "," + Body("99.999", "true", "icy") + "," + Body("null", "true", "gas") + "," + Body("100", "false", "crystal") + "," + Body("\"100\"", "true", "gas"));
            var result = Parse(" { \"metadata\":{\"note\":\"[}\\\"\"},\"systems\":[" + exact + "," + Row(Body("0", "true", "gas"), 15) + "]} ");
            var systems = (Dictionary<string, object>[])result["systems"];
            Check((int)result["totalSystems"] == 2 && (int)result["totalBodies"] == 6, "Complete counts were lost.");
            Check(systems.Length == 1 && (int)result["perfectNodeCount"] == 1, "Only numeric exact 100 with hasNodes=true may qualify.");
            Check((string)systems[0]["name"] == "Escaped \"star\" \u2605", "Escaped labels were not parsed correctly.");
            Check((int)systems[0]["z"] == 1, "Public coordinates must remain on the main layer.");
            var duplicate = Parse("{\"systems\":[" + exact + "," + exact + "]}");
            Check(((Dictionary<string, object>[])duplicate["systems"]).Length == 1, "Duplicate coordinates must not duplicate destinations.");
            Check(((Dictionary<string, object>[])Parse("{\"systems\":[]}")["systems"]).Length == 0, "An explicitly empty galaxy is valid.");
            Invalid("{}");
            Invalid("{\"systems\":[" + exact + ",]}");
            Invalid("{\"systems\":[" + exact);
            Invalid("{\"systems\":[]} trailing");
            Invalid("{\"systems\":[],\"systems\":[]}");
            Invalid("{\"systems\":[{\"coordinate_x\":1,\"coordinate_y\":2}]}");
            Invalid("{\"systems\":[" + Row(Body("100", "true", "gas"), 8000) + "]}");
            var watch = Stopwatch.StartNew();
            using (var large = new RepeatingGalaxyReader(Row(Body("50", "true", "rocky")), 220000))
            {
                var compact = PerfectSystemReader.Read(large);
                Check((int)compact["totalSystems"] == 220000, "Large streaming response was truncated.");
                Check(((Dictionary<string, object>[])compact["systems"]).Length == 0, "Non-perfect systems entered the compact index.");
                Check(large.CharactersRead > 32L * 1024 * 1024, "Stress fixture must exceed the old response cap.");
                Console.WriteLine("Streamed " + large.CharactersRead + " characters in " + watch.ElapsedMilliseconds + " ms without retaining the full galaxy.");
            }
            Console.WriteLine("Perfect-index native tests passed: exact quality, duplicates, escapes, malformed/truncated feeds, layer scope, and large streaming response.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private sealed class RepeatingGalaxyReader : TextReader
    {
        private readonly string row;
        private readonly int count;
        private string segment = "{\"systems\":[";
        private int index, emitted;
        private bool suffix;
        internal long CharactersRead;
        internal RepeatingGalaxyReader(string value, int repetitions) { row = value; count = repetitions; }
        public override int Peek()
        {
            if (index < segment.Length) return segment[index];
            if (emitted < count) { segment = (emitted++ == 0 ? "" : ",") + row; index = 0; }
            else if (!suffix) { segment = "]}"; index = 0; suffix = true; }
            else return -1;
            return segment[index];
        }
        public override int Read() { var value = Peek(); if (value >= 0) { index++; CharactersRead++; } return value; }
    }
}
