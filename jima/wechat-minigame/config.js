(function configureZaoluMiniGame(scope) {
  // Localhost is for the desktop simulator only. Real devices require a fixed HTTPS/WSS domain.
  var config = Object.freeze({
    serverUrl: "http://127.0.0.1:3001",
    socketPath: "/socket.io/",
    voice: Object.freeze({
      enabled: true,
      requireRealDevice: true,
    }),
  });

  scope.ZAOLU_MINIGAME_CONFIG = config;
  scope.ZAOLU_SERVER_URL = config.serverUrl;

  if (typeof window !== "undefined") {
    window.ZAOLU_MINIGAME_CONFIG = config;
    window.ZAOLU_SERVER_URL = config.serverUrl;
  }
})(typeof GameGlobal !== "undefined" ? GameGlobal : globalThis);
