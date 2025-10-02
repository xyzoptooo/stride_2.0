import { createWorker } from 'tesseract.js';

let worker = null;
let initPromise = null;
let workerBroken = false; // If true, avoid retrying initialization repeatedly

async function initWorker() {
  if (workerBroken) {
    // If worker previously failed in a way that could crash the process, avoid re-initializing
    throw new Error('OCR worker marked as broken');
  }

  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // Per tesseract.js v4+ docs, passing the language to createWorker is the simplest way.
      // It handles loading and initializing the language.
      console.log('Initializing Tesseract worker for English...');
      worker = await createWorker('eng');
      console.log('Tesseract worker initialized successfully.');
      return worker;
    } catch (err) {
      console.error('Failed to initialize tesseract worker:', err);
      workerBroken = true; // Mark as broken to prevent retries that would crash
      worker = null;
      initPromise = null; // Allow re-initialization on next call if not broken
      throw err; // Re-throw to signal failure
    }
  })();
  return initPromise;
}

export async function recognizeBuffer(buffer) {
  try {
    if (workerBroken) {
        console.warn('OCR recognition skipped: worker is marked as broken.');
        return '';
    }
    const safeWorker = await initWorker();
    if (!safeWorker) {
        console.warn('OCR recognition skipped: worker is not available.');
        return '';
    }
    const { data } = await safeWorker.recognize(buffer);
    return data?.text || '';
  } catch (err) {
    console.error('Error during OCR recognition:', err);
    // If a recognition error occurs, we'll log it but not mark the worker as broken
    // unless it's a fatal-looking error. The init block is better for that.
    return '';
  }
}

export async function terminateWorker() {
  if (initPromise) {
    try {
        const w = await initPromise;
        if (w) {
            await w.terminate();
        }
    } catch (e) {
        // ignore, may have failed to init
    }
  }
  worker = null;
  initPromise = null;
  workerBroken = false;
  console.log('Tesseract worker terminated.');
}

export default { recognizeBuffer, terminateWorker, initWorker };
export { initWorker };

export function isWorkerReady() {
  return Boolean(worker && !workerBroken);
}
