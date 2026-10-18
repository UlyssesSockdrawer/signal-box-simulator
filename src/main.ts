import { Store, type KeyValueStorage } from './core/store';
import { startApp } from './ui/app';

let storage: KeyValueStorage | null = null;
try {
  storage = window.localStorage;
  storage.getItem('probe');
} catch {
  storage = null; // private mode or blocked storage: the app still runs, it just won't remember.
}

const store = new Store(storage);
startApp(document.getElementById('app')!, store);

// Offline support when installed as an app (only works when served over http/https, not from a file).
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && document.querySelector('link[rel="manifest"]')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
