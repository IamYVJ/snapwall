<script lang="ts">
  import { router } from './lib/router.svelte';
  import { setVisitorFootnote } from './lib/visitorCount';
  import Admin from './routes/Admin.svelte';
  import Auth from './routes/Auth.svelte';
  import Home from './routes/Home.svelte';
  import NewEvent from './routes/NewEvent.svelte';
  import NotFound from './routes/NotFound.svelte';
  import Open from './routes/Open.svelte';
  import Privacy from './routes/Privacy.svelte';
  import SignInError from './routes/SignInError.svelte';
  import Slideshow from './routes/Slideshow.svelte';
  import Wall from './routes/Wall.svelte';

  const parts = $derived(router.parts);
  const key = $derived(parts.join('/'));

  // Event pages (guest wall, admin, slideshow) hide the footnote: a site-wide count would confuse guests.
  const PRIVATE = new Set(['auth', 'open', 'new', 'manage', 'a', 'e']);
  $effect(() => setVisitorFootnote(!PRIVATE.has(parts[0] ?? '')));
</script>

{#key key}
  {#if parts.length === 0}
    <Home />
  {:else if parts[0] === 'auth' && parts[1]}
    <Auth token={parts[1]} />
  {:else if parts[0] === 'open' && parts[1]}
    <Open code={parts[1]} />
  {:else if parts[0] === 'signin-error'}
    <SignInError code={parts[1] ?? ''} />
  {:else if parts[0] === 'new'}
    <NewEvent />
  {:else if parts[0] === 'manage' && parts[1]}
    <Admin eventId={parts[1]} adminToken={null} />
  {:else if parts[0] === 'a' && parts[1] && parts[2]}
    <Admin eventId={parts[1]} adminToken={parts[2]} />
  {:else if parts[0] === 'e' && parts[1] && parts[2] === 'show'}
    <Slideshow token={parts[1]} />
  {:else if parts[0] === 'e' && parts[1]}
    <Wall token={parts[1]} />
  {:else if parts[0] === 'privacy'}
    <Privacy />
  {:else}
    <NotFound />
  {/if}
{/key}
