class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Int16Array(this.bufferSize);
    this.bytesWritten = 0;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      for (let i = 0; i < channelData.length; i++) {
        this.buffer[this.bytesWritten++] = Math.max(-1, Math.min(1, channelData[i])) * 0x7FFF;
        if (this.bytesWritten >= this.bufferSize) {
          const outBuffer = new Int16Array(this.buffer);
          this.port.postMessage(outBuffer.buffer, [outBuffer.buffer]);
          this.bytesWritten = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
