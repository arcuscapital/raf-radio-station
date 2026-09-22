# My Radio Station

A fun, kid-friendly pretend radio station app for an 8-year-old.

## Features
- Build a show with colourful blocks: Songs, Jingles, Talk Time (silence), Talk-over Music, Commercial Breaks
- Add / remove / reorder blocks freely
- Loop the whole show
- Big friendly Live screen with clear status and buttons
- Spotify integration (Web Playback SDK)

## How to run on Android phone

### Option A – Quick test with a computer (recommended first)
1. On a computer, open a terminal in this folder.
2. Run a simple local server:
   ```bash
   npx serve -l 3000
   ```
   or
   ```bash
   python3 -m http.server 3000
   ```
3. Open Chrome on the computer → go to `http://127.0.0.1:3000`
4. Click **Connect Spotify** and log in.
5. Once it works on computer, you can transfer the files to the phone.

### Option B – On the Android phone
1. Copy the whole `my-radio-station` folder to your phone.
2. Install a free app like **“Simple HTTP Server”** or **“HTTP Server”** from Play Store.
3. Point it at the folder and start the server on port 3000.
4. Open Chrome and go to `http://127.0.0.1:3000` (or the IP the server shows).
5. Tap **Connect Spotify**.
6. After connecting, use Chrome menu → **Add to Home screen** so it feels like a real app.

### Important notes
- Spotify **Premium** is required for full playback control.
- The first time you connect, Spotify will ask for permission.
- Jingles and talk-over beds currently use simple generated tones. You can later replace them with real audio files.
- For the best experience, start playback of any song in the official Spotify app first, then come back to this radio app.

## Spotify credentials used
- Client ID: `6ec3c6f59ec14dcca495a904a268a67f`
- Redirect URIs already set in your Spotify Dashboard.

## Files
- `index.html` – main page
- `style.css` – colourful kid-friendly design
- `app.js` – all the logic + Spotify connection
- `manifest.json` – makes it installable as a PWA

Enjoy the show! 📻
