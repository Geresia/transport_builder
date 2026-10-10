using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Transitline.Construction3d
{
    public static class Construction3dProtocol
    {
        public const string EnvelopeSchema = "transitline.construction-3d-client-envelope/1";
        public const string AdapterProtocol = "transitline.construction-3d-adapter/1";
        public const string SceneSchema = "transitline.construction-3d-scene/1";
        public const string StageSchema = "transitline.construction-3d-stage-manifest/1";
        public const int ContractVersion = 1;

        public static string Handshake(string sessionId)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("A session id is required.", nameof(sessionId));
            return "{\"schema\":\"" + EnvelopeSchema + "\",\"contractVersion\":1,\"sessionId\":\"" + EscapeJson(sessionId) + "\",\"kind\":\"handshake\",\"payload\":{\"protocol\":\"" + AdapterProtocol + "\",\"contractVersion\":1,\"clientId\":\"transitline-unity-construction-client\",\"clientVersion\":\"0.1.0\",\"capabilities\":[\"scene-manifest-v1\",\"change-set-v1\",\"stage-manifest-v1\"]}}";
        }

        public static bool TrySceneEnvelope(string json, string expectedSessionId, out IDictionary<string, object> scene, out string error)
        {
            scene = null;
            error = null;
            var envelope = MiniJson.Deserialize(json) as IDictionary<string, object>;
            if (envelope == null) { error = "envelope-not-object"; return false; }
            if (!EqualsText(envelope, "schema", EnvelopeSchema) || !EqualsNumber(envelope, "contractVersion", ContractVersion)) { error = "envelope-schema-invalid"; return false; }
            if (!EqualsText(envelope, "sessionId", expectedSessionId)) { error = "envelope-session-mismatch"; return false; }
            if (!EqualsText(envelope, "kind", "scene")) { error = "envelope-kind-invalid"; return false; }
            scene = ReadObject(envelope, "payload");
            if (scene == null || !EqualsText(scene, "schema", SceneSchema) || !EqualsNumber(scene, "contractVersion", ContractVersion)) { error = "scene-schema-invalid"; scene = null; return false; }
            return true;
        }

        public static bool TryStageEnvelope(string json, string expectedSessionId, out IDictionary<string, object> stage, out string error)
        {
            stage = null;
            error = null;
            var envelope = MiniJson.Deserialize(json) as IDictionary<string, object>;
            if (envelope == null) { error = "envelope-not-object"; return false; }
            if (!EqualsText(envelope, "schema", EnvelopeSchema) || !EqualsNumber(envelope, "contractVersion", ContractVersion)) { error = "envelope-schema-invalid"; return false; }
            if (!EqualsText(envelope, "sessionId", expectedSessionId)) { error = "envelope-session-mismatch"; return false; }
            if (!EqualsText(envelope, "kind", "stage")) { error = "envelope-kind-invalid"; return false; }
            stage = ReadObject(envelope, "payload");
            if (stage == null || !EqualsText(stage, "schema", StageSchema) || !EqualsNumber(stage, "contractVersion", ContractVersion)) { error = "stage-schema-invalid"; stage = null; return false; }
            return true;
        }

        public static IDictionary<string, object> ReadObject(IDictionary<string, object> objectValue, string key)
        {
            return objectValue != null && objectValue.TryGetValue(key, out var value) ? value as IDictionary<string, object> : null;
        }

        public static IList ReadList(IDictionary<string, object> objectValue, string key)
        {
            return objectValue != null && objectValue.TryGetValue(key, out var value) ? value as IList : null;
        }

        public static string ReadText(IDictionary<string, object> objectValue, string key)
        {
            return objectValue != null && objectValue.TryGetValue(key, out var value) ? value as string : null;
        }

        public static bool TryNumber(object value, out double number)
        {
            switch (value)
            {
                case double doubleValue: number = doubleValue; return true;
                case float floatValue: number = floatValue; return true;
                case long longValue: number = longValue; return true;
                case int intValue: number = intValue; return true;
                case decimal decimalValue: number = (double)decimalValue; return true;
                default: number = 0; return false;
            }
        }

        private static bool EqualsText(IDictionary<string, object> value, string key, string expected) => string.Equals(ReadText(value, key), expected, StringComparison.Ordinal);
        private static bool EqualsNumber(IDictionary<string, object> value, string key, int expected) => value != null && value.TryGetValue(key, out var raw) && TryNumber(raw, out var number) && Math.Abs(number - expected) < double.Epsilon;
        public static string EscapeJson(string text) => text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
    }

    // A small, dependency-free JSON reader. Unity's JsonUtility cannot retain
    // the heterogeneous, nested geometry arrays in the B21 scene manifest.
    internal static class MiniJson
    {
        public static object Deserialize(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return null;
            // The host transport is intentionally fail-closed. Malformed JSON
            // must become a rejected frame, never an exception on Unity's main
            // thread that could leave an old scene on screen.
            try { return new Parser(json).ParseDocument(); }
            catch (Exception) { return null; }
        }

        private sealed class Parser
        {
            private readonly StringReader reader;
            public Parser(string json) { reader = new StringReader(json); }
            private char Peek => Convert.ToChar(reader.Peek());
            private char Next => Convert.ToChar(reader.Read());

            public object ParseDocument()
            {
                var value = ParseValue();
                EatWhitespace();
                return reader.Peek() == -1 ? value : null;
            }

            public object ParseValue()
            {
                EatWhitespace();
                if (reader.Peek() == -1) return null;
                switch (Peek)
                {
                    case '{': return ParseObject();
                    case '[': return ParseArray();
                    case '"': return ParseString();
                    case 't': Consume("true"); return true;
                    case 'f': Consume("false"); return false;
                    case 'n': Consume("null"); return null;
                    default: return ParseNumber();
                }
            }

            private IDictionary<string, object> ParseObject()
            {
                var result = new Dictionary<string, object>(StringComparer.Ordinal);
                reader.Read(); EatWhitespace();
                while (reader.Peek() != -1 && Peek != '}')
                {
                    var key = ParseString(); EatWhitespace();
                    if (key == null) return null;
                    if (reader.Peek() == -1 || Next != ':') return null;
                    var value = ParseValue();
                    result[key] = value; EatWhitespace();
                    if (reader.Peek() != -1 && Peek == ',') { reader.Read(); EatWhitespace(); }
                    else if (reader.Peek() != -1 && Peek != '}') return null;
                }
                if (reader.Peek() == -1) return null;
                reader.Read(); return result;
            }

            private IList ParseArray()
            {
                var result = new List<object>();
                reader.Read(); EatWhitespace();
                while (reader.Peek() != -1 && Peek != ']')
                {
                    result.Add(ParseValue()); EatWhitespace();
                    if (reader.Peek() != -1 && Peek == ',') { reader.Read(); EatWhitespace(); }
                    else if (reader.Peek() != -1 && Peek != ']') return null;
                }
                if (reader.Peek() == -1) return null;
                reader.Read(); return result;
            }

            private string ParseString()
            {
                if (reader.Peek() == -1 || Next != '"') return null;
                var text = new StringBuilder();
                while (reader.Peek() != -1)
                {
                    var character = Next;
                    if (character == '"') return text.ToString();
                    if (character != '\\') { text.Append(character); continue; }
                    if (reader.Peek() == -1) return null;
                    switch (Next)
                    {
                        case '"': text.Append('"'); break; case '\\': text.Append('\\'); break;
                        case '/': text.Append('/'); break; case 'b': text.Append('\b'); break;
                        case 'f': text.Append('\f'); break; case 'n': text.Append('\n'); break;
                        case 'r': text.Append('\r'); break; case 't': text.Append('\t'); break;
                        case 'u': text.Append((char)Convert.ToInt32(new string(new[] { Next, Next, Next, Next }), 16)); break;
                        default: return null;
                    }
                }
                return null;
            }

            private object ParseNumber()
            {
                var text = new StringBuilder();
                while (reader.Peek() != -1 && "-+0123456789.eE".IndexOf(Peek) >= 0) text.Append(Next);
                if (long.TryParse(text.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var integer)) return integer;
                return double.TryParse(text.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ? number : null;
            }

            private void Consume(string expected) { foreach (var character in expected) if (reader.Peek() == -1 || Next != character) throw new FormatException("Invalid JSON token."); }
            private void EatWhitespace() { while (reader.Peek() != -1 && char.IsWhiteSpace(Peek)) reader.Read(); }
        }
    }
}
