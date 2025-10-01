import { createWorker } from 'tesseract.js';

let worker = null;
let initPromise = null;

async function initWorker() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    worker = createWorker({});
    try {
      await worker.load();
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
      return worker;
    } catch (err) {
      console.warn('Failed to initialize tesseract worker:', err?.message || err);
      // If initialization fails, clear worker so future calls can retry
      try {
        if (worker) await worker.terminate();
      } catch (e) {
        // ignore
      }
      worker = null;
      initPromise = null;
      throw err;
    }
  })();
  return initPromise;
}

export async function recognizeBuffer(buffer) {
  try {
    await initWorker();
    if (!worker) return '';
    const { data } = await worker.recognize(buffer);
    return data?.text || '';
  } catch (err) {
    console.warn('OCR recognizeBuffer error:', err?.message || err);
    return '';
  }
}

export async function terminateWorker() {
  try {
    if (worker) {
      await worker.terminate();
      worker = null;
      initPromise = null;
    }
  } catch (err) {
    console.warn('Failed to terminate tesseract worker:', err?.message || err);
  }
}

export default { recognizeBuffer, terminateWorker };
