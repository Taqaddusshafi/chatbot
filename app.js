/* ══════════════════════════════════════════════════════════════════════════════
   AI Chatbot — Application Logic
   Chat engine, voice I/O, translation, conversation management
   ══════════════════════════════════════════════════════════════════════════════ */

// ── Configuration ─────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  apiUrl: '',  // empty = same origin (works on Vercel and local)
  temperature: 0.7,
  maxTokens: 2048,
  ttsVoice: 'divya',
  autoSpeak: 'off',
};

let config = loadConfig();
let currentMode = 'chat'; // 'chat' | 'translate'
let conversations = loadConversations();
let activeConversationId = null;
let isGenerating = false;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

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
  config.ttsVoice = document.getElementById('settingTtsVoice').value;
  config.autoSpeak = document.getElementById('settingAutoSpeak').value;

  localStorage.setItem('chatbot_config', JSON.stringify(config));
  toggleSettings();
  checkEngineHealth();
}

function applyConfig() {
  document.getElementById('settingApiUrl').value = config.apiUrl;
  document.getElementById('settingTemperature').value = config.temperature;
  document.getElementById('settingMaxTokens').value = config.maxTokens;
  document.getElementById('settingTtsVoice').value = config.ttsVoice;
  document.getElementById('settingAutoSpeak').value = config.autoSpeak;
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

  // Add user message
  conv.messages.push({ role: 'user', content: text });
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

  const messages = conv.messages.map(m => ({ role: m.role, content: m.content }));

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

    // Auto-speak if enabled
    if (config.autoSpeak === 'on' && conv.messages[msgIndex].content) {
      speakText(conv.messages[msgIndex].content);
    }

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

    if (config.autoSpeak === 'on' && data.translation) {
      const lang = data.target_lang === 'ar' ? 'ar' : 'en';
      speakText(data.translation, lang);
    }

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
  if (msg.meta && msg.meta.type === 'translation') {
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

  // Speak button (for AI messages)
  if (!isUser) {
    const speakBtn = document.createElement('button');
    speakBtn.className = 'msg-action-btn';
    speakBtn.title = 'Speak';
    speakBtn.textContent = '🔊';
    speakBtn.onclick = () => {
      const lang = isArabic ? 'ar' : 'en';
      speakText(msg.content, lang);
    };
    actions.appendChild(speakBtn);
  }

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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = getBestMimeType();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      await transcribeAudio(blob);
    };

    mediaRecorder.start(250);
    isRecording = true;
    updateMicButton();
  } catch (err) {
    alert('Microphone access denied.\n' + err.message);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  isRecording = false;
  updateMicButton();
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
  const cleanType = (blob.type || 'audio/webm').split(';')[0];
  formData.append('file', new File([blob], 'recording.webm', { type: cleanType }));

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

function getBestMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

// ── Voice Output (TTS) ────────────────────────────────────────────────────────
async function speakText(text, language = 'en') {
  // Strip markdown for TTS
  const cleanText = text
    .replace(/[#*`_~\[\]()]/g, '')
    .replace(/\n+/g, '. ')
    .trim()
    .substring(0, 1000);

  if (!cleanText) return;

  const formData = new FormData();
  formData.append('text', cleanText);
  formData.append('language', language);
  formData.append('voice', config.ttsVoice);

  try {
    const resp = await fetch(apiUrl('/voice/tts'), {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      throw new Error(`TTS failed: HTTP ${resp.status}`);
    }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
  } catch (err) {
    console.error('TTS error:', err);
  }
}

// ── Health Check ──────────────────────────────────────────────────────────────
async function checkEngineHealth() {
  try {
    const resp = await fetch(apiUrl('/engine-health'));
    const data = await resp.json();

    updateStatusDot('statusLlm', data.llm?.status);
    updateStatusDot('statusTts', data.tts?.status);
    updateStatusDot('statusStt', data.stt?.status);
  } catch {
    updateStatusDot('statusLlm', 'error');
    updateStatusDot('statusTts', 'error');
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
