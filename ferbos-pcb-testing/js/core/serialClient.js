export class SerialClient extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.pending = new Map();
    this.requestCounter = 0;
    this.reading = false;
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
      throw new Error("Web Serial API tidak tersedia. Gunakan Chrome atau Edge desktop.");
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
    this.readLoop();
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

    if (this.writer) {
      this.writer.releaseLock();
      this.writer = null;
    }

    if (this.port) {
      await this.port.close().catch(() => {});
      this.port = null;
    }

    this.dispatch("connection", { connected: false });
  }

  async sendCommand(command, payload = {}, timeoutMs = 3000) {
    if (!this.writer) {
      throw new Error("Serial belum connect");
    }

    const id = String(++this.requestCounter);
    const request = { id, cmd: command, ...payload };
    const line = `${JSON.stringify(request)}\n`;
    await this.writer.write(new TextEncoder().encode(line));
    this.dispatch("tx", { line: line.trim(), request });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout menunggu response ${command}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async sendRaw(rawJson, timeoutMs = 3000) {
    const parsed = JSON.parse(rawJson);
    if (!parsed.id) {
      parsed.id = String(++this.requestCounter);
    }
    if (!parsed.cmd) {
      throw new Error("Raw JSON wajib punya field cmd");
    }
    const { id, cmd } = parsed;
    const line = `${JSON.stringify(parsed)}\n`;
    await this.writer.write(new TextEncoder().encode(line));
    this.dispatch("tx", { line: line.trim(), request: parsed });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timeout menunggu response ${cmd}`));
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
