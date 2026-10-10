using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace Transitline.Construction3d
{
    public sealed class ConstructionScenePresenter : MonoBehaviour
    {
        private readonly List<GameObject> rendered = new List<GameObject>();
        private Material lineMaterial;
        public string Status { get; private set; } = "waiting-for-scene";
        public IDictionary<string, object> CurrentScene { get; private set; }

        public bool Present(string envelopeJson, string sessionId)
        {
            if (!Construction3dProtocol.TrySceneEnvelope(envelopeJson, sessionId, out var scene, out var error))
            {
                Clear(); CurrentScene = null;
                Status = error;
                return false;
            }
            var coordinates = Construction3dProtocol.ReadObject(scene, "coordinates");
            if (!TryCoordinates(coordinates, out var origin, out var metersPerUnit))
            {
                Clear(); CurrentScene = null;
                Status = "scene-coordinates-invalid";
                return false;
            }
            Clear();
            var bounds = new Bounds(Vector3.zero, Vector3.zero);
            var hasBounds = false;
            var sources = Construction3dProtocol.ReadList(scene, "sources");
            if (sources == null) { CurrentScene = null; Status = "scene-sources-missing"; return false; }
            foreach (var rawSource in sources)
            {
                var source = rawSource as IDictionary<string, object>;
                if (source == null) continue;
                var sourceType = Construction3dProtocol.ReadText(source, "sourceType") ?? "unknown";
                var sourceId = Construction3dProtocol.ReadText(source, "sourceId") ?? "unknown";
                if (!source.TryGetValue("geometry", out var geometry) || geometry == null) continue;
                var paths = new List<List<Vector2>>();
                ExtractPaths(geometry, paths);
                foreach (var path in paths)
                {
                    if (path.Count == 0) continue;
                    var points = new List<Vector3>();
                    foreach (var point in path)
                    {
                        var world = ToUnity(point, origin, metersPerUnit);
                        points.Add(world);
                        if (!hasBounds) { bounds = new Bounds(world, Vector3.zero); hasBounds = true; }
                        else bounds.Encapsulate(world);
                    }
                    RenderPath(sourceType, sourceId, points, IsAreaSource(sourceType));
                }
            }
            if (hasBounds) FrameCamera(bounds);
            CurrentScene = scene;
            Status = "scene-rendered";
            return true;
        }

        private void RenderPath(string sourceType, string sourceId, List<Vector3> points, bool closed)
        {
            if (points.Count == 1)
            {
                var marker = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                marker.name = sourceType + ":" + sourceId;
                marker.transform.position = points[0];
                marker.transform.localScale = Vector3.one * 8f;
                marker.GetComponent<Renderer>().material.color = ColorFor(sourceType);
                rendered.Add(marker);
                return;
            }
            var target = new GameObject(sourceType + ":" + sourceId);
            var line = target.AddComponent<LineRenderer>();
            line.material = LineMaterial;
            line.startColor = ColorFor(sourceType);
            line.endColor = ColorFor(sourceType);
            line.widthMultiplier = sourceType == "rail-geometry" ? 3f : 2f;
            line.positionCount = points.Count + (closed ? 1 : 0);
            for (var index = 0; index < points.Count; index++) line.SetPosition(index, points[index]);
            if (closed) line.SetPosition(points.Count, points[0]);
            rendered.Add(target);
        }

        private Material LineMaterial
        {
            get
            {
                if (lineMaterial == null)
                {
                    var shader = Shader.Find("Sprites/Default");
                    lineMaterial = new Material(shader) { hideFlags = HideFlags.DontSave };
                }
                return lineMaterial;
            }
        }

        private static Color ColorFor(string sourceType)
        {
            switch (sourceType)
            {
                case "rail-geometry": return new Color(0.1f, 0.75f, 1f);
                case "station-site": return new Color(1f, 0.9f, 0.2f);
                case "depot-site": return new Color(1f, 0.4f, 0.1f);
                case "new-town-development": return new Color(0.4f, 0.9f, 0.35f);
                default: return Color.magenta;
            }
        }

        private static bool IsAreaSource(string sourceType) => sourceType == "depot-site" || sourceType == "new-town-development";

        private static bool TryCoordinates(IDictionary<string, object> coordinates, out Vector2 origin, out double metersPerUnit)
        {
            origin = Vector2.zero; metersPerUnit = 1;
            var values = Construction3dProtocol.ReadList(coordinates, "originLonLat");
            if (values == null || values.Count != 2 || !Construction3dProtocol.TryNumber(values[0], out var longitude) || !Construction3dProtocol.TryNumber(values[1], out var latitude)) return false;
            if (!coordinates.TryGetValue("metersPerUnit", out var rawScale) || !Construction3dProtocol.TryNumber(rawScale, out metersPerUnit) || metersPerUnit <= 0) return false;
            origin = new Vector2((float)longitude, (float)latitude); return true;
        }

        private static Vector3 ToUnity(Vector2 point, Vector2 origin, double metersPerUnit)
        {
            var north = (point.y - origin.y) * 110540d;
            var east = (point.x - origin.x) * 111320d * Math.Cos(origin.y * Math.PI / 180d);
            return new Vector3((float)(east / metersPerUnit), 0, (float)(north / metersPerUnit));
        }

        private static void ExtractPaths(object node, List<List<Vector2>> output)
        {
            var list = node as IList;
            if (list == null) return;
            if (IsPoint(list, out var point)) { output.Add(new List<Vector2> { point }); return; }
            var points = new List<Vector2>();
            var allPoints = list.Count > 0;
            foreach (var item in list)
            {
                if (item is IList candidate && IsPoint(candidate, out var candidatePoint)) points.Add(candidatePoint);
                else { allPoints = false; break; }
            }
            if (allPoints) { output.Add(points); return; }
            foreach (var item in list) ExtractPaths(item, output);
        }

        private static bool IsPoint(IList value, out Vector2 point)
        {
            point = Vector2.zero;
            if (value == null || value.Count != 2 || !Construction3dProtocol.TryNumber(value[0], out var longitude) || !Construction3dProtocol.TryNumber(value[1], out var latitude)) return false;
            point = new Vector2((float)longitude, (float)latitude); return true;
        }

        private void FrameCamera(Bounds bounds)
        {
            var camera = Camera.main;
            if (camera == null) return;
            var extent = Mathf.Max(80f, Mathf.Max(bounds.extents.x, bounds.extents.z));
            camera.transform.position = bounds.center + new Vector3(extent * 1.2f, extent * 1.6f, -extent * 1.2f);
            camera.transform.LookAt(bounds.center);
        }

        private void Clear()
        {
            foreach (var item in rendered) if (item != null) Destroy(item);
            rendered.Clear();
        }

        public void ClearPresentation()
        {
            Clear();
            CurrentScene = null;
            Status = "scene-cleared";
        }

        private void OnDestroy()
        {
            Clear();
            if (lineMaterial != null) Destroy(lineMaterial);
        }
    }
}
