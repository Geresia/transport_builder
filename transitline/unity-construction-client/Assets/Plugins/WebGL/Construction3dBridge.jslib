mergeInto(LibraryManager.library, {
  Construction3dBridgeConfigure: function(receiverPointer, methodPointer, sessionPointer, originPointer) {
    var receiver = UTF8ToString(receiverPointer);
    var method = UTF8ToString(methodPointer);
    var sessionId = UTF8ToString(sessionPointer);
    var hostOrigin = UTF8ToString(originPointer);
    var bridge = window.transitlineConstruction3dBridge || {};
    if (bridge.listener) window.removeEventListener("message", bridge.listener);
    bridge.hostOrigin = hostOrigin;
    bridge.listener = function(event) {
      if (event.source !== window.parent || event.origin !== bridge.hostOrigin) return;
      if (!event.data || event.data.sessionId !== sessionId) return;
      SendMessage(receiver, method, JSON.stringify(event.data));
    };
    window.addEventListener("message", bridge.listener);
    window.transitlineConstruction3dBridge = bridge;
  },
  Construction3dBridgePost: function(jsonPointer) {
    var bridge = window.transitlineConstruction3dBridge;
    if (!bridge || !bridge.hostOrigin || window.parent === window) return;
    try { window.parent.postMessage(JSON.parse(UTF8ToString(jsonPointer)), bridge.hostOrigin); } catch (_) { }
  }
});
