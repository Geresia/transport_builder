using System;
using System.IO;
using Transitline.Construction3d;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.Build.Reporting;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Transitline.Construction3d.Editor
{
    public static class BuildConstruction3dWebGl
    {
        private const string ScenePath = "Assets/Scenes/ConstructionPreview.unity";
        private const string BuildPath = "Build/WebGL";

        // Batch-mode entry point used by the repository build check. The empty
        // scene is deliberate: the runtime bootstrap creates the visual-only
        // client and no authored scene can contain simulation state.
        public static void Perform()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath) ?? "Assets");
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = new GameObject("Construction3dClientBootstrap");
            root.AddComponent<Construction3dClientBridge>();
            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            Directory.CreateDirectory(BuildPath);
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = BuildPath,
                target = BuildTarget.WebGL,
                options = BuildOptions.None,
            });
            if (report.summary.result != BuildResult.Succeeded)
                throw new InvalidOperationException("Construction 3D WebGL build failed: " + report.summary.result);
        }
    }
}
