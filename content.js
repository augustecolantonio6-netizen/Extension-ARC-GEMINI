(() => {
  if (window.__geminiScreenContentLoaded) return;
  window.__geminiScreenContentLoaded = true;

  const MODEL_DEFAULT = "gemini-3.5-flash-lite";
  let overlay = null;
  let shadow = null;
  let sessionId = null;
  let captures = [];
  let history = [];
  let busy = false;
  let mediaStream = null;
  let mediaRecorder = null;
  let voiceChunks = [];
  let voiceMonitor = null;
  let voiceStartedAt = 0;
  let voiceHeardSpeech = false;
  let voiceLastLoudAt = 0;
  let activeRequestId = null;
  let streamText = "";

  const esc = (v) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const post = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

  // Arc/Chromium may fail to dispatch chrome.commands shortcuts on some Windows builds.
  // On regular web pages, listen for the same single shortcut directly in the page.
  // The service worker deduplicates this path against chrome.commands, so Ctrl+Y fires once.
  let lastPageHotkeyAt = 0;
  window.addEventListener("keydown", (e) => {
    if (e.isComposing || e.repeat || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    if (String(e.key).toLowerCase() !== "y") return;

    const target = e.target;
    const editable = target instanceof HTMLElement && (
      target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT"
    );
    // Keep normal browser/page editing behavior inside form controls.
    if (editable) return;

    const now = Date.now();
    if (now - lastPageHotkeyAt < 800) return;
    lastPageHotkeyAt = now;

    e.preventDefault();
    e.stopImmediatePropagation();
    void post({type:"OPEN_FOR_TAB", source:"page-keyboard"});
  }, true);

  function shadowEls() {
    return {
      chat: shadow.getElementById("chat"), input: shadow.getElementById("input"), send: shadow.getElementById("send"),
      status: shadow.getElementById("status"), rail: shadow.getElementById("rail"), mic: shadow.getElementById("mic"), micStatus: shadow.getElementById("micStatus")
    };
  }

  function removeOverlay() {
    try { mediaRecorder?.stop?.(); } catch (_) {}
    mediaRecorder = null;
    mediaStream?.getTracks?.().forEach((t) => t.stop());
    mediaStream = null;
    if (voiceMonitor) cancelAnimationFrame(voiceMonitor);
    voiceMonitor = null;
    if (overlay) overlay.remove();
    overlay = null;
    shadow = null;
  }

  function setStatus(text) { shadowEls().status.textContent = text; }

  function addMessage(role, text, capturesCount = 0) {
    const { chat } = shadowEls();
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;
    const bubble = document.createElement("div");
    bubble.className = `bubble ${role === "model" ? "modelBubble markdown" : "userBubble"}`;
    bubble.innerHTML = role === "model" ? renderMarkdown(text) : esc(text).replaceAll("\n", "<br>");
    if (capturesCount) {
      const note = document.createElement("div");
      note.style.cssText = "margin-top:5px;color:#777881;font-size:8px";
      note.textContent = `${capturesCount} capture${capturesCount > 1 ? "s" : ""}`;
      bubble.appendChild(note);
    }
    wrap.appendChild(bubble); chat.appendChild(wrap); chat.scrollTop = chat.scrollHeight;
    return bubble;
  }

  // KaTeX is bundled locally (MV3 forbids remote code). Fonts must be declared on the
  // document because @font-face inside a shadow root is ignored; the rest goes in the shadow.
  let katexCss = null;
  async function injectKatexCss(root) {
    try {
      if (katexCss === null) {
        const base = chrome.runtime.getURL("vendor/katex/");
        katexCss = (await (await fetch(`${base}katex.min.css`)).text()).replaceAll("url(fonts/", `url(${base}fonts/`);
      }
      if (!document.getElementById("__gemini_screen_katex_fonts__")) {
        const fonts = document.createElement("style"); fonts.id = "__gemini_screen_katex_fonts__";
        fonts.textContent = (katexCss.match(/@font-face\{[^}]*\}/g) || []).join("");
        (document.head || document.documentElement).appendChild(fonts);
      }
      const s = document.createElement("style"); s.textContent = katexCss.replace(/@font-face\{[^}]*\}/g, ""); root.appendChild(s);
    } catch (_) {}
  }

  const unesc = (v) => v.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#039;", "'").replaceAll("&amp;", "&");
  function renderMath(tex, displayMode) {
    if (typeof katex === "undefined") return null;
    try { return katex.renderToString(unesc(tex).trim(), {displayMode, throwOnError:false, output:"html"}); } catch (_) { return null; }
  }

  function renderMarkdown(text) {
    let html = esc(text);
    const blocks = [];
    const stash = (b) => { const token = `@@BLOCK_${blocks.length}@@`; blocks.push(b); return token; };
    html = html.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      stash(`<pre><code>${lang ? `<div style="color:#8f9097;font-size:8px;margin-bottom:4px">${esc(lang)}</div>` : ""}${code}</code></pre>`));
    html = html.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${code}</code>`));
    const math = (display) => (m, tex) => { const r = renderMath(tex, display); return r ? stash(r) : m; };
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, math(true));
    html = html.replace(/\\\[([\s\S]+?)\\\]/g, math(true));
    html = html.replace(/\\\(([\s\S]+?)\\\)/g, math(false));
    html = html.replace(/(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (m, pre, tex) => { const r = renderMath(tex, false); return r ? pre + stash(r) : m; });
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/(^|\n)- (.*)/g, "$1• $2");
    html = html.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>");
    html = `<p>${html}</p>`.replace(/@@BLOCK_(\d+)@@/g, (_, i) => blocks[Number(i)]);
    return html;
  }

  function renderCaptures() {
    const { rail } = shadowEls(); rail.innerHTML = "";
    if (!captures.length) { rail.innerHTML = '<div class="empty">Aucune capture</div>'; return; }
    captures.forEach((c) => {
      const card = document.createElement("div"); card.className = `thumb ${c.pending ? "pending" : ""}`;
      const img = document.createElement("img"); img.src = c.dataUrl; img.alt = "Capture"; card.appendChild(img);
      const badge = document.createElement("div"); badge.className = "badge"; badge.textContent = c.pending ? "nouvelle" : "envoyée"; card.appendChild(badge);
      if (!c.pending) {
        const reuse = document.createElement("button"); reuse.className = "reuse"; reuse.textContent = "réutiliser";
        reuse.addEventListener("click", () => { c.pending = true; renderCaptures(); shadowEls().input.focus(); }); card.appendChild(reuse);
      }
      const stamp = document.createElement("div"); stamp.className = "stamp"; stamp.textContent = new Date(c.createdAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); card.appendChild(stamp);
      rail.appendChild(card);
    });
  }

  function showWelcome() { shadowEls().chat.innerHTML = '<div class="welcome"><strong>Prêt.</strong><br>Pose une question sur ce que tu regardes. Une capture est prise automatiquement à l’ouverture.</div>'; }
  function resizeInput() { const i=shadowEls().input; i.style.height="auto"; i.style.height=`${Math.min(i.scrollHeight,100)}px`; }
  function dataUrlToPart(dataUrl) { const m=/^data:([^;]+);base64,(.+)$/.exec(dataUrl); if(!m) throw new Error("Capture invalide."); return {inline_data:{mime_type:m[1],data:m[2]}}; }
  function buildContents(text, newCaptures) { const c=history.map(m=>({role:m.role,parts:[{text:m.text}]})); const parts=[{text}]; newCaptures.forEach(x=>parts.push(dataUrlToPart(x.dataUrl))); c.push({role:"user",parts}); return c; }

  async function captureNow() {
    setStatus("Capture…");
    if (overlay) overlay.style.visibility = "hidden";
    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));
      const response = await post({ type:"CAPTURE_TAB", sessionId });
      if (!response?.ok) { setStatus("Capture impossible"); addMessage("model", response?.error || "Impossible de capturer cette page."); return false; }
      captures.push({id:crypto.randomUUID(),dataUrl:response.dataUrl,pending:true,createdAt:Date.now()}); renderCaptures(); setStatus("Prêt"); return true;
    } finally { if (overlay) overlay.style.visibility = "visible"; }
  }

  async function sendMessage() {
    if (busy) return;
    const { input, send } = shadowEls(); const text=input.value.trim(); if(!text) return;
    const opt=await post({type:"GET_OPTIONS"}); const settings=opt?.settings || {};
    if(!settings.apiKey){ addMessage("model","Il manque ta clé Gemini. Ouvre ⚙ pour la renseigner."); return; }
    const newCaptures=captures.filter(c=>c.pending); newCaptures.forEach(c=>c.pending=false); renderCaptures();
    input.value=""; resizeInput(); addMessage("user",text,newCaptures.length); history.push({role:"user",text});
    busy=true; send.disabled=true; setStatus("Gemini…");
    const bubble=addMessage("model",""); bubble.innerHTML='<span class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
    activeRequestId=crypto.randomUUID(); streamText="";
    const response=await post({type:"STREAM_GEMINI",sessionId,requestId:activeRequestId,model:settings.model||MODEL_DEFAULT,contents:buildContents(text,newCaptures)});
    if(!response?.ok){ bubble.innerHTML=`<span style="color:#ff8b8b">${esc(response?.error||"Impossible de contacter Gemini.")}</span>`; busy=false; send.disabled=false; setStatus("Erreur"); return; }
    input.focus();
  }

  async function blobToBase64(blob) {
    const buffer=await blob.arrayBuffer(); if(!buffer.byteLength) throw new Error("L’enregistrement audio est vide.");
    const bytes=new Uint8Array(buffer); let binary=""; const chunk=0x8000;
    for(let i=0;i<bytes.length;i+=chunk) binary += String.fromCharCode(...bytes.subarray(i,i+chunk));
    return btoa(binary);
  }

  function setMicState(listening,label="") { const {mic,micStatus}=shadowEls(); mic.setAttribute("aria-pressed",String(listening)); mic.textContent=listening?"■":"🎙"; mic.title=listening?"Arrêter la dictée":"Dicter une question"; micStatus.textContent=label; }
  function stopVoiceMonitor() { if(voiceMonitor) cancelAnimationFrame(voiceMonitor); voiceMonitor=null; }

  function monitorVoice() {
    const AudioCtx=window.AudioContext||window.webkitAudioContext; if(!AudioCtx||!mediaStream) return;
    const ctx=new AudioCtx(); const source=ctx.createMediaStreamSource(mediaStream); const analyser=ctx.createAnalyser(); analyser.fftSize=1024; source.connect(analyser);
    const buf=new Uint8Array(analyser.fftSize); voiceStartedAt=performance.now(); voiceHeardSpeech=false; voiceLastLoudAt=voiceStartedAt;
    const tick=()=>{
      if(!mediaRecorder||mediaRecorder.state!=="recording"){ctx.close().catch(()=>{});stopVoiceMonitor();return;}
      analyser.getByteTimeDomainData(buf); let sum=0; for(const v of buf){const x=(v-128)/128;sum+=x*x;} const rms=Math.sqrt(sum/buf.length); const now=performance.now();
      if(rms>0.018){voiceHeardSpeech=true;voiceLastLoudAt=now;}
      if(voiceHeardSpeech&&now-voiceLastLoudAt>3000&&now-voiceStartedAt>900){stopRecording();return;}
      if(now-voiceStartedAt>12000){stopRecording();return;} voiceMonitor=requestAnimationFrame(tick);
    }; voiceMonitor=requestAnimationFrame(tick);
  }

  function stopRecording() {
    stopVoiceMonitor(); if(mediaRecorder&&mediaRecorder.state!=="inactive"){try{mediaRecorder.stop();}catch(_){}}
    mediaStream?.getTracks?.().forEach(t=>t.stop()); mediaStream=null; setMicState(false,"traitement…");
  }

  async function startRecording() {
    const {mic}=shadowEls();
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){setMicState(false,"micro non disponible");return;}
    try{
      setStatus("Micro…"); setMicState(true,"parle…");
      mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      const preferred="audio/webm;codecs=opus"; const mimeType=MediaRecorder.isTypeSupported(preferred)?preferred:"audio/webm";
      mediaRecorder=new MediaRecorder(mediaStream,{mimeType}); voiceChunks=[];
      mediaRecorder.ondataavailable=e=>{if(e.data?.size)voiceChunks.push(e.data);};
      mediaRecorder.onstop=async()=>{
        stopVoiceMonitor(); const stream=mediaStream; mediaStream=null; stream?.getTracks?.().forEach(t=>t.stop());
        const recorder=mediaRecorder; mediaRecorder=null;
        if(!voiceChunks.length){setMicState(false,"aucun audio");setStatus("Prêt");return;}
        try{
          const actualMime=(recorder?.mimeType||mimeType||"audio/webm").split(";")[0].trim().toLowerCase();
          const blob=new Blob(voiceChunks,{type:actualMime}); voiceChunks=[]; const base64Audio=await blobToBase64(blob);
          const response=await post({type:"TRANSCRIBE_AUDIO",sessionId,base64Audio,mimeType:actualMime});
          if(!response?.ok) throw new Error(response?.error||"La transcription vocale a échoué.");
          const text=(response.text||"").trim(); if(!text) throw new Error("Je n’ai rien compris dans l’enregistrement.");
          const {input}=shadowEls(); input.value=text; resizeInput(); setMicState(false,""); setStatus("Prêt"); setTimeout(()=>sendMessage(),60);
        }catch(error){voiceChunks=[];setMicState(false,"erreur micro");setStatus("Erreur");addMessage("model",`🎙 ${esc(error?.message||"La dictée vocale a échoué.")}`);}
      };
      mediaRecorder.onerror=()=>stopRecording(); mediaRecorder.start(120); monitorVoice();
    }catch(error){
      mediaStream?.getTracks?.().forEach(t=>t.stop()); mediaStream=null; mediaRecorder=null; setMicState(false,"micro refusé"); setStatus("Prêt");
      // Extension popups (PDF mode) can't show the mic permission prompt: grant it once from a tab.
      if(error?.name==="NotAllowedError"&&location.protocol==="chrome-extension:"){addMessage("model","🎙 La popup ne peut pas demander le micro. Un onglet s’ouvre pour l’autoriser une fois, puis rouvre Gemini sur le PDF.");setTimeout(()=>chrome.tabs.create({url:chrome.runtime.getURL("mic.html")}),900);return;}
      const msg=error?.name==="NotAllowedError"?"Le micro est refusé. Autorise le microphone pour Arc puis réessaie.":error?.message||"Impossible d’accéder au micro.";
      addMessage("model",`🎙 ${esc(msg)}`);
    }
  }

  function buildOverlay() {
    removeOverlay(); overlay=document.createElement("div"); overlay.id="__gemini_screen_chat_root__"; if(location.protocol==="chrome-extension:") overlay.style.cssText="position:fixed;inset:0;"; shadow=overlay.attachShadow({mode:"closed"});
    const style=document.createElement("style"); style.textContent=`
      :host{all:initial}*{box-sizing:border-box}.gemini-root{position:fixed;z-index:2147483647;left:14px;top:50%;transform:translateY(-50%);width:20vw;min-width:320px;max-width:420px;height:50vh;min-height:390px;max-height:680px;color:#f2f2f3;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.panel{width:100%;height:100%;overflow:hidden;display:flex;flex-direction:column;color-scheme:dark;background:rgba(20,21,25,.97);border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.45),0 4px 16px rgba(0,0,0,.25);backdrop-filter:blur(18px)}button,textarea{font:inherit}button{color:inherit}.topbar{flex:0 0 48px;display:flex;align-items:center;justify-content:space-between;padding:8px 10px 8px 12px;border-bottom:1px solid rgba(255,255,255,.08)}.brand{display:flex;align-items:center;gap:8px}.mark{width:26px;height:26px;display:grid;place-items:center;border-radius:8px;background:rgba(200,166,255,.13);font-size:14px}.title{font-size:12px;font-weight:750}.status{margin-top:2px;color:#96979f;font-size:9px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;gap:2px}.icon{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#9fa0a7;cursor:pointer}.icon:hover{background:rgba(255,255,255,.07);color:#fff}.captureBar{padding:7px 9px 8px;border-bottom:1px solid rgba(255,255,255,.08)}.captureHead{display:flex;align-items:center;justify-content:space-between}.label{font-size:9px;text-transform:uppercase;letter-spacing:.08em;font-weight:750;color:#85868e}.capture{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.045);border-radius:8px;padding:5px 7px;font-size:9px;cursor:pointer}.rail{display:flex;gap:6px;overflow-x:auto;margin-top:6px}.empty{color:#74757d;font-size:9px;padding:6px 2px}.thumb{position:relative;flex:0 0 74px;height:48px;border-radius:7px;overflow:hidden;border:1px solid rgba(255,255,255,.09)}.thumb img{width:100%;height:100%;object-fit:cover;display:block}.badge{position:absolute;left:4px;top:4px;padding:2px 4px;border-radius:4px;background:rgba(0,0,0,.66);font-size:7px}.stamp{position:absolute;right:4px;bottom:3px;font-size:6px;color:#ddd;text-shadow:0 1px 2px #000}.reuse{position:absolute;right:4px;top:4px;padding:2px 4px;border:0;border-radius:4px;background:rgba(0,0,0,.72);font-size:7px;opacity:0;cursor:pointer}.thumb:hover .reuse{opacity:1}.pending{box-shadow:0 0 0 1px rgba(200,166,255,.5)}.chat{flex:1;min-height:0;overflow:auto;padding:10px}.welcome{color:#85868e;text-align:center;padding:18px 8px;font-size:10px;line-height:1.5}.welcome strong{color:#f2f2f3}.msg{display:flex;margin-bottom:9px}.msg.user{justify-content:flex-end}.bubble{max-width:92%;padding:8px 9px;border-radius:11px;border:1px solid rgba(255,255,255,.08);font-size:11px;line-height:1.45;overflow-wrap:anywhere}.userBubble{background:#292c33;border-bottom-right-radius:4px}.modelBubble{border-color:transparent;padding:8px 2px}.markdown p{margin:0 0 6px}.markdown p:last-child{margin-bottom:0}.markdown pre{margin:7px 0 0;padding:7px;border-radius:8px;background:#0b0c0e;border:1px solid rgba(255,255,255,.08);overflow:auto}.markdown code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px}.markdown :not(pre)>code{padding:1px 3px;border-radius:4px;background:rgba(255,255,255,.09)}.markdown a{color:#c8a6ff}.composerArea{padding:7px 9px 8px;border-top:1px solid rgba(255,255,255,.08);background:rgba(17,18,20,.95)}.footer{min-height:12px;padding:2px 2px 4px;color:#66676f;font-size:8px;display:flex;justify-content:space-between}.composer{display:flex;gap:4px;align-items:flex-end;min-height:38px;padding:4px;border:1px solid rgba(255,255,255,.13);border-radius:11px;background:#17181b}.composer textarea{flex:1;min-height:28px;max-height:100px;resize:none;border:0;outline:0;color:#f2f2f3;background:transparent;padding:5px 6px;font-size:11px;line-height:1.35;user-select:text;-webkit-user-select:text}.composer textarea::placeholder{color:#6f7077}.mic,.send{flex:0 0 29px;height:29px;border:0;border-radius:8px;cursor:pointer}.mic{background:transparent;color:#9fa0a7}.send{background:#c8a6ff;color:#19141f;font-weight:850}.send:disabled{opacity:.42;cursor:not-allowed}.thinking{display:inline-flex;gap:3px;align-items:center;color:#8d8e95}.dot{width:3px;height:3px;border-radius:50%;background:currentColor;animation:blink 1.1s infinite}.dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}@media(max-width:700px){.gemini-root{width:82vw;max-width:380px;min-width:280px;left:8px}}
      ${location.protocol === "chrome-extension:" ? `.gemini-root{position:relative;left:0;top:0;transform:none;width:100%;min-width:0;max-width:none;height:100%;min-height:0;max-height:none}.panel{border:0;border-radius:0;box-shadow:none;backdrop-filter:none;background:#141519}.chat{padding:10px}` : ""}
    .markdown .katex{font-size:1.1em}.markdown .katex-display{margin:6px 0;overflow-x:auto;overflow-y:hidden}
    `; shadow.appendChild(style); void injectKatexCss(shadow);
    const shell=document.createElement("div"); shell.className="gemini-root"; shell.innerHTML=`<div class="panel"><div class="topbar"><div class="brand"><div class="mark">✦</div><div><div class="title">Gemini Screen</div><div class="status" id="status">Prêt</div></div></div><div class="actions"><button class="icon" id="new" title="Nouvelle conversation">＋</button><button class="icon" id="settings" title="Paramètres">⚙</button><button class="icon" id="close" title="Fermer">×</button></div></div><div class="captureBar"><div class="captureHead"><div class="label">Captures</div><button class="capture" id="capture">↻ Refaire</button></div><div class="rail" id="rail"><div class="empty">Capture automatique…</div></div></div><div class="chat" id="chat"></div><div class="composerArea"><div class="footer"><span id="micStatus"></span><span>Ctrl+Entrée · 🎙 pour parler</span></div><div class="composer"><button class="mic" id="mic" title="Dicter">🎙</button><textarea id="input" rows="1" placeholder="Une question sur cet écran…"></textarea><button class="send" id="send" title="Envoyer">➤</button></div></div></div>`;
    shadow.appendChild(shell); document.documentElement.appendChild(overlay);

    // Stop host-page handlers after controls have received the events. Normal editing keeps working.
    shadow.addEventListener("keydown", (e)=>e.stopPropagation()); shadow.addEventListener("keyup", (e)=>e.stopPropagation()); shadow.addEventListener("keypress", (e)=>e.stopPropagation());
    shadow.getElementById("close").addEventListener("click",async()=>{await post({type:"CLOSE_SESSION",sessionId});removeOverlay();captures=[];history=[];sessionId=null;if(location.protocol === "chrome-extension:") window.close();});
    shadow.getElementById("new").addEventListener("click",()=>{history=[];captures=[];showWelcome();renderCaptures();captureNow();});
    shadow.getElementById("settings").addEventListener("click",()=>{chrome.runtime.sendMessage({type:"OPEN_SETTINGS_PAGE"});});
    shadow.getElementById("capture").addEventListener("click",captureNow); shadow.getElementById("send").addEventListener("click",sendMessage);
    shadow.getElementById("input").addEventListener("input",resizeInput); shadow.getElementById("input").addEventListener("keydown",(e)=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();sendMessage();}});
    shadow.getElementById("mic").addEventListener("click",()=>{if(mediaRecorder?.state==="recording")stopRecording();else startRecording();});
    showWelcome(); renderCaptures();
  }

  async function show(newSessionId) {
    if(sessionId===newSessionId&&overlay){overlay.style.display="block";shadowEls().input.focus();return {ok:true};}
    sessionId=newSessionId;captures=[];history=[];busy=false;activeRequestId=null;buildOverlay();await captureNow();shadowEls().input.focus();return {ok:true};
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse)=>{
    if(message?.type==="PING"){sendResponse({ok:true});return;}
    if(message?.type==="SHOW_OVERLAY"){show(message.sessionId).then(sendResponse).catch(e=>sendResponse({ok:false,error:e?.message||"Erreur d’affichage."}));return true;}
    if(message?.type==="TOGGLE_OVERLAY"){if(overlay&&sessionId===message.sessionId){removeOverlay();captures=[];history=[];sendResponse({ok:true,closed:true});if(location.protocol === "chrome-extension:") setTimeout(()=>window.close(),0);}else show(message.sessionId).then(sendResponse).catch(e=>sendResponse({ok:false,error:e?.message||"Erreur d’affichage."}));return true;}
    if(message?.type==="CLOSE_OVERLAY"){if(!message.sessionId||message.sessionId===sessionId){removeOverlay();captures=[];history=[];sessionId=null;if(location.protocol === "chrome-extension:") setTimeout(()=>window.close(),0);}sendResponse({ok:true});return;}
    if(message?.type==="PDF_POPUP_TOGGLE_CLOSE" && location.protocol === "chrome-extension:" && location.pathname.endsWith("/pdf.html")){
      if(message.sessionId && message.sessionId===sessionId){
        removeOverlay(); captures=[]; history=[]; sessionId=null;
        sendResponse({ok:true,closed:true});
        setTimeout(()=>window.close(),0);
      } else sendResponse({ok:false,closed:false});
      return;
    }
    if(message?.type==="GEMINI_STREAM_CHUNK"&&message.requestId===activeRequestId){streamText=message.text||"";const b=[...shadowEls().chat.querySelectorAll(".modelBubble")].at(-1);if(b){b.innerHTML=renderMarkdown(streamText);shadowEls().chat.scrollTop=shadowEls().chat.scrollHeight;}return;}
    if(message?.type==="GEMINI_STREAM_DONE"&&message.requestId===activeRequestId){const text=(message.text||streamText||"Je n’ai pas reçu de réponse.").trim();const b=[...shadowEls().chat.querySelectorAll(".modelBubble")].at(-1);if(b)b.innerHTML=renderMarkdown(text);history.push({role:"model",text});busy=false;activeRequestId=null;shadowEls().send.disabled=false;setStatus("Prêt");return;}
    if(message?.type==="GEMINI_STREAM_ERROR"&&message.requestId===activeRequestId){const b=[...shadowEls().chat.querySelectorAll(".modelBubble")].at(-1);if(b)b.innerHTML=`<span style="color:#ff8b8b">Erreur : ${esc(message.error||"Gemini indisponible")}</span>`;busy=false;activeRequestId=null;shadowEls().send.disabled=false;setStatus("Erreur");}
  });

  // PDF mode uses the browser-native extension action popup. The popup has no
  // sender.tab, so it announces itself to the service worker and receives the
  // session id for the active PDF.
  if(location.protocol === "chrome-extension:" && location.pathname.endsWith("/pdf.html")){
    post({type:"PDF_POPUP_READY"}).then(response=>{
      if(response?.ok && response.sessionId) show(response.sessionId).catch(()=>{});
    }).catch(()=>{});
    window.addEventListener("pagehide",()=>{
      if(sessionId) void post({type:"CLOSE_SESSION",sessionId});
    },{once:true});
  }
})();
