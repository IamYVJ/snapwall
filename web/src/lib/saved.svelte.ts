import { untrack } from 'svelte';
import { session } from './api';
import { merge, upsert, type Handoff, type SavedEvent } from './saved';

const KEY = 'snapwall.events';

function read(): SavedEvent[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

let list = $state<SavedEvent[]>(read());

function write(next: SavedEvent[]) {
  list = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the list lasts until the page closes */
  }
}

// Another tab opened or removed an event.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) list = read();
});

/** The guest and co-host events this device has opened, newest first. */
export const saved = {
  get list() {
    return list;
  },
  // Untracked, so an effect that saves the open event doesn't rerun on the list it just changed.
  add: (e: Omit<SavedEvent, 'seen'>) => untrack(() => write(upsert(list, { ...e, seen: Date.now() }))),
  remove: (id: string) => write(list.filter((e) => e.id !== id)),
  /** Takes in what the installed app was started with; an existing sign-in on this side wins. */
  receive(h: Handoff) {
    write(merge(list, h.events));
    if (h.session && !session.get()) session.set(h.session);
  },
};
