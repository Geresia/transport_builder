using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace Transitline.Construction3d
{
    // B22's small review surface intentionally records only the three supplied
    // observation states. It does not decide feasibility or mutate the scene.
    public sealed class ConstructionSpatialReviewController : MonoBehaviour
    {
        private readonly Dictionary<string, string> states = new Dictionary<string, string>(StringComparer.Ordinal);
        private ConstructionScenePresenter presenter;
        private Construction3dClientBridge bridge;
        private string notice = "Waiting for a current scene snapshot.";
        private static readonly string[] StateLabels = { "clear", "conflict", "unknown" };

        private void Awake()
        {
            presenter = GetComponent<ConstructionScenePresenter>();
            bridge = GetComponent<Construction3dClientBridge>();
        }

        private void OnGUI()
        {
            var scene = presenter == null ? null : presenter.CurrentScene;
            GUILayout.BeginArea(new Rect(12f, 12f, 340f, Screen.height - 24f), GUI.skin.box);
            GUILayout.Label("Construction spatial review");
            GUILayout.Label("Observations only — never construction approval.");
            if (scene == null)
            {
                GUILayout.Label(notice);
                GUILayout.EndArea();
                return;
            }
            var sources = Construction3dProtocol.ReadList(scene, "sources");
            if (sources == null || sources.Count == 0)
            {
                GUILayout.Label("No source facts were supplied.");
                GUILayout.EndArea();
                return;
            }
            foreach (var raw in sources)
            {
                var source = raw as IDictionary<string, object>;
                var type = Construction3dProtocol.ReadText(source, "sourceType");
                var id = Construction3dProtocol.ReadText(source, "sourceId");
                var revision = Construction3dProtocol.ReadText(source, "sourceRevision");
                if (string.IsNullOrWhiteSpace(type) || string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(revision)) continue;
                var key = type + "|" + id;
                if (!states.TryGetValue(key, out var current)) current = "unknown";
                GUILayout.Space(4f);
                GUILayout.Label(type + ": " + id);
                GUILayout.Label(SourceHasGeometry(source) ? "geometry supplied" : "geometry unknown — no substitute drawn");
                var index = Array.IndexOf(StateLabels, current);
                states[key] = StateLabels[GUILayout.Toolbar(Mathf.Max(0, index), StateLabels)];
            }
            GUILayout.Space(8f);
            if (GUILayout.Button("Submit spatial-review proposal")) Submit(scene, sources);
            GUILayout.Label(notice);
            GUILayout.EndArea();
        }

        private void Submit(IDictionary<string, object> scene, IList sources)
        {
            var sessionId = bridge == null ? null : bridge.SessionId;
            var packId = Construction3dProtocol.ReadText(scene, "packId");
            if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(packId)) { notice = "Review not sent: bridge or pack identity is missing."; return; }
            var observations = new StringBuilder();
            var count = 0;
            foreach (var raw in sources)
            {
                var source = raw as IDictionary<string, object>;
                var type = Construction3dProtocol.ReadText(source, "sourceType");
                var id = Construction3dProtocol.ReadText(source, "sourceId");
                var revision = Construction3dProtocol.ReadText(source, "sourceRevision");
                if (string.IsNullOrWhiteSpace(type) || string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(revision)) continue;
                var key = type + "|" + id;
                var state = states.TryGetValue(key, out var chosen) ? chosen : "unknown";
                if (count++ > 0) observations.Append(',');
                observations.Append("{\"observationId\":\"unity:").Append(Construction3dProtocol.EscapeJson(key)).Append("\",\"sourceType\":\"").Append(Construction3dProtocol.EscapeJson(type)).Append("\",\"sourceId\":\"").Append(Construction3dProtocol.EscapeJson(id)).Append("\",\"sourceRevision\":\"").Append(Construction3dProtocol.EscapeJson(revision)).Append("\",\"state\":\"").Append(state).Append("\",\"reason\":").Append(SourceHasGeometry(source) ? "null" : "\"geometry-not-provided\"").Append('}');
            }
            if (count == 0) { notice = "Review not sent: no complete source identity."; return; }
            var payload = "{\"schema\":\"transitline.construction-3d-spatial-review/1\",\"contractVersion\":1,\"reviewId\":\"unity-review:" + Construction3dProtocol.EscapeJson(sessionId) + "\",\"packId\":\"" + Construction3dProtocol.EscapeJson(packId) + "\",\"observations\":[" + observations + "]}";
            var envelope = "{\"schema\":\"" + Construction3dProtocol.EnvelopeSchema + "\",\"contractVersion\":1,\"sessionId\":\"" + Construction3dProtocol.EscapeJson(sessionId) + "\",\"kind\":\"spatial-review\",\"payload\":" + payload + "}";
            bridge.PostToHost(envelope);
            notice = "Spatial-review proposal sent; the 2D host still decides whether it is current.";
        }

        private static bool SourceHasGeometry(IDictionary<string, object> source) => source != null && source.TryGetValue("geometry", out var value) && value != null;
    }
}
