import express from 'express';
import cors from 'cors';
import { Mistral } from '@mistralai/mistralai';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// ========== STATE ==========
let systemPrompt = 'You are Onyx, a helpful, harmless, and honest AI assistant. You always respond concisely, clearly, and with a friendly tone. You refuse to generate harmful, illegal, or toxic content. If asked about something you do not know, you admit it.';
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

// ========== WEB SEARCH ==========
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

// ========== URL SCRAPER ==========
async function scrapeURL(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OnyxBot/1.0; +https://onyx-ai.com)'
      }
    });
    const html = await response.text();
    
    // Remove script and style tags
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    // Remove HTML tags
    text = text.replace(/<[^>]+>/g, ' ');
    // Decode HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    // Condense whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    // Limit to 5000 chars to avoid token overload
    if (text.length > 5000) {
      text = text.substring(0, 5000) + '\n... (truncated)';
    }
    return text || 'No readable content found on this page.';
  } catch (e) {
    console.error('Scrape error:', e);
    return null;
  }
}

// ========== ENDPOINT: Set Personality ==========
app.post('/api/system', (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  systemPrompt = prompt;
  res.json({ status: 'System prompt updated' });
});

// ========== ENDPOINT: Clear Memory ==========
app.post('/api/clear', (req, res) => {
  conversationHistory = [];
  res.json({ status: 'Memory cleared' });
});

// ========== ENDPOINT: Get Memory ==========
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
    useMemory = true
  } = req.body;

  if (!message && !fileContent) {
    return res.status(400).json({ error: 'Message or file required' });
  }

  // ---- Build user content ----
  let userContent = message || '';
  
  // ---- URL SCRAPING: Auto-detect URLs in the message ----
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = message ? message.match(urlRegex) : [];
  let scrapedText = null;
  if (urls && urls.length > 0) {
    // Scrape the first URL found
    const scraped = await scrapeURL(urls[0]);
    if (scraped) {
      scrapedText = scraped;
      userContent += `\n\n[Scraped webpage content from ${urls[0]}]:\n${scraped}`;
    } else {
      userContent += `\n\n[Failed to scrape ${urls[0]}]`;
    }
  }

  if (fileContent) {
    userContent += `\n\n[File content]:\n${fileContent}`;
  }

  // ---- Input Guard ----
  if (!isMessageSafe(userContent)) {
    return res.status(400).json({ error: 'Your message contains inappropriate content.' });
  }

  // ---- Build system prompt with Think/Search ----
  let currentSystem = systemPrompt;
  if (thinking) {
    currentSystem += ' You must think step by step and provide a final answer. Show your reasoning in a clear manner.';
  }

  let searchResults = null;
  if (search) {
    const query = (message || '').split('.')[0] || 'general knowledge';
    searchResults = await webSearch(query);
    if (searchResults) {
      currentSystem += `\n\nAdditional context from web search (use if relevant):\n${searchResults}`;
    }
  }

  // ---- Manage Memory ----
  let messagesToSend = [];
  if (useMemory) {
    conversationHistory.push({ role: 'user', content: userContent });
    const maxMessages = 20;
    const context = conversationHistory.slice(-maxMessages);
    messagesToSend = [
      { role: 'system', content: currentSystem },
      ...context
    ];
  } else {
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
        if (!isMessageSafe(fullResponse)) {
          res.write(`data: ${JSON.stringify({ error: 'Response blocked by safety filter.' })}\n\n`);
          res.end();
          if (useMemory) conversationHistory.pop();
          return;
        }
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    if (useMemory) {
      conversationHistory.push({ role: 'assistant', content: fullResponse });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Mistral Error:', error);
    if (useMemory) conversationHistory.pop();
    res.write(`data: ${JSON.stringify({ error: 'AI service error. Please try again.' })}\n\n`);
    res.end();
  }
});

app.listen(port, () => {
  console.log(`🖤 Onyx AI v3.1 running on port ${port}`);
});
