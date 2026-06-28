/* ══════════════════════════════════════════════════════════════════════════════
   AI Chatbot — Application Logic
   Chat engine, voice I/O, TTS, translation, conversation management
   ══════════════════════════════════════════════════════════════════════════════ */

// ── Configuration ─────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  apiUrl: '',  // empty = same origin (works on Vercel and local)
  temperature: 0.7,
  maxTokens: 2048,
};

let config = loadConfig();
let currentMode = 'chat'; // 'chat' | 'translate'
let conversations = loadConversations();
let activeConversationId = null;
let isGenerating = false;
let isRecording = false;
// Web Audio recording state (records raw PCM so we can encode a WAV the STT engine reads)
let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let recordedSamples = [];   // Float32 PCM chunks at audioContext.sampleRate
let recordSampleRate = 48000;

// ── Initialization ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyConfig();
  renderConversationList();

  // Load last active conversation or show welcome
  const lastId = localStorage.getItem('chatbot_activeConversation');
  if (lastId && conversations[lastId]) {
    switchConversation(lastId);
  }

  checkEngineHealth();
  setInterval(checkEngineHealth, 30000);
});

// ── API helper — all calls go through /api/ prefix ────────────────────────────
function apiUrl(path) {
  const base = config.apiUrl || '';
  return `${base}/api${path}`;
}

