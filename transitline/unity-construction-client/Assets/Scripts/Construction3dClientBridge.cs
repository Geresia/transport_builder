using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Transitline.Construction3d
{
    public sealed class Construction3dClientBridge : MonoBehaviour
    {
        private string sessionId;
        private string hostOrigin;
        private ConstructionScenePresenter presenter;
        private ConstructionStagePresenter stagePresenter;
        public string Status { get; private set; } = "starting";
        public string SessionId => sessionId;

        private void Awake()
        {
            DontDestroyOnLoad(gameObject);
            presenter = gameObject.GetComponent<ConstructionScenePresenter>() ?? gameObject.AddComponent<ConstructionScenePresenter>();
            stagePresenter = gameObject.GetComponent<ConstructionStagePresenter>() ?? gameObject.AddComponent<ConstructionStagePresenter>();
            if (gameObject.GetComponent<ConstructionSpatialReviewController>() == null) gameObject.AddComponent<ConstructionSpatialReviewController>();
        }

        private void Start()
        {
            sessionId = ReadQuery("sessionId");
            hostOrigin = ReadQuery("hostOrigin");
            if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(hostOrigin))
            {
                Status = "bridge-configuration-missing";
                return;
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            Construction3dBridgeConfigure(gameObject.name, nameof(ReceiveFromHost), sessionId, hostOrigin);
            Construction3dBridgePost(Construction3dProtocol.Handshake(sessionId));
            Status = "handshake-sent";
#else
            Status = "webgl-bridge-unavailable";
#endif
        }

        // Called only by the WebGL bridge after it has checked parent origin,
        // parent window identity, and the query-bound session id.
        public void ReceiveFromHost(string json)
        {
            var envelope = MiniJson.Deserialize(json) as System.Collections.Generic.IDictionary<string, object>;
            var kind = Construction3dProtocol.ReadText(envelope, "kind");
            if (kind == "scene")
            {
                if (presenter == null) { Status = "presenter-missing"; return; }
                Status = presenter.Present(json, sessionId) ? "scene-rendered" : presenter.Status;
                return;
            }
            if (kind == "stage")
            {
                if (stagePresenter == null) { Status = "stage-presenter-missing"; return; }
                Status = stagePresenter.Present(json, sessionId) ? "stage-rendered" : stagePresenter.Status;
                return;
            }
            presenter?.ClearPresentation();
            stagePresenter?.ClearPresentation();
            Status = "envelope-kind-invalid";
        }

        public string HandshakeForTest(string id) => Construction3dProtocol.Handshake(id);

        // The spatial-review controller may only submit a proposal after an
        // explicit click. The browser bridge still owns the parent/origin check
        // and the JavaScript host still validates every source revision.
        public void PostToHost(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return;
#if UNITY_WEBGL && !UNITY_EDITOR
            Construction3dBridgePost(json);
#endif
        }

        private static string ReadQuery(string key)
        {
            var query = Application.absoluteURL;
            if (string.IsNullOrWhiteSpace(query)) return null;
            var marker = "?";
            var start = query.IndexOf(marker, StringComparison.Ordinal);
            if (start < 0) return null;
            foreach (var part in query.Substring(start + 1).Split('&'))
            {
                var pair = part.Split(new[] { '=' }, 2);
                if (pair.Length == 2 && Uri.UnescapeDataString(pair[0]) == key) return Uri.UnescapeDataString(pair[1]);
            }
            return null;
        }

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern void Construction3dBridgeConfigure(string receiver, string method, string sessionId, string hostOrigin);
        [DllImport("__Internal")] private static extern void Construction3dBridgePost(string json);
#endif
    }
}
