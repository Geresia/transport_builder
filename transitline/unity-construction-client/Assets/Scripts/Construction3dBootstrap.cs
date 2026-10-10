using UnityEngine;

namespace Transitline.Construction3d
{
    public static class Construction3dBootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void CreateClient()
        {
            if (Object.FindAnyObjectByType<Construction3dClientBridge>() == null)
            {
                var root = new GameObject("TransitlineConstruction3dClient");
                root.AddComponent<Construction3dClientBridge>();
            }
            if (Camera.main != null) return;
            var cameraObject = new GameObject("ConstructionPreviewCamera");
            cameraObject.tag = "MainCamera";
            cameraObject.AddComponent<Camera>();
            cameraObject.AddComponent<AudioListener>();
            cameraObject.transform.position = new Vector3(0, 120, -120);
            cameraObject.transform.LookAt(Vector3.zero);
            Camera.main.backgroundColor = new Color(0.035f, 0.055f, 0.08f);
        }
    }
}