// ── Config Management ─────────────────────────────────────────────────────────
function loadConfig() {
  try {
    const saved = localStorage.getItem('chatbot_config');
    return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveSettings() {
  config.apiUrl = document.getElementById('settingApiUrl').value.replace(/\/$/, '') || '';
  config.temperature = parseFloat(document.getElementById('settingTemperature').value) || DEFAULT_CONFIG.temperature;
  config.maxTokens = parseInt(document.getElementById('settingMaxTokens').value) || DEFAULT_CONFIG.maxTokens;

  localStorage.setItem('chatbot_config', JSON.stringify(config));
  toggleSettings();
  checkEngineHealth();
}

function applyConfig() {
  document.getElementById('settingApiUrl').value = config.apiUrl;
  document.getElementById('settingTemperature').value = config.temperature;
  document.getElementById('settingMaxTokens').value = config.maxTokens;
}

// ── Conversation Management ───────────────────────────────────────────────────
function loadConversations() {
  try {
    const saved = localStorage.getItem('chatbot_conversations');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function saveConversations() {
  localStorage.setItem('chatbot_conversations', JSON.stringify(conversations));
}

function newConversation() {
  const id = 'conv_' + Date.now();
  conversations[id] = {
    id,
    title: 'New Chat',
    messages: [],
    mode: currentMode,
    createdAt: new Date().toISOString(),
  };
  saveConversations();
  switchConversation(id);
  renderConversationList();
}

function switchConversation(id) {
  activeConversationId = id;
  localStorage.setItem('chatbot_activeConversation', id);

  const conv = conversations[id];
  if (conv) {
    setMode(conv.mode || 'chat', false);
    renderMessages();
  }
  renderConversationList();
}

function deleteConversation(id, event) {
  event.stopPropagation();
  delete conversations[id];
  saveConversations();

  if (activeConversationId === id) {
    activeConversationId = null;
    const container = document.getElementById('messagesContainer');
    container.innerHTML = '';
    showWelcome();
  }
  renderConversationList();
}

function clearCurrentChat() {
  if (!activeConversationId || !conversations[activeConversationId]) return;
  conversations[activeConversationId].messages = [];
  conversations[activeConversationId].title = 'New Chat';
  saveConversations();
  renderMessages();
}

function renderConversationList() {
  const container = document.getElementById('conversationList');
  const noConv = document.getElementById('noConversations');
  const keys = Object.keys(conversations).sort((a, b) => {
    return new Date(conversations[b].createdAt) - new Date(conversations[a].createdAt);
  });

  // Remove existing items (keep section label and no-conversations)
  container.querySelectorAll('.conversation-item').forEach(el => el.remove());

  if (keys.length === 0) {
    noConv.style.display = 'block';
    return;
  }

  noConv.style.display = 'none';

  keys.forEach(id => {
    const conv = conversations[id];
    const item = document.createElement('div');
    item.className = 'conversation-item' + (id === activeConversationId ? ' active' : '');
    item.onclick = () => switchConversation(id);
    item.innerHTML = `
      <span class="conversation-item__icon">${conv.mode === 'translate' ? '🌐' : '💬'}</span>
      <span class="conversation-item__text">${escapeHtml(conv.title)}</span>
      <button class="conversation-item__delete" onclick="deleteConversation('${id}', event)" title="Delete">✕</button>
    `;
    container.appendChild(item);
  });
}

// ── Mode Management ───────────────────────────────────────────────────────────
function setMode(mode, updateConv = true) {
  currentMode = mode;

  const chatBtn = document.getElementById('modeChatBtn');
  const transBtn = document.getElementById('modeTranslateBtn');
  const headerIcon = document.getElementById('headerModeIcon');
  const headerText = document.getElementById('headerModeText');
  const headerHint = document.getElementById('headerModeHint');
  const input = document.getElementById('messageInput');

  chatBtn.classList.toggle('active', mode === 'chat');
  transBtn.classList.toggle('active', mode === 'translate');
  transBtn.classList.toggle('translate-active', mode === 'translate');

  const translateBar = document.getElementById('translateBar');
  if (mode === 'translate') {
    headerIcon.className = 'chat-header__mode-icon translate-mode';
    headerIcon.textContent = '🌐';
    headerText.textContent = 'Translation Mode';
    headerHint.textContent = 'Pick a target language';
    input.placeholder = 'Type text to translate…';
    if (translateBar) translateBar.classList.add('visible');
  } else {
    headerIcon.className = 'chat-header__mode-icon chat-mode';
    headerIcon.textContent = '💬';
    headerText.textContent = 'Chat Mode';
    headerHint.textContent = 'General AI conversation';
    input.placeholder = 'Type your message...';
    if (translateBar) translateBar.classList.remove('visible');
  }

  if (updateConv) {
    const conv = activeConversationId ? conversations[activeConversationId] : null;
    if (conv && conv.messages.length > 0 && (conv.mode || 'chat') !== mode) {
      // Keep chat and translation in separate threads: switching modes on a
      // conversation that already has messages of the other mode starts a fresh
      // conversation instead of mixing them.
      newConversation();
    } else if (conv) {
      // Empty conversation just adopts the new mode (no need to spawn a new one).
      conv.mode = mode;
      saveConversations();
      renderConversationList();
    }
    // No active conversation yet → one is created with this mode on first message.
  }
}

// ── Message Sending ───────────────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text || isGenerating) return;

  // Create conversation if needed
  if (!activeConversationId) {
    newConversation();
  }

  const conv = conversations[activeConversationId];

  // Update title from first message
  if (conv.messages.length === 0) {
    conv.title = text.substring(0, 50) + (text.length > 50 ? '…' : '');
    renderConversationList();
  }

  // Add user message — tag translate-mode turns so they don't pollute chat context
  const userMsg = { role: 'user', content: text };
  if (currentMode === 'translate') userMsg.meta = { type: 'translation' };
  conv.messages.push(userMsg);
  saveConversations();

  // Clear input
  input.value = '';
  autoResize(input);

  // Render
  hideWelcome();
  renderMessages();
  scrollToBottom();

  // Generate response
  if (currentMode === 'translate') {
    await generateTranslation(text);
  } else {
    await generateChatResponse();
  }
}

function sendSuggestion(text) {
  document.getElementById('messageInput').value = text;
  sendMessage();
}

// ── Chat Generation (Streaming) ───────────────────────────────────────────────
async function generateChatResponse() {
  if (!activeConversationId) return;
  const conv = conversations[activeConversationId];

  isGenerating = true;
  updateSendButton();
  showTypingIndicator();

  // Only send real chat turns to the LLM. Excluding translation turns (which are
  // often Arabic) and error notices prevents the model from continuing in the
  // wrong language or echoing error text.
  const messages = conv.messages
    .filter(m => m.meta?.type !== 'translation')
    .filter(m => !(m.role === 'assistant' && m.content.startsWith('⚠️')))
    .map(m => ({ role: m.role, content: m.content }));

  try {
    const response = await fetch(apiUrl('/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    // Remove typing indicator and add empty assistant message
    removeTypingIndicator();
    conv.messages.push({ role: 'assistant', content: '' });
    renderMessages();

    const msgIndex = conv.messages.length - 1;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const data = JSON.parse(dataStr);
          if (data.error) {
            conv.messages[msgIndex].content += `\n\n⚠️ Error: ${data.error}`;
            break;
          }
          if (data.content) {
            conv.messages[msgIndex].content += data.content;
            updateLastMessage(conv.messages[msgIndex].content);
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    saveConversations();
    renderMessages();
    scrollToBottom();

  } catch (err) {
    removeTypingIndicator();
    conv.messages.push({
      role: 'assistant',
      content: `⚠️ **Error:** ${err.message}\n\nMake sure the LLM service is running and accessible.`,
    });
    saveConversations();
    renderMessages();
    scrollToBottom();
  } finally {
    isGenerating = false;
    updateSendButton();
  }
}

// ── Translation ───────────────────────────────────────────────────────────────
async function generateTranslation(text) {
  if (!activeConversationId) return;
  const conv = conversations[activeConversationId];

  isGenerating = true;
  updateSendButton();
  showTypingIndicator();

  const targetSel = document.getElementById('translateTarget');
  const targetLang = targetSel ? targetSel.value : undefined;

  try {
    const response = await fetch(apiUrl('/translate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, target_lang: targetLang }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();

    removeTypingIndicator();
    conv.messages.push({
      role: 'assistant',
      content: data.translation,
      meta: {
        type: 'translation',
        sourceLang: data.source_lang,
        targetLang: data.target_lang,
      },
    });
    saveConversations();
    renderMessages();
    scrollToBottom();

  } catch (err) {
    removeTypingIndicator();
    conv.messages.push({
      role: 'assistant',
      content: `⚠️ **Translation Error:** ${err.message}`,
    });
    saveConversations();
    renderMessages();
    scrollToBottom();
  } finally {
    isGenerating = false;
    updateSendButton();
  }
}

// ── Message Rendering ─────────────────────────────────────────────────────────
function renderMessages() {
  const container = document.getElementById('messagesContainer');
  container.innerHTML = '';

  if (!activeConversationId || !conversations[activeConversationId]) {
    showWelcome();
    return;
  }

  const conv = conversations[activeConversationId];

  if (conv.messages.length === 0) {
    showWelcome();
    return;
  }

  hideWelcome();

  conv.messages.forEach((msg, idx) => {
    const el = createMessageElement(msg, idx);
    container.appendChild(el);
  });

  scrollToBottom();
}

function createMessageElement(msg, index) {
  const isUser = msg.role === 'user';
  const isArabic = detectArabic(msg.content);

  const wrapper = document.createElement('div');
  wrapper.className = `message message--${msg.role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message__avatar';
  avatar.textContent = isUser ? '👤' : '🤖';

  const content = document.createElement('div');
  content.className = 'message__content';

  const bubble = document.createElement('div');
  bubble.className = 'message__bubble';
  if (isArabic) {
    bubble.setAttribute('dir', 'rtl');
  }
  bubble.innerHTML = renderMarkdown(msg.content);

  content.appendChild(bubble);

  // Translation meta
  if (msg.meta && msg.meta.type === 'translation' && msg.meta.sourceLang && msg.meta.targetLang) {
    const meta = document.createElement('div');
    meta.className = 'message__translation-meta';
    meta.innerHTML = `
      <span class="lang-badge">${msg.meta.sourceLang.toUpperCase()}</span>
      <span>→</span>
      <span class="lang-badge">${msg.meta.targetLang.toUpperCase()}</span>
    `;
    content.appendChild(meta);
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'message__actions';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn';
  copyBtn.title = 'Copy';
  copyBtn.textContent = '📋';
  copyBtn.onclick = () => copyMessage(msg.content, copyBtn);
  actions.appendChild(copyBtn);

  // Speak button (TTS)
  const speakBtn = document.createElement('button');
  speakBtn.className = 'msg-action-btn btn-speak';
  speakBtn.title = 'Speak';
  speakBtn.textContent = '🔊';
  speakBtn.onclick = () => speakMessage(msg.content, speakBtn);
  actions.appendChild(speakBtn);

  content.appendChild(actions);

  wrapper.appendChild(avatar);
  wrapper.appendChild(content);

  return wrapper;
}

function updateLastMessage(content) {
  const messages = document.querySelectorAll('.message--assistant');
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg) return;

  const bubble = lastMsg.querySelector('.message__bubble');
  if (bubble) {
    const isArabic = detectArabic(content);
    if (isArabic) {
      bubble.setAttribute('dir', 'rtl');
    }
    bubble.innerHTML = renderMarkdown(content);
  }
  scrollToBottom();
}

// ── Typing Indicator ──────────────────────────────────────────────────────────
function showTypingIndicator() {
  removeTypingIndicator();
  const container = document.getElementById('messagesContainer');
  const typing = document.createElement('div');
  typing.className = 'typing-indicator';
  typing.id = 'typingIndicator';
  typing.innerHTML = `
    <div class="message__avatar">🤖</div>
    <div class="typing-dots">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>
  `;
  container.appendChild(typing);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

// ── Welcome Screen ────────────────────────────────────────────────────────────
function showWelcome() {
  let welcome = document.getElementById('welcomeScreen');
  if (!welcome) {
    const container = document.getElementById('messagesContainer');
    container.innerHTML = `
      <div class="welcome" id="welcomeScreen">
        <div class="welcome__icon">🤖</div>
        <h2>Hello! I'm your AI Assistant</h2>
        <p>Powered by DexaiTech with Arabic ↔ English translation. Ask me anything or switch to translation mode.</p>
        <div class="welcome__suggestions">
          <div class="suggestion-chip" onclick="sendSuggestion('Tell me about the history of Arabic calligraphy')">📜 Arabic calligraphy history</div>
          <div class="suggestion-chip" onclick="sendSuggestion('Translate: Good morning, how are you?')">🌐 Translate a greeting</div>
          <div class="suggestion-chip" onclick="sendSuggestion('Write a Python function to reverse a string')">💻 Write Python code</div>
          <div class="suggestion-chip" onclick="sendSuggestion('What are the wonders of the ancient world?')">🏛️ Ancient wonders</div>
        </div>
      </div>
    `;
  }
}

function hideWelcome() {
  const welcome = document.getElementById('welcomeScreen');
  if (welcome) welcome.remove();
}

// ── Voice Input (STT) ─────────────────────────────────────────────────────────
async function toggleMic() {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtx();
    // Some browsers start the context suspended until a user gesture.
    if (audioContext.state === 'suspended') await audioContext.resume();

    recordSampleRate = audioContext.sampleRate;
    recordedSamples = [];

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);

    processorNode.onaudioprocess = (e) => {
      if (!isRecording) return;
      // Copy — the underlying buffer is reused by the audio thread.
      recordedSamples.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    isRecording = true;
    updateMicButton();
  } catch (err) {
    alert('Microphone access denied.\n' + err.message);
  }
}

async function stopRecording() {
  isRecording = false;
  updateMicButton();

  // Tear down the audio graph.
  if (processorNode) { processorNode.disconnect(); processorNode.onaudioprocess = null; }
  if (sourceNode) sourceNode.disconnect();
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  if (audioContext) { try { await audioContext.close(); } catch {} }

  const samples = flattenSamples(recordedSamples);
  recordedSamples = [];
  processorNode = sourceNode = mediaStream = audioContext = null;

  if (samples.length === 0) {
    alert('No audio captured — please hold the mic and speak, then stop.');
    return;
  }

  // Downsample to 16 kHz mono and encode a 16-bit PCM WAV (what the STT engine expects).
  const wavBlob = encodeWav(downsample(samples, recordSampleRate, 16000), 16000);
  await transcribeAudio(wavBlob);
}

// ── PCM → WAV helpers ─────────────────────────────────────────────────────────
function flattenSamples(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function downsample(samples, inRate, outRate) {
  if (outRate >= inRate) return samples;
  const ratio = inRate / outRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    // Average the source window to avoid aliasing.
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0, count = 0;
    for (let j = start; j < end; j++) { sum += samples[j]; count++; }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  const dataSize = samples.length * 2;

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // audio format = PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * blockAlign)
  view.setUint16(32, 2, true);           // block align (channels * bytesPerSample)
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

function updateMicButton() {
  const btn = document.getElementById('btnMic');
  if (isRecording) {
    btn.classList.add('recording');
    btn.textContent = '⏹';
    btn.title = 'Stop recording';
  } else {
    btn.classList.remove('recording');
    btn.textContent = '🎙️';
    btn.title = 'Voice input';
  }
}

async function transcribeAudio(blob) {
  const formData = new FormData();
  formData.append('file', new File([blob], 'recording.wav', { type: 'audio/wav' }));

  try {
    const resp = await fetch(apiUrl('/voice/stt'), {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const text = data.text || data.detail || data.transcript || data.transcription || '';

    if (text) {
      document.getElementById('messageInput').value = text;
      autoResize(document.getElementById('messageInput'));
      // Auto-send the transcribed text
      sendMessage();
    }
  } catch (err) {
    console.error('STT error:', err);
    alert('Speech-to-text failed: ' + err.message);
  }
}

// ── Health Check ──────────────────────────────────────────────────────────────
async function checkEngineHealth() {
  try {
    const resp = await fetch(apiUrl('/engine-health'));
    const data = await resp.json();

    updateStatusDot('statusLlm', data.llm?.status);
    updateStatusDot('statusStt', data.stt?.status);
  } catch {
    updateStatusDot('statusLlm', 'error');
    updateStatusDot('statusStt', 'error');
  }
}

function updateStatusDot(id, status) {
  const dot = document.getElementById(id);
  if (!dot) return;
  dot.className = 'status-dot__indicator ' + (status === 'ok' ? 'ok' : 'error');
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function handleInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
}

function scrollToBottom() {
  const container = document.getElementById('messagesContainer');
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function updateSendButton() {
  const btn = document.getElementById('btnSend');
  btn.disabled = isGenerating;
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('visible');
}

function toggleSettings() {
  const overlay = document.getElementById('settingsOverlay');
  overlay.classList.toggle('visible');
  if (overlay.classList.contains('visible')) {
    applyConfig();
  }
}

function closeSettingsOnOverlay(event) {
  if (event.target === event.currentTarget) {
    toggleSettings();
  }
}

async function copyMessage(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    btn.textContent = '✓';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = '📋';
    }, 2000);
  } catch {
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

// ── Arabic Detection ──────────────────────────────────────────────────────────
function detectArabic(text) {
  const arabicRe = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const matches = (text.match(new RegExp(arabicRe.source, 'g')) || []).length;
  const alphaCount = (text.match(/[a-zA-Z\u0600-\u06FF]/g) || []).length;
  return alphaCount > 0 && matches / alphaCount > 0.5;
}

// ── Simple Markdown Renderer ──────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Line breaks (preserve double newlines as paragraphs)
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br/>');

  // Wrap in paragraph if not already structured
  if (!html.startsWith('<h') && !html.startsWith('<pre') && !html.startsWith('<ul') && !html.startsWith('<ol')) {
    html = `<p>${html}</p>`;
  }

  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Text-to-Speech (TTS) via Server Edge TTS — Streaming Playback ─────────────
let activeSpeakBtn = null;
let currentAudio = null;
let currentMediaSource = null;

/**
 * Speak a message using the server's Edge Neural TTS with streaming playback.
 * Audio starts playing as soon as the first chunk arrives (~200ms).
 */
async function speakMessage(text, btn) {
  // Stop any current playback
  stopCurrentPlayback();

  // If same button clicked, just toggle off
  if (activeSpeakBtn === btn) {
    activeSpeakBtn = null;
    return;
  }

  // Strip markdown and divider lines for cleaner speech
  const cleanText = text
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>*-]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[=\-_*~#]{2,}/g, '')  // Strip repeated formatting characters like ===, ---, ***, etc.
    .replace(/\s+/g, ' ')            // Collapse consecutive spaces/newlines into a single space
    .trim();

  if (!cleanText) return;

  // Show speaking state
  activeSpeakBtn = btn;
  btn.classList.add('speaking');
  btn.textContent = '⏹';
  btn.title = 'Stop speaking';

  try {
    const formData = new FormData();
    formData.append('text', cleanText);

    const resp = await fetch(apiUrl('/voice/tts'), {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) throw new Error(`TTS server error: ${resp.status}`);

    // Try streaming playback (Chrome, Edge, Safari support MP3 in MediaSource)
    const canStream = window.MediaSource
      && typeof MediaSource.isTypeSupported === 'function'
      && MediaSource.isTypeSupported('audio/mpeg');

    if (canStream && resp.body) {
      await streamingPlayback(resp.body);
    } else {
      // Fallback: wait for full blob (Firefox, older browsers)
      const blob = await resp.blob();
      playAudioBlob(blob);
    }
  } catch (err) {
    console.warn('Server TTS failed, falling back to browser:', err.message);
    fallbackBrowserTTS(cleanText);
  }
}

/**
 * Stream audio via MediaSource — starts playing within ~200ms.
 */
async function streamingPlayback(readableStream) {
  return new Promise((resolve, reject) => {
    const mediaSource = new MediaSource();
    currentMediaSource = mediaSource;

    const audio = new Audio();
    audio.src = URL.createObjectURL(mediaSource);
    currentAudio = audio;

    // Clean up when audio finishes
    audio.onended = () => {
      cleanupPlayback();
      resolve();
    };
    audio.onerror = () => {
      cleanupPlayback();
      reject(new Error('Audio playback error'));
    };

    mediaSource.addEventListener('sourceopen', async () => {
      let sourceBuffer;
      try {
        sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
      } catch (e) {
        // Fallback if addSourceBuffer fails
        cleanupPlayback();
        reject(e);
        return;
      }

      const reader = readableStream.getReader();
      let hasStartedPlaying = false;
      let pendingChunks = [];
      let streamDone = false;

      // Append next chunk from queue
      function appendNext() {
        if (sourceBuffer.updating || pendingChunks.length === 0) {
          // If stream is done and no more chunks, end the stream
          if (streamDone && pendingChunks.length === 0 && !sourceBuffer.updating) {
            try {
              if (mediaSource.readyState === 'open') {
                mediaSource.endOfStream();
              }
            } catch {}
          }
          return;
        }
        const chunk = pendingChunks.shift();
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch {
          // Buffer full or other error — just skip
        }
      }

      sourceBuffer.addEventListener('updateend', () => {
        // Start playing as soon as the first chunk is appended
        if (!hasStartedPlaying && audio.paused) {
          audio.play().catch(() => {});
          hasStartedPlaying = true;
        }
        appendNext();
      });

      // Read chunks from the stream and queue them
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            streamDone = true;
            // If sourceBuffer isn't busy, end the stream now
            if (!sourceBuffer.updating && pendingChunks.length === 0) {
              try {
                if (mediaSource.readyState === 'open') {
                  mediaSource.endOfStream();
                }
              } catch {}
            }
            break;
          }
          pendingChunks.push(value);
          appendNext();
        }
      } catch {
        streamDone = true;
      }
    });
  });
}

/**
 * Play audio from a complete blob (fallback for browsers without MediaSource MP3).
 */
function playAudioBlob(blob) {
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  currentAudio = audio;

  audio.onended = () => {
    URL.revokeObjectURL(audioUrl);
    cleanupPlayback();
  };
  audio.onerror = () => {
    URL.revokeObjectURL(audioUrl);
    cleanupPlayback();
  };
  audio.play().catch(() => cleanupPlayback());
}

/**
 * Fallback: browser SpeechSynthesis if server TTS is unreachable.
 */
function fallbackBrowserTTS(text) {
  const synth = window.speechSynthesis;
  if (!synth) {
    cleanupPlayback();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const isArabic = detectArabic(text);
  utterance.lang = isArabic ? 'ar' : 'en-US';
  utterance.rate = 0.95;

  const voices = synth.getVoices();
  const langPrefix = isArabic ? 'ar' : 'en';
  const voice = voices.find(v => v.lang.startsWith(langPrefix));
  if (voice) utterance.voice = voice;

  utterance.onend = () => cleanupPlayback();
  utterance.onerror = () => cleanupPlayback();
  synth.speak(utterance);
}

/**
 * Stop any currently playing audio.
 */
function stopCurrentPlayback() {
  // Stop HTML5 audio
  if (currentAudio) {
    currentAudio.pause();
    if (currentAudio.src) {
      URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio = null;
  }
  // Close MediaSource
  if (currentMediaSource && currentMediaSource.readyState === 'open') {
    try { currentMediaSource.endOfStream(); } catch {}
  }
  currentMediaSource = null;

  // Stop browser TTS
  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
  }
  resetSpeakButton();
}

/**
 * Reset speak button visuals and clear tracking state.
 */
function cleanupPlayback() {
  currentAudio = null;
  currentMediaSource = null;
  resetSpeakButton();
  activeSpeakBtn = null;
}

function resetSpeakButton() {
  if (activeSpeakBtn) {
    activeSpeakBtn.classList.remove('speaking');
    activeSpeakBtn.textContent = '🔊';
    activeSpeakBtn.title = 'Speak';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Live Voice Agent — hands-free conversation
//  Listen (browser SpeechRecognition) → think (/api/chat) → speak (Edge/Bing TTS
//  with browser-speech fallback) → listen again. Built to degrade gracefully so
//  it never gets stuck silent.
// ══════════════════════════════════════════════════════════════════════════════
const LIVE = {
  active: false,
  state: 'idle',        // idle | listening | thinking | speaking
  recog: null,
  audio: null,
  audioResolve: null,   // resolves the in-flight speak promise when interrupted
  lang: 'en-US',
  fatal: false,         // mic permanently blocked
  paused: false,        // user paused via orb tap
  gen: 0,               // turn generation — stale async flows bail when it changes
  silenceTimer: null,   // end-of-speech (silence) detection timer
  barge: null,          // recognition that listens for interruptions while speaking
};

// SpeechRecognition locale → Edge TTS language code (backend auto-detects too).
const LIVE_TTS_LANG = {
  'en-US': 'en', 'ar-SA': 'ar', 'hi-IN': 'hi', 'fr-FR': 'fr', 'es-ES': 'es',
};

function liveSupported() {
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
}

function openLiveVoice() {
  const overlay = document.getElementById('liveOverlay');
  overlay.classList.add('open');
  LIVE.active = true;
  LIVE.fatal = false;
  LIVE.paused = false;

  // Warm up the synthesis voice list for the fallback path.
  if (window.speechSynthesis) window.speechSynthesis.getVoices();

  if (!liveSupported()) {
    liveSetState('idle');
    liveSetStatus('Live voice needs Chrome, Edge, or Safari (Web Speech API).');
    return;
  }
  // Start each live session in a fresh conversation so it begins from the beginning
  // (reuse the current one only if it's still empty).
  const conv = activeConversationId ? conversations[activeConversationId] : null;
  if (!conv || conv.messages.length > 0) newConversation();
  liveSetState('idle');
  liveSetStatus('Starting…');
  liveSetTranscript('');
  liveStartListening();
}

function closeLiveVoice() {
  LIVE.active = false;
  LIVE.gen++;                      // supersede any in-flight turn
  liveStopBargeMonitor();
  liveStopRecognition();
  liveStopAudio();
  liveSetState('idle');
  liveSetTranscript('');           // clear so the next session starts fresh
  document.getElementById('liveOverlay').classList.remove('open');
}

function liveSetLang(value) {
  LIVE.lang = value;
  if (LIVE.recog) LIVE.recog.lang = value;
}

// Orb tap = context-aware control: interrupt speech, pause listening, or resume.
function liveOrbTap() {
  if (!LIVE.active) return;
  if (LIVE.state === 'speaking') {
    liveStopAudio();                 // barge-in
    liveStartListening();
  } else if (LIVE.state === 'listening') {
    LIVE.paused = true;
    liveStopRecognition();
    liveSetState('idle');
    liveSetStatus('Paused — tap the orb to talk');
  } else {
    LIVE.paused = false;
    liveStartListening();
  }
}

function liveSetState(s) {
  LIVE.state = s;
  const orb = document.getElementById('liveOrb');
  if (orb) orb.className = 'live-orb live-orb--' + s;
  const core = document.getElementById('liveOrbCore');
  if (core) {
    core.textContent =
      s === 'listening' ? '🎙️' : s === 'thinking' ? '💭' : s === 'speaking' ? '🔊' : '🎤';
  }
}

function liveSetStatus(text) {
  const el = document.getElementById('liveStatus');
  if (el) el.textContent = text;
}

function liveSetTranscript(text) {
  const el = document.getElementById('liveTranscript');
  if (el) el.textContent = text || '';
}

function liveStartListening() {
  if (!LIVE.active || LIVE.fatal || !liveSupported()) return;
  LIVE.gen++;                      // new turn supersedes any in-flight async flow
  LIVE.paused = false;
  liveStopBargeMonitor();
  liveStopAudio();
  liveStopRecognition();

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recog = new Recognition();
  LIVE.recog = recog;
  recog.lang = LIVE.lang;
  recog.interimResults = true;
  recog.continuous = true;         // stay on across pauses; we end on real silence
  recog.maxAlternatives = 1;

  let finalText = '';
  let speaking = false;

  // End-of-speech detection driven by the browser's voice-activity events: only
  // start the silence countdown once the mic reports speech has actually stopped,
  // so a pause mid-sentence (or sparse interim results) never cuts the user off.
  const SILENCE_MS = 700;
  const cancelStop = () => {
    if (LIVE.silenceTimer) { clearTimeout(LIVE.silenceTimer); LIVE.silenceTimer = null; }
  };
  const scheduleStop = () => {
    cancelStop();
    LIVE.silenceTimer = setTimeout(() => {
      try { recog.stop(); } catch {}   // graceful stop → onend processes the text
    }, SILENCE_MS);
  };

  recog.onstart = () => {
    liveSetState('listening');
    liveSetStatus('Listening… speak now');
    liveSetTranscript('');
  };

  // While the mic detects speech, never schedule a stop.
  recog.onaudiostart = cancelStop;
  recog.onsoundstart = cancelStop;
  recog.onspeechstart = () => { speaking = true; cancelStop(); };
  recog.onspeechend = () => { speaking = false; scheduleStop(); };

  recog.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    liveSetTranscript((finalText + ' ' + interim).trim());
    // Only count silence when the mic isn't actively hearing speech. This also
    // serves as a fallback for browsers that don't fire onspeechend.
    if (!speaking) scheduleStop();
  };

  recog.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      LIVE.fatal = true;
      liveSetState('idle');
      liveSetStatus('Microphone blocked. Allow mic access, then reopen Live.');
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      liveSetStatus('Mic error: ' + e.error);
    }
    // 'no-speech' / 'aborted' fall through to onend, which decides what to do.
  };

  recog.onend = () => {
    if (LIVE.silenceTimer) { clearTimeout(LIVE.silenceTimer); LIVE.silenceTimer = null; }
    if (LIVE.recog !== recog) return;       // a newer session took over
    LIVE.recog = null;
    if (!LIVE.active || LIVE.fatal || LIVE.paused) return;
    const text = finalText.trim();
    if (text) {
      liveHandleUtterance(text);
    } else {
      // Nothing captured (browser auto-ended) — keep listening seamlessly.
      setTimeout(() => {
        if (LIVE.active && !LIVE.paused && LIVE.state !== 'thinking' && LIVE.state !== 'speaking') {
          liveStartListening();
        }
      }, 200);
    }
  };

  try {
    recog.start();
  } catch {
    // start() throws if called too soon after a previous session; retry shortly.
    setTimeout(() => { if (LIVE.active && !LIVE.paused) liveStartListening(); }, 300);
  }
}

function liveStopRecognition() {
  if (LIVE.silenceTimer) { clearTimeout(LIVE.silenceTimer); LIVE.silenceTimer = null; }
  const r = LIVE.recog;
  LIVE.recog = null;
  if (r) {
    r.onstart = r.onresult = r.onerror = r.onend = null;
    r.onaudiostart = r.onsoundstart = r.onspeechstart = r.onspeechend = null;
    try { r.abort(); } catch {}
  }
}

async function liveHandleUtterance(text) {
  const myGen = LIVE.gen;          // this turn; bail if superseded mid-flight
  liveStopRecognition();
  liveSetState('thinking');
  liveSetStatus('Thinking…');
  liveSetTranscript(text);

  if (!activeConversationId) newConversation();
  const conv = conversations[activeConversationId];
  if (conv.messages.length === 0) {
    conv.title = text.slice(0, 50) + (text.length > 50 ? '…' : '');
    renderConversationList();
  }
  conv.messages.push({ role: 'user', content: text });
  saveConversations();
  renderMessages();

  let reply = '';
  try {
    reply = await liveGetReply(conv);
  } catch (err) {
    liveSetStatus('Connection error: ' + err.message);
  }
  if (myGen !== LIVE.gen) return;  // interrupted/closed while thinking

  if (reply) {
    conv.messages.push({ role: 'assistant', content: reply });
    saveConversations();
    renderMessages();
    liveSetTranscript(reply);
    await liveSpeak(reply);
    if (myGen !== LIVE.gen) return; // interrupted/closed while speaking
  }

  if (LIVE.active && !LIVE.paused) liveStartListening();
}

async function liveGetReply(conv) {
  const messages = conv.messages
    .filter(m => m.meta?.type !== 'translation')
    .filter(m => !(m.role === 'assistant' && m.content.startsWith('⚠️')))
    .map(m => ({ role: m.role, content: m.content }));

  const resp = await fetch(apiUrl('/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: false,
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new Error(err.detail || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function liveSpeak(text) {
  liveSetState('speaking');
  liveSetStatus('Speaking… (just start talking to interrupt)');

  const clean = liveCleanForSpeech(text);
  if (!clean) return;
  const langCode = LIVE_TTS_LANG[LIVE.lang] || 'en';

  liveStartBargeMonitor(clean);    // let the user cut in by speaking
  // Primary: Edge/Bing neural TTS from the backend. Fallback: browser speech.
  try {
    const fd = new FormData();
    fd.append('text', clean);
    fd.append('language', langCode);
    const resp = await fetch(apiUrl('/voice/tts'), { method: 'POST', body: fd });
    if (!resp.ok) throw new Error(`TTS ${resp.status}`);
    const blob = await resp.blob();
    if (blob.size === 0) throw new Error('empty audio');
    await livePlayBlob(blob);
  } catch (err) {
    console.warn('Live TTS fell back to browser speech:', err.message);
    await liveBrowserSpeak(clean, langCode);
  } finally {
    liveStopBargeMonitor();
  }
}

// While the agent is speaking, run a lightweight recognizer that interrupts
// playback the moment the user starts talking, then the normal flow resumes
// listening. (Needs a couple of transcribed characters so a stray noise doesn't
// trigger it; works best with headphones so the agent's own voice isn't heard.)
function liveStartBargeMonitor(spokenText) {
  if (!liveSupported()) return;
  liveStopBargeMonitor();
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let mon;
  try { mon = new Recognition(); } catch { return; }
  LIVE.barge = mon;
  mon.lang = LIVE.lang;
  mon.interimResults = true;
  mon.continuous = true;
  const spoken = (spokenText || '').toLowerCase();
  mon.onresult = (e) => {
    let txt = '';
    for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
    const heard = txt.trim().toLowerCase();
    if (heard.length < 2) return;
    // Echo guard: if what we heard is part of what the agent is saying, it's the
    // agent's own voice looping back — ignore it. Interrupt only on new words.
    if (spoken.includes(heard)) return;
    liveStopBargeMonitor();
    liveStopAudio();               // interrupt → resolves the speak await → resumes listening
  };
  mon.onerror = () => {};
  mon.onend = () => { if (LIVE.barge === mon) LIVE.barge = null; };
  try { mon.start(); } catch {}
}

function liveStopBargeMonitor() {
  const m = LIVE.barge;
  LIVE.barge = null;
  if (m) {
    m.onresult = m.onerror = m.onend = null;
    try { m.abort(); } catch {}
  }
}

function livePlayBlob(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    LIVE.audio = audio;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (LIVE.audio === audio) LIVE.audio = null;
      if (LIVE.audioResolve === done) LIVE.audioResolve = null;
      resolve();
    };
    LIVE.audioResolve = done;        // lets liveStopAudio() unblock a barge-in
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

function liveBrowserSpeak(text, langCode) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) { resolve(); return; }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (LIVE.audioResolve === done) LIVE.audioResolve = null;
      resolve();
    };
    LIVE.audioResolve = done;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LIVE.lang || 'en-US';
    u.rate = 1.0;
    const voice = synth.getVoices().find(v => v.lang && v.lang.toLowerCase().startsWith(langCode));
    if (voice) u.voice = voice;
    u.onend = done;
    u.onerror = done;
    // Some browsers need a fresh cancel before speaking.
    try { synth.cancel(); } catch {}
    synth.speak(u);
  });
}

function liveStopAudio() {
  if (LIVE.audio) {
    try { LIVE.audio.pause(); } catch {}
    LIVE.audio = null;
  }
  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
  // pause()/cancel() don't fire ended/onend, so resolve the pending speak promise.
  if (LIVE.audioResolve) {
    const r = LIVE.audioResolve;
    LIVE.audioResolve = null;
    r();
  }
}

// Strip markdown/code/urls so the TTS engine doesn't "pronounce" syntax.
function liveCleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[#*_~>`|]/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}



// ══════════════════════════════════════════════════════════════════════════════
//  Conversation Interpreter — two-language, two-person live translation
//  Speaker A talks in language A → transcribe → translate to language B →
//  speak aloud in B. Then Speaker B talks in B → translate to A → speak in A.
//  Turns alternate automatically; tap a speaker button to override whose turn.
// ══════════════════════════════════════════════════════════════════════════════

// code → display label + BCP-47 locale for SpeechRecognition.
// (Languages without reliable browser STT can still be a translation *target*.)
const INTERP_LANGS = [
  { code: 'en', label: 'English', locale: 'en-US' },
  { code: 'hi', label: 'Hindi — हिन्दी', locale: 'hi-IN' },
  { code: 'bn', label: 'Bengali — বাংলা', locale: 'bn-IN' },
  { code: 'ta', label: 'Tamil — தமிழ்', locale: 'ta-IN' },
  { code: 'te', label: 'Telugu — తెలుగు', locale: 'te-IN' },
  { code: 'mr', label: 'Marathi — मराठी', locale: 'mr-IN' },
  { code: 'gu', label: 'Gujarati — ગુજરાતી', locale: 'gu-IN' },
  { code: 'kn', label: 'Kannada — ಕನ್ನಡ', locale: 'kn-IN' },
  { code: 'ml', label: 'Malayalam — മലയാളം', locale: 'ml-IN' },
  { code: 'pa', label: 'Punjabi — ਪੰਜਾਬੀ', locale: 'pa-IN' },
  { code: 'ur', label: 'Urdu — اردو', locale: 'ur-PK' },
  { code: 'ne', label: 'Nepali — नेपाली', locale: 'ne-NP' },
  { code: 'si', label: 'Sinhala — සිංහල', locale: 'si-LK' },
  { code: 'ar', label: 'Arabic — العربية', locale: 'ar-SA' },
  { code: 'fa', label: 'Persian — فارسی', locale: 'fa-IR' },
  { code: 'es', label: 'Spanish — Español', locale: 'es-ES' },
  { code: 'fr', label: 'French — Français', locale: 'fr-FR' },
  { code: 'de', label: 'German — Deutsch', locale: 'de-DE' },
  { code: 'it', label: 'Italian — Italiano', locale: 'it-IT' },
  { code: 'pt', label: 'Portuguese — Português', locale: 'pt-BR' },
  { code: 'ru', label: 'Russian — Русский', locale: 'ru-RU' },
  { code: 'tr', label: 'Turkish — Türkçe', locale: 'tr-TR' },
  { code: 'zh', label: 'Chinese — 中文', locale: 'zh-CN' },
  { code: 'ja', label: 'Japanese — 日本語', locale: 'ja-JP' },
  { code: 'ko', label: 'Korean — 한국어', locale: 'ko-KR' },
  { code: 'id', label: 'Indonesian', locale: 'id-ID' },
  { code: 'vi', label: 'Vietnamese — Tiếng Việt', locale: 'vi-VN' },
  { code: 'th', label: 'Thai — ไทย', locale: 'th-TH' },
  { code: 'pl', label: 'Polish — Polski', locale: 'pl-PL' },
  { code: 'nl', label: 'Dutch — Nederlands', locale: 'nl-NL' },
  { code: 'uk', label: 'Ukrainian — Українська', locale: 'uk-UA' },
];

const INTERP = {
  active: false,
  state: 'idle',     // idle | listening | translating | speaking
  recog: null,
  audio: null,
  audioResolve: null,
  current: 'A',      // whose turn it is to speak
  langA: 'en',
  langB: 'hi',
  paused: false,
  fatal: false,
  gen: 0,            // turn generation — stale async flows bail when it changes
  silenceTimer: null, // end-of-speech (silence) detection timer
};

function interpLang(code) {
  return INTERP_LANGS.find(l => l.code === code) || INTERP_LANGS[0];
}

function openInterpreter() {
  const overlay = document.getElementById('interpOverlay');

  // Populate both selects once.
  const a = document.getElementById('interpLangA');
  const b = document.getElementById('interpLangB');
  if (!a.options.length) {
    const opts = INTERP_LANGS.map(l => `<option value="${l.code}">${l.label}</option>`).join('');
    a.innerHTML = opts;
    b.innerHTML = opts;
    a.value = 'en';
    b.value = 'hi';
  }
  interpSyncLangs();

  if (window.speechSynthesis) window.speechSynthesis.getVoices();

  INTERP.active = true;
  INTERP.paused = false;
  INTERP.fatal = false;
  INTERP.current = 'A';             // fresh session always starts with Speaker A
  const log = document.getElementById('interpLog');
  if (log) log.innerHTML = '';      // clear any previous conversation
  overlay.classList.add('open');
  interpSetState('idle');

  if (!liveSupported()) {
    interpSetStatus('Live speech needs Chrome, Edge, or Safari (Web Speech API).');
  } else {
    interpSetStatus('Tap “Speaker A” or “Speaker B” to begin');
  }
  interpUpdateButtons();
}

function closeInterpreter() {
  INTERP.active = false;
  INTERP.gen++;                     // supersede any in-flight turn
  interpStopRecognition();
  interpStopAudio();
  interpSetState('idle');
  INTERP.current = 'A';
  const log = document.getElementById('interpLog');
  if (log) log.innerHTML = '';      // end = wipe the conversation so next start is fresh
  document.getElementById('interpOverlay').classList.remove('open');
}

function interpSyncLangs() {
  INTERP.langA = document.getElementById('interpLangA').value;
  INTERP.langB = document.getElementById('interpLangB').value;
  interpUpdateButtons();
}

function interpSwap() {
  const a = document.getElementById('interpLangA');
  const b = document.getElementById('interpLangB');
  const tmp = a.value; a.value = b.value; b.value = tmp;
  interpSyncLangs();
}

function interpUpdateButtons() {
  const btnA = document.getElementById('interpBtnA');
  const btnB = document.getElementById('interpBtnB');
  if (btnA) btnA.textContent = '🎙️ ' + interpLang(INTERP.langA).label.split(' —')[0];
  if (btnB) btnB.textContent = '🎙️ ' + interpLang(INTERP.langB).label.split(' —')[0];
}

// Manually start a given speaker's turn.
function interpSpeak(which) {
  if (!INTERP.active || INTERP.fatal) return;
  INTERP.current = which;
  INTERP.paused = false;
  interpStartListening();
}

function interpOrbTap() {
  if (!INTERP.active) return;
  if (INTERP.state === 'speaking') {
    interpStopAudio();
    interpStartListening();
  } else if (INTERP.state === 'listening') {
    INTERP.paused = true;
    interpStopRecognition();
    interpSetState('idle');
    interpSetStatus('Paused — tap a speaker to continue');
  } else {
    interpStartListening();
  }
}

function interpSetState(s) {
  INTERP.state = s;
  const orb = document.getElementById('interpOrb');
  if (orb) orb.className = 'live-orb live-orb--' + (s === 'translating' ? 'thinking' : s);
  const core = document.getElementById('interpOrbCore');
  if (core) {
    core.textContent =
      s === 'listening' ? '🎙️' : s === 'translating' ? '🔁' : s === 'speaking' ? '🔊' : '🎤';
  }
}

function interpSetStatus(text) {
  const el = document.getElementById('interpStatus');
  if (el) el.textContent = text;
}

function interpLog(speakerCode, original, targetCode, translation) {
  const el = document.getElementById('interpLog');
  if (!el) return;
  const row = document.createElement('div');
  row.className = 'interp-log__row';
  row.innerHTML =
    `<div class="interp-log__src"><span class="lang-badge">${speakerCode.toUpperCase()}</span> ${escapeHtml(original)}</div>` +
    `<div class="interp-log__dst"><span class="lang-badge">${targetCode.toUpperCase()}</span> ${escapeHtml(translation)}</div>`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

function interpStartListening() {
  if (!INTERP.active || INTERP.fatal || !liveSupported()) return;
  INTERP.gen++;                     // new turn supersedes any in-flight async flow
  INTERP.paused = false;
  interpStopAudio();
  interpStopRecognition();

  const speakerCode = INTERP.current === 'A' ? INTERP.langA : INTERP.langB;
  const loc = interpLang(speakerCode).locale;

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recog = new Recognition();
  INTERP.recog = recog;
  recog.lang = loc;
  recog.interimResults = true;
  recog.continuous = true;         // stay on across pauses; end on real silence
  recog.maxAlternatives = 1;

  let finalText = '';
  let speaking = false;

  // Wait for the speaker to actually finish (browser voice-activity events drive
  // the endpoint, so mid-sentence pauses never cut the turn short).
  const SILENCE_MS = 700;
  const cancelStop = () => {
    if (INTERP.silenceTimer) { clearTimeout(INTERP.silenceTimer); INTERP.silenceTimer = null; }
  };
  const scheduleStop = () => {
    cancelStop();
    INTERP.silenceTimer = setTimeout(() => {
      try { recog.stop(); } catch {}
    }, SILENCE_MS);
  };

  recog.onstart = () => {
    interpSetState('listening');
    interpSetStatus(`Listening — ${interpLang(speakerCode).label.split(' —')[0]} (Speaker ${INTERP.current})`);
  };
  recog.onaudiostart = cancelStop;
  recog.onsoundstart = cancelStop;
  recog.onspeechstart = () => { speaking = true; cancelStop(); };
  recog.onspeechend = () => { speaking = false; scheduleStop(); };
  recog.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    interpSetStatus((finalText + ' ' + interim).trim() || 'Listening…');
    if (!speaking) scheduleStop();
  };
  recog.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      INTERP.fatal = true;
      interpSetState('idle');
      interpSetStatus('Microphone blocked. Allow mic access, then reopen.');
    } else if (e.error === 'language-not-supported') {
      interpSetState('idle');
      interpSetStatus(`Your browser can’t listen in ${interpLang(speakerCode).label.split(' —')[0]}. Try another language.`);
      INTERP.paused = true;
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      interpSetStatus('Mic error: ' + e.error);
    }
  };
  recog.onend = () => {
    if (INTERP.silenceTimer) { clearTimeout(INTERP.silenceTimer); INTERP.silenceTimer = null; }
    if (INTERP.recog !== recog) return;
    INTERP.recog = null;
    if (!INTERP.active || INTERP.fatal || INTERP.paused) return;
    const text = finalText.trim();
    if (text) {
      interpHandle(text);
    } else {
      setTimeout(() => {
        if (INTERP.active && !INTERP.paused && INTERP.state === 'listening') interpStartListening();
      }, 200);
    }
  };

  try {
    recog.start();
  } catch {
    setTimeout(() => { if (INTERP.active && !INTERP.paused) interpStartListening(); }, 300);
  }
}

function interpStopRecognition() {
  if (INTERP.silenceTimer) { clearTimeout(INTERP.silenceTimer); INTERP.silenceTimer = null; }
  const r = INTERP.recog;
  INTERP.recog = null;
  if (r) {
    r.onstart = r.onresult = r.onerror = r.onend = null;
    r.onaudiostart = r.onsoundstart = r.onspeechstart = r.onspeechend = null;
    try { r.abort(); } catch {}
  }
}

async function interpHandle(text) {
  const myGen = INTERP.gen;        // this turn; bail if superseded mid-flight
  interpStopRecognition();
  interpSetState('translating');

  const speakerCode = INTERP.current === 'A' ? INTERP.langA : INTERP.langB;
  const targetCode = INTERP.current === 'A' ? INTERP.langB : INTERP.langA;
  interpSetStatus('Translating…');

  let translation = '';
  try {
    translation = await interpTranslate(text, targetCode);
  } catch (err) {
    interpSetStatus('Translation error: ' + err.message);
  }
  if (myGen !== INTERP.gen) return; // interrupted/closed while translating

  if (translation) {
    interpLog(speakerCode, text, targetCode, translation);
    interpSetState('speaking');
    interpSetStatus(`Speaking — ${interpLang(targetCode).label.split(' —')[0]}`);
    await interpSpeakTTS(translation, targetCode);
    if (myGen !== INTERP.gen) return; // interrupted/closed while speaking
  }

  if (INTERP.active && !INTERP.paused) {
    // On success, hand the turn to the other speaker; on a failed translation,
    // let the SAME speaker retry instead of bouncing turns on errors.
    if (translation) INTERP.current = INTERP.current === 'A' ? 'B' : 'A';
    interpStartListening();
  }
}

async function interpTranslate(text, targetCode) {
  const resp = await fetch(apiUrl('/translate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_lang: targetCode }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new Error(err.detail || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return (data.translation || '').trim();
}

async function interpSpeakTTS(text, langCode) {
  const clean = liveCleanForSpeech(text);
  if (!clean) return;
  try {
    const fd = new FormData();
    fd.append('text', clean);
    fd.append('language', langCode);
    const resp = await fetch(apiUrl('/voice/tts'), { method: 'POST', body: fd });
    if (!resp.ok) throw new Error(`TTS ${resp.status}`);
    const blob = await resp.blob();
    if (blob.size === 0) throw new Error('empty audio');
    await interpPlayBlob(blob);
  } catch (err) {
    console.warn('Interpreter TTS fell back to browser speech:', err.message);
    await interpBrowserSpeak(clean, langCode);
  }
}

function interpPlayBlob(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    INTERP.audio = audio;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (INTERP.audio === audio) INTERP.audio = null;
      if (INTERP.audioResolve === done) INTERP.audioResolve = null;
      resolve();
    };
    INTERP.audioResolve = done;      // lets interpStopAudio() unblock a barge-in
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

function interpBrowserSpeak(text, langCode) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) { resolve(); return; }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (INTERP.audioResolve === done) INTERP.audioResolve = null;
      resolve();
    };
    INTERP.audioResolve = done;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = interpLang(langCode).locale;
    u.rate = 1.0;
    const voice = synth.getVoices().find(v => v.lang && v.lang.toLowerCase().startsWith(langCode));
    if (voice) u.voice = voice;
    u.onend = done;
    u.onerror = done;
    try { synth.cancel(); } catch {}
    synth.speak(u);
  });
}

function interpStopAudio() {
  if (INTERP.audio) {
    try { INTERP.audio.pause(); } catch {}
    INTERP.audio = null;
  }
  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    try { window.speechSynthesis.cancel(); } catch {}
  }
  // pause()/cancel() don't fire ended/onend, so resolve the pending speak promise.
  if (INTERP.audioResolve) {
    const r = INTERP.audioResolve;
    INTERP.audioResolve = null;
    r();
  }
}
