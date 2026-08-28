export class SerialClient extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.pending = new Map();
    this.requestCounter = 0;
    this.reading = false;
    this.readLoopPromise = null;
    this.rxBuffer = "";
  }

  get supported() {
    return "serial" in navigator;
  }

  get isConnected() {
    return Boolean(this.port && this.writer);
  }

  async connect({ baudRate }) {
    if (!this.supported) {
      throw new Error("Web Serial API is not available. Use Chrome or Edge on desktop.");
    }

    this.port = await navigator.serial.requestPort();
    await this.port.open({
      baudRate: Number(baudRate),
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none"
    });

    this.writer = this.port.writable.getWriter();
    this.reading = true;
    this.readLoopPromise = this.readLoop();
    this.dispatch("connection", { connected: true });
  }

  async disconnect() {
    this.reading = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Serial disconnected"));
    }
    this.pending.clear();

    if (this.reader) {
      await this.reader.cancel().catch(() => {});
    }

    if (this.readLoopPromise) {
      await this.readLoopPromise.catch(() => {});
      this.readLoopPromise = null;
    }

    if (this.writer) {
      this.writer.releaseLock();
      this.writer = null;
    }

    if (this.port) {
      await this.port.close();
      this.port = null;
    }

    this.dispatch("connection", { connected: false });
  }

  async sendCommand(command, payload = {}, timeoutMs = 3000) {
    if (!this.writer) {
      throw new Error("Serial is not connected");
    }

    const id = String(++this.requestCounter);
    const request = { id, cmd: command, ...payload };
    const line = `${JSON.stringify(request)}\n`;
    await this.writer.write(new TextEncoder().encode(line));
    this.dispatch("tx", { line: line.trim(), request });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${command} response`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async sendString(text) {
    if (!this.writer) throw new Error("Serial is not connected");
    await this.writer.write(new TextEncoder().encode(text));
    this.dispatch("tx", { line: text.trim(), request: { cmd: "raw_string" } });
  }

  async sendRaw(rawJson, timeoutMs = 3000) {
    const parsed = JSON.parse(rawJson);
    if (!parsed.id) {
      parsed.id = String(++this.requestCounter);
    }
    if (!parsed.cmd) {
      throw new Error("Raw JSON must include the cmd field");
    }
    const { id, cmd } = parsed;
    const line = `${JSON.stringify(parsed)}\n`;
    await this.writer.write(new TextEncoder().encode(line));
    this.dispatch("tx", { line: line.trim(), request: parsed });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${cmd} response`));
      }, timeoutMs);

      this.pending.set(String(id), { resolve, reject, timer });
    });
  }

  async readLoop() {
    const decoder = new TextDecoder();

    while (this.port?.readable && this.reading) {
      this.reader = this.port.readable.getReader();
      try {
        while (this.reading) {
          const { value, done } = await this.reader.read();
          if (done) {
            break;
          }
          this.consumeText(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        this.dispatch("error", { error });
      } finally {
        this.reader?.releaseLock();
        this.reader = null;
      }
    }
  }

  consumeText(chunk) {
    this.rxBuffer += chunk;
    const lines = this.rxBuffer.split(/\r?\n/);
    this.rxBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.handleLine(trimmed);
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.dispatch("rx-invalid", { line, error });
      return;
    }

    this.dispatch("rx", { line, message });

    if (message.type === "response" && message.id && this.pending.has(String(message.id))) {
      const pending = this.pending.get(String(message.id));
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      pending.resolve(message);
    }
  }

  dispatch(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
