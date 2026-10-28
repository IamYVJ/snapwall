import { mount } from 'svelte';
import App from './App.svelte';
import './lib/install.svelte';
import { showVisitorCount } from './lib/visitorCount';
import './styles.css';

mount(App, { target: document.getElementById('app')! });
// Modules run after parsing, so the beacon tag is already in the DOM.
showVisitorCount();

// Lets guests add SnapWall to their home screen and open it without a network round trip for the shell.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
}
