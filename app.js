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

  if (mode === 'translate') {
    headerIcon.className = 'chat-header__mode-icon translate-mode';
    headerIcon.textContent = '🌐';
    headerText.textContent = 'Translation Mode';
    headerHint.textContent = 'Arabic ↔ English';
    input.placeholder = 'Type text to translate (Arabic or English)...';
  } else {
    headerIcon.className = 'chat-header__mode-icon chat-mode';
    headerIcon.textContent = '💬';
    headerText.textContent = 'Chat Mode';
    headerHint.textContent = 'General AI conversation';
    input.placeholder = 'Type your message...';
  }

  if (updateConv && activeConversationId && conversations[activeConversationId]) {
    conversations[activeConversationId].mode = mode;
    saveConversations();
    renderConversationList();
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

  try {
    const response = await fetch(apiUrl('/translate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
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
        <div class="welcome__icon">🦙</div>
        <h2>Hello! I'm your AI Assistant</h2>
        <p>Powered by LLaMA 3.1 with Arabic ↔ English translation. Ask me anything or switch to translation mode.</p>
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

// ── Text-to-Speech (TTS) ──────────────────────────────────────────────────────
let activeSpeakBtn = null; // Track the currently speaking button

/**
 * Detect the dominant language/script of the text.
 * Returns a BCP-47 lang code. Supports Urdu, Arabic, Hindi, and many more.
 */
function detectLanguage(text) {
  // Count characters in various Unicode script ranges
  const counts = {
    // Urdu-specific characters (Urdu uses Arabic script + extra chars like ے ہ ٹ ڈ ڑ ں)
    urdu:       (text.match(/[\u0679\u0688\u0691\u06BA\u06BE\u06C1\u06C3\u06CC\u06D2]/g) || []).length,
    // General Arabic script (shared by Arabic, Urdu, Persian, etc.)
    arabicScript: (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length,
    // Devanagari (Hindi, Marathi, Sanskrit)
    devanagari: (text.match(/[\u0900-\u097F]/g) || []).length,
    // Bengali
    bengali:    (text.match(/[\u0980-\u09FF]/g) || []).length,
    // Gurmukhi (Punjabi)
    gurmukhi:   (text.match(/[\u0A00-\u0A7F]/g) || []).length,
    // Tamil
    tamil:      (text.match(/[\u0B80-\u0BFF]/g) || []).length,
    // Telugu
    telugu:     (text.match(/[\u0C00-\u0C7F]/g) || []).length,
    // CJK (Chinese/Japanese/Korean)
    cjk:        (text.match(/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length,
    // Cyrillic (Russian, etc.)
    cyrillic:   (text.match(/[\u0400-\u04FF]/g) || []).length,
    // Latin (English, French, Spanish, etc.)
    latin:      (text.match(/[a-zA-Z\u00C0-\u024F]/g) || []).length,
  };

  // If Urdu-specific chars are present alongside Arabic script → it's Urdu
  if (counts.urdu >= 2 || (counts.urdu >= 1 && counts.arabicScript > counts.latin * 2)) {
    return 'ur';
  }

  // Persian has chars like گ چ پ ژ (also in Arabic range but less in Arabic)
  const persianChars = (text.match(/[\u06AF\u0686\u067E\u0698]/g) || []).length;
  if (persianChars >= 2 && counts.arabicScript > counts.latin) {
    return 'fa';
  }

  // Pure Arabic (no Urdu/Persian markers)
  if (counts.arabicScript > counts.latin && counts.arabicScript > 3) {
    return 'ar';
  }

  if (counts.devanagari > counts.latin) return 'hi';
  if (counts.bengali > counts.latin) return 'bn';
  if (counts.gurmukhi > counts.latin) return 'pa';
  if (counts.tamil > counts.latin) return 'ta';
  if (counts.telugu > counts.latin) return 'te';
  if (counts.cyrillic > counts.latin) return 'ru';
  if (counts.cjk > 3) return 'zh';

  // Latin-based language detection via common words
  const lower = text.toLowerCase();
  if (/\b(le|la|les|une?|est|sont|avec|dans|pour|que|qui|mais|très)\b/.test(lower)) return 'fr';
  if (/\b(el|los|las|una?|es|son|con|para|que|pero|más|como|muy)\b/.test(lower)) return 'es';
  if (/\b(der|die|das|und|ist|ein|eine|mit|auf|für|nicht|auch)\b/.test(lower)) return 'de';
  if (/\b(bir|ve|bu|ile|için|olan|gibi|daha|çok)\b/.test(lower)) return 'tr';
  if (/\b(il|lo|la|gli|una?|è|sono|con|per|che|non|più)\b/.test(lower)) return 'it';
  if (/\b(um|uma|os|as|é|são|com|para|que|não|mais)\b/.test(lower)) return 'pt';

  return 'en-US';
}

/**
 * Pick the best available voice for a language.
 * Prefers premium/natural voices over robotic system defaults.
 */
function pickBestVoice(voices, lang) {
  if (!voices.length) return null;

  const langPrefix = lang.split('-')[0]; // 'en-US' → 'en', 'ur' → 'ur'

  // Get all voices matching this language
  const matching = voices.filter(v =>
    v.lang.startsWith(langPrefix) || v.lang.startsWith(lang)
  );

  if (matching.length === 0) {
    // Fallback: for Urdu, try Hindi voices (intelligible)
    if (langPrefix === 'ur') {
      const hindiFallback = voices.filter(v => v.lang.startsWith('hi'));
      if (hindiFallback.length) return pickPremiumVoice(hindiFallback);
    }
    // For Persian, try Arabic
    if (langPrefix === 'fa') {
      const arabicFallback = voices.filter(v => v.lang.startsWith('ar'));
      if (arabicFallback.length) return pickPremiumVoice(arabicFallback);
    }
    return null;
  }

  return pickPremiumVoice(matching);
}

/**
 * From a list of matching voices, pick the most natural-sounding one.
 * Premium voices (Google, Microsoft Neural, Apple's Samantha/Siri) sound
 * significantly better than generic system voices.
 */
function pickPremiumVoice(voices) {
  if (!voices.length) return null;

  // Score each voice — higher = better quality
  const scored = voices.map(v => {
    let score = 0;
    const name = v.name.toLowerCase();

    // Premium cloud voices (best quality)
    if (name.includes('google') && !name.includes('espeak')) score += 30;
    if (name.includes('microsoft') && name.includes('neural')) score += 30;
    if (name.includes('microsoft') && name.includes('online')) score += 25;
    if (name.includes('natural')) score += 20;
    if (name.includes('enhanced')) score += 15;
    if (name.includes('premium')) score += 15;

    // Apple high-quality voices
    if (name.includes('samantha')) score += 20;
    if (name.includes('karen')) score += 18;
    if (name.includes('daniel')) score += 18;
    if (name.includes('siri')) score += 15;
    if (name.includes('compact')) score -= 10;

    // Penalize known robotic engines
    if (name.includes('espeak')) score -= 20;
    if (name.includes('mbrola')) score -= 15;

    // Non-local (cloud) voices tend to be higher quality
    if (!v.localService) score += 5;

    return { voice: v, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].voice;
}

function speakMessage(text, btn) {
  const synth = window.speechSynthesis;

  // If already speaking — stop and reset
  if (synth.speaking) {
    synth.cancel();
    resetSpeakButton();
    // If the same button was clicked, just stop (toggle off)
    if (activeSpeakBtn === btn) {
      activeSpeakBtn = null;
      return;
    }
  }

  // Strip markdown-like formatting for a cleaner read
  const cleanText = text
    .replace(/```[\s\S]*?```/g, ' code block omitted ')  // code blocks
    .replace(/`([^`]+)`/g, '$1')                          // inline code
    .replace(/\*\*(.+?)\*\*/g, '$1')                      // bold
    .replace(/\*(.+?)\*/g, '$1')                          // italic
    .replace(/^#{1,6}\s+/gm, '')                          // headings
    .replace(/^[>*-]\s+/gm, '')                           // lists / blockquotes
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')              // links
    .trim();

  if (!cleanText) return;

  const utterance = new SpeechSynthesisUtterance(cleanText);

  // Auto-detect language (supports Urdu, Arabic, Hindi, and many more)
  const detectedLang = detectLanguage(cleanText);
  utterance.lang = detectedLang;

  // Pick the best (most natural) voice available
  const voices = synth.getVoices();
  const bestVoice = pickBestVoice(voices, detectedLang);
  if (bestVoice) utterance.voice = bestVoice;

  // Slightly slower rate sounds more natural and human
  utterance.rate = 0.95;
  utterance.pitch = 1.0;

  // Update button to active state
  activeSpeakBtn = btn;
  btn.classList.add('speaking');
  btn.textContent = '⏹';
  btn.title = 'Stop speaking';

  utterance.onend = () => {
    resetSpeakButton();
    activeSpeakBtn = null;
  };

  utterance.onerror = () => {
    resetSpeakButton();
    activeSpeakBtn = null;
  };

  synth.speak(utterance);
}

function resetSpeakButton() {
  if (activeSpeakBtn) {
    activeSpeakBtn.classList.remove('speaking');
    activeSpeakBtn.textContent = '🔊';
    activeSpeakBtn.title = 'Speak';
  }
}

// Pre-load voices (some browsers load them async)
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
  };
}

