<script lang="ts">
  import Wordmark from '../components/Wordmark.svelte';
</script>

<div class="page narrow prose">
  <header class="top"><Wordmark /></header>
  <h1 class="title">Privacy</h1>
  <p class="lede">SnapWall is built so your photos never sit anywhere but your own storage.</p>

  <h2 class="h2">What we store</h2>
  <ul>
    <li>Your Google account email and name, so you can sign in.</li>
    <li>Your Google access, encrypted, so guests can upload while you’re offline.</li>
    <li>Event details (name, date, settings) and a list of uploaded files: name, type, size, uploader’s name if given, and time.</li>
    <li>A salted hash of each uploader’s IP address, only to stop abuse. The address itself is never kept.</li>
  </ul>

  <h2 class="h2">What we never store</h2>
  <ul>
    <li>Photos, videos or thumbnails. Uploads go straight from the guest’s device to the host’s Google Drive.</li>
    <li>Analytics, ads or third-party trackers. There are none.</li>
  </ul>

  <h2 class="h2">Google Drive access</h2>
  <p>
    SnapWall uses the <code>drive.file</code> permission. It can only see the folders and files SnapWall itself created, never anything else in your
    Drive. Files are never made public; the wall shows them through short-lived signed links.
  </p>

  <h2 class="h2">Location data</h2>
  <p>By default, location and camera metadata are removed from JPEG and PNG photos on the guest’s device before upload.</p>

  <h2 class="h2">Removing your data</h2>
  <p>
    Deleting an event removes it from SnapWall, and optionally moves its Drive folder to your trash. “Disconnect Google” on your dashboard revokes
    SnapWall’s access and erases your account and all events. Files in your Drive stay yours.
  </p>

  <p class="muted small" style="margin-top: 48px"><a href="#/">Back to SnapWall</a></p>
</div>

<style>
  .prose {
    padding-bottom: 80px;
  }
  .top {
    padding: 28px 0 56px;
  }
  .prose :global(.h2) {
    margin: 40px 0 12px;
  }
  .prose ul {
    padding-left: 20px;
    color: var(--muted);
  }
  .prose li + li {
    margin-top: 6px;
  }
  .prose p {
    color: var(--muted);
  }
  .prose .lede {
    margin-top: 16px;
  }
  code {
    font-size: 0.9em;
    background: var(--shade);
    padding: 2px 6px;
    border-radius: 4px;
  }
</style>
