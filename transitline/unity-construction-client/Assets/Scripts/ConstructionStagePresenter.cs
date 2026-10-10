using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace Transitline.Construction3d
{
    // B23 displays one host-authored construction time slice. It deliberately
    // has no controls, update loop, schedule math, or world-coordinate guess.
    public sealed class ConstructionStagePresenter : MonoBehaviour
    {
        public string Status { get; private set; } = "waiting-for-stage";
        public IDictionary<string, object> CurrentStage { get; private set; }

        public bool Present(string envelopeJson, string sessionId)
        {
            if (!Construction3dProtocol.TryStageEnvelope(envelopeJson, sessionId, out var stage, out var error))
            {
                CurrentStage = null; Status = error; return false;
            }
            if (Construction3dProtocol.ReadList(stage, "entries") == null)
            {
                CurrentStage = null; Status = "stage-entries-missing"; return false;
            }
            CurrentStage = stage;
            Status = "stage-rendered";
            return true;
        }

        public void ClearPresentation()
        {
            CurrentStage = null;
            Status = "stage-cleared";
        }

        private void OnGUI()
        {
            var stage = CurrentStage;
            if (stage == null) return;
            var entries = Construction3dProtocol.ReadList(stage, "entries");
            if (entries == null) return;
            GUILayout.BeginArea(new Rect(Mathf.Max(360f, Screen.width - 330f), 12f, 318f, Screen.height - 24f), GUI.skin.box);
            GUILayout.Label("Construction stage (display only)");
            GUILayout.Label("Simulation minute: " + Value(stage, "simMinute"));
            if (entries.Count == 0) GUILayout.Label("No supplied stage entries.");
            foreach (var raw in entries)
            {
                var entry = raw as IDictionary<string, object>;
                if (entry == null) continue;
                GUILayout.Space(4f);
                GUILayout.Label(Value(entry, "kind") + ": " + Value(entry, "id"));
                GUILayout.Label("status: " + Value(entry, "status") + " · revision: " + Value(entry, "revision"));
                var location = entry.TryGetValue("location", out var value) ? value as IList : null;
                GUILayout.Label(location == null ? "location unknown — no marker inferred" : "location supplied by host");
            }
            GUILayout.EndArea();
        }

        private static string Value(IDictionary<string, object> value, string key)
        {
            if (value == null || !value.TryGetValue(key, out var raw) || raw == null) return "unknown";
            return raw.ToString();
        }
    }
}
