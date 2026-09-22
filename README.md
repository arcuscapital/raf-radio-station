# Krom FM

A fun, kid-friendly pretend radio station app for an 8-year-old.

**Live app:** https://arcuscapital.github.io/raf-radio-station/

## One-time setup (parent)

1. **Register the redirect URI in Spotify.** Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), open the app with Client ID `6ec3c6f59ec14dcca495a904a268a67f`, click **Edit Settings**, and add this exact Redirect URI:
   ```
   https://arcuscapital.github.io/raf-radio-station/
   ```
   Save. (Spotify Premium is required for playback control.)
2. On the child's phone, open the link above in the browser and tap **Connect Spotify**, then log in once.
3. Tap the browser menu → **Add to Home Screen**. It now behaves like a normal app icon — one tap, no browser bar, no server, no setup.

## How the child uses it

- **The DJ Raf Show**: paste a Spotify playlist link, add blocks (Songs, Jingle, Talk Time/News, Talk-over Music, Commercial Break), drag to reorder.
- For any non-song block, choose how it works:
  - 🤫 **Quiet** — silence for a set number of seconds (news, breaks).
  - 🎙️ **Record my own voice** — tap record, say the bit, save. Each block keeps its own separate recording, even if it's the same block type used again later in the show.
  - 🎶 **Background Music** — plays the one song/playlist set in "Background Music" (quiet, under the talking) — that link is entered once in the builder and reused everywhere "Background Music" is picked.
- Tap ▶ **Start Show** to go live. Big buttons: skip song, "I'm finished talking" → next, pause, stop.
- The whole show and its settings are saved on the phone automatically (localStorage + IndexedDB for recordings), so it's still there next time.

## Notes / limits

- Requires a real internet connection and Spotify Premium (Web Playback SDK playback control needs Premium).
- Microphone recording and Spotify login both require HTTPS — that's why this is hosted (for free) on GitHub Pages instead of being a plain local file. The parent still never has to run anything; it's just a link that acts like an app.
- Jingles use a short built-in chime unless you record your own for that block.

## Files
- `index.html` – main page
- `style.css` – colourful kid-friendly design
- `app.js` – all the logic, Spotify connection, recorder, show engine
- `manifest.json` – makes it installable as a PWA

## Redeploying after changes

```bash
git add -A
git commit -m "update"
git push
```

GitHub Pages rebuilds automatically in about a minute.

Enjoy the show! 📻
