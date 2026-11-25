/* Vinyl Pi web app. Plain JS, no build step. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $("#app");
  const audio = $("#audio");
  const SECURE = location.protocol === "https:";
  // On the secure page the stream comes through the same address (nginx), or the browser would block it.
  const STREAM = SECURE ? `${location.origin}/vinyl` : `http://${location.hostname}:8000/vinyl`;
  let state = { now: null, history: [] };
  let status = {};
  let match = null;

  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
    return data;
  };
  const say = (el, text, err = false) => { el.textContent = text || ""; el.classList.toggle("err", err); };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ago = (t) => {
    const m = Math.round((Date.now() / 1000 - t) / 60);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(t * 1000).toLocaleDateString("en-GB", { weekday: "short" });
  };

  /* ---------- views ---------- */
  function go(view) {
    if (status.mode === "hotspot") view = "wifi";
    $$(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
    if (view !== "scan") stopLive();
    if (view === "settings") loadStatus();
    if (view === "stats") loadStats();
    if (view === "shelf") loadShelf();
    if (view === "now") addTarget = "spin";
    if (view === "add") {
      $("#add-kicker").textContent = addTarget === "shelf" ? "ADD TO YOUR SHELF" : "SEARCH · MUSICBRAINZ";
      $("#add-title").textContent = addTarget === "shelf" ? "Add a record" : "New record";
      $("#spin-match").textContent = addTarget === "shelf" ? "Add to shelf" : "Spin it";
    }
    if (view === "scan") { setScanMode(); if (CAN_LIVE) startLive(); $("#secure-tip").hidden = CAN_LIVE; }
    if (view === "wifi") loadNetworks();
    if (view === "add") setTimeout(() => $("#add-q").focus(), 50);
    history.replaceState(null, "", view === "now" ? "/" : `#${view}`);
    window.scrollTo(0, 0);
  }
  const VIEWS = ["now", "add", "scan", "settings", "wifi", "stats", "shelf"];
  let addTarget = "spin"; // "shelf" when adding from the shelf: pick a record without playing it
  window.addEventListener("hashchange", () => { const v = location.hash.slice(1) || "now"; if (VIEWS.includes(v)) go(v); });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (b) { e.preventDefault(); go(b.dataset.go); }
  });

  /* ---------- colour from the cover ---------- */
  function setColours(src) {
    const root = document.documentElement.style;
    if (!src) { root.removeProperty("--accent"); root.removeProperty("--tint"); return; }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 24;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0, 24, 24);
      const px = g.getImageData(0, 0, 24, 24).data;
      let r = 0, gr = 0, b = 0, w = 0;
      for (let i = 0; i < px.length; i += 4) {
        const max = Math.max(px[i], px[i + 1], px[i + 2]), min = Math.min(px[i], px[i + 1], px[i + 2]);
        const weight = (max - min) / 255 + 0.05; // favour colourful pixels
        r += px[i] * weight; gr += px[i + 1] * weight; b += px[i + 2] * weight; w += weight;
      }
      const [h, s] = rgbToHsl(r / w, gr / w, b / w);
      root.setProperty("--accent", `hsl(${h} ${Math.max(35, Math.min(75, s))}% 74%)`);
      root.setProperty("--tint", `hsl(${h} ${Math.min(45, s)}% 10%)`);
    };
    img.src = src;
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [220, 0, l * 100];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
  }

  /* ---------- now playing ---------- */
  function render() {
    const n = state.now;
    const sleeve = $("#sleeve");
    $("#flip").disabled = !n;
    if (!n) {
      $("#side-line").textContent = "NOTHING ON THE PLATTER";
      $("#title").textContent = "Drop the needle";
      $("#artist").textContent = "Then tell Vinyl Pi what's spinning.";
      $("#tracks").innerHTML = "";
      $("#heard").innerHTML = "";
      sleeve.style.backgroundImage = "";
      sleeve.classList.add("empty");
      setColours(null);
    } else {
      $("#side-line").textContent = `SIDE ${n.side || "A"} · ${ago(n.started_at).toUpperCase()}`;
      $("#title").textContent = n.title;
      $("#artist").textContent = [n.artist, n.year, n.label].filter(Boolean).join(" · ");
      sleeve.setAttribute("aria-label", `Album cover: ${n.title}`);
      sleeve.style.backgroundImage = n.cover ? `url("${n.cover}")` : "";
      sleeve.classList.toggle("empty", !n.cover);
      setColours(n.cover);
      // Some releases list the vinyl sides (A1, B2...) plus a CD or bonus disc (1, 2...). Keep the sides only.
      const all = n.tracks || [];
      const lettered = all.filter((t) => /^[A-Z]/i.test(t.number));
      const vinyl = lettered.length ? lettered : all;
      const sideOf = (t) => (/^[A-Z]/i.test(t.number) ? t.number[0].toUpperCase() : "");
      const h = n.heard;
      const heard = $("#heard");
      if (h) {
        heard.classList.remove("err");
        const art = h.artwork || n.cover;
        const where = h.number ? ` · ${esc(h.number)}` : "";
        const off = h.on_record === false && (h.album || h.title);
        heard.innerHTML = `<div class="heard-card${off ? " off" : ""}">
          <div class="art"${art ? ` style="background-image:url('${esc(art)}')"` : ""}></div>
          <div class="txt"><div class="kicker accent">♪ HEARD ${esc(ago(h.at).toUpperCase())}${where}</div>
            <div class="t1">${esc(h.title)}</div><div class="t2">${esc(h.artist)}${h.album && off ? ` · ${esc(h.album)}` : ""}</div></div>
          ${h.link ? `<a class="icon-btn" href="${esc(h.link)}" target="_blank" rel="noopener" aria-label="Open the song"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5"/></svg></a>` : ""}
        </div>${off ? `<div class="heard-off"><span>Not on ${esc(n.title)}.</span> <button class="link" id="heard-switch">Switch to ${esc(h.album || "that album")}</button></div>` : ""}`;
        const sw = $("#heard-switch");
        if (sw) sw.addEventListener("click", async () => {
          sw.disabled = true; sw.textContent = "Finding it…";
          try {
            const rs = await api(`/api/search?q=${encodeURIComponent([h.artist, h.album || h.title].filter(Boolean).join(" "))}`);
            if (!rs.length) throw new Error("Couldn't find that album. Try New record.");
            await api("/api/now", { method: "POST", body: { release_group: rs[0].release_group } });
          } catch (err) { say(heard, err.message, true); }
        });
      } else if (!heard.classList.contains("err")) heard.innerHTML = "";
      // Every side is rendered; sides not on the platter are marked "other" (hidden on narrow screens).
      let last = null;
      const sides = new Set(vinyl.map(sideOf).filter(Boolean));
      $("#tracks").innerHTML = vinyl.map((t) => {
        const sd = sideOf(t), cur = !sd || sd === (n.side || "A");
        const head = sd && sd !== last ? `<li class="side-head${cur ? "" : " other"}${sides.size === 2 && last ? " brk" : ""}"><span class="kicker${cur ? " accent" : " dim"}">SIDE ${esc(sd)}${cur ? " · ON NOW" : ""}</span></li>` : "";
        last = sd;
        const cls = [cur ? "" : "other", h && h.number === t.number ? "on" : ""].filter(Boolean).join(" ");
        return `${head}<li${cls ? ` class="${cls}"` : ""}><span class="n">${esc(t.number)}</span><span>${esc(t.title)}</span><span class="t">${esc(t.length)}</span></li>`;
      }).join("");
      document.title = `${n.title} · Vinyl Pi`;
    }
    setMediaInfo(n);
    $("#history").innerHTML = (state.history || []).slice(0, 8).map((h) =>
      `<li><div class="art" style="${h.cover ? `background-image:url('${esc(h.cover)}')` : ""}"></div>
        <div class="txt"><div class="t1">${esc(h.title)}</div><div class="t2">${esc(h.artist)} · ${esc(ago(h.started_at))}</div></div></li>`).join("");
  }
  setInterval(render, 60000);

  $("#flip").addEventListener("click", () => api("/api/flip", { method: "POST" }).catch(() => {}));

  /* ---------- what's this song? ---------- */
  $("#identify").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains("busy")) return;
    btn.classList.add("busy");
    const label = $("#identify-label");
    const stop = listenCountdown((t) => { label.textContent = t; });
    try {
      const r = await api("/api/identify", { method: "POST" });
      if (!r.found) say($("#heard"), r.message, true);
    } catch (err) {
      say($("#heard"), err.message, true);
    }
    stop();
    btn.classList.remove("busy");
    label.textContent = "What's this?";
  });
  // The Pi listens for about 9 seconds, asks AudD, and takes a second listen if the first draws a blank.
  function listenCountdown(show) {
    const t0 = Date.now();
    const step = () => {
      const s = (Date.now() - t0) / 1000;
      show(s < 9 ? `Listening… ${Math.ceil(9 - s)}` : s < 13 ? "Checking…" : s < 22 ? "Listening again…" : "Still checking…");
    };
    step();
    const id = setInterval(step, 250);
    return () => clearInterval(id);
  }

  /* ---------- player + level meter ----------
     Phones get a plain <audio> element with no Web Audio in the way, so the browser treats it
     like any music app: it keeps playing with the screen locked and shows lock-screen controls.
     Computers also get the real level meter. If the stream drops, it reconnects by itself. */
  const meter = $("#meter");
  const BARS = 44;
  meter.innerHTML = "<i></i>".repeat(BARS);
  const bars = $$("i", meter);
  const PHONE = matchMedia("(pointer: coarse)").matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
  const ms = "mediaSession" in navigator ? navigator.mediaSession : null;
  let ctx, analyser, buf, raf;
  let wanted = false;      // the listener wants music: keep it going
  let ours = false;        // a pause we made ourselves, not the phone
  let retry = 0, retryTimer = null, lastTime = 0, lastMove = 0;

  function connectStream() {
    ours = true;
    audio.src = `${STREAM}?t=${Date.now()}`; // fresh connection, so we're as close to live as possible
    audio.volume = +$("#volume").value;
    ours = false;
    lastMove = Date.now();
    return audio.play();
  }
  async function play() {
    wanted = true;
    clearTimeout(retryTimer); retryTimer = null;
    try {
      await connectStream();
    } catch {
      if (!retry) { wanted = false; setPlaying(false); return say($("#live"), "● STREAM OFFLINE", true); }
      return reconnect();
    }
    retry = 0;
    setPlaying(true);
    if (!PHONE) {
      try {
        if (!ctx) {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          const src = ctx.createMediaElementSource(audio);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 128;
          buf = new Uint8Array(analyser.frequencyBinCount);
          src.connect(analyser).connect(ctx.destination);
        }
        await ctx.resume();
      } catch { /* meter is a nice-to-have */ }
    }
    cancelAnimationFrame(raf);
    draw();
  }
  function stop() {
    wanted = false;
    retry = 0;
    clearTimeout(retryTimer); retryTimer = null;
    ours = true;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    ours = false;
    setPlaying(false);
  }
  function setPlaying(on) {
    app.classList.toggle("playing", on);
    $("#play").setAttribute("aria-label", on ? "Pause" : "Play");
    if (ms) ms.playbackState = on ? "playing" : "paused";
    if (!on) {
      cancelAnimationFrame(raf);
      bars.forEach((b) => { b.style.height = "8%"; b.classList.remove("on"); });
    }
  }
  // The stream dropped (Wi-Fi blip, Pi restarted the stream): try again, waiting a bit longer each time.
  function reconnect() {
    if (!wanted || retryTimer) return;
    say($("#live"), "● RECONNECTING", true);
    const wait = Math.min(15000, 1000 * 2 ** retry++);
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (!wanted) return;
      try { await connectStream(); retry = 0; setPlaying(true); refreshLive(); }
      catch { reconnect(); }
    }, wait);
  }
  function draw() {
    if (analyser) {
      analyser.getByteFrequencyData(buf);
    } else {
      // Phones: no Web Audio (it would stop the music when the screen locks), so the bars just dance.
      buf = buf || new Uint8Array(48);
      const t = performance.now() / 1000;
      for (let i = 0; i < buf.length; i++) buf[i] = 90 + 80 * Math.abs(Math.sin(t * (1.3 + i * 0.07) + i)) * (1 - (i / buf.length) * 0.6);
    }
    const level = buf.reduce((a, v) => a + v, 0) / buf.length / 255;
    bars.forEach((b, i) => {
      const v = buf[Math.floor((i / BARS) * buf.length * 0.8)] / 255;
      b.style.height = `${Math.max(8, v * 100)}%`;
      b.classList.toggle("on", i / BARS < level * 2.2);
    });
    raf = requestAnimationFrame(draw);
  }
  $("#play").addEventListener("click", () => (wanted ? stop() : play()));
  $("#volume").addEventListener("input", (e) => (audio.volume = +e.target.value));
  audio.addEventListener("error", () => { if (wanted && !ours) reconnect(); });
  audio.addEventListener("ended", () => { if (wanted) reconnect(); });
  audio.addEventListener("pause", () => {
    // Paused by the phone (lock-screen button, headphones out, a call): treat it as Stop, so Play is live again.
    // A dropped stream also fires "pause", so give "error"/"ended" a moment to claim it first.
    if (ours || !wanted) return;
    setTimeout(() => {
      if (wanted && !retryTimer && audio.paused && !audio.ended && !audio.error) stop();
    }, 400);
  });
  audio.addEventListener("timeupdate", () => {
    if (audio.currentTime !== lastTime) { lastTime = audio.currentTime; lastMove = Date.now(); }
  });
  // Watchdog: music stuck for 12 seconds means the connection has quietly died.
  setInterval(() => {
    if (wanted && !retryTimer && !audio.paused && Date.now() - lastMove > 12000) { lastMove = Date.now(); reconnect(); }
  }, 4000);
  // Back on the page after the phone slept: if the music should be on but isn't, pick it back up.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (wanted && audio.paused) reconnect();
    if (wanted && ctx) ctx.resume().catch(() => {});
  });

  // Lock-screen and notification controls, with the record's title and cover.
  if (ms) {
    const on = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* not supported here */ } };
    on("play", () => play());
    on("pause", () => stop());
    on("stop", () => stop());
  }
  function setMediaInfo(n) {
    if (!ms || !("MediaMetadata" in window)) return;
    const art = n?.cover ? new URL(n.cover, location.href).href : new URL("/static/icon-512.png", location.href).href;
    ms.metadata = new MediaMetadata({
      title: n ? n.title : "Vinyl Pi",
      artist: n ? n.artist || "" : "Live from the turntable",
      album: n ? `Side ${n.side || "A"}` : "",
      artwork: [{ src: art, sizes: "512x512", type: n?.cover ? "image/jpeg" : "image/png" }],
    });
  }

  /* ---------- search ---------- */
  let searchTimer;
  async function search(q) {
    const msg = $("#add-msg");
    if (!q.trim()) { $("#results").innerHTML = ""; return say(msg, ""); }
    say(msg, "Searching MusicBrainz…");
    try {
      const rs = await api(`/api/search?q=${encodeURIComponent(q)}`);
      say(msg, rs.length ? "" : "Nothing found. Try fewer words, or type it in.");
      $("#results").innerHTML = rs.map((r, i) => `<button class="result" data-i="${i}">
          <div class="art" style="background-image:url('${esc(r.cover)}')"></div>
          <div class="t1">${esc(r.title)}</div><div class="t2">${esc(r.artist)}${r.year ? " · " + esc(r.year) : ""}</div>
        </button>`).join("");
      $$(".result").forEach((b) => b.addEventListener("click", () => spin({ release_group: rs[b.dataset.i].release_group }, msg)));
    } catch (e) { say(msg, e.message, true); }
  }
  $$("[data-search]").forEach((f) => {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = f.q.value;
      if (f.closest(".side")) { $("#add-q").value = q; go("add"); }
      search(q);
    });
  });
  $("#add-q").addEventListener("input", (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(e.target.value), 450); });

  async function spin(body, msg) {
    if (addTarget === "shelf" && !body.collection_id) {
      say(msg, "Adding to your shelf…");
      try {
        const r = await api("/api/collection", { method: "POST", body });
        say(msg, "");
        go("shelf");
        say($("#shelf-msg"), `Added ${r.title}.`);
      } catch (e) { say(msg, e.message, true); }
      return;
    }
    say(msg, "Fetching the details…");
    try {
      await api("/api/now", { method: "POST", body });
      say(msg, "");
      go("now");
    } catch (e) { say(msg, e.message, true); }
  }
  $("#manual-open").addEventListener("click", () => { $("#manual").hidden = !$("#manual").hidden; });
  $("#manual").addEventListener("submit", (e) => {
    e.preventDefault();
    spin({ title: e.target.title.value, artist: e.target.artist.value }, $("#add-msg"));
  });

  /* ---------- scan ---------- */
  let scanMode = "barcode";
  const DESK = matchMedia("(min-width: 960px) and (pointer: fine)").matches;

  // Browsers only allow a live camera feed on secure (https or localhost) pages. vinyl.local is plain http,
  // so there we open the phone's camera straight away instead, and read the barcode from the photo.
  const CAN_LIVE = window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  let liveStream = null, liveTimer = null;
  $("#scan-open").addEventListener("click", () => { if (!CAN_LIVE) { go("scan"); $("#photo").click(); } });
  async function startLive() {
    if (liveStream) return;
    const video = $("#live-cam");
    try {
      liveStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
    } catch { liveStream = null; return; }
    video.srcObject = liveStream;
    // Torch for dim rooms and glossy sleeves, where the phone supports it.
    const track = liveStream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    $("#torch").hidden = !caps.torch;
    $("#torch").setAttribute("aria-pressed", "false");
    video.hidden = false;
    $("#shot").hidden = true;
    await video.play().catch(() => {});
    // Some browsers grant the camera but never show a picture. Give up after 4 s and fall back to photos.
    setTimeout(() => {
      if (liveStream && !video.videoWidth) {
        stopLive();
        say($("#scan-msg"), "This browser won't show a live camera. Tap Take photo instead, or try Chrome.", true);
      }
    }, 4000);
    $("#scan-hint").textContent = "Point at the barcode on the back of the sleeve. It reads it by itself.";
    const native = "BarcodeDetector" in window;
    const c = document.createElement("canvas");
    let busy = false, tick = 0;
    liveTimer = setInterval(async () => {
      if (busy || scanMode !== "barcode" || !video.videoWidth) return;
      if (!native && tick++ % 2) return; // the fallback reader is slower, so try every other tick
      busy = true;
      try {
        const scale = Math.min(1, 1280 / video.videoWidth);
        c.width = video.videoWidth * scale; c.height = video.videoHeight * scale;
        c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
        const code = await decode(c, native);
        if (code) { gotIt(); $("#code").value = code; stopLive(true); await lookup(code); }
      } catch { /* no barcode in this frame */ }
      busy = false;
    }, 600);
  }
  // A little buzz and a green frame when a barcode is read, like a shop scanner.
  function gotIt() {
    if (navigator.vibrate) navigator.vibrate(60);
    const v = $("#viewfinder");
    v.classList.add("got");
    setTimeout(() => v.classList.remove("got"), 900);
  }
  $("#torch").addEventListener("click", async (e) => {
    const b = e.currentTarget, on = b.getAttribute("aria-pressed") !== "true";
    const track = liveStream && liveStream.getVideoTracks()[0];
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); b.setAttribute("aria-pressed", on); } catch { b.hidden = true; }
  });
  function stopLive(keepFrame) {
    clearInterval(liveTimer); liveTimer = null;
    $("#torch").hidden = true;
    if (liveStream) liveStream.getTracks().forEach((t) => t.stop());
    liveStream = null;
    if (!keepFrame) { $("#live-cam").srcObject = null; $("#live-cam").hidden = true; }
  }
  $$(".view-scan .tabs button").forEach((t) => t.addEventListener("click", () => {
    scanMode = t.dataset.mode;
    $$(".view-scan .tabs button").forEach((b) => b.setAttribute("aria-selected", b === t));
    setScanMode();
  }));
  function setScanMode() {
    const cover = scanMode === "cover", listen = scanMode === "listen";
    $("#viewfinder").classList.toggle("cover", cover);
    $("#viewfinder").classList.toggle("listen", listen);
    $("#code-form").hidden = scanMode !== "barcode";
    $("#photo-btn").hidden = listen;
    $("#listen-go").hidden = !listen;
    $("#drop-hint").hidden = listen;
    $("#shot").hidden = true;
    $("#photo-label").textContent = DESK ? "Choose a photo" : "Take photo";
    if (listen) stopLive();
    else if (CAN_LIVE && $(".view-scan").hidden === false) startLive();
    $("#picks").innerHTML = "";
    $("#q-form").hidden = true;
    $("#match").hidden = true; $("#spin-match").hidden = true; match = null;
    say($("#scan-msg"), "");
    if (listen) {
      $("#scan-hint").textContent = "Drop the needle, then tap Listen now. The Pi hears the record and finds the album.";
      return;
    }
    $("#scan-hint").textContent = !cover
      ? (liveStream ? "Point at the barcode on the back of the sleeve. It reads it by itself." : "Take a photo of the barcode on the back of the sleeve.")
      : status.cover_scan
        ? "Take a photo of the front cover. Fill the frame and avoid glare."
        : "Take a photo of the front cover, with the artist and title in shot.";
  }

  // Phone photos are big; send the Pi a small JPEG.
  async function shrink(file, max = 1024) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
  }

  // Free mode: read the printed text on the sleeve in the browser, then search MusicBrainz with it.
  let ocrWorker;
  async function readCoverText(file) {
    if (!window.Tesseract) {
      await new Promise((ok, fail) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
        s.onload = ok; s.onerror = () => fail(new Error("Couldn't load the text reader. Is your phone online?"));
        document.head.appendChild(s);
      });
    }
    if (!ocrWorker) ocrWorker = await Tesseract.createWorker("eng");
    const bmp = await createImageBitmap(await shrink(file, 1400));
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const words = async () => (await ocrWorker.recognize(c)).data.words
      .filter((w) => w.confidence > 55 && /[A-Za-z0-9]{2,}/.test(w.text))
      .map((w, i) => ({ text: w.text.replace(/[^\w'&.-]/g, ""), size: w.bbox.y1 - w.bbox.y0, i }));
    let found = await words();
    if (found.length < 2) { // light text on a dark sleeve: try the negative
      g.globalCompositeOperation = "difference"; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      found = found.concat((await words()).map((w) => ({ ...w, i: w.i + 10000 })));
    }
    // The biggest lettering is nearly always the artist and the title.
    const big = found.filter((w) => w.text).sort((a, b) => b.size - a.size).slice(0, 6).sort((a, b) => a.i - b.i); // back into reading order
    return [...new Set(big.map((w) => w.text))].join(" ");
  }

  async function showPicks(q, msg, lead) {
    $("#q-form").hidden = false;
    $("#cover-q").value = q;
    if (!q) { $("#picks").innerHTML = ""; return say(msg, "Couldn't read any text. Type what's on the cover, or try the barcode.", true); }
    say(msg, "Searching MusicBrainz…");
    let rs = [];
    try { rs = (await api(`/api/search?q=${encodeURIComponent(q)}`)).slice(0, 4); } catch (e) { return say(msg, e.message, true); }
    if (!rs.length) { $("#picks").innerHTML = ""; return say(msg, `Nothing found for "${q}". Fix the words above and search again.`, true); }
    say(msg, lead || "Tap the right one, or fix the words and search again.");
    $("#picks").innerHTML = rs.map((r, i) => `<button class="pick" data-i="${i}">
        <div class="art" style="background-image:url('${esc(r.cover)}')"></div>
        <div><div class="t1">${esc(r.title)}</div><div class="t2">${esc(r.artist)}${r.year ? " · " + esc(r.year) : ""}</div></div>
      </button>`).join("");
    $$(".pick").forEach((b) => b.addEventListener("click", () => spin({ release_group: rs[b.dataset.i].release_group }, msg)));
  }
  $("#q-form").addEventListener("submit", (e) => { e.preventDefault(); showPicks($("#cover-q").value.trim(), $("#scan-msg")); });

  async function scanCover(file) {
    const msg = $("#scan-msg");
    $("#picks").innerHTML = "";
    if (!status.cover_scan) {
      say(msg, "Reading the text on the cover…");
      try { return await showPicks(await readCoverText(file), msg); } catch (e) { return say(msg, e.message, true); }
    }
    say(msg, "Asking Claude what this is…");
    try {
      const fd = new FormData();
      fd.append("photo", await shrink(file), "cover.jpg");
      const res = await fetch("/api/cover", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Cover scan failed");
      const f = data.found || {};
      const what = f.title ? `${f.title}${f.artist ? " by " + f.artist : ""}` : "";
      if (!what) return say(msg, "Claude couldn't recognise that one. Try again closer up, or use the barcode.", true);
      await showPicks(data.query || what, msg, `Looks like ${what}. Tap the right one.`);
    } catch (e) { say(msg, e.message, true); }
  }

  async function decode(file, quick = false) {
    const bitmap = await createImageBitmap(file);
    if ("BarcodeDetector" in window) {
      try {
        const found = await new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] }).detect(bitmap);
        if (found.length) return found[0].rawValue;
      } catch { /* fall through to ZXing */ }
      if (quick) return null;
    }
    if (!window.ZXing) {
      await new Promise((ok, fail) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
        s.onload = ok; s.onerror = () => fail(new Error("Couldn't load the barcode reader"));
        document.head.appendChild(s);
      });
    }
    const c = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    c.width = bitmap.width * scale; c.height = bitmap.height * scale;
    c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
    const reader = new ZXing.BrowserMultiFormatReader();
    const res = await reader.decodeFromImageUrl(c.toDataURL("image/jpeg", 0.9));
    return res.getText();
  }

  function showSides(tracks) {
    const box = $("#match-tracks");
    const sides = new Map();
    tracks.forEach((t) => {
      const s = /^[A-Z]/i.test(t.number) ? `SIDE ${t.number[0].toUpperCase()}` : "TRACKS";
      if (!sides.has(s)) sides.set(s, []);
      sides.get(s).push(t);
    });
    box.innerHTML = [...sides].map(([s, ts]) => `<section><div class="kicker accent">${esc(s)}</div><ol>${ts.map((t) =>
      `<li><span class="n">${esc(t.number)}</span><span>${esc(t.title)}</span><span class="t">${esc(t.length)}</span></li>`).join("")}</ol></section>`).join("");
    box.hidden = !tracks.length;
  }

  async function lookup(code) {
    const msg = $("#scan-msg");
    say(msg, `Looking up ${code}…`);
    try {
      match = await api(`/api/barcode/${encodeURIComponent(code)}`);
      $("#match").hidden = false;
      $("#match-art").src = match.cover;
      $("#match-title").textContent = match.title;
      $("#match-meta").textContent = [match.artist, match.year, match.label].filter(Boolean).join(" · ");
      showSides(match.tracks || []);
      $("#spin-match").hidden = false;
      say(msg, "");
    } catch (e) { match = null; $("#match").hidden = true; $("#match-tracks").hidden = true; $("#spin-match").hidden = true; say(msg, e.message, true); }
  }

  // Listen tab: the Pi names the song on the stream and puts its album on the platter.
  $("#listen-go").addEventListener("click", async (e) => {
    const btn = e.currentTarget, msg = $("#scan-msg");
    if (btn.disabled) return;
    btn.disabled = true;
    $("#viewfinder").classList.add("hearing");
    const stop = listenCountdown((t) => { btn.textContent = t; });
    say(msg, "");
    try {
      const r = await api("/api/identify?switch=1", { method: "POST" });
      if (!r.found) say(msg, r.message, true);
      else { say(msg, ""); go("now"); }
    } catch (err) { say(msg, err.message, true); }
    stop();
    btn.disabled = false; btn.textContent = "Listen now";
    $("#viewfinder").classList.remove("hearing");
  });

  $("#photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) await usePhoto(file);
  });
  // On a computer there's rarely a camera: drop a photo of the sleeve onto the page instead.
  const scanView = $(".view-scan");
  ["dragenter", "dragover"].forEach((ev) => scanView.addEventListener(ev, (e) => {
    if (scanMode === "listen") return;
    e.preventDefault(); scanView.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((ev) => scanView.addEventListener(ev, (e) => {
    e.preventDefault(); if (ev === "drop" || e.target === scanView) scanView.classList.remove("dragging");
  }));
  scanView.addEventListener("drop", (e) => {
    const file = [...(e.dataTransfer.files || [])].find((f) => f.type.startsWith("image/"));
    if (file && scanMode !== "listen") usePhoto(file);
  });
  async function usePhoto(file) {
    stopLive();
    const shot = $("#shot");
    shot.src = URL.createObjectURL(file);
    shot.hidden = false;
    $("#photo-label").textContent = "Retake";
    if (scanMode === "cover") return scanCover(file);
    say($("#scan-msg"), "Reading the barcode…");
    try {
      const code = await decode(file);
      gotIt();
      $("#code").value = code;
      await lookup(code);
    } catch {
      say($("#scan-msg"), "Couldn't read a barcode. Try closer, with less glare, or type the number.", true);
    }
  }
  $("#code-form").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#code").value.trim(); if (v) lookup(v); });
  $("#spin-match").addEventListener("click", () => match && spin(match.release ? { release: match.release } : { discogs: match.discogs }, $("#scan-msg")));

  /* ---------- shelf ---------- */
  let shelfItems = [], shelfSetup = [{ name: "Shelf 1", capacity: 80 }], pulled = null;
  const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  let shelfOrder = pref("shelf-order", "artist"), shelfLook = pref("shelf-look", "spines");
  const hues = {};
  try { Object.assign(hues, JSON.parse(localStorage.getItem("shelf-hues") || "{}")); } catch { /* fresh */ }

  $("#shelf-add").addEventListener("click", () => { addTarget = "shelf"; go("add"); });
  function tabsFor(id, attr, get, set) {
    const btns = $$(`#${id} button`);
    const sync = () => btns.forEach((b) => b.setAttribute("aria-selected", b.dataset[attr] === get()));
    btns.forEach((b) => b.addEventListener("click", () => { set(b.dataset[attr]); sync(); drawShelf(); }));
    sync();
  }
  tabsFor("shelf-order", "order", () => shelfOrder, (v) => { shelfOrder = v; keep("shelf-order", v); if (v === "colour") measureColours(); });
  tabsFor("shelf-look", "look", () => shelfLook, (v) => { shelfLook = v; keep("shelf-look", v); });

  async function loadShelf() {
    try {
      [shelfItems, shelfSetup] = await Promise.all([api("/api/collection"), api("/api/shelves")]);
    } catch (e) { return say($("#shelf-msg"), e.message, true); }
    drawShelf();
    if (shelfOrder === "colour") measureColours();
  }

  const fold = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const byArtist = (a, b) => fold(a.sort_artist || a.artist).localeCompare(fold(b.sort_artist || b.artist)) || (a.year || "9999").localeCompare(b.year || "9999") || fold(a.title).localeCompare(fold(b.title));
  function colourKey(r) {
    const h = hues[r.cover];
    if (!h) return [3, 0, 0];
    if (h.s < 18) return [2, -h.l, 0]; // black, greys and white sleeves go at the end, light to dark
    return [1, (h.h + 15) % 360, -h.l]; // start the rainbow at red
  }
  function sorted() {
    const list = [...shelfItems];
    if (shelfOrder === "genre") list.sort((a, b) => a.section.localeCompare(b.section) || byArtist(a, b));
    else if (shelfOrder === "year") list.sort((a, b) => (a.year || "9999").localeCompare(b.year || "9999") || byArtist(a, b));
    else if (shelfOrder === "colour") list.sort((a, b) => { const x = colourKey(a), y = colourKey(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || byArtist(a, b); });
    else list.sort(byArtist);
    return list;
  }
  function groupOf(r) {
    if (shelfOrder === "genre") return r.section;
    if (shelfOrder === "year") return r.year ? `${r.year.slice(0, 3)}0s` : "No year";
    if (shelfOrder === "artist") { const c = fold(r.sort_artist || r.artist).replace(/^[^a-z0-9]+/, "")[0] || "#"; return /[0-9]/.test(c) ? "#" : c.toUpperCase(); }
    return null;
  }
  // Fill shelves in order. Anything past the last shelf waits for more space.
  function layout() {
    const list = sorted(), shelves = shelfSetup.map((s) => ({ ...s, items: [] }));
    let i = 0;
    list.forEach((r, n) => {
      while (i < shelves.length && shelves[i].items.length >= shelves[i].capacity) i++;
      const where = i < shelves.length ? shelves[i] : null;
      r.pos = n + 1;
      r.shelf = where ? where.name : null;
      r.slot = where ? where.items.length + 1 : null;
      if (where) where.items.push(r);
    });
    const over = list.filter((r) => !r.shelf);
    return { list, shelves, over };
  }
  function spineStyle(r) {
    if (r.cover) return `background-image:url('${esc(r.cover)}')`;
    let h = 0; for (const c of r.artist + r.title) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `background-color:hsl(${h} 30% 28%)`;
  }
  function drawShelf() {
    const { list, shelves, over } = layout();
    const n = list.length;
    $("#shelf-count").textContent = n ? `${n} record${n === 1 ? "" : "s"}` : "Your records";
    const room = shelves.reduce((a, s) => a + s.capacity, 0);
    $("#shelf-sub").textContent = !n ? "Everything you play lands here. Tap + to add records you own."
      : over.length ? `${over.length} won't fit yet. Add a shelf or raise the counts in shelf setup.`
      : `${shelves.length} shelf${shelves.length === 1 ? "" : "s"}, ${room - n} spaces left.`;
    const groups = [...shelves.filter((s) => s.items.length || shelves.length === 1), ...(over.length ? [{ name: "No room yet", capacity: 0, items: over, over: true }] : [])];
    if (!n) { $("#shelves").innerHTML = ""; return; }
    $("#shelves").innerHTML = groups.map((s) => {
      const first = s.items[0], last = s.items[s.items.length - 1];
      const range = first ? `${first.sort_artist || first.artist} → ${last.sort_artist || last.artist}` : "Empty";
      const head = `<div class="shelf-head"><span class="kicker accent">${esc(s.name.toUpperCase())}${s.over ? "" : ` · ${s.items.length}/${s.capacity}`}</span><span class="kicker dim">${esc(shelfOrder === "colour" ? "" : range)}</span></div>`;
      let prev = null, body = "";
      if (shelfLook === "list") {
        body = `<ol class="order">${s.items.map((r) => {
          const g = groupOf(r), div = g && g !== prev ? `<li class="div">${esc(g)}</li>` : ""; prev = g;
          return `${div}<li><button data-id="${r.id}"><span class="n">${r.pos}</span><span class="art" style="${spineStyle(r)}"></span><span class="tx"><b>${esc(r.artist)}</b> ${esc(r.title)}</span><span class="y">${esc(r.year)}</span></button></li>`;
        }).join("")}</ol>`;
      } else {
        body = `<div class="plank">${s.items.map((r) => {
          const g = groupOf(r), div = g && g !== prev ? `<span class="divider"><i>${esc(g)}</i></span>` : ""; prev = g;
          return `${div}<button class="spine${pulled === r.id ? " out" : ""}" data-id="${r.id}" style="${spineStyle(r)}" aria-label="${esc(r.artist)}, ${esc(r.title)}"><span>${esc(r.artist)}<b>${esc(r.title)}</b></span></button>`;
        }).join("")}</div>`;
      }
      return `<section class="shelf${s.over ? " over" : ""}">${head}${body}</section>`;
    }).join("");
    $$("#shelves [data-id]").forEach((b) => b.addEventListener("click", () => pull(b.dataset.id)));
  }
  function pull(id) {
    const { list } = layout();
    const i = list.findIndex((r) => r.id === id), r = list[i];
    if (!r) return;
    pulled = id;
    $("#pull").hidden = false;
    $("#pull-art").src = r.cover || "";
    $("#pull-where").textContent = r.shelf ? `${r.shelf.toUpperCase()} · SLOT ${r.slot} · #${r.pos} OVERALL` : "NO ROOM YET";
    $("#pull-title").textContent = r.title;
    $("#pull-meta").textContent = [r.artist, r.year, r.section !== "Other" ? r.section : "", r.plays ? `played ${r.plays}×` : ""].filter(Boolean).join(" · ");
    const before = list[i - 1], after = list[i + 1];
    $("#pull-between").textContent = before && after ? `Goes after ${before.artist} – ${before.title}, before ${after.artist} – ${after.title}.`
      : before ? `Goes at the end, after ${before.artist} – ${before.title}.` : after ? `Goes first, before ${after.artist} – ${after.title}.` : "Your first record. Lonely.";
    drawShelf();
  }
  $("#pull-close").addEventListener("click", () => { pulled = null; $("#pull").hidden = true; drawShelf(); });
  $("#pull-spin").addEventListener("click", () => pulled && spin({ collection_id: pulled }, $("#shelf-msg")));
  $("#pull-remove").addEventListener("click", async () => {
    if (!pulled) return;
    const r = shelfItems.find((x) => x.id === pulled);
    try { await api(`/api/collection/${pulled}`, { method: "DELETE" }); } catch (e) { return say($("#shelf-msg"), e.message, true); }
    say($("#shelf-msg"), r ? `Took ${r.title} off the shelf.` : "");
    pulled = null; $("#pull").hidden = true; loadShelf();
  });

  // Colour order: read each sleeve's main colour (covers are on the Pi, so the browser may read them).
  async function measureColours() {
    const todo = shelfItems.filter((r) => r.cover && !hues[r.cover]);
    if (!todo.length) return;
    say($("#shelf-msg"), "Reading sleeve colours…");
    const c = document.createElement("canvas"); c.width = c.height = 24;
    const g = c.getContext("2d", { willReadFrequently: true });
    for (const r of todo) {
      try {
        const img = new Image(); img.src = r.cover; await img.decode();
        g.drawImage(img, 0, 0, 24, 24);
        const d = g.getImageData(0, 0, 24, 24).data;
        let best = null; const bins = {};
        for (let p = 0; p < d.length; p += 4) {
          const [h, s, l] = rgbToHsl(d[p], d[p + 1], d[p + 2]);
          const k = s < 18 ? "grey" : Math.round(h / 20);
          const b = (bins[k] = bins[k] || { n: 0, h: 0, s: 0, l: 0 });
          b.n += s < 18 ? 0.6 : 1 + s / 100; b.h += h; b.s += s; b.l += l; b.c = (b.c || 0) + 1;
        }
        for (const k in bins) if (!best || bins[k].n > best.n) best = bins[k];
        hues[r.cover] = { h: best.h / best.c, s: best.s / best.c, l: best.l / best.c };
      } catch { hues[r.cover] = { h: 0, s: 0, l: 50 }; }
    }
    keep("shelf-hues", JSON.stringify(hues));
    say($("#shelf-msg"), "");
    drawShelf();
  }

  // Shelf setup
  function drawSetup() {
    $("#shelf-rows").innerHTML = shelfSetup.map((s, i) => `<div class="row shelf-row">
        <input class="field grow" data-k="name" data-i="${i}" value="${esc(s.name)}" aria-label="Shelf name">
        <input class="field num" data-k="capacity" data-i="${i}" type="number" min="1" max="2000" inputmode="numeric" value="${s.capacity}" aria-label="Records that fit">
        ${shelfSetup.length > 1 ? `<button class="icon-btn" data-del="${i}" aria-label="Remove shelf"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : ""}
      </div>`).join("");
    $$("#shelf-rows input").forEach((el) => el.addEventListener("input", () => {
      const s = shelfSetup[el.dataset.i];
      s[el.dataset.k] = el.dataset.k === "capacity" ? Math.max(1, parseInt(el.value, 10) || 1) : el.value;
    }));
    $$("#shelf-rows [data-del]").forEach((b) => b.addEventListener("click", () => { shelfSetup.splice(+b.dataset.del, 1); drawSetup(); }));
  }
  $("#shelf-setup-open").addEventListener("click", () => { const c = $("#shelf-setup"); c.hidden = !c.hidden; if (!c.hidden) drawSetup(); });
  $("#shelf-row-add").addEventListener("click", () => {
    const last = shelfSetup[shelfSetup.length - 1];
    shelfSetup.push({ name: `Shelf ${shelfSetup.length + 1}`, capacity: last ? last.capacity : 80 });
    drawSetup();
  });
  $("#shelf-save").addEventListener("click", async () => {
    try { shelfSetup = await api("/api/shelves", { method: "POST", body: shelfSetup }); } catch (e) { return say($("#shelf-msg"), e.message, true); }
    $("#shelf-setup").hidden = true;
    say($("#shelf-msg"), "Shelves saved.");
    drawShelf();
  });

  /* ---------- settings ---------- */
  async function loadStatus() {
    try { status = await api("/api/status"); } catch { return; }
    if (status.mode === "hotspot") return go("wifi");
    $("#ver").textContent = `${status.version} · ${status.temperature ?? "?"}°C`;
    const u = status.update || {};
    const apply = $("#update-apply");
    if (u.state === "updating") {
      $("#update-line").textContent = "● UPDATING";
      $("#update-text").textContent = "Installing the update. The page will reload when it's done.";
      apply.hidden = true;
    } else if (u.available) {
      $("#update-line").textContent = `● UPDATE READY · ${u.latest || ""}`;
      $("#update-text").textContent = (u.notes || []).slice(0, 3).join(" · ") || "A new version is on GitHub.";
      apply.hidden = false;
    } else {
      $("#update-line").textContent = "UP TO DATE";
      $("#update-text").textContent = u.checked_at ? `Last checked ${ago(u.checked_at)}.${u.error ? " " + u.error : ""}` : "Not checked yet.";
      apply.hidden = true;
    }
    const w = status.wifi, wd = status.watchdog || {};
    const rows = [
      ["Turntable", status.turntable || "Not found", status.turntable ? "" : "bad"],
      ["Stream", status.live ? `${status.bitrate} · ${status.listeners} listening` : "Offline", status.live ? "" : "bad"],
      ...(!status.live && status.stream && status.stream.state === "failed" ? [["Why", status.stream.message, "bad"]] : []),
      ["Wi-Fi", w ? `${w.ssid} · ${w.signal > 60 ? "good" : w.signal > 35 ? "ok" : "weak"}` : "Wired or offline", w && w.signal <= 35 ? "warn" : ""],
      ["Watchdog", wd.last_fix ? `Last fix ${ago(wd.last_fix)}` : "All quiet", ""],
      ["Temperature", status.temperature != null ? `${status.temperature}°C` : "?", status.temperature > 70 ? "bad" : status.temperature > 60 ? "warn" : ""],
    ];
    $("#status-list").innerHTML = rows.map(([l, v, c]) =>
      `<div class="item"><span class="dot ${c}"></span><span class="lbl">${esc(l)}</span><span class="val">${esc(v)}</span></div>`).join("");
    $("#auto-update").setAttribute("aria-checked", status.auto_update);
    $("#cover-state").textContent = status.cover_scan ? "CLAUDE" : "TEXT ONLY";
    $("#cover-state").classList.toggle("accent", !!status.cover_scan);
    $("#key-remove").hidden = !status.cover_scan;
    $("#api-key").placeholder = status.cover_scan ? "Key saved. Paste a new one to replace it" : "sk-ant-…";
    $("#bitrate").value = status.bitrate;
    $("#secure-state").textContent = SECURE ? "IN USE" : status.https ? "READY" : "NOT SET UP";
    $("#secure-state").classList.toggle("accent", SECURE);
    $("#secure-open").href = `https://${location.hostname}/`;
    $("#secure-open").hidden = SECURE;
    $("#discogs-state").textContent = status.discogs ? "LINKED" : "NOT LINKED";
    $("#discogs-state").classList.toggle("accent", !!status.discogs);
    $("#discogs-actions").hidden = $("#discogs-remove").hidden = !status.discogs;
    $("#discogs-token").placeholder = status.discogs ? "Token saved. Paste a new one to replace it" : "Paste your Discogs token";
    if (status.discogs) checkImport();
    $("#song-state").textContent = status.song_id ? "TOKEN SAVED" : "FREE TRIAL";
    $("#song-state").classList.toggle("accent", !!status.song_id);
    $("#audd-remove").hidden = !status.song_id;
    $("#audd-token").placeholder = status.song_id ? "Token saved. Paste a new one to replace it" : "Paste your AudD token";
  }
  const smsg = $("#settings-msg");
  $("#update-check").addEventListener("click", async (e) => {
    e.target.disabled = true; say(smsg, "Checking GitHub…");
    try { await api("/api/update/check", { method: "POST" }); say(smsg, ""); } catch (err) { say(smsg, err.message, true); }
    e.target.disabled = false; loadStatus();
  });
  $("#update-apply").addEventListener("click", async () => {
    try {
      const r = await api("/api/update/apply", { method: "POST" });
      say(smsg, r.message);
      waitForRestart();
    } catch (err) { say(smsg, err.message, true); }
  });
  function waitForRestart() {
    let seenDown = false, tries = 0;
    const t = setInterval(async () => {
      tries++;
      try {
        await api("/api/health");
        if (seenDown || tries > 40) { clearInterval(t); location.reload(); }
      } catch { seenDown = true; }
    }, 3000);
  }
  $("#auto-update").addEventListener("click", async (e) => {
    const on = e.currentTarget.getAttribute("aria-checked") !== "true";
    e.currentTarget.setAttribute("aria-checked", on);
    try { await api("/api/settings", { method: "POST", body: { auto_update: on } }); say(smsg, on ? "Auto-update on." : "Auto-update off."); }
    catch (err) { say(smsg, err.message, true); }
  });
  $("#bitrate").addEventListener("change", async (e) => {
    say(smsg, "Switching quality…");
    try { await api("/api/settings", { method: "POST", body: { bitrate: e.target.value } }); say(smsg, "Done. Press play again to hear it."); }
    catch (err) { say(smsg, err.message, true); }
  });
  async function saveKey(key) {
    say(smsg, key ? "Saving key…" : "Removing key…");
    try {
      const r = await api("/api/settings", { method: "POST", body: { anthropic_key: key } });
      say(smsg, r.message || "Saved.");
      $("#api-key").value = "";
      loadStatus();
    } catch (err) { say(smsg, err.message, true); }
  }
  $("#key-form").addEventListener("submit", (e) => { e.preventDefault(); const k = $("#api-key").value.trim(); if (k) saveKey(k); });
  $("#key-remove").addEventListener("click", () => saveKey(""));
  async function saveToken(token) {
    say(smsg, token ? "Saving token…" : "Removing token…");
    try {
      const r = await api("/api/settings", { method: "POST", body: { audd_token: token } });
      say(smsg, r.message || "Saved.");
      $("#audd-token").value = "";
      loadStatus();
    } catch (err) { say(smsg, err.message, true); }
  }
  $("#audd-form").addEventListener("submit", (e) => { e.preventDefault(); const t = $("#audd-token").value.trim(); if (t) saveToken(t); });
  $("#audd-remove").addEventListener("click", () => saveToken(""));

  async function saveDiscogs(token) {
    const m = $("#discogs-msg");
    say(m, token ? "Checking the token…" : "Unlinking…");
    try {
      const r = await api("/api/settings", { method: "POST", body: { discogs_token: token } });
      $("#discogs-token").value = "";
      await loadStatus();
      if (token) {
        const d = await api("/api/discogs?check=1");
        say(m, d.username ? `Linked to ${d.username}.` : "Saved, but Discogs didn't recognise the token. Check it and paste it again.", !d.username);
      } else say(m, r.message || "Unlinked.");
    } catch (err) { say(m, err.message, true); }
  }
  $("#discogs-form").addEventListener("submit", (e) => { e.preventDefault(); const t = $("#discogs-token").value.trim(); if (t) saveDiscogs(t); });
  $("#discogs-remove").addEventListener("click", () => saveDiscogs(""));
  let importTimer;
  function showImport(i) {
    const m = $("#discogs-msg"), b = $("#discogs-import");
    const busy = i.state === "reading" || i.state === "adding";
    b.disabled = busy;
    if (i.state === "reading") say(m, "Reading your Discogs collection…");
    else if (i.state === "adding") say(m, `Adding to your shelf: ${i.done} of ${i.total}…`);
    else if (i.state === "done") say(m, `Imported from ${i.user}: ${i.added} new record${i.added === 1 ? "" : "s"} on your shelf.`);
    else if (i.state === "failed") say(m, i.error, true);
    clearTimeout(importTimer);
    if (busy) importTimer = setTimeout(checkImport, 2000);
  }
  async function checkImport() { try { showImport((await api("/api/discogs")).import); } catch { /* try later */ } }
  $("#discogs-import").addEventListener("click", async () => {
    try { showImport(await api("/api/discogs/import", { method: "POST" })); } catch (err) { say($("#discogs-msg"), err.message, true); }
  });

  $("#restart-stream").addEventListener("click", async () => {
    say(smsg, "Restarting the stream…");
    try { await api("/api/restart-stream", { method: "POST" }); say(smsg, "Stream restarted."); } catch (err) { say(smsg, err.message, true); }
  });

  $("#report-get").addEventListener("click", async (e) => {
    e.target.disabled = true; say(smsg, "Putting a report together…");
    try {
      const r = await api("/api/diagnostics", { method: "POST" });
      $("#report-text").textContent = r.report; $("#report-card").hidden = false; say(smsg, "");
      $("#report-card").scrollIntoView({ behavior: "smooth" });
    } catch (err) { say(smsg, err.message, true); }
    e.target.disabled = false;
  });
  $("#report-copy").addEventListener("click", async () => {
    const text = $("#report-text").textContent;
    try { await navigator.clipboard.writeText(text); say(smsg, "Report copied. Paste it into the chat."); }
    catch {
      const range = document.createRange(); range.selectNodeContents($("#report-text"));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      say(smsg, "Report selected. Use Copy from your phone's menu.");
    }
  });

  /* ---------- Wi-Fi ---------- */
  let chosen = null;
  async function loadNetworks() {
    const rescue = status.mode === "hotspot";
    $("#wifi-kicker").textContent = rescue ? "● OFFLINE · VINYLPI-SETUP" : "WI-FI";
    $("#wifi-kicker").style.color = rescue ? "var(--bad)" : "";
    $("#wifi-title").innerHTML = rescue ? "The Pi lost<br>its Wi-Fi" : "Change Wi-Fi";
    $("#wifi-text").textContent = rescue
      ? "It tried for 5 minutes, then opened this hotspot. Pick your network and it'll hop back on."
      : "Pick a network and Vinyl Pi will join it.";
    $("#wifi-back").hidden = rescue;
    let nets = [];
    try { nets = await api("/api/wifi/networks"); } catch { /* empty list */ }
    const box = $("#nets");
    if (!nets.length) {
      box.innerHTML = `<div class="empty">No networks seen yet. Type the name below.</div>
        <label class="sr" for="ssid">Network name</label><input id="ssid" class="field" placeholder="Network name">`;
      chosen = null;
      return;
    }
    box.innerHTML = nets.map((n, i) =>
      `<button type="button" data-i="${i}" aria-pressed="false"><span>${esc(n.ssid)}</span><span class="sig">${n.signal > 60 ? "STRONG" : n.signal > 35 ? "OK" : "WEAK"}</span></button>`).join("");
    $$("button", box).forEach((b) => b.addEventListener("click", () => {
      chosen = nets[b.dataset.i].ssid;
      $$("button", box).forEach((x) => x.setAttribute("aria-pressed", x === b));
      $("#wifi-pass").placeholder = `Password for ${chosen}`;
      $("#wifi-pass").focus();
    }));
  }
  $("#wifi-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ssid = chosen || ($("#ssid") && $("#ssid").value.trim());
    const msg = $("#wifi-msg");
    if (!ssid) return say(msg, "Pick a network first.", true);
    say(msg, `Joining ${ssid}… This page will go quiet while the Pi switches over. Then open vinyl.local on your normal Wi-Fi.`);
    try { await api("/api/wifi/connect", { method: "POST", body: { ssid, password: $("#wifi-pass").value } }); }
    catch (err) { say(msg, err.message, true); }
  });

  /* ---------- listening stats ---------- */
  let statDays = 7;
  const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)}<small>h</small>${m % 60 ? ` ${m % 60}<small>m</small>` : ""}` : `${m}<small>m</small>`);
  const hmText = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
  $$("#range button").forEach((b) => b.addEventListener("click", () => {
    statDays = +b.dataset.days;
    $$("#range button").forEach((x) => x.setAttribute("aria-selected", x === b));
    loadStats();
  }));
  async function loadStats() {
    let s;
    try { s = await api(`/api/stats?days=${statDays}`); } catch (e) { return say($("#stats-msg"), e.message, true); }
    say($("#stats-msg"), "");
    $("#stats-kicker").textContent = { 7: "THIS WEEK", 30: "LAST 30 DAYS", 0: "ALL TIME" }[s.days];
    $("#stats-time").innerHTML = hm(s.minutes);
    $("#st-spins").textContent = s.spins; $("#st-records").textContent = s.records; $("#st-artists").textContent = s.artists;
    $("#chart-title").textContent = s.days ? "BY DAY" : "BY WEEK";
    const max = Math.max(1, ...s.chart.map((c) => c.minutes));
    const peak = s.chart.reduce((a, c) => (c.minutes > a.minutes ? c : a), s.chart[0]);
    $("#chart-peak").textContent = peak && peak.minutes ? `BEST ${peak.label.toUpperCase()} · ${hmText(peak.minutes)}` : "";
    const chart = $("#chart");
    const n = s.chart.length, step = n > 14 ? 5 : n > 8 ? 3 : 1; // label every few bars, counting back from today
    chart.setAttribute("aria-label", s.chart.map((c) => `${c.label}: ${hmText(c.minutes)}`).join(", "));
    chart.innerHTML = s.chart.map((c, i) => `<div class="col${i === s.chart.length - 1 ? " today" : ""}" title="${esc(c.label)} · ${hmText(c.minutes)}">
        <div class="b${c.minutes ? " on" : ""}" style="height:${c.minutes ? Math.max(4, (c.minutes / max) * 100) : 0}%"></div><span class="l">${(n - 1 - i) % step ? "" : esc(c.label)}</span></div>`).join("");
    const none = (t) => `<li class="none">${t}</li>`;
    $("#top-records").innerHTML = s.top_records.length ? s.top_records.map((r) => `<li>
        <div class="art" style="${r.cover ? `background-image:url('${esc(r.cover)}')` : ""}"></div>
        <div style="min-width:0"><div class="t1">${esc(r.title)}</div><div class="t2">${esc(r.artist)}${r.year ? " · " + esc(r.year) : ""}</div></div>
        <span class="n">${r.spins}×</span></li>`).join("") : none("Nothing spun yet. Set what's playing and it'll show up here.");
    const topA = Math.max(1, ...s.top_artists.map((a) => a.spins));
    $("#top-artists").innerHTML = s.top_artists.length ? s.top_artists.map((a) => `<li>
        <div style="min-width:0"><div class="t1">${esc(a.artist)}</div><div class="bar-fill" style="width:${(a.spins / topA) * 100}%"></div></div>
        <span class="n">${a.spins} · ${hmText(a.minutes)}</span></li>`).join("") : none("No artists yet.");
    const when = (t) => new Date(t * 1000).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
    $("#tidy").hidden = !s.partials;
    $("#tidy").textContent = `Tidy ${s.partials} partial ${s.partials === 1 ? "play" : "plays"}`;
    $("#recent").innerHTML = (s.recent || []).length ? s.recent.map((r) => `<li${r.partial ? ' class="partial"' : ""}>
        <div class="art" style="${r.cover ? `background-image:url('${esc(r.cover)}')` : ""}"></div>
        <div style="min-width:0"><div class="t1">${esc(r.title)}</div><div class="t2">${esc(r.artist)} · ${esc(when(r.start))} · ${r.minutes < 1 ? "under a minute" : hmText(Math.round(r.minutes))}${r.partial ? ' · <b>partial</b>' : ""}</div></div>
        <button class="icon-btn" data-rm="${esc(r.id)}" aria-label="Remove this play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>`).join("") : none("No plays yet.");
  }

  // Recent plays: remove misplays and half-played records so they stop counting.
  $("#tidy").addEventListener("click", async () => {
    try { await api("/api/stats/remove", { method: "POST", body: { tidy: true } }); loadStats(); } catch (e) { say($("#stats-msg"), e.message, true); }
  });
  $("#recent").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    b.disabled = true;
    try { await api("/api/stats/remove", { method: "POST", body: { ids: [b.dataset.rm] } }); loadStats(); } catch (err) { say($("#stats-msg"), err.message, true); b.disabled = false; }
  });

  /* ---------- live updates ---------- */
  function connect() {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => { state = JSON.parse(e.data); render(); if (!$('[data-view="stats"]').hidden) loadStats(); };
    es.onopen = () => refreshLive();
    es.onerror = () => { say($("#live"), "● RECONNECTING", true); };
  }
  async function refreshLive() {
    try { status = await api("/api/status"); } catch { return; }
    if (status.mode === "hotspot") return go("wifi");
    say($("#live"), status.live ? `● LIVE · ${status.listeners} LISTENING` : "● STREAM OFFLINE", !status.live);
  }
  setInterval(refreshLive, 20000);

  (async () => {
    try { state = await api("/api/state"); } catch { /* first paint without state */ }
    render();
    await refreshLive();
    const start = location.hash.slice(1);
    if (status.mode === "hotspot") go("wifi");
    else if (VIEWS.includes(start) && start !== "now") go(start);
    connect();
    upgrade();
  })();

  /* ---------- home-screen app ---------- */
  // Phones only offer "Add to home screen" as an app on a secure (https) page with a service worker.
  if ("serviceWorker" in navigator && SECURE) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("#phone-state").textContent = standalone ? "APP" : "BROWSER";
  $("#phone-state").classList.toggle("accent", !!standalone);
  let installPrompt;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    $("#install-app").hidden = false;
  });
  $("#install-app").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    $("#install-app").hidden = true;
  });
  window.addEventListener("appinstalled", () => { $("#install-app").hidden = true; $("#phone-state").textContent = "APP"; });

  // If this phone already trusts the Pi's certificate, hop to the secure page quietly.
  // A no-cors fetch only succeeds when the certificate is trusted.
  async function upgrade() {
    if (SECURE || !status.https || status.mode === "hotspot" || app.classList.contains("playing")) return;
    try {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 3000);
      await fetch(`https://${location.hostname}/api/health`, { mode: "no-cors", signal: ctl.signal });
      location.replace(`https://${location.hostname}${location.pathname}${location.hash}`);
    } catch { /* not trusted yet: stay on http */ }
  }
})();
