import { mount } from 'svelte';
import App from './App.svelte';
import { showVisitorCount } from './lib/visitorCount';
import './styles.css';

mount(App, { target: document.getElementById('app')! });
// Modules run after parsing, so the beacon tag is already in the DOM.
showVisitorCount();
