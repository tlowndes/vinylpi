/* Vinyl Pi web app. Plain JS, no build step. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $("#app");
  const audio = $("#audio");
  const STREAM = `${location.protocol}//${location.hostname}:8000/vinyl`;
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
    if (view === "settings") loadStatus();
    if (view === "wifi") loadNetworks();
    if (view === "add") setTimeout(() => $("#add-q").focus(), 50);
    history.replaceState(null, "", view === "now" ? "/" : `#${view}`);
    window.scrollTo(0, 0);
  }
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
      const side = (n.tracks || []).filter((t) => !/^[A-Z]/i.test(t.number) || t.number[0].toUpperCase() === n.side);
      $("#tracks").innerHTML = side.slice(0, 8).map((t) =>
        `<li><span class="n">${esc(t.number)}</span><span>${esc(t.title)}</span><span class="t">${esc(t.length)}</span></li>`).join("");
      document.title = `${n.title} · Vinyl Pi`;
    }
    $("#history").innerHTML = (state.history || []).slice(0, 8).map((h) =>
      `<li><div class="art" style="${h.cover ? `background-image:url('${esc(h.cover)}')` : ""}"></div>
        <div class="txt"><div class="t1">${esc(h.title)}</div><div class="t2">${esc(h.artist)} · ${esc(ago(h.started_at))}</div></div></li>`).join("");
  }
  setInterval(render, 60000);

  $("#flip").addEventListener("click", () => api("/api/flip", { method: "POST" }).catch(() => {}));

  /* ---------- player + level meter ---------- */
  const meter = $("#meter");
  const BARS = 44;
  meter.innerHTML = "<i></i>".repeat(BARS);
  const bars = $$("i", meter);
  let ctx, analyser, buf, raf;

  async function play() {
    audio.src = `${STREAM}?t=${Date.now()}`; // fresh connection, so we're as close to live as possible
    audio.volume = +$("#volume").value;
    try {
      await audio.play();
    } catch {
      return say($("#live"), "● STREAM OFFLINE", true);
    }
    app.classList.add("playing");
    $("#play").setAttribute("aria-label", "Pause");
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
      draw();
    } catch { /* meter is a nice-to-have */ }
  }
  function stop() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    app.classList.remove("playing");
    $("#play").setAttribute("aria-label", "Play");
    cancelAnimationFrame(raf);
    bars.forEach((b) => { b.style.height = "8%"; b.classList.remove("on"); });
  }
  function draw() {
    analyser.getByteFrequencyData(buf);
    const level = buf.reduce((a, v) => a + v, 0) / buf.length / 255;
    bars.forEach((b, i) => {
      const v = buf[Math.floor((i / BARS) * buf.length * 0.8)] / 255;
      b.style.height = `${Math.max(8, v * 100)}%`;
      b.classList.toggle("on", i / BARS < level * 2.2);
    });
    raf = requestAnimationFrame(draw);
  }
  $("#play").addEventListener("click", () => (app.classList.contains("playing") ? stop() : play()));
  $("#volume").addEventListener("input", (e) => (audio.volume = +e.target.value));
  audio.addEventListener("error", () => { if (audio.getAttribute("src")) { stop(); say($("#live"), "● STREAM OFFLINE", true); } });

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
  $$(".tabs button").forEach((t) => t.addEventListener("click", () => {
    scanMode = t.dataset.mode;
    $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", b === t));
    $("#scan-hint").textContent = scanMode === "barcode"
      ? "Take a photo of the barcode on the back of the sleeve."
      : "Cover scan is coming soon. Use the barcode or search for now.";
    $("#photo").disabled = scanMode !== "barcode";
  }));

  async function decode(file) {
    const bitmap = await createImageBitmap(file);
    if ("BarcodeDetector" in window) {
      try {
        const found = await new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] }).detect(bitmap);
        if (found.length) return found[0].rawValue;
      } catch { /* fall through to ZXing */ }
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

  async function lookup(code) {
    const msg = $("#scan-msg");
    say(msg, `Looking up ${code}…`);
    try {
      match = await api(`/api/barcode/${encodeURIComponent(code)}`);
      $("#match").hidden = false;
      $("#match-art").src = match.cover;
      $("#match-title").textContent = match.title;
      $("#match-meta").textContent = [match.artist, match.year, match.label].filter(Boolean).join(" · ");
      $("#spin-match").hidden = false;
      say(msg, "");
    } catch (e) { match = null; $("#match").hidden = true; $("#spin-match").hidden = true; say(msg, e.message, true); }
  }

  $("#photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const shot = $("#shot");
    shot.src = URL.createObjectURL(file);
    shot.hidden = false;
    $("#photo-label").textContent = "Retake";
    say($("#scan-msg"), "Reading the barcode…");
    try {
      const code = await decode(file);
      $("#code").value = code;
      await lookup(code);
    } catch {
      say($("#scan-msg"), "Couldn't read a barcode. Try closer, with less glare, or type the number.", true);
    }
    e.target.value = "";
  });
  $("#code-form").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#code").value.trim(); if (v) lookup(v); });
  $("#spin-match").addEventListener("click", () => match && spin({ release: match.release }, $("#scan-msg")));

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
      ["Wi-Fi", w ? `${w.ssid} · ${w.signal > 60 ? "good" : w.signal > 35 ? "ok" : "weak"}` : "Wired or offline", w && w.signal <= 35 ? "warn" : ""],
      ["Watchdog", wd.last_fix ? `Last fix ${ago(wd.last_fix)}` : "All quiet", ""],
      ["Temperature", status.temperature != null ? `${status.temperature}°C` : "?", status.temperature > 70 ? "bad" : status.temperature > 60 ? "warn" : ""],
    ];
    $("#status-list").innerHTML = rows.map(([l, v, c]) =>
      `<div class="item"><span class="dot ${c}"></span><span class="lbl">${esc(l)}</span><span class="val">${esc(v)}</span></div>`).join("");
    $("#auto-update").setAttribute("aria-checked", status.auto_update);
    $("#bitrate").value = status.bitrate;
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
  $("#restart-stream").addEventListener("click", async () => {
    say(smsg, "Restarting the stream…");
    try { await api("/api/restart-stream", { method: "POST" }); say(smsg, "Stream restarted."); } catch (err) { say(smsg, err.message, true); }
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

  /* ---------- live updates ---------- */
  function connect() {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => { state = JSON.parse(e.data); render(); };
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
    else if (["add", "scan", "settings", "wifi"].includes(start)) go(start);
    connect();
  })();
})();
