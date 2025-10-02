import { env } from '../config/environment.js';

class Semaphore {
  constructor(maxConcurrent = env.ocrConcurrency || 2) {
    this.max = typeof maxConcurrent === 'number' && maxConcurrent > 0 ? maxConcurrent : 2;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current += 1;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.current += 1;
        resolve(() => this.release());
      });
    });
  }

  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

export const globalSemaphore = new Semaphore(); // uses env.ocrConcurrency by default

export default Semaphore;
