import { WebSocket as EngineWebSocketTransport } from "engine.io-client";

export class WxWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols) {
    this.url = url;
    this.readyState = WxWebSocket.CONNECTING;
    this.binaryType = "arraybuffer";
    this.bufferedAmount = 0;
    this.protocol = "";
    this.extensions = "";
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this.listeners = {
      open: new Set(),
      close: new Set(),
      error: new Set(),
      message: new Set(),
    };

    const wxApi = globalThis.wx;
    if (!wxApi?.connectSocket) throw new Error("wx.connectSocket is unavailable");
    const protocolList = Array.isArray(protocols) ? protocols : protocols ? [protocols] : undefined;
    this.task = wxApi.connectSocket({
      url,
      protocols: protocolList,
      tcpNoDelay: true,
      perMessageDeflate: false,
      timeout: 10_000,
      fail: (error) => setTimeout(() => this.emitError(error), 0),
    });
    this.task.onOpen((raw) => {
      this.readyState = WxWebSocket.OPEN;
      this.emit("open", { type: "open", target: this, raw });
    });
    this.task.onMessage(({ data }) => {
      this.emit("message", { type: "message", target: this, data });
    });
    this.task.onError((error) => this.emitError(error));
    this.task.onClose(({ code = 1006, reason = "" } = {}) => {
      this.readyState = WxWebSocket.CLOSED;
      this.emit("close", {
        type: "close",
        target: this,
        code,
        reason,
        wasClean: code === 1000,
      });
    });
  }

  addEventListener(type, listener) {
    this.listeners[type]?.add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners[type]?.delete(listener);
  }

  emit(type, event) {
    this[`on${type}`]?.(event);
    this.listeners[type]?.forEach((listener) => listener(event));
  }

  emitError(error) {
    this.emit("error", {
      type: "error",
      target: this,
      message: error?.errMsg || error?.message || "websocket error",
      error,
    });
  }

  send(data) {
    if (this.readyState !== WxWebSocket.OPEN) throw new Error("WebSocket is not open");
    this.task.send({ data, fail: (error) => this.emitError(error) });
  }

  close(code = 1000, reason = "") {
    if ([WxWebSocket.CLOSING, WxWebSocket.CLOSED].includes(this.readyState)) return;
    this.readyState = WxWebSocket.CLOSING;
    this.task.close({ code, reason, fail: (error) => this.emitError(error) });
  }
}

export class WxSocketTransport extends EngineWebSocketTransport {
  createSocket(uri, protocols, _options) {
    return new WxWebSocket(uri, protocols);
  }
}
