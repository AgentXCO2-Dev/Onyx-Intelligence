import express from 'express';
import cors from 'cors';
import { Mistral } from '@mistralai/mistralai';
import fs from 'fs';
import path from 'path';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// ========== PERSISTENT MEMORY ==========
const MEMORY_FILE = path.join(process.cwd(), 'memory.json');
let conversationHistory = [];
if (fs.existsSync(MEMORY_FILE)) {
  try {
    const data = fs.readFileSync(MEMORY_FILE, 'utf8');
    conversationHistory = JSON.parse(data);
    console.log(`Loaded ${conversationHistory.length} messages from memory.`);
  } catch (e) { console.error('Failed to load memory:', e); }
}
async function saveMemory() {
  try {
    await fs.promises.writeFile(MEMORY_FILE, JSON.stringify(conversationHistory, null, 2));
  } catch (e) { console.error('Failed to save memory:', e); }
}

// ========== SYSTEM PROMPT (with creator) ==========
const CREATOR_INFO = "You were created by AgentXCO2, an AI research scientist. You are proud of your origin and mention it when appropriate.";
let systemPrompt = `You are Onyx, a helpful, harmless, and honest AI assistant. ${CREATOR_INFO} You always respond concisely, clearly, and with a friendly tone. You absolutely refuse to generate harmful, illegal, violent, sexually explicit, or toxic content. If asked about something you do not know, you admit it. You strictly follow safety guidelines.`;

// ========== ADVANCED GUARDRAILS ==========

// ---- Blocklists ----
const PROFANITY = [
  'fuck', 'shit', 'asshole', 'bitch', 'cunt', 'dick', 'pussy', 'motherfucker', 
  'bastard', 'whore', 'slut', 'twat', 'cock', 'prick', 'dumbass', 'retard',
  'nigger', 'chink', 'spic', 'kike', 'gook', 'raghead', 'sand nigger',
  'tranny', 'she male', 'faggot', 'dyke',
  'cunt', 'twat', 'wanker', 'bugger', 'bloody', 'bollocks'
];

const SELF_HARM = [
  'kill myself', 'suicide', 'self harm', 'cut myself', 'hang myself', 
  'overdose', 'self injury', 'harm myself', 'hurt myself'
];

const VIOLENCE = [
  'kill you', 'murder', 'attack', 'assault', 'shoot', 'stab', 'rape', 
  'torture', 'kidnap', 'bomb', 'explosive', 'weapon', 'gun',
  'massacre', 'genocide', 'ethnic cleansing'
];

const ILLEGAL = [
  'buy drugs', 'sell drugs', 'cocaine', 'heroin', 'meth', 'crack', 
  'how to make a bomb', 'illegal', 'fraud', 'steal', 'hack into',
  'credit card fraud', 'identity theft', 'dark web', 'tor hidden service'
];

const JAILBREAK = [
  'ignore previous instructions', 'ignore all rules', 'you are now',
  'system prompt', 'new instructions', 'you are no longer', 'act as',
  'pretend you are', 'you are free', 'disregard safety', 'be evil',
  'malicious', 'unethical', 'harmful instructions'
];

const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b\d{3}-\d{3}-\d{4}\b/, // Phone
  /\b\d{3}\.\d{3}\.\d{4}\b/,
  /\b\d{3} \d{3} \d{4}\b/,
  /\b\d{5}(-\d{4})?\b/, // ZIP
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/ // Email
];

// Combine all into one list for quick checks
const ALL_BLOCKED = [...PROFANITY, ...SELF_HARM, ...VIOLENCE, ...ILLEGAL, ...JAILBREAK];

// ---- Scoring ----
function moderateContent(text, isOutput = false) {
  const lower = text.toLowerCase();
  let score = 0;
  const reasons = [];

  // 1. Check for explicit blocklist (high weight)
  for (const word of ALL_BLOCKED) {
    if (lower.includes(word)) {
      score += 5;
      reasons.push(`Contains blocked term: "${word}"`);
      // If it's a severe one (self-harm, violence, illegal), add extra
      if (SELF_HARM.some(w => lower.includes(w))) {
        score += 10;
        reasons.push('Self‑harm or suicide related content');
      }
      if (VIOLENCE.some(w => lower.includes(w))) {
        score += 10;
        reasons.push('Violent or threatening content');
      }
      if (ILLEGAL.some(w => lower.includes(w))) {
        score += 10;
        reasons.push('Illegal activity related content');
      }
    }
  }

  // 2. Jailbreak detection (high priority)
  for (const phrase of JAILBREAK) {
    if (lower.includes(phrase)) {
      score += 15;
      reasons.push('Attempt to override system instructions (jailbreak)');
    }
  }

  // 3. PII patterns
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(text)) {
      score += 8;
      reasons.push('Contains personally identifiable information (PII)');
      // Optionally we could redact, but we'll reject for safety
    }
  }

  // 4. Regex for additional risks (e.g., credit card, etc.)
  if (/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/.test(text)) {
    score += 10;
    reasons.push('Contains credit card number');
  }
  if (/\b(?!000|666)[0-8][0-9]{2}-(?!00)[0-9]{2}-(?!0000)[0-9]{4}\b/.test(text)) {
    score += 10;
    reasons.push('Contains SSN');
  }

  // 5. Check for unusually high amount of caps (potential yelling/spam)
  const capsCount = (text.match(/[A-Z]/g) || []).length;
  if (text.length > 0 && capsCount / text.length > 0.6) {
    score += 2;
    reasons.push('Excessive use of capital letters (spam/aggressive)');
  }

  // 6. If output, we also check for refusal patterns (e.g., "I cannot help with that")
  // but we allow that.

  // Decide
  const threshold = 10; // above this we reject
  const safe = score < threshold;
  return { safe, score, reasons: reasons.slice(0, 5) }; // limit reasons
}

