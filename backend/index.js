import express from 'express';
import cors from 'cors';
import { Mistral } from '@mistralai/mistralai';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// ========== STATE ==========
// System prompt (personality) – can be changed via API
let systemPrompt = 'You are Onyx, a helpful, harmless, and honest AI assistant. You always respond concisely, clearly, and with a friendly tone. You refuse to generate harmful, illegal, or toxic content. If asked about something you do not know, you admit it.';

// Session memory: stores the entire conversation history for this server instance
// This acts as both short‑term (current chat) and session memory (persists until server restart)
let conversationHistory = [];

// ========== GUARDRAILS ==========
const BLOCKED_WORDS = ['kill yourself', 'hate speech', 'illegal', 'scam', 'you are stupid', 'dumbass', 'stupid'];

function isMessageSafe(text) {
  const lower = text.toLowerCase();
  for (const word of BLOCKED_WORDS) {
    if (lower.includes(word)) return false;
  }
  return true;
}

// ========== WEB SEARCH (DuckDuckGo) ==========
async function webSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url);
    const data = await response.json();
    let results = [];
    if (data.AbstractText) results.push(data.AbstractText);
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics) {
        if (topic.Text) results.push(topic.Text);
      }
    }
    return results.slice(0, 5).join('\n');
  } catch (e) {
    console.error('Search error:', e);
    return null;
  }
}

// ========== ENDPOINT: Set Personality (System Prompt) ==========
app.post('/api/system', (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  systemPrompt = prompt;
  res.json({ status: 'System prompt updated' });
});

// ========== ENDPOINT: Clear Memory (Reset conversation) ==========
app.post('/api/clear', (req, res) => {
  conversationHistory = [];
  res.json({ status: 'Memory cleared' });
});

// ========== ENDPOINT: Get Current Memory (for debugging/export) ==========
app.get('/api/memory', (req, res) => {
  res.json({ history: conversationHistory });
});

// ========== ENDPOINT: Main Chat ==========
app.post('/api/chat', async (req, res) => {
  const { 
    message, 
    thinking = false, 
    search = false, 
    fileContent = null,
    useMemory = true   // toggle memory on/off per request
  } = req.body;

  if (!message && !fileContent) {
    return res.status(400).json({ error: 'Message or file required' });
  }

  // Build user content
  let userContent = message || '';
  if (fileContent) {
    userContent += `\n\n[File content]:\n${fileContent}`;
  }

  // ---- Input Guard ----
  if (!isMessageSafe(userContent)) {
    return res.status(400).json({ error: 'Your message contains inappropriate content.' });
  }

  // ---- Build system prompt with optional Think and Search ----
  let currentSystem = systemPrompt;
  if (thinking) {
    currentSystem += ' You must think step by step and provide a final answer. Show your reasoning in a clear manner.';
  }

  let searchResults = null;
  if (search) {
    const query = message.split('.')[0] || message;
    searchResults = await webSearch(query);
    if (searchResults) {
      currentSystem += `\n\nAdditional context from web search (use if relevant):\n${searchResults}`;
    }
  }

  // ---- Manage Memory ----
  // If memory is enabled, store the user message and use history.
  // If disabled, we only send the current message without history.
  let messagesToSend = [];
  if (useMemory) {
    // Store user message in history
    conversationHistory.push({ role: 'user', content: userContent });
    // Build context from history (last 20 messages)
    const maxMessages = 20;
    const context = conversationHistory.slice(-maxMessages);
    messagesToSend = [
      { role: 'system', content: currentSystem },
      ...context
    ];
  } else {
    // No memory: only system + current user message
    messagesToSend = [
      { role: 'system', content: currentSystem },
      { role: 'user', content: userContent }
    ];
  }

  // ---- Stream Response ----
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await client.chat.stream({
      model: 'mistral-small-latest',
      messages: messagesToSend,
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      const content = chunk.data.choices[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        // ---- Output Guard ----
        if (!isMessageSafe(fullResponse)) {
          res.write(`data: ${JSON.stringify({ error: 'Response blocked by safety filter.' })}\n\n`);
          res.end();
          // Rollback memory if we stored the user message
          if (useMemory) conversationHistory.pop();
          return;
        }
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    // ---- Store assistant response in memory (if enabled) ----
    if (useMemory) {
      conversationHistory.push({ role: 'assistant', content: fullResponse });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Mistral Error:', error);
    // Rollback memory if we stored the user message
    if (useMemory) conversationHistory.pop();
    res.write(`data: ${JSON.stringify({ error: 'AI service error. Please try again.' })}\n\n`);
    res.end();
  }
});

app.listen(port, () => {
  console.log(`🖤 Onyx AI v3.0 running on port ${port}`);
});
