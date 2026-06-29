# Frontend Integration Guide

How the web frontend talks to the platform. **All requests go to the Voice Gateway**,
which authenticates them and proxies to the LLM service.

```
Frontend ──X-API-Key──▶ Gateway (:8001) ──▶ LLM service (:8008) ──▶ model / Edge TTS / Google translate
                              └──▶ Postgres (chat history)
```

---

## 1. Setup

```js
// One place to configure everything.
const GATEWAY_URL = "https://your-gateway-host:8001";  // no trailing slash
const API_KEY = localStorage.getItem("api_key") || "";  // the user's gateway key

// One key unlocks every feature. Send it on every call.
function authHeaders(extra = {}) {
  return { "X-API-Key": API_KEY, ...extra };
}
function api(path) { return `${GATEWAY_URL}${path}`; }
```

> **One API key = all features.** The gateway requires `X-API-Key` on every
> endpoint — chat, translate, voice, and history. A single gateway key is the
> credential for the whole platform; without it you get **401**.
>
> The key is checked **only at the gateway**. Internally the model stays keyless
> (gateway → LLM service → vLLM/llama), so you manage access in exactly one place.

---

## 2. Chat (streaming)

`POST /api/chat` — returns Server-Sent Events: lines of `data: {"content":"..."}`
ending with `data: [DONE]`.

```js
async function streamChat(messages, onToken) {
  const res = await fetch(api("/api/chat"), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ messages, temperature: 0.7, max_tokens: 2048, stream: true }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const obj = JSON.parse(data);
        if (obj.error) throw new Error(obj.error);
        if (obj.content) onToken(obj.content);   // append to the bubble
      } catch {}
    }
  }
}

// usage
const history = [{ role: "user", content: "Hello!" }];
let reply = "";
await streamChat(history, (t) => { reply += t; render(reply); });
```

**Non-streaming** (set `stream:false`) returns `{ choices:[{ message:{ role, content } }] }`.

---

## 3. Translation (AI model **or** free Google API)

`POST /api/translate` — `engine:"llm"` (default) or `engine:"api"` (free Google).

```js
async function translate(text, targetLang, engine = "llm") {
  const res = await fetch(api("/api/translate"), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ text, target_lang: targetLang, engine }),
  });
  if (!res.ok) throw new Error(`translate ${res.status}`);
  return res.json(); // { translation, source_lang, target_lang }
}

// the user's engine toggle just changes the `engine` value:
const out = await translate("Good morning", "ar", userPickedApi ? "api" : "llm");
```

---

## 4. Voice — Text-to-Speech (Edge/Bing neural, streaming MP3)

`POST /api/voice/tts` — **form-data** (`text`, optional `language`, `voice`, `gender`).
Returns `audio/mpeg`. Stream it for instant playback.

```js
async function speak(text, language) {
  const fd = new FormData();
  fd.append("text", text);
  if (language) fd.append("language", language);  // else auto-detected
  const res = await fetch(api("/api/voice/tts"), { method: "POST", headers: authHeaders(), body: fd });
  if (!res.ok) throw new Error(`tts ${res.status}`);

  // Simplest: play the whole clip.
  const blob = await res.blob();
  const audio = new Audio(URL.createObjectURL(blob));
  await audio.play();
  return audio;
}
```

For low-latency streaming playback (start on first chunk) use `MediaSource` with
`audio/mpeg` — see `liveStreamPlay()` in `app.js` for the production pattern.

---

## 5. Voice — Speech-to-Text

`POST /api/voice/stt` — **form-data** with a `file` (16 kHz mono WAV works best).
Returns `{ text }`.

```js
async function transcribe(wavBlob, language) {
  const fd = new FormData();
  fd.append("file", new File([wavBlob], "recording.wav", { type: "audio/wav" }));
  if (language) fd.append("language", language);
  const res = await fetch(api("/api/voice/stt"), { method: "POST", headers: authHeaders(), body: fd });
  if (!res.ok) throw new Error(`stt ${res.status}`);
  return (await res.json()).text;
}
```

Record mic audio with the Web Audio API, downsample to 16 kHz, encode WAV — see
`startRecording()` / `encodeWav()` in `app.js`.

### Live voice loop
Wire the three calls into a loop: **`transcribe()` → `streamChat()` → `speak()` → repeat.**
For lowest latency, speak sentence-by-sentence as chat tokens arrive (see
`liveStreamReplyAndSpeak()` in `app.js`).

---

## 6. Chat history (saved server-side in Postgres)

These live at the gateway root (`/conversations`, **not** `/api/...`). All scoped
to the API-key user.

```js
// create (optionally seed with messages)
await fetch(api("/conversations"), {
  method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
  body: JSON.stringify({ title: "New Chat", mode: "chat",
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }),
}); // → 201 { conversation_id, title, mode, messages: [...] }

// list
await fetch(api("/conversations"), { headers: authHeaders() });            // [ {conversation_id,...} ]
// detail (with messages)
await fetch(api(`/conversations/${id}`), { headers: authHeaders() });
// append one message (e.g. after each turn / translation)
await fetch(api(`/conversations/${id}/messages`), {
  method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
  body: JSON.stringify({ role: "assistant", content: "مرحبا",
    source_lang: "en", target_lang: "ar", engine: "api" }),
});
// rename / delete
await fetch(api(`/conversations/${id}`), { method: "PATCH", headers: authHeaders({ "Content-Type":"application/json" }), body: JSON.stringify({ title: "Greetings", mode: "chat" }) });
await fetch(api(`/conversations/${id}`), { method: "DELETE", headers: authHeaders() });
```

**Pattern:** create a conversation on first message, then `POST .../messages` after
every user + assistant turn so history survives across devices (instead of only
`localStorage`).

---

## 7. Health & errors

- `GET /api/engine-health` → `{ llm, tts, stt }` each `{status:"ok"|...}` — poll for status dots.
- Error shape from the gateway: `{ "error": "...", "message": "...", "path": "..." }`.
- Status codes: **401** missing/invalid key · **404** conversation not found · **502** LLM service unreachable.

---

## Endpoint quick reference

| Feature | Method & path | Body | Returns |
|---|---|---|---|
| Chat | `POST /api/chat` | JSON `{messages,stream}` | SSE / `{choices}` |
| Translate | `POST /api/translate` | JSON `{text,target_lang,engine}` | `{translation,source_lang,target_lang}` |
| TTS | `POST /api/voice/tts` | form `text,language?,voice?,gender?` | `audio/mpeg` |
| STT | `POST /api/voice/stt` | form `file,language?` | `{text}` |
| Health | `GET /api/engine-health` | — | `{llm,tts,stt}` |
| OpenAI API | `POST /v1/chat/completions` | OpenAI JSON | OpenAI response |
| History | `… /conversations …` | see §6 | conversation/message JSON |

Every row requires the same `X-API-Key` — one gateway key unlocks all features.