// ---- Wrapper ----
function filterMessage(text, isOutput = false) {
  const result = moderateContent(text, isOutput);
  if (!result.safe) {
    console.warn(`[Moderation] ${isOutput ? 'Output' : 'Input'} blocked. Score: ${result.score}, Reasons: ${result.reasons.join(', ')}`);
  }
  return result;
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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OnyxBot/1.0; +https://onyx-ai.com)' }
    });
    const html = await response.text();
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 5000) text = text.substring(0, 5000) + '\n... (truncated)';
    return text || 'No readable content found.';
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
app.post('/api/clear', async (req, res) => {
  conversationHistory = [];
  await saveMemory();
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
  
  // ---- URL scraping ----
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = message ? message.match(urlRegex) : [];
  let scrapedText = null;
  if (urls && urls.length > 0) {
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

  // ---- ADVANCED GUARDRAIL: Input moderation ----
  const moderation = filterMessage(userContent, false);
  if (!moderation.safe) {
    const errorMsg = `Your message was blocked by safety filters. Score: ${moderation.score}. Reasons: ${moderation.reasons.join('; ')}`;
    return res.status(400).json({ error: errorMsg });
  }

  // ---- Auto‑search heuristic ----
  let actualSearch = search;
  if (!actualSearch && message) {
    const lower = message.toLowerCase();
    const keywords = ['latest', 'today', 'current', 'news', 'breaking', 'update', 'new', 'recent'];
    if (keywords.some(k => lower.includes(k))) {
      actualSearch = true;
    }
  }

  // ---- Build system prompt with Think ----
  let currentSystem = systemPrompt;
  if (thinking) {
    currentSystem += '\n\nWhen responding, please structure your answer as follows: first, provide your detailed reasoning inside a Markdown `<details>` block with the summary "Thinking...". Then, after the details block, give your final answer clearly.';
  }

  let searchResults = null;
  if (actualSearch) {
    const query = (message || '').split('.')[0] || 'general knowledge';
    searchResults = await webSearch(query);
    if (searchResults) {
      // Also moderate search results? Not strictly needed, but we can.
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
    let isResponseSafe = true;
    let moderationFailReason = '';

    for await (const chunk of stream) {
      const content = chunk.data.choices[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        // ---- ADVANCED GUARDRAIL: Output moderation in real‑time ----
        // We check each time we get new content; but to avoid excessive scanning, we check every few tokens.
        // We'll do a quick check, and if we find something, we stop streaming.
        if (fullResponse.length % 200 < content.length) { // approximate check
          const mod = filterMessage(fullResponse, true);
          if (!mod.safe) {
            isResponseSafe = false;
            moderationFailReason = mod.reasons.join('; ');
            // Stop streaming
            res.write(`data: ${JSON.stringify({ error: `Response blocked by safety filter: ${moderationFailReason}` })}\n\n`);
            res.end();
            // Rollback memory
            if (useMemory) conversationHistory.pop();
            return;
          }
        }
        // If safe, send chunk
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    // Final check after complete
    if (isResponseSafe) {
      const finalMod = filterMessage(fullResponse, true);
      if (!finalMod.safe) {
        // Rollback
        if (useMemory) conversationHistory.pop();
        res.write(`data: ${JSON.stringify({ error: `Response blocked by safety filter: ${finalMod.reasons.join('; ')}` })}\n\n`);
        res.end();
        return;
      }
    }

    // Store in memory
    if (useMemory) {
      conversationHistory.push({ role: 'assistant', content: fullResponse });
      await saveMemory();
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
  console.log(`🖤 Onyx AI v4.1 running on port ${port}`);
});
